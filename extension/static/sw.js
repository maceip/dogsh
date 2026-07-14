// Service worker: only job is to guarantee the offscreen document (the
// WebSocket hub) exists. All terminal traffic flows content-script <-> port
// <-> offscreen <-> daemon; none of it depends on this worker staying alive.
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification:
        'Maintain WebSocket connections to the local dogsh terminal daemon',
    });
  } catch (e) {
    // Racing creation from two events is fine; "already exists" is success.
    if (!String(e).includes('single offscreen')) throw e;
  }
}

// On install/reload/update: re-arm every open tab. Reloading an extension
// kills its content scripts everywhere and Chrome never reinjects them on its
// own — without this, "reload the extension" silently means "the overlay is
// gone until you also refresh every tab by hand".
chrome.runtime.onInstalled.addListener(async () => {
  ensureOffscreen();
  // A persisted mode:'off' would make a fresh install look broken (overlay
  // hidden everywhere). ghost/min are kept — they're visibly "on".
  chrome.storage.local.get(['mode'], ({ mode }) => {
    if (mode === 'off') chrome.storage.local.set({ mode: 'normal' });
  });
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
        .catch(() => {
          /* chrome web store pages etc. refuse injection; fine */
        });
    }
  } catch {
    /* no tabs access; manifest injection still covers new page loads */
  }
});
chrome.runtime.onStartup.addListener(ensureOffscreen);

// The OS gave/took a Chrome window's focus (cmd-tab, dock click). The active
// tab's renderer frequently sees NO event for this — from its own point of
// view its focus/visibility never changed (especially when browser UI like
// the omnibox held focus) — so the "follow me back to the browser" signal
// must originate here, where the windows API sees the truth.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const focused = windowId !== chrome.windows.WINDOW_ID_NONE;
  try {
    const tabs = focused
      ? await chrome.tabs.query({ active: true, windowId })
      : await chrome.tabs.query({ active: true }); // Chrome lost focus: tell every active tab
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs
        .sendMessage(tab.id, { type: focused ? 'dogsh-window-focused' : 'dogsh-window-blurred' })
        .catch(() => {
          /* tab has no content script (chrome:// etc.) */
        });
    }
  } catch {
    /* window closed mid-flight */
  }
});

// Browser-global hotkey (default Ctrl+Shift+Period, remappable at
// chrome://extensions/shortcuts). Unlike the in-page Ctrl+Shift+\ listener,
// this works even when the page swallows keystrokes or has no content script.
// Mode changes propagate to every tab via storage.onChanged.
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'toggle-overlay') return;
  chrome.storage.local.get(['mode'], ({ mode }) => {
    chrome.storage.local.set({ mode: mode === 'off' ? 'normal' : 'off' });
  });
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ensure-offscreen') {
    ensureOffscreen().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  // Ground truth for "is my Chrome window focused at the OS level".
  // document.hasFocus() in the page LIES on macOS: app deactivation often
  // delivers no blur to the renderer, so an occluded background tab still
  // reports focused — which once created a WebGL context that composited
  // black forever. Content scripts ask here instead.
  if (msg && msg.type === 'query-window-focus') {
    const windowId = sender.tab && sender.tab.windowId;
    if (windowId == null) {
      sendResponse({ focused: false });
      return;
    }
    chrome.windows
      .get(windowId)
      .then((w) => sendResponse({ focused: !!w.focused }))
      .catch(() => sendResponse({ focused: false }));
    return true; // async response
  }
});
