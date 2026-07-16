(function() {
  let activeInput = null;
  let config = {
    autoDetect: true,
    quality: 80
  };

  // 初始化配置
  chrome.storage.sync.get(['autoDetect', 'quality'], (result) => {
    if (result.autoDetect !== undefined) config.autoDetect = result.autoDetect;
    if (result.quality !== undefined) config.quality = result.quality;
  });

  // 监听配置变更
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.autoDetect) config.autoDetect = changes.autoDetect.newValue;
    if (changes.quality) config.quality = changes.quality.newValue;
  });

  // 监听所有文件选择框的变更
  document.addEventListener('change', async (event) => {
    if (!config.autoDetect) return;
    
    const target = event.target;
    if (target.tagName === 'INPUT' && target.type === 'file') {
      // 如果已经处理过，直接允许事件通过
      if (target.dataset.optimizerProcessed === 'true') {
        delete target.dataset.optimizerProcessed;
        return;
      }

      const files = target.files;
      if (!files || files.length === 0) return;

      const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
      if (imageFiles.length === 0) return;

      // 关键：立即停止事件传播，防止原网站直接处理原图
      event.stopImmediatePropagation();
      event.preventDefault();

      activeInput = target;
      showOptimizerUI(imageFiles);
    }
  }, true); // 使用捕获阶段，确保在原网站脚本之前拦截

  function showOptimizerUI(files) {
    // 移除已有的 UI
    const existing = document.getElementById('image-optimizer-root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = 'image-optimizer-root';
    const shadow = root.attachShadow({ mode: 'open' });

    const container = document.createElement('div');
    container.className = 'optimizer-container';
    
    const formatSize = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const totalOriginalSize = files.reduce((acc, file) => acc + file.size, 0);

    // 简约设计风格
    const style = document.createElement('style');
    style.textContent = `
      .optimizer-container {
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 2147483647;
        background: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 16px;
        padding: 20px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
        width: 300px;
        animation: slideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        color: #1d1d1f;
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
        margin-bottom: 18px;
        line-height: 1.4;
      }
      .size-info {
        background: rgba(0, 0, 0, 0.03);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 20px;
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
      
      .actions {
        display: flex;
        gap: 10px;
      }
      button {
        flex: 1;
        padding: 10px 16px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        border: none;
        outline: none;
      }
      .btn-compress {
        background: #007aff;
        color: white;
      }
      .btn-compress:hover {
        background: #0071e3;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 122, 255, 0.24);
      }
      .btn-skip {
        background: #f5f5f7;
        color: #1d1d1f;
      }
      .btn-skip:hover {
        background: #e8e8ed;
      }
      .btn-confirm {
        display: none;
        background: #34c759;
        color: white;
        width: 100%;
      }
      .btn-confirm:hover {
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
    `;

    container.innerHTML = `
      <div class="title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#007aff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        TD-东哥 Image Compress
      </div>
      <div class="subtitle">检测到 ${files.length} 张图片 (${formatSize(totalOriginalSize)})，是否进行压缩？</div>
      
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
        <button class="btn-skip">原图上传</button>
        <button class="btn-compress">开始压缩</button>
      </div>
      
      <button class="btn-confirm" id="confirmBtn">确认上传</button>
      
      <div class="loading" id="statusLabel">正在处理中...</div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(container);
    document.body.appendChild(root);

    let compressedFilesResult = null;

    shadow.querySelector('.btn-skip').onclick = () => {
      activeInput.dataset.optimizerProcessed = 'true';
      activeInput.dispatchEvent(new Event('change', { bubbles: true }));
      root.remove();
    };

    shadow.querySelector('.btn-compress').onclick = async () => {
      shadow.querySelector('#initialActions').style.display = 'none';
      shadow.querySelector('#statusLabel').style.display = 'block';
      
      try {
        const compressedFiles = await Promise.all(files.map(file => compressImage(file)));
        const totalCompressedSize = compressedFiles.reduce((acc, file) => acc + file.size, 0);
        const savingsPercent = Math.round((1 - totalCompressedSize / totalOriginalSize) * 100);

        // 更新大小展示
        shadow.querySelector('#oldSize').textContent = formatSize(totalOriginalSize);
        shadow.querySelector('#newSize').textContent = formatSize(totalCompressedSize);
        shadow.querySelector('#savings').textContent = `${formatSize(totalOriginalSize - totalCompressedSize)} (${savingsPercent}%)`;
        
        shadow.querySelector('#sizeInfo').style.display = 'block';
        shadow.querySelector('#statusLabel').style.display = 'none';
        shadow.querySelector('#confirmBtn').style.display = 'block';
        
        compressedFilesResult = compressedFiles;
      } catch (err) {
        console.error('Compression failed:', err);
        shadow.querySelector('#statusLabel').textContent = '处理失败，请重试';
        setTimeout(() => root.remove(), 2000);
      }
    };

    shadow.querySelector('#confirmBtn').onclick = () => {
      if (!compressedFilesResult) return;
      
      const dataTransfer = new DataTransfer();
      compressedFilesResult.forEach(file => dataTransfer.items.add(file));
      
      activeInput.dataset.optimizerProcessed = 'true';
      activeInput.files = dataTransfer.files;
      activeInput.dispatchEvent(new Event('change', { bubbles: true }));
      
      root.remove();
    };
  }

  async function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          // 最大宽度限制 (可选)
          const MAX_WIDTH = 1920;
          if (width > MAX_WIDTH) {
            height = Math.round((height * MAX_WIDTH) / width);
            width = MAX_WIDTH;
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // 使用配置的压缩质量
          canvas.toBlob((blob) => {
            if (blob) {
              const compressedFile = new File([blob], file.name, {
                type: 'image/jpeg',
                lastModified: Date.now(),
              });
              resolve(compressedFile);
            } else {
              reject(new Error('Canvas toBlob failed'));
            }
          }, 'image/jpeg', config.quality / 100);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
})();
