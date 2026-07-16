document.addEventListener('DOMContentLoaded', () => {
  const autoDetect = document.getElementById('autoDetect');
  const quality = document.getElementById('quality');
  const qualityValue = document.getElementById('qualityValue');

  // 加载保存的设置
  chrome.storage.sync.get(['autoDetect', 'quality'], (result) => {
    if (result.autoDetect !== undefined) {
      autoDetect.checked = result.autoDetect;
    }
    if (result.quality !== undefined) {
      quality.value = result.quality;
      qualityValue.textContent = `${result.quality}%`;
    }
  });

  // 保存设置
  autoDetect.addEventListener('change', () => {
    chrome.storage.sync.set({ autoDetect: autoDetect.checked });
  });

  quality.addEventListener('input', () => {
    qualityValue.textContent = `${quality.value}%`;
  });

  quality.addEventListener('change', () => {
    chrome.storage.sync.set({ quality: parseInt(quality.value) });
  });
});
