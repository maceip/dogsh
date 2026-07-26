// Options page: the two settings that turn the desktop overlay extension
// into a remote face (Edge on Android following the laptop's daemon over a
// tailnet). Saved to chrome.storage.local; every content script listens for
// the change and rebuilds its bridge — no reloads needed.
const urlInput = document.getElementById('url') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const savedBadge = document.getElementById('saved')!;

chrome.storage.local.get(['daemonUrl', 'daemonToken'], (res) => {
  if (typeof res.daemonUrl === 'string') urlInput.value = res.daemonUrl;
  if (typeof res.daemonToken === 'string') tokenInput.value = res.daemonToken;
});

document.getElementById('save')!.addEventListener('click', () => {
  const daemonUrl = urlInput.value.trim();
  // A half-typed URL bricks every face until corrected; catch the obvious.
  if (daemonUrl && !/^wss?:\/\/.+/.test(daemonUrl)) {
    urlInput.style.borderColor = '#ff7b72';
    return;
  }
  urlInput.style.borderColor = '';
  chrome.storage.local.set({ daemonUrl, daemonToken: tokenInput.value }, () => {
    savedBadge.dataset.on = '1';
    setTimeout(() => delete savedBadge.dataset.on, 2000);
  });
});
