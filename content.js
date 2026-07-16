(function() {
  let activeInput = null;       // 点选场景：触发的 <input type=file>
  let activeDrop = null;        // 拖拽场景：{ target, originalEvent }
  let dropOverlay = null;       // 拖拽提示遮罩
  let dropDepth = 0;            // dragenter/leave 计数，避免进出子元素时遮罩闪烁
  let config = { autoDetect: true, autoCrop: true, quality: 80 };

  chrome.storage.sync.get(['autoDetect', 'autoCrop', 'quality'], (result) => {
    if (result.autoDetect !== undefined) config.autoDetect = result.autoDetect;
    if (result.autoCrop !== undefined) config.autoCrop = result.autoCrop;
    if (result.quality !== undefined) config.quality = result.quality;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.autoDetect) config.autoDetect = changes.autoDetect.newValue;
    if (changes.autoCrop) config.autoCrop = changes.autoCrop.newValue;
    if (changes.quality) config.quality = changes.quality.newValue;
  });

  document.addEventListener('change', (event) => {
    if (!config.autoDetect) return;
    const target = event.target;
    if (target.tagName === 'INPUT' && target.type === 'file') {
      if (target.dataset.optimizerProcessed === 'true') {
        delete target.dataset.optimizerProcessed;
        return;
      }
      const files = target.files;
      if (!files || files.length === 0) return;
      const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      activeInput = target;
      activeDrop = null;
      showOptimizerUI(imageFiles);
    }
  }, true);

  /* ========== Drag & Drop Upload ========== */

  function dataTransferHasFiles(dt) {
    if (!dt) return false;
    if (dt.types) {
      for (let i = 0; i < dt.types.length; i++) {
        if (String(dt.types[i]).toLowerCase() === 'files') return true;
      }
    }
    return !!(dt.files && dt.files.length);
  }

  function filesFromDataTransfer(dt) {
    if (!dt) return [];
    if (dt.files && dt.files.length) return Array.from(dt.files);
    const out = [];
    if (dt.items) {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  function ensureDropOverlay() {
    if (dropOverlay && document.contains(dropOverlay)) return dropOverlay;
    const el = document.createElement('div');
    el.id = 'image-optimizer-drop-overlay';
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '2147483645',
      pointerEvents: 'none', display: 'none',
      alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,122,255,0.12)', border: '3px dashed rgba(0,122,255,0.55)',
      boxSizing: 'border-box',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      color: '#007aff', fontSize: '18px', fontWeight: '600'
    });
    el.textContent = '松开鼠标将智能裁剪 / 压缩图片';
    (document.body || document.documentElement).appendChild(el);
    dropOverlay = el;
    return el;
  }
  function showDropOverlay() { ensureDropOverlay().style.display = 'flex'; }
  function hideDropOverlay() {
    dropDepth = 0;
    if (dropOverlay) dropOverlay.style.display = 'none';
  }

  document.addEventListener('dragenter', (e) => {
    if (!config.autoDetect || !dataTransferHasFiles(e.dataTransfer)) return;
    dropDepth += 1;
    showDropOverlay();
  }, true);

  document.addEventListener('dragleave', () => {
    if (!config.autoDetect) return;
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) hideDropOverlay();
  }, true);

  document.addEventListener('dragover', (e) => {
    if (!config.autoDetect || !dataTransferHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    showDropOverlay();
  }, true);

  document.addEventListener('drop', (e) => {
    hideDropOverlay();
    if (!config.autoDetect) return;
    // 跳过我们在「确认上传」时重派的 drop（isTrusted=false）
    if (e.isTrusted === false) return;
    const dropFiles = filesFromDataTransfer(e.dataTransfer);
    if (!dropFiles.length) return;
    const imageFiles = dropFiles.filter((f) => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    activeInput = null;
    activeDrop = { target: e.target, originalEvent: e };
    showOptimizerUI(imageFiles);
  }, true);

  function findNearbyFileInput(fromEl) {
    const ok = (el) => el instanceof HTMLInputElement && el.type === 'file' && !el.disabled;
    let el = fromEl;
    for (let i = 0; i < 8 && el; i++) {
      if (ok(el)) return el;
      const f = el.querySelector && el.querySelector('input[type="file"]');
      if (f && ok(f)) return f;
      el = el.parentElement;
    }
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(ok);
    return inputs.length === 1 ? inputs[0] : null;
  }

  function redispatchDrop(target, dt, originalEvent) {
    const fire = (type, cancelable) => {
      let ev;
      try {
        ev = new DragEvent(type, {
          bubbles: true, cancelable, dataTransfer: dt,
          clientX: (originalEvent && originalEvent.clientX) || 0,
          clientY: (originalEvent && originalEvent.clientY) || 0
        });
      } catch (_) {
        ev = new CustomEvent(type, { bubbles: true, cancelable, detail: { files: dt.files } });
      }
      try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch (_) {}
      target.dispatchEvent(ev);
    };
    fire('dragenter', true);
    fire('dragover', true);
    fire('drop', true);
  }

  // 把处理结果交还给网站：点选写回 input；拖拽优先写回附近 input，否则重派 drop
  function commitToSite(files) {
    if (activeInput) {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      activeInput.dataset.optimizerProcessed = 'true';
      activeInput.files = dt.files;
      activeInput.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (activeDrop) {
      const nearby = findNearbyFileInput(activeDrop.target);
      if (nearby) {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        nearby.dataset.optimizerProcessed = 'true';
        nearby.files = dt.files;
        nearby.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      redispatchDrop(activeDrop.target, dt, activeDrop.originalEvent);
    }
  }

  // 取消：关闭弹层，不向网站回交任何文件
  function closeUI() {
    const existing = document.getElementById('image-optimizer-root');
    if (existing) existing.remove();
    const editor = document.getElementById('crop-editor-root');
    if (editor) editor.remove();
    activeInput = null;
    activeDrop = null;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 编辑器打开时,Esc 由编辑器自己处理(取消),避免连浮层面板一起关掉、Promise 悬空
    if (document.getElementById('crop-editor-root')) return;
    closeUI();
  }, true);

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /* ========== Floating Panel ========== */

  function showOptimizerUI(files) {
    const existing = document.getElementById('image-optimizer-root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = 'image-optimizer-root';
    const shadow = root.attachShadow({ mode: 'open' });

    const container = document.createElement('div');
    container.className = 'optimizer-container';
    const totalOriginalSize = files.reduce((a, f) => a + f.size, 0);

    const style = document.createElement('style');
    style.textContent = `
      .optimizer-container {
        position: fixed; top: 24px; right: 24px; z-index: 2147483646;
        background: rgba(255,255,255,0.92);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        border: 1px solid rgba(255,255,255,0.4);
        border-radius: 16px; padding: 20px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.14);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
        width: 320px;
        animation: slideIn 0.4s cubic-bezier(0.16,1,0.3,1);
        color: #1d1d1f;
      }
      @keyframes slideIn {
        from { transform: translateX(120%); opacity: 0; }
        to   { transform: translateX(0);    opacity: 1; }
      }
      .title { font-size: 15px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
      .subtitle { font-size: 13px; color: #86868b; margin-bottom: 16px; line-height: 1.4; }

      .option-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; background: rgba(0,0,0,0.03);
        border-radius: 10px; margin-bottom: 8px;
      }
      .option-label { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; }
      .option-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; letter-spacing: 0.3px; }
      .badge-crop { background: rgba(255,149,0,0.12); color: #ff9500; }
      .badge-compress { background: rgba(0,122,255,0.12); color: #007aff; }

      .toggle { position: relative; width: 40px; height: 22px; cursor: pointer; }
      .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
      .toggle-track {
        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        background: #d1d1d6; border-radius: 22px; transition: background 0.25s;
      }
      .toggle-track::after {
        content: ''; position: absolute; width: 16px; height: 16px;
        left: 3px; top: 3px; background: white; border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0,0,0,0.15); transition: transform 0.25s;
      }
      .toggle input:checked + .toggle-track { background: #007aff; }
      .toggle input:checked + .toggle-track::after { transform: translateX(18px); }

      .size-info { background: rgba(0,0,0,0.03); border-radius: 10px; padding: 12px; margin-top: 16px; margin-bottom: 16px; display: none; }
      .size-row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; }
      .size-row:last-child { margin-bottom: 0; }
      .size-label { color: #86868b; }
      .size-value { font-weight: 500; font-variant-numeric: tabular-nums; }
      .savings { color: #34c759; font-weight: 600; }

      .preview-area { margin-top: 12px; display: none; }
      .preview-label { font-size: 11px; color: #86868b; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
      .preview-grid { display: flex; gap: 8px; align-items: flex-start; }
      .preview-box { flex: 1; text-align: center; }
      .preview-box img { width: 100%; max-width: 120px; aspect-ratio: 1; object-fit: cover; border-radius: 8px; border: 1px solid rgba(0,0,0,0.06); }
      .preview-box .p-label { font-size: 10px; color: #86868b; margin-top: 4px; }
      .preview-arrow { display: flex; align-items: center; color: #86868b; font-size: 14px; padding-top: 30px; }

      .actions { display: flex; gap: 10px; margin-top: 16px; }
      button {
        flex: 1; padding: 10px 16px; border-radius: 10px;
        font-size: 13px; font-weight: 500; cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4,0,0.2,1);
        border: none; outline: none;
      }
      .btn-process { background: #007aff; color: white; }
      .btn-process:hover { background: #0071e3; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,122,255,0.24); }
      .btn-skip { background: #f5f5f7; color: #1d1d1f; }
      .btn-skip:hover { background: #e8e8ed; }
      .btn-confirm { display: none; background: #34c759; color: white; width: 100%; }
      .btn-confirm:hover { background: #28a745; }
      .loading { display: none; font-size: 13px; color: #007aff; margin-top: 12px; text-align: center; font-weight: 500; }
      .close { position: absolute; top: 12px; right: 12px; width: 26px; height: 26px; border-radius: 8px; background: transparent; color: #86868b; font-size: 18px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; flex: none !important; padding: 0; border: none; }
      .close:hover { background: rgba(0,0,0,0.06); color: #1d1d1f; }
    `;

    container.innerHTML = `
      <button class="close" title="取消 / 关闭 (Esc)" aria-label="关闭">×</button>
      <div class="title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#007aff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        TD-东哥 Image Tool
      </div>
      <div class="subtitle">检测到 ${files.length} 张图片 (${formatSize(totalOriginalSize)})</div>

      <div class="option-row">
        <div class="option-label"><span class="option-badge badge-crop">裁</span>裁剪 / 旋转 / 翻转</div>
        <label class="toggle"><input type="checkbox" id="optCrop" ${config.autoCrop ? 'checked' : ''}><span class="toggle-track"></span></label>
      </div>
      <div class="option-row">
        <div class="option-label"><span class="option-badge badge-compress">Q</span>压缩图片</div>
        <label class="toggle"><input type="checkbox" id="optCompress" checked><span class="toggle-track"></span></label>
      </div>

      <div class="preview-area" id="previewArea">
        <div class="preview-label">预览对比</div>
        <div class="preview-grid">
          <div class="preview-box"><img id="previewOriginal" src="" alt="原图"><div class="p-label">原图</div></div>
          <div class="preview-arrow">→</div>
          <div class="preview-box"><img id="previewResult" src="" alt="处理后"><div class="p-label" id="previewResultLabel">处理后</div></div>
        </div>
      </div>

      <div class="size-info" id="sizeInfo">
        <div class="size-row"><span class="size-label">原始大小</span><span class="size-value" id="oldSize">-</span></div>
        <div class="size-row"><span class="size-label">处理后</span><span class="size-value" id="newSize">-</span></div>
        <div class="size-row" style="margin-top:8px;border-top:1px solid rgba(0,0,0,0.05);padding-top:8px;">
          <span class="size-label">节省空间</span><span class="size-value savings" id="savings">-</span>
        </div>
      </div>

      <div class="actions" id="initialActions">
        <button class="btn-skip">原图上传</button>
        <button class="btn-process">开始处理</button>
      </div>
      <button class="btn-confirm" id="confirmBtn">确认上传</button>
      <div class="loading" id="statusLabel">正在处理中...</div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(container);
    document.body.appendChild(root);

    let processedFilesResult = null;

    shadow.querySelector('.close').onclick = () => closeUI();

    shadow.querySelector('.btn-skip').onclick = () => {
      // 原图上传：拖拽场景也要能把原图交还给网站
      commitToSite(files);
      closeUI();
    };

    shadow.querySelector('.btn-process').onclick = async () => {
      const doCrop = shadow.querySelector('#optCrop').checked;
      const doCompress = shadow.querySelector('#optCompress').checked;
      if (!doCrop && !doCompress) return;

      shadow.querySelector('#initialActions').style.display = 'none';
      shadow.querySelector('#statusLabel').style.display = 'block';
      shadow.querySelector('#statusLabel').textContent = '正在处理中...';

      try {
        let edits = [];
        if (doCrop) {
          for (let i = 0; i < files.length; i++) {
            const edit = await showImageEditor(files[i], i, files.length);
            if (edit === null) {
              shadow.querySelector('#initialActions').style.display = 'flex';
              shadow.querySelector('#statusLabel').style.display = 'none';
              return;
            }
            edits.push(edit);
          }
        }

        const results = [];
        for (let i = 0; i < files.length; i++) {
          results.push(await processImage(files[i], doCrop ? edits[i] : null, doCompress));
        }

        const totalResult = results.reduce((a, f) => a + f.size, 0);
        const pct = Math.round((1 - totalResult / totalOriginalSize) * 100);
        shadow.querySelector('#oldSize').textContent = formatSize(totalOriginalSize);
        shadow.querySelector('#newSize').textContent = formatSize(totalResult);
        shadow.querySelector('#savings').textContent = formatSize(totalOriginalSize - totalResult) + ' (' + pct + '%)';

        shadow.querySelector('#sizeInfo').style.display = 'block';
        shadow.querySelector('#statusLabel').style.display = 'none';
        shadow.querySelector('#confirmBtn').style.display = 'block';
        processedFilesResult = results;

        if (files.length > 0) showPreview(shadow, files[0], doCrop ? edits[0] : null, doCompress);
      } catch (err) {
        console.error('Processing failed:', err);
        shadow.querySelector('#statusLabel').textContent = '处理失败，请重试';
        setTimeout(() => root.remove(), 2000);
      }
    };

    shadow.querySelector('#confirmBtn').onclick = () => {
      if (!processedFilesResult) return;
      commitToSite(processedFilesResult);
      closeUI();
    };
  }

  /* ========== Image Editor ========== */

  function showImageEditor(file, index, total) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => buildEditor(img, index, total, resolve);
        img.onerror = () => resolve({ rotation: 0, flipH: false, flipV: false, crop: null });
        img.src = ev.target.result;
      };
      reader.onerror = () => resolve({ rotation: 0, flipH: false, flipV: false, crop: null });
      reader.readAsDataURL(file);
    });
  }

  function buildEditor(imgObj, index, total, resolve) {
    const editorRoot = document.createElement('div');
    editorRoot.id = 'crop-editor-root';
    const shadow = editorRoot.attachShadow({ mode: 'open' });

    const OW = imgObj.naturalWidth, OH = imgObj.naturalHeight;
    const MIN = 30, SNAP_PX = 6;
    const RATIOS = [
      { mode: 'free', label: '自由', value: 0 },
      { mode: '1:1', label: '1:1', value: 1 },
      { mode: '4:3', label: '4:3', value: 4 / 3 },
      { mode: '3:4', label: '3:4', value: 3 / 4 },
      { mode: '16:9', label: '16:9', value: 16 / 9 },
      { mode: '9:16', label: '9:16', value: 9 / 16 },
      { mode: '2.35:1', label: '2.35:1', value: 2.35 },
    ];

    let state = {
      rotation: 0, flipH: false, flipV: false,
      ratioMode: 'free', ratioValue: 0,
      selX: 0, selY: 0, selW: 0, selH: 0,
      snap: true,
    };
    let tW = OW, tH = OH, dw = 0, dh = 0, s = 1, transformedSrc = '';
    let undoStack = [], redoStack = [];

    const headerH = 44, topbarH = 44, bottombarH = 46, footerH = 60, pad = 24;

    /* ----- geometry ----- */
    function computeFit() {
      const vw = window.innerWidth, vh = window.innerHeight;
      const maxW = Math.max(80, vw - pad * 2);
      const maxH = Math.max(80, vh - headerH - topbarH - bottombarH - footerH - pad * 2);
      const r = tW / tH;
      if (tW / maxW > tH / maxH) { dw = Math.min(tW, maxW); dh = dw / r; }
      else { dh = Math.min(tH, maxH); dw = dh * r; }
      dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
      s = tW / dw;
    }
    function renderTransformed() {
      const d = transformedDims(OW, OH, state.rotation);
      tW = d.tW; tH = d.tH;
      const cap = 1600;
      const scale = Math.min(1, cap / Math.max(tW, tH));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(tW * scale));
      c.height = Math.max(1, Math.round(tH * scale));
      applyTransform(c.getContext('2d'), imgObj, state.rotation, state.flipH, state.flipV);
      transformedSrc = c.toDataURL('image/jpeg', 0.92);
    }
    function fitSelection() {
      let w, h;
      if (state.ratioValue > 0) {
        if (dw / dh > state.ratioValue) { h = dh; w = h * state.ratioValue; }
        else { w = dw; h = w / state.ratioValue; }
      } else { w = dw; h = dh; }
      state.selW = Math.round(w); state.selH = Math.round(h);
      state.selX = Math.round((dw - state.selW) / 2);
      state.selY = Math.round((dh - state.selH) / 2);
    }
    function clampSel() {
      state.selW = Math.max(MIN, Math.min(state.selW, dw));
      state.selH = Math.max(MIN, Math.min(state.selH, dh));
      state.selX = Math.max(0, Math.min(state.selX, dw - state.selW));
      state.selY = Math.max(0, Math.min(state.selY, dh - state.selH));
    }
    function centerSel() {
      state.selX = Math.round((dw - state.selW) / 2);
      state.selY = Math.round((dh - state.selH) / 2);
      clampSel();
    }

    /* ----- history ----- */
    function snapshot() {
      const st = state;
      return { rotation: st.rotation, flipH: st.flipH, flipV: st.flipV,
        ratioMode: st.ratioMode, ratioValue: st.ratioValue,
        selX: st.selX, selY: st.selY, selW: st.selW, selH: st.selH };
    }
    function pushHistory() { undoStack.push(snapshot()); redoStack = []; refreshUndoRedo(); }
    function applySnapshot(snap) { Object.assign(state, snap); }
    function refreshUndoRedo() {
      shadow.querySelector('[data-act=undo]').disabled = undoStack.length === 0;
      shadow.querySelector('[data-act=redo]').disabled = redoStack.length === 0;
    }
    function doUndoRedo(fromStack, toStack) {
      if (!fromStack.length) return;
      toStack.push(snapshot());
      applySnapshot(fromStack.pop());
      syncImage(); updateRatioUI(); clampSel(); updateSel();
      refreshUndoRedo();
    }

    /* ----- DOM ----- */
    const style = document.createElement('style');
    style.textContent = `
      *{box-sizing:border-box;margin:0;padding:0}
      .backdrop{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.9);display:flex;flex-direction:column;align-items:center;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:#fff;animation:fadeIn .2s ease}
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
      .header{height:${headerH}px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:#fff;flex-shrink:0;gap:8px;position:relative;z-index:3}
      .header .cnt{color:rgba(255,255,255,.5);font-weight:500;font-size:12px}
      .topbar{height:${topbarH}px;display:flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;flex-wrap:wrap;padding:0 12px;position:relative;z-index:3}
      .pchip{padding:5px 10px;border-radius:14px;font-size:12px;font-weight:500;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;border:1px solid transparent;white-space:nowrap}
      .pchip:hover{background:rgba(255,255,255,.18)}
      .pchip.active{background:#007aff;border-color:#007aff}
      .pchip.custom{display:inline-flex;align-items:center;gap:4px}
      .pchip input{width:32px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;text-align:center;font-size:12px;padding:2px 0}
      .pchip input:focus{outline:none;border-color:#007aff}
      .pchip .apply{font-size:11px;padding:2px 7px;background:#007aff;border-radius:6px;cursor:pointer}
      .body{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;width:100%}
      .wrap{position:relative;user-select:none;touch-action:none}
      .wrap img{display:block;width:100%;height:100%;pointer-events:none}
      .sel{position:absolute;box-shadow:0 0 0 9999px rgba(0,0,0,.5);border:2px solid rgba(255,255,255,.9);cursor:move;touch-action:none}
      .handle{position:absolute;width:14px;height:14px;background:#fff;border:2px solid #007aff;border-radius:2px;z-index:2}
      .handle.nw{top:-7px;left:-7px;cursor:nw-resize}.handle.ne{top:-7px;right:-7px;cursor:ne-resize}
      .handle.sw{bottom:-7px;left:-7px;cursor:sw-resize}.handle.se{bottom:-7px;right:-7px;cursor:se-resize}
      .handle.n{top:-7px;left:50%;margin-left:-7px;cursor:ns-resize}.handle.s{bottom:-7px;left:50%;margin-left:-7px;cursor:ns-resize}
      .handle.w{top:50%;left:-7px;margin-top:-7px;cursor:ew-resize}.handle.e{top:50%;right:-7px;margin-top:-7px;cursor:ew-resize}
      .hint{position:absolute;bottom:-24px;left:50%;transform:translateX(-50%);font-size:11px;color:#fff;white-space:nowrap;pointer-events:none;background:rgba(0,0,0,.5);padding:2px 8px;border-radius:8px}
      .grid-h,.grid-v{position:absolute;background:rgba(255,255,255,.18);pointer-events:none;z-index:1}
      .grid-h{left:0;right:0;height:1px}.grid-v{top:0;bottom:0;width:1px}
      .guide-v,.guide-h{position:absolute;background:#ff3b30;pointer-events:none;display:none;z-index:3}
      .guide-v{top:0;bottom:0;width:1px}.guide-h{left:0;right:0;height:1px}
      .bottombar{height:${bottombarH}px;display:flex;align-items:center;justify-content:center;gap:6px;flex-shrink:0;flex-wrap:wrap;padding:0 8px;position:relative;z-index:3}
      .tbtn{display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:34px;padding:0 9px;border-radius:9px;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;border:none;font-size:12px;gap:4px}
      .tbtn:hover:not(:disabled){background:rgba(255,255,255,.2)}
      .tbtn:disabled{opacity:.35;cursor:default}
      .tbtn.on{background:#007aff}
      .sep{width:1px;height:20px;background:rgba(255,255,255,.15);margin:0 2px}
      .footer{height:${footerH}px;display:flex;align-items:center;justify-content:center;gap:12px;flex-shrink:0;position:relative;z-index:3}
      .footer button{padding:10px 30px;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;border:none;outline:none;transition:all .15s}
      .btn-c{background:rgba(255,255,255,.12);color:#fff}.btn-c:hover{background:rgba(255,255,255,.22)}
      .btn-ok{background:#007aff;color:#fff}.btn-ok:hover{background:#0066d6;transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,122,255,.35)}
    `;

    const label = total > 1 ? ` <span class="cnt">(${index + 1}/${total})</span>` : '';
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.innerHTML = `
      <div class="header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
        编辑图片${label}
      </div>
      <div class="topbar">
        ${RATIOS.map(r => `<span class="pchip" data-ratio="${r.mode}" data-value="${r.value}">${r.label}</span>`).join('')}
        <span class="pchip custom" data-ratio="custom">自定义
          <input id="cw" type="number" min="1" max="999" value="4">:<input id="ch" type="number" min="1" max="999" value="3">
          <span class="apply" id="capply">应用</span>
        </span>
      </div>
      <div class="body"><div class="wrap" id="wrap">
        <img id="img" src="">
        <div class="guide-v" id="gv"></div>
        <div class="guide-h" id="gh"></div>
        <div class="sel" id="sel">
          <div class="handle nw" data-d="nw"></div><div class="handle ne" data-d="ne"></div>
          <div class="handle sw" data-d="sw"></div><div class="handle se" data-d="se"></div>
          <div class="handle n" data-d="n"></div><div class="handle s" data-d="s"></div>
          <div class="handle w" data-d="w"></div><div class="handle e" data-d="e"></div>
          <div class="grid-h" style="top:33.33%"></div><div class="grid-h" style="top:66.66%"></div>
          <div class="grid-v" style="left:33.33%"></div><div class="grid-v" style="left:66.66%"></div>
          <div class="hint" id="hint"></div>
        </div>
      </div></div>
      <div class="bottombar">
        <button class="tbtn" data-act="rotL" title="逆时针 90°">↺90</button>
        <button class="tbtn" data-act="rotR" title="顺时针 90°">↻90</button>
        <button class="tbtn" data-act="rot180" title="旋转 180°">180°</button>
        <span class="sep"></span>
        <button class="tbtn" data-act="flipH" title="水平翻转">⇄ 翻H</button>
        <button class="tbtn" data-act="flipV" title="垂直翻转">↕ 翻V</button>
        <span class="sep"></span>
        <button class="tbtn" data-act="undo" title="撤销 (Ctrl+Z)">↶</button>
        <button class="tbtn" data-act="redo" title="重做 (Ctrl+Shift+Z)">↷</button>
        <span class="sep"></span>
        <button class="tbtn" data-act="reset" title="重置裁剪框">⊡ 重置</button>
        <button class="tbtn" data-act="center" title="居中">⌖ 居中</button>
        <button class="tbtn on" data-act="snap" title="对齐吸附">🧲 吸附</button>
      </div>
      <div class="footer">
        <button class="btn-c" id="cancel">取消</button>
        <button class="btn-ok" id="done">完成</button>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(backdrop);
    document.body.appendChild(editorRoot);

    const sel = shadow.querySelector('#sel');
    const hint = shadow.querySelector('#hint');
    const wrap = shadow.querySelector('#wrap');
    const imgEl = shadow.querySelector('#img');
    const gv = shadow.querySelector('#gv');
    const gh = shadow.querySelector('#gh');
    const snapBtn = shadow.querySelector('[data-act=snap]');

    let active = true;
    let mode = null, dir = '';
    let pStartX, pStartY, sStartX, sStartY, sStartW, sStartH;

    /* ----- sync ----- */
    function syncImage() {
      renderTransformed();
      computeFit();
      imgEl.src = transformedSrc;
      wrap.style.width = dw + 'px';
      wrap.style.height = dh + 'px';
    }
    function updateSel(snap) {
      sel.style.left = state.selX + 'px';
      sel.style.top = state.selY + 'px';
      sel.style.width = state.selW + 'px';
      sel.style.height = state.selH + 'px';
      hint.textContent = Math.round(state.selW * s) + ' × ' + Math.round(state.selH * s) + ' px';
      if (snap && snap.v != null) { gv.style.display = 'block'; gv.style.left = snap.v + 'px'; } else gv.style.display = 'none';
      if (snap && snap.h != null) { gh.style.display = 'block'; gh.style.top = snap.h + 'px'; } else gh.style.display = 'none';
    }
    function updateRatioUI() {
      shadow.querySelectorAll('.pchip').forEach(c => c.classList.toggle('active', c.dataset.ratio === state.ratioMode));
    }
    function setRatio(modeName, value) {
      pushHistory();
      state.ratioMode = modeName; state.ratioValue = value;
      fitSelection(); updateRatioUI(); updateSel();
    }
    function doTransform(fn) {
      pushHistory();
      fn();
      syncImage(); fitSelection(); updateRatioUI(); updateSel();
    }

    /* ----- snap ----- */
    function nearest(val, arr) {
      let best = null, bd = SNAP_PX + 1;
      for (const g of arr) { const d = Math.abs(g - val); if (d < bd) { bd = d; best = g; } }
      return bd <= SNAP_PX ? best : null;
    }
    function snapMove() {
      const res = {};
      if (!state.snap) return res;
      const vg = [0, dw / 3, dw / 2, 2 * dw / 3, dw];
      const hg = [0, dh / 3, dh / 2, 2 * dh / 3, dh];
      const lv = nearest(state.selX, vg), rv = nearest(state.selX + state.selW, vg);
      if (lv !== null && (rv === null || Math.abs(lv - state.selX) <= Math.abs(rv - (state.selX + state.selW)))) { state.selX = lv; res.v = lv; }
      else if (rv !== null) { state.selX = rv - state.selW; res.v = rv; }
      const th = nearest(state.selY, hg), bh = nearest(state.selY + state.selH, hg);
      if (th !== null && (bh === null || Math.abs(th - state.selY) <= Math.abs(bh - (state.selY + state.selH)))) { state.selY = th; res.h = th; }
      else if (bh !== null) { state.selY = bh - state.selH; res.h = bh; }
      return res;
    }

    /* ----- resize ----- */
    function resizeFree(mx, my) {
      let L = sStartX, T = sStartY, R = sStartX + sStartW, B = sStartY + sStartH;
      switch (dir) {
        case 'se': R = mx; B = my; break; case 'nw': L = mx; T = my; break;
        case 'ne': R = mx; T = my; break; case 'sw': L = mx; B = my; break;
        case 'e': R = mx; break; case 'w': L = mx; break;
        case 's': B = my; break; case 'n': T = my; break;
      }
      L = Math.max(0, Math.min(L, dw)); R = Math.max(0, Math.min(R, dw));
      T = Math.max(0, Math.min(T, dh)); B = Math.max(0, Math.min(B, dh));
      let w = R - L, h = B - T;
      const xRight = dir === 'e' || dir === 'se' || dir === 'ne';
      const xLeft = dir === 'w' || dir === 'sw' || dir === 'nw';
      const yBot = dir === 's' || dir === 'se' || dir === 'sw';
      const yTop = dir === 'n' || dir === 'ne' || dir === 'nw';
      if (w < MIN && (xRight || xLeft)) { if (xRight) R = L + MIN; else L = R - MIN; w = MIN; }
      if (h < MIN && (yBot || yTop)) { if (yBot) B = T + MIN; else T = B - MIN; h = MIN; }
      state.selX = L; state.selY = T; state.selW = w; state.selH = h;
    }
    function resizeRatio(mx, my) {
      const R = state.ratioValue;
      let ax, ay, sgnX, sgnY;
      switch (dir) {
        case 'se': ax = sStartX; ay = sStartY; sgnX = 1; sgnY = 1; break;
        case 'nw': ax = sStartX + sStartW; ay = sStartY + sStartH; sgnX = -1; sgnY = -1; break;
        case 'ne': ax = sStartX; ay = sStartY + sStartH; sgnX = 1; sgnY = -1; break;
        case 'sw': ax = sStartX + sStartW; ay = sStartY; sgnX = -1; sgnY = 1; break;
        default: return;
      }
      const dxr = Math.abs(mx - ax), dyr = Math.abs(my - ay);
      let w = dxr / R <= dyr ? dxr : dyr * R;
      w = Math.max(MIN, w);
      const maxByX = sgnX > 0 ? (dw - ax) : ax;
      const maxByY = sgnY > 0 ? (dh - ay) : ay;
      w = Math.min(w, maxByX);
      let h = w / R;
      if (h > maxByY) { h = maxByY; w = h * R; }
      w = Math.max(MIN, w); h = w / R;
      state.selW = Math.round(w); state.selH = Math.round(h);
      state.selX = Math.round(sgnX > 0 ? ax : ax - state.selW);
      state.selY = Math.round(sgnY > 0 ? ay : ay - state.selH);
    }

    /* ----- pointer ----- */
    sel.addEventListener('pointerdown', (e) => {
      if (!active) return;
      const handle = e.target.closest('.handle');
      if (handle) {
        dir = handle.dataset.d;
        if (state.ratioValue > 0 && (dir === 'n' || dir === 's' || dir === 'e' || dir === 'w')) return;
        mode = 'resize';
      } else { mode = 'move'; }
      pushHistory();
      pStartX = e.clientX; pStartY = e.clientY;
      sStartX = state.selX; sStartY = state.selY; sStartW = state.selW; sStartH = state.selH;
      sel.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    sel.addEventListener('pointermove', (e) => {
      if (!mode) return;
      if (mode === 'move') {
        state.selX = Math.max(0, Math.min(dw - state.selW, sStartX + (e.clientX - pStartX)));
        state.selY = Math.max(0, Math.min(dh - state.selH, sStartY + (e.clientY - pStartY)));
        const snap = snapMove();
        state.selX = Math.max(0, Math.min(state.selX, dw - state.selW));
        state.selY = Math.max(0, Math.min(state.selY, dh - state.selH));
        updateSel(snap);
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const mx = Math.max(0, Math.min(dw, e.clientX - rect.left));
      const my = Math.max(0, Math.min(dh, e.clientY - rect.top));
      if (state.ratioValue > 0) resizeRatio(mx, my); else resizeFree(mx, my);
      updateSel();
    });
    function endGesture() {
      if (mode && state.selX === sStartX && state.selY === sStartY && state.selW === sStartW && state.selH === sStartH) {
        undoStack.pop(); refreshUndoRedo();
      }
      mode = null; dir = '';
      gv.style.display = 'none'; gh.style.display = 'none';
    }
    sel.addEventListener('pointerup', endGesture);
    sel.addEventListener('pointercancel', endGesture);

    /* ----- toolbars ----- */
    shadow.querySelector('.topbar').addEventListener('click', (e) => {
      if (mode) return;
      const chip = e.target.closest('.pchip');
      if (chip && chip.dataset.ratio !== 'custom') setRatio(chip.dataset.ratio, parseFloat(chip.dataset.value));
    });
    function applyCustom() {
      if (mode) return;
      const w = parseInt(shadow.querySelector('#cw').value, 10);
      const h = parseInt(shadow.querySelector('#ch').value, 10);
      if (w > 0 && h > 0) setRatio('custom', w / h);
    }
    shadow.querySelector('#capply').addEventListener('click', applyCustom);
    shadow.querySelectorAll('#cw,#ch').forEach(inp => inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyCustom(); }
    }));

    shadow.querySelector('.bottombar').addEventListener('click', (e) => {
      if (mode) return;
      const btn = e.target.closest('.tbtn');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.act) {
        case 'rotL': doTransform(() => { state.rotation = (state.rotation + 270) % 360; }); break;
        case 'rotR': doTransform(() => { state.rotation = (state.rotation + 90) % 360; }); break;
        case 'rot180': doTransform(() => { state.rotation = (state.rotation + 180) % 360; }); break;
        case 'flipH': doTransform(() => { state.flipH = !state.flipH; }); break;
        case 'flipV': doTransform(() => { state.flipV = !state.flipV; }); break;
        case 'undo': doUndoRedo(undoStack, redoStack); break;
        case 'redo': doUndoRedo(redoStack, undoStack); break;
        case 'reset': pushHistory(); fitSelection(); updateSel(); break;
        case 'center': pushHistory(); centerSel(); updateSel(); break;
        case 'snap': state.snap = !state.snap; snapBtn.classList.toggle('on', state.snap); break;
      }
    });

    /* ----- finish / cancel / keys ----- */
    function cleanup() { active = false; document.removeEventListener('keydown', onKey, true); }
    function cancel() { cleanup(); editorRoot.remove(); resolve(null); }
    function finish() {
      cleanup();
      const crop = {
        sx: Math.round(state.selX * s), sy: Math.round(state.selY * s),
        sw: Math.round(state.selW * s), sh: Math.round(state.selH * s),
      };
      const full = crop.sx <= 1 && crop.sy <= 1 && crop.sw >= tW - 2 && crop.sh >= tH - 2;
      editorRoot.remove();
      resolve({ rotation: state.rotation, flipH: state.flipH, flipV: state.flipV, crop: full ? null : crop });
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); return; }
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && k === 'z') {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) doUndoRedo(redoStack, undoStack); else doUndoRedo(undoStack, redoStack);
      } else if (ctrl && k === 'y') {
        e.preventDefault(); e.stopPropagation();
        doUndoRedo(redoStack, undoStack);
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation(); finish();
      }
    }
    document.addEventListener('keydown', onKey, true);
    shadow.querySelector('#cancel').onclick = cancel;
    shadow.querySelector('#done').onclick = finish;

    /* ----- init ----- */
    syncImage();
    fitSelection();
    updateRatioUI();
    refreshUndoRedo();
    updateSel();
  }

  /* ========== Image Processing ========== */

  // 变换后自然尺寸:90/270 互换宽高,翻转不变
  function transformedDims(nw, nh, rotation) {
    return (rotation === 90 || rotation === 270) ? { tW: nh, tH: nw } : { tW: nw, tH: nh };
  }

  // 把原图按 翻转→旋转 画进已设好 tW×tH 尺寸的 ctx(编辑器预览与最终输出共用,保证像素一致)
  function applyTransform(ctx, img, rotation, flipH, flipV) {
    const OW = img.naturalWidth, OH = img.naturalHeight;
    const { tW, tH } = transformedDims(OW, OH, rotation);
    let tx = 0, ty = 0, ang = 0;
    if (rotation === 90) { tx = tW; ty = 0; ang = Math.PI / 2; }
    else if (rotation === 180) { tx = tW; ty = tH; ang = Math.PI; }
    else if (rotation === 270) { tx = 0; ty = tH; ang = -Math.PI / 2; }
    const sx = flipH ? -1 : 1, sy = flipV ? -1 : 1;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(ang);
    ctx.scale(sx, sy);
    ctx.drawImage(img, sx < 0 ? -OW : 0, sy < 0 ? -OH : 0, OW, OH);
    ctx.restore();
  }

  // 渲染完整编辑结果:先变换到 tW×tH 画布,再按 crop 裁出。edit 为 null/无变换时返回原图画布
  function renderEdit(img, edit) {
    if (!edit || (!edit.rotation && !edit.flipH && !edit.flipV && !edit.crop)) {
      const full = document.createElement('canvas');
      full.width = img.naturalWidth; full.height = img.naturalHeight;
      full.getContext('2d').drawImage(img, 0, 0);
      return full;
    }
    const a = document.createElement('canvas');
    const { tW, tH } = transformedDims(img.naturalWidth, img.naturalHeight, edit.rotation);
    a.width = tW; a.height = tH;
    applyTransform(a.getContext('2d'), img, edit.rotation, edit.flipH, edit.flipV);
    if (!edit.crop) return a;
    const out = document.createElement('canvas');
    out.width = edit.crop.sw; out.height = edit.crop.sh;
    out.getContext('2d').drawImage(a, edit.crop.sx, edit.crop.sy, edit.crop.sw, edit.crop.sh, 0, 0, edit.crop.sw, edit.crop.sh);
    return out;
  }

  function buildEditLabel(edit, doCompress) {
    const lb = [];
    if (edit && edit.crop) lb.push('裁剪');
    if (edit && (edit.rotation || edit.flipH || edit.flipV)) lb.push('旋转/翻转');
    if (doCompress) lb.push('压缩');
    return lb.join('+') || '原图';
  }

  function deriveName(file, edit, doCompress, outW, outH) {
    const changed = doCompress || (edit && (edit.crop || edit.rotation || edit.flipH || edit.flipV));
    if (!changed) return file.name;
    const base = file.name.replace(/\.[^.]+$/, '');
    const ext = doCompress ? 'jpg' : ((file.name.split('.').pop() || 'jpg').toLowerCase());
    return base + '_' + outW + 'x' + outH + '.' + ext;
  }

  function showPreview(shadow, file, edit, doCompress) {
    const reader = new FileReader();
    reader.onload = (e) => {
      shadow.querySelector('#previewOriginal').src = e.target.result;
      const img = new Image();
      img.onload = () => {
        const c = renderEdit(img, edit);
        shadow.querySelector('#previewResultLabel').textContent = buildEditLabel(edit, doCompress);
        shadow.querySelector('#previewResult').src = c.toDataURL('image/jpeg', doCompress ? config.quality / 100 : 0.92);
        shadow.querySelector('#previewArea').style.display = 'block';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function processImage(file, edit, doCompress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const c = renderEdit(img, edit);
          const outType = doCompress ? 'image/jpeg' : file.type;
          c.toBlob((blob) => {
            if (!blob) { reject(new Error('toBlob failed')); return; }
            const name = deriveName(file, edit, doCompress, c.width, c.height);
            resolve(new File([blob], name, { type: outType, lastModified: Date.now() }));
          }, outType, doCompress ? config.quality / 100 : undefined);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
})();
