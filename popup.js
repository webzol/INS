document.addEventListener('DOMContentLoaded', () => {
  const autoDetect = document.getElementById('autoDetect');
  const quality = document.getElementById('quality');
  const qualityValue = document.getElementById('qualityValue');
  const maxEdge = document.getElementById('maxEdge');
  const maxEdgeValue = document.getElementById('maxEdgeValue');
  const minSizeKB = document.getElementById('minSizeKB');
  const minSizeValue = document.getElementById('minSizeValue');
  const formatGroup = document.getElementById('formatGroup');

  const DEFAULTS = {
    autoDetect: true,
    quality: 80,
    maxEdge: 1920,
    minSizeKB: 100,
    format: 'auto'
  };

  function setFormatUI(format) {
    formatGroup.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.format === format);
    });
  }

  chrome.storage.sync.get(DEFAULTS, (result) => {
    autoDetect.checked = result.autoDetect !== false;

    quality.value = result.quality ?? DEFAULTS.quality;
    qualityValue.textContent = `${quality.value}%`;

    maxEdge.value = result.maxEdge ?? DEFAULTS.maxEdge;
    maxEdgeValue.textContent = `${maxEdge.value}px`;

    minSizeKB.value = result.minSizeKB ?? DEFAULTS.minSizeKB;
    minSizeValue.textContent = `${minSizeKB.value}KB`;

    setFormatUI(result.format || DEFAULTS.format);
  });

  autoDetect.addEventListener('change', () => {
    chrome.storage.sync.set({ autoDetect: autoDetect.checked });
  });

  quality.addEventListener('input', () => {
    qualityValue.textContent = `${quality.value}%`;
  });
  quality.addEventListener('change', () => {
    chrome.storage.sync.set({ quality: parseInt(quality.value, 10) });
  });

  maxEdge.addEventListener('input', () => {
    maxEdgeValue.textContent = `${maxEdge.value}px`;
  });
  maxEdge.addEventListener('change', () => {
    chrome.storage.sync.set({ maxEdge: parseInt(maxEdge.value, 10) });
  });

  minSizeKB.addEventListener('input', () => {
    minSizeValue.textContent = `${minSizeKB.value}KB`;
  });
  minSizeKB.addEventListener('change', () => {
    chrome.storage.sync.set({ minSizeKB: parseInt(minSizeKB.value, 10) });
  });

  formatGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-format]');
    if (!btn) return;
    const format = btn.dataset.format;
    setFormatUI(format);
    chrome.storage.sync.set({ format });
  });
});
