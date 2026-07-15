chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ status: 'ready' });
});
