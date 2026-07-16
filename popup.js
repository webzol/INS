document.addEventListener('DOMContentLoaded', () => {
  const autoDetect = document.getElementById('autoDetect');
  const autoCrop = document.getElementById('autoCrop');
  const quality = document.getElementById('quality');
  const qualityValue = document.getElementById('qualityValue');
  const closeBtn = document.getElementById('closeBtn');

  closeBtn.addEventListener('click', () => window.close());

  chrome.storage.sync.get(['autoDetect', 'autoCrop', 'quality'], (result) => {
    if (result.autoDetect !== undefined) autoDetect.checked = result.autoDetect;
    if (result.autoCrop !== undefined) autoCrop.checked = result.autoCrop;
    if (result.quality !== undefined) {
      quality.value = result.quality;
      qualityValue.textContent = `${result.quality}%`;
    }
  });

  autoDetect.addEventListener('change', () => {
    chrome.storage.sync.set({ autoDetect: autoDetect.checked });
  });

  autoCrop.addEventListener('change', () => {
    chrome.storage.sync.set({ autoCrop: autoCrop.checked });
  });

  quality.addEventListener('input', () => {
    qualityValue.textContent = `${quality.value}%`;
  });

  quality.addEventListener('change', () => {
    chrome.storage.sync.set({ quality: parseInt(quality.value) });
  });
});
