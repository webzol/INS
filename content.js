(function () {
  'use strict';

  const DEFAULTS = {
    autoDetect: true,
    quality: 80,
    maxEdge: 1920,
    minSizeKB: 100,
    format: 'auto' // auto | webp | jpeg
  };

  /** @type {{ kind: 'input', input: HTMLInputElement } | { kind: 'drop', target: EventTarget, originalEvent: DragEvent } | null} */
  let activeSession = null;
  let activeRoot = null;
  let config = { ...DEFAULTS };
  let dropDepth = 0;

  chrome.storage.sync.get(Object.keys(DEFAULTS), (result) => {
    Object.keys(DEFAULTS).forEach((key) => {
      if (result[key] !== undefined) config[key] = result[key];
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    Object.keys(DEFAULTS).forEach((key) => {
      if (changes[key]) config[key] = changes[key].newValue;
    });
  });

  // ---------- helpers ----------

  function isImageFile(file) {
    return !!(file && file.type && file.type.startsWith('image/') && !file.type.includes('svg'));
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
    const minBytes = (Number(config.minSizeKB) || 0) * 1024;
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
        if (dt.types[i] === 'Files') return true;
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

      const maybeAlpha = /png|webp|gif/i.test(file.type);
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

  // ---------- file input intercept ----------

  document.addEventListener(
    'change',
    (event) => {
      if (!config.autoDetect) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== 'file') return;

      if (target.dataset.optimizerProcessed === 'true') {
        delete target.dataset.optimizerProcessed;
        return;
      }

      const allFiles = target.files ? Array.from(target.files) : [];
      if (!allFiles.length) return;

      const imageFiles = allFiles.filter(isImageFile);
      if (!shouldIntercept(imageFiles)) return;

      event.stopImmediatePropagation();
      event.preventDefault();

      activeSession = { kind: 'input', input: target };
      showOptimizerUI(imageFiles, allFiles);
    },
    true
  );

  // ---------- drag & drop intercept ----------

  let dropOverlay = null;

  function ensureDropOverlay() {
    if (dropOverlay) return dropOverlay;
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
    (e) => {
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
      // 必须 preventDefault 才能成为合法 drop 目标，并抢在站点之前
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
      if (!shouldIntercept(imageFiles)) return;

      // 拦截站点默认 drop 处理
      e.preventDefault();
      e.stopImmediatePropagation();

      activeSession = {
        kind: 'drop',
        target: e.target,
        originalEvent: e
      };
      showOptimizerUI(imageFiles, allFiles);
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

  // ---------- re-dispatch helpers ----------

  function passThroughInput(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.dataset.optimizerProcessed = 'true';
    try {
      input.files = dt.files;
    } catch (err) {
      console.error('[ImageCompress] assign files failed:', err);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function passThroughDrop(session, files) {
    const target = session.target;
    if (!(target instanceof Element)) return;

    // 找最近的可落点：优先 file input 所在表单/可拖放区
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
        // 部分环境 DataTransfer 只读，退回自定义事件携带 files
        ev = new CustomEvent(type, { bubbles: true, cancelable, detail: { files } });
      }
      // 再挂一层，便于调试/站点自定义读取
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
    const multi = files.length > 1;
    const acceptImages = (input) => {
      if (!(input instanceof HTMLInputElement) || input.type !== 'file') return false;
      if (input.disabled) return false;
      if (multi && !input.multiple && files.filter(isImageFile).length > 1) {
        // 仍可用，只是站点可能只取第一张
      }
      return true;
    };

    // 1) 目标自身或祖先内
    let el = fromEl;
    for (let i = 0; i < 8 && el; i++) {
      if (el instanceof HTMLInputElement && acceptImages(el)) return el;
      const found = el.querySelector && el.querySelector('input[type="file"]');
      if (found && acceptImages(found)) return found;
      el = el.parentElement;
    }

    // 2) 页面上唯一可见的 file input
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

    const root = document.createElement('div');
    root.id = 'image-optimizer-root';
    root._items = items;
    activeRoot = root;
    const shadow = root.attachShadow({ mode: 'open' });

    const totalOriginalSize = imageFiles.reduce((acc, f) => acc + f.size, 0);
    const otherCount = allFiles.length - imageFiles.length;
    const sourceLabel = activeSession?.kind === 'drop' ? '拖拽' : '选择';

    const style = document.createElement('style');
    style.textContent = `
      .optimizer-container {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        background: rgba(255, 255, 255, 0.94);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(0, 0, 0, 0.06);
        border-radius: 16px;
        padding: 18px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.14);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
        width: 360px;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 40px);
        overflow: auto;
        animation: slideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        color: #1d1d1f;
        box-sizing: border-box;
      }
      @keyframes slideIn {
        from { transform: translateX(120%); opacity: 0; }
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
      .card.skipped {
        opacity: 0.55;
      }
      .card-top {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .thumbs {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }
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
      .info {
        flex: 1;
        min-width: 0;
      }
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
      .card-actions {
        margin-top: 8px;
        display: flex;
        justify-content: flex-end;
      }
      .btn-skip-one {
        border: none;
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
    (document.documentElement || document.body).appendChild(root);

    let busy = false;
    let compressedDone = false;

    const setBusy = (v) => {
      busy = v;
      shadow.querySelectorAll('button.main, .btn-skip-one').forEach((btn) => {
        btn.disabled = v;
      });
      shadow.querySelector('.close').disabled = v;
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

      const targets = items
        .map((it, idx) => ({ it, idx }))
        .filter(({ it }) => !it.skipped);

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
        console.error('[ImageCompress] failed:', err);
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
})();
