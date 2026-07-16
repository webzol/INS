(function () {
  'use strict';

  const DEFAULTS = {
    autoDetect: true,
    quality: 80,
    maxEdge: 1920,
    minSizeKB: 100,
    format: 'auto' // auto | webp | jpeg
  };

  let activeInput = null;
  let activeRoot = null;
  let config = { ...DEFAULTS };

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

      const imageFiles = allFiles.filter((f) => f.type.startsWith('image/') && !f.type.includes('svg'));
      if (!imageFiles.length) return;

      const minBytes = (Number(config.minSizeKB) || 0) * 1024;
      const needWork = imageFiles.some((f) => f.size >= minBytes);
      if (!needWork) return;

      event.stopImmediatePropagation();
      event.preventDefault();

      activeInput = target;
      showOptimizerUI(imageFiles, allFiles);
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeRoot) {
      dismissUI();
    }
  });

  function dismissUI() {
    if (activeRoot) {
      activeRoot.remove();
      activeRoot = null;
    }
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
        /* fallback below */
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
          /* unsupported mime in this browser */
        }
      };

      if (format === 'jpeg') {
        await pushCandidate('image/jpeg', '.jpg', q);
      } else if (format === 'webp') {
        await pushCandidate('image/webp', '.webp', q);
        if (!candidates.length) await pushCandidate('image/jpeg', '.jpg', q);
      } else {
        // auto: try webp + jpeg, keep png if alpha and still smallest-ish
        await pushCandidate('image/webp', '.webp', q);
        await pushCandidate('image/jpeg', '.jpg', q);
        if (maybeAlpha) await pushCandidate('image/png', '.png');
      }

      if (!candidates.length) return file;

      candidates.sort((a, b) => a.blob.size - b.blob.size);
      const best = candidates[0];

      // 压缩后几乎没变小则保留原图，避免白白改格式
      if (best.blob.size >= file.size * 0.97) {
        return file;
      }

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

  function showOptimizerUI(imageFiles, allFiles) {
    dismissUI();

    const root = document.createElement('div');
    root.id = 'image-optimizer-root';
    activeRoot = root;
    const shadow = root.attachShadow({ mode: 'open' });

    const totalOriginalSize = imageFiles.reduce((acc, f) => acc + f.size, 0);
    const otherCount = allFiles.length - imageFiles.length;

    const style = document.createElement('style');
    style.textContent = `
      .optimizer-container {
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 2147483647;
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(0, 0, 0, 0.06);
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.14);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
        width: 320px;
        max-width: calc(100vw - 32px);
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
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .subtitle {
        font-size: 13px;
        color: #86868b;
        margin-bottom: 16px;
        line-height: 1.45;
      }
      .meta {
        font-size: 11px;
        color: #aeaeb2;
        margin: -8px 0 16px;
      }
      .size-info {
        background: rgba(0, 0, 0, 0.03);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 16px;
        display: none;
      }
      .size-row {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        margin-bottom: 6px;
      }
      .size-row:last-child { margin-bottom: 0; }
      .size-label { color: #86868b; }
      .size-value { font-weight: 500; font-variant-numeric: tabular-nums; }
      .savings { color: #34c759; font-weight: 600; }
      .warn { color: #ff9f0a; font-weight: 600; }
      .actions { display: flex; gap: 10px; }
      button {
        flex: 1;
        padding: 10px 14px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.18s ease;
        border: none;
        outline: none;
      }
      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        transform: none !important;
        box-shadow: none !important;
      }
      .btn-compress {
        background: #007aff;
        color: white;
      }
      .btn-compress:hover:not(:disabled) {
        background: #0071e3;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 122, 255, 0.24);
      }
      .btn-skip {
        background: #f5f5f7;
        color: #1d1d1f;
      }
      .btn-skip:hover:not(:disabled) { background: #e8e8ed; }
      .btn-confirm {
        display: none;
        background: #34c759;
        color: white;
        width: 100%;
        margin-top: 0;
      }
      .btn-confirm:hover:not(:disabled) {
        background: #28a745;
      }
      .loading {
        display: none;
        font-size: 13px;
        color: #007aff;
        margin-top: 12px;
        text-align: center;
        font-weight: 500;
      }
      .close {
        position: absolute;
        top: 10px;
        right: 12px;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: transparent;
        color: #86868b;
        font-size: 18px;
        line-height: 1;
        padding: 0;
        flex: none;
      }
      .close:hover { background: rgba(0,0,0,0.05); color: #1d1d1f; }
      .wrap { position: relative; }
    `;

    const container = document.createElement('div');
    container.className = 'optimizer-container wrap';
    container.innerHTML = `
      <button class="close" type="button" title="关闭 (Esc)" aria-label="关闭">×</button>
      <div class="title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#007aff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        TD-东哥 Image Compress
      </div>
      <div class="subtitle">检测到 ${imageFiles.length} 张图片（${formatSize(totalOriginalSize)}），是否压缩后上传？</div>
      <div class="meta">质量 ${Number(config.quality) || 80}% · 最大边 ${Number(config.maxEdge) || 1920}px · 格式 ${config.format || 'auto'}${otherCount > 0 ? ` · 另有 ${otherCount} 个非图片文件将原样保留` : ''}</div>

      <div class="size-info" id="sizeInfo">
        <div class="size-row">
          <span class="size-label">原始大小</span>
          <span class="size-value" id="oldSize">-</span>
        </div>
        <div class="size-row">
          <span class="size-label">压缩后</span>
          <span class="size-value" id="newSize">-</span>
        </div>
        <div class="size-row" style="margin-top: 8px; border-top: 1px solid rgba(0,0,0,0.05); padding-top: 8px;">
          <span class="size-label">节省空间</span>
          <span class="size-value savings" id="savings">-</span>
        </div>
      </div>

      <div class="actions" id="initialActions">
        <button class="btn-skip" type="button">原图上传</button>
        <button class="btn-compress" type="button">开始压缩</button>
      </div>

      <button class="btn-confirm" id="confirmBtn" type="button">确认上传</button>
      <div class="loading" id="statusLabel">正在处理中...</div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(container);
    (document.documentElement || document.body).appendChild(root);

    let compressedImages = null;
    let busy = false;

    const setBusy = (v) => {
      busy = v;
      shadow.querySelectorAll('button').forEach((btn) => {
        if (btn.classList.contains('close')) return;
        btn.disabled = v;
      });
    };

    const passThrough = (filesToSet) => {
      if (!activeInput) return;
      const dt = new DataTransfer();
      filesToSet.forEach((f) => dt.items.add(f));
      activeInput.dataset.optimizerProcessed = 'true';
      try {
        activeInput.files = dt.files;
      } catch (err) {
        console.error('[ImageCompress] assign files failed:', err);
      }
      activeInput.dispatchEvent(new Event('change', { bubbles: true }));
      dismissUI();
      activeInput = null;
    };

    shadow.querySelector('.close').onclick = () => {
      if (busy) return;
      dismissUI();
      activeInput = null;
    };

    shadow.querySelector('.btn-skip').onclick = () => {
      if (busy) return;
      passThrough(allFiles);
    };

    shadow.querySelector('.btn-compress').onclick = async () => {
      if (busy) return;
      setBusy(true);
      shadow.querySelector('#initialActions').style.display = 'none';
      const status = shadow.querySelector('#statusLabel');
      status.style.display = 'block';
      status.textContent = `正在处理 0/${imageFiles.length}...`;

      try {
        let done = 0;
        const results = await mapPool(imageFiles, 2, async (file) => {
          const out = await compressImage(file);
          done += 1;
          status.textContent = `正在处理 ${done}/${imageFiles.length}...`;
          return out;
        });

        const totalCompressedSize = results.reduce((acc, f) => acc + f.size, 0);
        const saved = totalOriginalSize - totalCompressedSize;
        const savingsPercent = totalOriginalSize
          ? Math.round((saved / totalOriginalSize) * 100)
          : 0;

        shadow.querySelector('#oldSize').textContent = formatSize(totalOriginalSize);
        shadow.querySelector('#newSize').textContent = formatSize(totalCompressedSize);
        const savingsEl = shadow.querySelector('#savings');
        if (saved > 0) {
          savingsEl.className = 'size-value savings';
          savingsEl.textContent = `${formatSize(saved)} (${savingsPercent}%)`;
        } else {
          savingsEl.className = 'size-value warn';
          savingsEl.textContent = '几乎无收益，可原图上传';
        }

        shadow.querySelector('#sizeInfo').style.display = 'block';
        status.style.display = 'none';
        shadow.querySelector('#confirmBtn').style.display = 'block';
        compressedImages = results;
      } catch (err) {
        console.error('[ImageCompress] failed:', err);
        status.textContent = '处理失败，请重试或原图上传';
        shadow.querySelector('#initialActions').style.display = 'flex';
      } finally {
        setBusy(false);
      }
    };

    shadow.querySelector('#confirmBtn').onclick = () => {
      if (busy || !compressedImages) return;

      // 保持原多选顺序：图片替换为压缩结果，非图片原样保留
      const queue = compressedImages.slice();
      const merged = allFiles.map((f) => {
        if (f.type.startsWith('image/') && !f.type.includes('svg')) {
          return queue.shift() || f;
        }
        return f;
      });

      passThrough(merged);
    };
  }
})();
