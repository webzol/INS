(function () {
  'use strict';

  // 防止同一页面被注入多次（all_frames + 重复加载）
  if (window.__TD_IMAGE_COMPRESS_LOADED__) return;
  window.__TD_IMAGE_COMPRESS_LOADED__ = true;

  const DEFAULTS = {
    autoDetect: true,
    quality: 80,
    maxEdge: 1920,
    // 默认 0：所有图片都拦截。设为 100 时小于 100KB 的图不弹层。
    minSizeKB: 0,
    format: 'auto', // auto | webp | jpeg
    debug: false
  };

  /** @type {{ kind: 'input', input: HTMLInputElement } | { kind: 'drop', target: EventTarget, originalEvent: DragEvent } | null} */
  let activeSession = null;
  let activeRoot = null;
  let config = { ...DEFAULTS };
  let dropDepth = 0;
  let configReady = false;
  const pendingJobs = [];

  function log(...args) {
    if (config.debug) console.log('[TD-ImageCompress]', ...args);
  }

  function loadConfig() {
    try {
      chrome.storage.sync.get(DEFAULTS, (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          console.warn('[TD-ImageCompress] storage:', chrome.runtime.lastError.message);
        }
        Object.keys(DEFAULTS).forEach((key) => {
          if (result && result[key] !== undefined) config[key] = result[key];
        });
        // 兼容旧版本曾把 minSizeKB 默认成 100 的用户：若用户从未改过可在 UI 调到 0
        configReady = true;
        log('config ready', config);
        while (pendingJobs.length) {
          const job = pendingJobs.shift();
          try {
            job();
          } catch (e) {
            console.error('[TD-ImageCompress] pending job', e);
          }
        }
      });
    } catch (e) {
      console.error('[TD-ImageCompress] storage get failed', e);
      configReady = true;
    }
  }

  loadConfig();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area && area !== 'sync') return;
      Object.keys(DEFAULTS).forEach((key) => {
        if (changes[key]) config[key] = changes[key].newValue;
      });
      log('config changed', config);
    });
  } catch (_) {
    /* extension context */
  }

  // ---------- helpers ----------

  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tif|tiff|jfif)$/i;

  function isImageFile(file) {
    if (!file) return false;
    const type = (file.type || '').toLowerCase();
    if (type.startsWith('image/')) {
      if (type.includes('svg')) return false;
      return true;
    }
    // 部分系统/浏览器选图后 type 为空，用扩展名兜底
    if (!type && file.name && IMAGE_EXT.test(file.name)) return true;
    return false;
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  function replaceExt(name, ext) {
    const base = name.replace(/\.[^.]+$/, '');
    return `${base}${ext}`;
  }

  function shouldIntercept(imageFiles) {
    if (!imageFiles.length) return false;
    const minBytes = Math.max(0, Number(config.minSizeKB) || 0) * 1024;
    if (minBytes <= 0) return true;
    return imageFiles.some((f) => f.size >= minBytes);
  }

  function filesFromDataTransfer(dt) {
    if (!dt) return [];
    if (dt.files && dt.files.length) return Array.from(dt.files);
    const out = [];
    if (dt.items) {
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  function dataTransferHasFiles(dt) {
    if (!dt) return false;
    if (dt.types) {
      for (let i = 0; i < dt.types.length; i++) {
        if (String(dt.types[i]).toLowerCase() === 'files') return true;
      }
    }
    return !!(dt.files && dt.files.length);
  }

  function dismissUI() {
    if (activeRoot) {
      activeRoot.remove();
      activeRoot = null;
    }
    hideDropOverlay();
  }

  function revokePreviewUrls(items) {
    (items || []).forEach((it) => {
      if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      if (it.afterUrl) URL.revokeObjectURL(it.afterUrl);
    });
  }

  function mountHost() {
    // 全屏 fixed 宿主：Shadow 内 position:fixed 在部分站点会相对 host 计算；
    // 若 host 是 0×0 左上角，面板会「跑到左边」。全屏 host + 面板 top/right 才稳。
    const host = document.createElement('div');
    host.id = 'image-optimizer-root';
    host.setAttribute('data-td-image-compress', '1');
    Object.assign(host.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      width: '100vw',
      height: '100vh',
      margin: '0',
      padding: '0',
      border: 'none',
      zIndex: '2147483647',
      pointerEvents: 'none',
      overflow: 'visible',
      background: 'transparent',
      transform: 'none',
      filter: 'none',
      perspective: 'none',
      contain: 'none'
    });
    // 尽量挂到 html，避开 body 上的 transform/filter 影响 fixed
    const parent = document.documentElement || document.body;
    parent.appendChild(host);
    return host;
  }

  // ---------- compression ----------

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error(`toBlob failed: ${type}`));
        },
        type,
        quality
      );
    });
  }

  async function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file);
      } catch (_) {
        /* fallback */
      }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      };
      img.src = url;
    });
  }

  function closeBitmap(source) {
    if (source && typeof source.close === 'function') source.close();
  }

  async function compressImage(file) {
    const source = await loadBitmap(file);
    try {
      let width = source.width;
      let height = source.height;
      const maxEdge = Math.max(320, Number(config.maxEdge) || DEFAULTS.maxEdge);

      if (width > maxEdge || height > maxEdge) {
        const scale = maxEdge / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) return file;

      const maybeAlpha = /png|webp|gif/i.test(file.type || '') || /\.(png|webp|gif)$/i.test(file.name || '');
      if (!maybeAlpha) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(source, 0, 0, width, height);

      const q = Math.min(1, Math.max(0.1, (Number(config.quality) || 80) / 100));
      const format = config.format || 'auto';
      const candidates = [];

      const pushCandidate = async (type, ext, quality) => {
        try {
          const blob = await canvasToBlob(canvas, type, quality);
          if (blob && blob.size > 0) candidates.push({ blob, type, ext });
        } catch (_) {
          /* unsupported */
        }
      };

      if (format === 'jpeg') {
        await pushCandidate('image/jpeg', '.jpg', q);
      } else if (format === 'webp') {
        await pushCandidate('image/webp', '.webp', q);
        if (!candidates.length) await pushCandidate('image/jpeg', '.jpg', q);
      } else {
        await pushCandidate('image/webp', '.webp', q);
        await pushCandidate('image/jpeg', '.jpg', q);
        if (maybeAlpha) await pushCandidate('image/png', '.png');
      }

      if (!candidates.length) return file;
      candidates.sort((a, b) => a.blob.size - b.blob.size);
      const best = candidates[0];
      if (best.blob.size >= file.size * 0.97) return file;

      return new File([best.blob], replaceExt(file.name, best.ext), {
        type: best.type,
        lastModified: Date.now()
      });
    } finally {
      closeBitmap(source);
    }
  }

  async function mapPool(items, limit, worker) {
    const results = new Array(items.length);
    let idx = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const current = idx++;
        results[current] = await worker(items[current], current);
      }
    });
    await Promise.all(runners);
    return results;
  }

  // ---------- intercept core ----------

  function handleFileInput(input, event) {
    if (!config.autoDetect) {
      log('autoDetect off, skip');
      return false;
    }
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return false;
    if (input.dataset.optimizerProcessed === 'true') {
      delete input.dataset.optimizerProcessed;
      log('pass-through processed input');
      return false;
    }

    const allFiles = input.files ? Array.from(input.files) : [];
    if (!allFiles.length) {
      log('no files on input');
      return false;
    }

    const imageFiles = allFiles.filter(isImageFile);
    log('input files', allFiles.length, 'images', imageFiles.length, imageFiles.map((f) => `${f.name}:${f.type}:${f.size}`));

    if (!shouldIntercept(imageFiles)) {
      log('below minSize or no images', { minSizeKB: config.minSizeKB });
      return false;
    }

    if (event) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }

    activeSession = { kind: 'input', input };
    // 延后弹层，避免与站点同步 change 处理打架
    const open = () => showOptimizerUI(imageFiles, allFiles);
    if (!configReady) pendingJobs.push(open);
    else queueMicrotask(open);
    return true;
  }

  function onChangeCapture(event) {
    try {
      const target = event.target;
      // Shadow DOM 内控件：event.target 可能是 host，用 composedPath
      let input = null;
      if (target instanceof HTMLInputElement && target.type === 'file') {
        input = target;
      } else if (typeof event.composedPath === 'function') {
        const path = event.composedPath();
        for (let i = 0; i < path.length; i++) {
          const n = path[i];
          if (n instanceof HTMLInputElement && n.type === 'file') {
            input = n;
            break;
          }
        }
      }
      if (!input) return;
      handleFileInput(input, event);
    } catch (err) {
      console.error('[TD-ImageCompress] change handler', err);
    }
  }

  // document + window 双挂，提高捕获成功率
  document.addEventListener('change', onChangeCapture, true);
  window.addEventListener('change', onChangeCapture, true);

  // 部分站点用 input 事件；少数只在冒泡阶段读 files —— 捕获阶段已拦 change 足够
  // 额外：监听动态创建的 file input，打日志便于 debug
  try {
    const mo = new MutationObserver((mutations) => {
      if (!config.debug) return;
      for (const m of mutations) {
        m.addedNodes &&
          m.addedNodes.forEach((node) => {
            if (!(node instanceof Element)) return;
            if (node.matches && node.matches('input[type="file"]')) log('file input added', node);
            const list = node.querySelectorAll && node.querySelectorAll('input[type="file"]');
            if (list && list.length) log('file inputs in subtree', list.length);
          });
      }
    });
    const startMo = () => {
      if (document.documentElement) {
        mo.observe(document.documentElement, { childList: true, subtree: true });
      }
    };
    if (document.documentElement) startMo();
    else document.addEventListener('DOMContentLoaded', startMo, { once: true });
  } catch (_) {
    /* ignore */
  }

  // ---------- drag & drop ----------

  let dropOverlay = null;

  function ensureDropOverlay() {
    if (dropOverlay && document.contains(dropOverlay)) return dropOverlay;
    const el = document.createElement('div');
    el.id = 'image-optimizer-drop-overlay';
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      pointerEvents: 'none',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 122, 255, 0.12)',
      border: '3px dashed rgba(0, 122, 255, 0.55)',
      boxSizing: 'border-box',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      color: '#007aff',
      fontSize: '16px',
      fontWeight: '600',
      backdropFilter: 'blur(2px)',
      WebkitBackdropFilter: 'blur(2px)'
    });
    el.textContent = '松开后将智能压缩图片';
    (document.documentElement || document.body).appendChild(el);
    dropOverlay = el;
    return el;
  }

  function showDropOverlay() {
    const el = ensureDropOverlay();
    el.style.display = 'flex';
  }

  function hideDropOverlay() {
    dropDepth = 0;
    if (dropOverlay) dropOverlay.style.display = 'none';
  }

  document.addEventListener(
    'dragenter',
    (e) => {
      if (!config.autoDetect || !dataTransferHasFiles(e.dataTransfer)) return;
      dropDepth += 1;
      showDropOverlay();
    },
    true
  );

  document.addEventListener(
    'dragleave',
    () => {
      if (!config.autoDetect) return;
      dropDepth = Math.max(0, dropDepth - 1);
      if (dropDepth === 0) hideDropOverlay();
    },
    true
  );

  document.addEventListener(
    'dragover',
    (e) => {
      if (!config.autoDetect || !dataTransferHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch (_) {
        /* ignore */
      }
      showDropOverlay();
    },
    true
  );

  document.addEventListener(
    'drop',
    (e) => {
      hideDropOverlay();
      if (!config.autoDetect) return;

      const allFiles = filesFromDataTransfer(e.dataTransfer);
      if (!allFiles.length) return;

      const imageFiles = allFiles.filter(isImageFile);
      log('drop images', imageFiles.length);
      if (!shouldIntercept(imageFiles)) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      activeSession = { kind: 'drop', target: e.target, originalEvent: e };
      const open = () => showOptimizerUI(imageFiles, allFiles);
      if (!configReady) pendingJobs.push(open);
      else queueMicrotask(open);
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeRoot) {
      const items = activeRoot._items;
      revokePreviewUrls(items);
      dismissUI();
      activeSession = null;
    }
  });

  // ---------- re-dispatch ----------

  function passThroughInput(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.dataset.optimizerProcessed = 'true';
    try {
      input.files = dt.files;
    } catch (err) {
      console.error('[TD-ImageCompress] assign files failed:', err);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // 再补一次 input 事件，兼容只听 input 的站点
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) {
      /* ignore */
    }
  }

  function passThroughDrop(session, files) {
    const target = session.target;
    if (!(target instanceof Element)) return;

    const nearbyInput = findNearbyFileInput(target, files);
    if (nearbyInput) {
      passThroughInput(nearbyInput, files);
      return;
    }

    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));

    const fire = (type, cancelable) => {
      let ev;
      try {
        ev = new DragEvent(type, {
          bubbles: true,
          cancelable,
          dataTransfer: dt,
          clientX: session.originalEvent?.clientX || 0,
          clientY: session.originalEvent?.clientY || 0
        });
      } catch (_) {
        ev = new CustomEvent(type, { bubbles: true, cancelable, detail: { files } });
      }
      try {
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
      } catch (_) {
        /* ignore */
      }
      target.dispatchEvent(ev);
    };

    fire('dragenter', true);
    fire('dragover', true);
    fire('drop', true);
  }

  function findNearbyFileInput(fromEl, files) {
    const acceptImages = (input) => {
      if (!(input instanceof HTMLInputElement) || input.type !== 'file') return false;
      if (input.disabled) return false;
      return true;
    };

    let el = fromEl;
    for (let i = 0; i < 8 && el; i++) {
      if (el instanceof HTMLInputElement && acceptImages(el)) return el;
      const found = el.querySelector && el.querySelector('input[type="file"]');
      if (found && acceptImages(found)) return found;
      el = el.parentElement;
    }

    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(acceptImages);
    if (inputs.length === 1) return inputs[0];
    return null;
  }

  function commitFiles(files) {
    const session = activeSession;
    dismissUI();
    activeSession = null;
    if (!session) return;

    if (session.kind === 'input') {
      passThroughInput(session.input, files);
    } else if (session.kind === 'drop') {
      passThroughDrop(session, files);
    }
  }

  // ---------- UI ----------

  function showOptimizerUI(imageFiles, allFiles) {
    dismissUI();

    /** @type {Array<{ original: File, compressed: File|null, skipped: boolean, previewUrl: string, afterUrl: string|null }>} */
    const items = imageFiles.map((file) => ({
      original: file,
      compressed: null,
      skipped: false,
      previewUrl: URL.createObjectURL(file),
      afterUrl: null
    }));

    const host = mountHost();
    host.style.pointerEvents = 'none';
    activeRoot = host;
    host._items = items;

    const shadow = host.attachShadow({ mode: 'open' });

    const totalOriginalSize = imageFiles.reduce((acc, f) => acc + f.size, 0);
    const otherCount = allFiles.length - imageFiles.length;
    const sourceLabel = activeSession?.kind === 'drop' ? '拖拽' : '选择';

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        display: block !important;
      }
      .optimizer-container {
        position: absolute;
        top: 20px;
        right: 20px;
        left: auto;
        z-index: 2147483647;
        pointer-events: auto;
        background: rgba(255, 255, 255, 0.96);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 16px;
        padding: 18px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
        width: 360px;
        max-width: min(360px, calc(100vw - 24px));
        max-height: calc(100vh - 40px);
        overflow: auto;
        animation: slideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        color: #1d1d1f;
        box-sizing: border-box;
      }
      @media (max-width: 420px) {
        .optimizer-container {
          top: 12px;
          right: 12px;
          left: 12px;
          width: auto;
          max-width: none;
        }
      }
      @keyframes slideIn {
        from { transform: translateX(40px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      .title {
        font-size: 15px;
        font-weight: 600;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding-right: 28px;
      }
      .subtitle {
        font-size: 12px;
        color: #86868b;
        margin-bottom: 10px;
        line-height: 1.45;
      }
      .meta {
        font-size: 11px;
        color: #aeaeb2;
        margin: -4px 0 12px;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 14px;
        max-height: 340px;
        overflow: auto;
        padding-right: 2px;
      }
      .card {
        border: 1px solid rgba(0,0,0,0.06);
        border-radius: 12px;
        padding: 10px;
        background: rgba(0,0,0,0.02);
      }
      .card.skipped { opacity: 0.55; }
      .card-top { display: flex; gap: 8px; align-items: center; }
      .thumbs { display: flex; gap: 6px; flex-shrink: 0; }
      .thumb-wrap {
        width: 56px;
        height: 56px;
        border-radius: 8px;
        overflow: hidden;
        background: #e8e8ed;
        position: relative;
        border: 1px solid rgba(0,0,0,0.05);
      }
      .thumb-wrap img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .thumb-wrap .tag {
        position: absolute;
        left: 3px;
        bottom: 3px;
        font-size: 9px;
        background: rgba(0,0,0,0.55);
        color: #fff;
        padding: 1px 4px;
        border-radius: 4px;
        line-height: 1.2;
      }
      .thumb-wrap.after .tag { background: rgba(52, 199, 89, 0.9); }
      .thumb-wrap.empty {
        display: flex;
        align-items: center;
        justify-content: center;
        color: #aeaeb2;
        font-size: 11px;
      }
      .info { flex: 1; min-width: 0; }
      .name {
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 4px;
      }
      .sizes {
        font-size: 11px;
        color: #86868b;
        line-height: 1.4;
        font-variant-numeric: tabular-nums;
      }
      .sizes .ok { color: #34c759; font-weight: 600; }
      .sizes .warn { color: #ff9f0a; font-weight: 600; }
      .card-actions { margin-top: 8px; display: flex; justify-content: flex-end; }
      .btn-skip-one {
        background: #fff;
        border: 1px solid rgba(0,0,0,0.08);
        color: #1d1d1f;
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 8px;
        cursor: pointer;
      }
      .btn-skip-one:hover { background: #f5f5f7; }
      .btn-skip-one.on {
        background: #fff4e5;
        border-color: #ffd59a;
        color: #b36b00;
      }
      .size-info {
        background: rgba(0, 0, 0, 0.03);
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 12px;
        display: none;
      }
      .size-row {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        margin-bottom: 4px;
      }
      .size-row:last-child { margin-bottom: 0; }
      .size-label { color: #86868b; }
      .size-value { font-weight: 500; font-variant-numeric: tabular-nums; }
      .savings { color: #34c759; font-weight: 600; }
      .warn { color: #ff9f0a; font-weight: 600; }
      .actions { display: flex; gap: 8px; }
      button.main {
        flex: 1;
        padding: 10px 12px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.18s ease;
        border: none;
        outline: none;
      }
      button.main:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        transform: none !important;
        box-shadow: none !important;
      }
      .btn-compress { background: #007aff; color: white; }
      .btn-compress:hover:not(:disabled) {
        background: #0071e3;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 122, 255, 0.24);
      }
      .btn-skip { background: #f5f5f7; color: #1d1d1f; }
      .btn-skip:hover:not(:disabled) { background: #e8e8ed; }
      .btn-confirm {
        display: none;
        background: #34c759;
        color: white;
        width: 100%;
      }
      .btn-confirm:hover:not(:disabled) { background: #28a745; }
      .loading {
        display: none;
        font-size: 12px;
        color: #007aff;
        margin-top: 10px;
        text-align: center;
        font-weight: 500;
      }
      .close {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: transparent;
        color: #86868b;
        font-size: 18px;
        line-height: 1;
        padding: 0;
        border: none;
        cursor: pointer;
      }
      .close:hover { background: rgba(0,0,0,0.05); color: #1d1d1f; }
      .wrap { position: relative; }
    `;

    const container = document.createElement('div');
    container.className = 'optimizer-container wrap';

    const listHtml = items
      .map(
        (it, idx) => `
      <div class="card" data-idx="${idx}">
        <div class="card-top">
          <div class="thumbs">
            <div class="thumb-wrap before">
              <img src="${it.previewUrl}" alt="before">
              <span class="tag">前</span>
            </div>
            <div class="thumb-wrap after empty" data-after="${idx}">后</div>
          </div>
          <div class="info">
            <div class="name" title="${escapeAttr(it.original.name)}">${escapeHtml(it.original.name)}</div>
            <div class="sizes" data-sizes="${idx}">
              原图 ${formatSize(it.original.size)}
            </div>
          </div>
        </div>
        <div class="card-actions">
          <button type="button" class="btn-skip-one" data-skip="${idx}">跳过此图</button>
        </div>
      </div>`
      )
      .join('');

    container.innerHTML = `
      <button class="close" type="button" title="关闭 (Esc)" aria-label="关闭">×</button>
      <div class="title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#007aff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        TD-东哥 Image Compress
      </div>
      <div class="subtitle">${sourceLabel}了 ${imageFiles.length} 张图片（${formatSize(totalOriginalSize)}）</div>
      <div class="meta">质量 ${Number(config.quality) || 80}% · 边 ${Number(config.maxEdge) || 1920}px · ${config.format || 'auto'}${otherCount > 0 ? ` · 另有 ${otherCount} 个非图片保留` : ''}</div>

      <div class="list" id="fileList">${listHtml}</div>

      <div class="size-info" id="sizeInfo">
        <div class="size-row">
          <span class="size-label">参与压缩</span>
          <span class="size-value" id="workCount">-</span>
        </div>
        <div class="size-row">
          <span class="size-label">原始 / 结果</span>
          <span class="size-value" id="sizeCompare">-</span>
        </div>
        <div class="size-row" style="margin-top: 6px; border-top: 1px solid rgba(0,0,0,0.05); padding-top: 6px;">
          <span class="size-label">节省空间</span>
          <span class="size-value savings" id="savings">-</span>
        </div>
      </div>

      <div class="actions" id="initialActions">
        <button class="main btn-skip" type="button">全部原图</button>
        <button class="main btn-compress" type="button">开始压缩</button>
      </div>

      <button class="main btn-confirm" id="confirmBtn" type="button">确认上传</button>
      <div class="loading" id="statusLabel">正在处理中...</div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(container);

    log('UI mounted');

    let busy = false;
    let compressedDone = false;

    const setBusy = (v) => {
      busy = v;
      shadow.querySelectorAll('button.main, .btn-skip-one').forEach((btn) => {
        btn.disabled = v;
      });
      const closeBtn = shadow.querySelector('.close');
      if (closeBtn) closeBtn.disabled = v;
    };

    const updateSkipUI = (idx) => {
      const it = items[idx];
      const card = shadow.querySelector(`.card[data-idx="${idx}"]`);
      const btn = shadow.querySelector(`[data-skip="${idx}"]`);
      if (!card || !btn) return;
      card.classList.toggle('skipped', it.skipped);
      btn.classList.toggle('on', it.skipped);
      btn.textContent = it.skipped ? '已跳过 · 点恢复' : '跳过此图';
    };

    shadow.querySelectorAll('[data-skip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (busy) return;
        const idx = Number(btn.getAttribute('data-skip'));
        items[idx].skipped = !items[idx].skipped;
        updateSkipUI(idx);
        if (compressedDone) refreshTotals();
      });
    });

    function refreshTotals() {
      let orig = 0;
      let result = 0;
      let work = 0;
      let skip = 0;
      items.forEach((it) => {
        if (it.skipped) {
          skip += 1;
          orig += it.original.size;
          result += it.original.size;
          return;
        }
        work += 1;
        orig += it.original.size;
        result += (it.compressed || it.original).size;
      });
      const saved = orig - result;
      const pct = orig ? Math.round((saved / orig) * 100) : 0;
      shadow.querySelector('#workCount').textContent = `${work} 张压缩 · ${skip} 张跳过`;
      shadow.querySelector('#sizeCompare').textContent = `${formatSize(orig)} → ${formatSize(result)}`;
      const savingsEl = shadow.querySelector('#savings');
      if (saved > 0) {
        savingsEl.className = 'size-value savings';
        savingsEl.textContent = `${formatSize(saved)} (${pct}%)`;
      } else {
        savingsEl.className = 'size-value warn';
        savingsEl.textContent = '几乎无收益';
      }
      shadow.querySelector('#sizeInfo').style.display = 'block';
    }

    shadow.querySelector('.close').onclick = () => {
      if (busy) return;
      revokePreviewUrls(items);
      dismissUI();
      activeSession = null;
    };

    shadow.querySelector('.btn-skip').onclick = () => {
      if (busy) return;
      revokePreviewUrls(items);
      commitFiles(allFiles);
    };

    shadow.querySelector('.btn-compress').onclick = async () => {
      if (busy) return;
      setBusy(true);
      shadow.querySelector('#initialActions').style.display = 'none';
      const status = shadow.querySelector('#statusLabel');
      status.style.display = 'block';

      const targets = items.map((it, idx) => ({ it, idx })).filter(({ it }) => !it.skipped);

      try {
        let done = 0;
        status.textContent = `正在处理 0/${targets.length || 1}...`;

        if (!targets.length) {
          status.textContent = '全部已跳过';
        } else {
          await mapPool(targets, 2, async ({ it, idx }) => {
            const out = await compressImage(it.original);
            it.compressed = out;
            if (it.afterUrl) URL.revokeObjectURL(it.afterUrl);
            it.afterUrl = URL.createObjectURL(out);

            const afterSlot = shadow.querySelector(`[data-after="${idx}"]`);
            if (afterSlot) {
              afterSlot.classList.remove('empty');
              afterSlot.innerHTML = `<img src="${it.afterUrl}" alt="after"><span class="tag">后</span>`;
            }

            const sizes = shadow.querySelector(`[data-sizes="${idx}"]`);
            if (sizes) {
              const saved = it.original.size - out.size;
              const pct = it.original.size ? Math.round((saved / it.original.size) * 100) : 0;
              if (saved > 0) {
                sizes.innerHTML = `${formatSize(it.original.size)} → <span class="ok">${formatSize(out.size)} (−${pct}%)</span>`;
              } else {
                sizes.innerHTML = `${formatSize(it.original.size)} → <span class="warn">${formatSize(out.size)}（保留）</span>`;
              }
            }

            done += 1;
            status.textContent = `正在处理 ${done}/${targets.length}...`;
          });
        }

        compressedDone = true;
        refreshTotals();
        status.style.display = 'none';
        shadow.querySelector('#confirmBtn').style.display = 'block';
      } catch (err) {
        console.error('[TD-ImageCompress] failed:', err);
        status.textContent = '处理失败，请重试或原图上传';
        shadow.querySelector('#initialActions').style.display = 'flex';
      } finally {
        setBusy(false);
      }
    };

    shadow.querySelector('#confirmBtn').onclick = () => {
      if (busy) return;

      const queue = items.map((it) => {
        if (it.skipped) return it.original;
        return it.compressed || it.original;
      });

      const merged = allFiles.map((f) => {
        if (isImageFile(f)) return queue.shift() || f;
        return f;
      });

      revokePreviewUrls(items);
      commitFiles(merged);
    };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
  }

  // 启动标记，便于控制台确认脚本已注入
  console.info('[TD-ImageCompress] content script ready', location.href);
})();
