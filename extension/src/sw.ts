// Service worker: only job is to guarantee the offscreen document (the
// WebSocket hub) exists. All terminal traffic flows content-script <-> port
// <-> offscreen <-> daemon; none of it depends on this worker staying alive.
async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Maintain WebSocket connections to the local dogsh terminal daemon',
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
      if (tab.id == null) continue;
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
    // EVERY tab gets told, not just active ones: a background tab keeps a
    // stale windowFocused otherwise and would report a wrong fact whenever
    // its next real event fires. Content scripts fold this into their
    // signal report; no report loops can come out of it (one push per real
    // OS focus change).
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      const inFocusedWindow = focused && tab.windowId === windowId;
      chrome.tabs
        .sendMessage(tab.id, {
          type: inFocusedWindow ? 'dogsh-window-focused' : 'dogsh-window-blurred',
        })
        .catch(() => {
          /* tab has no content script (chrome:// etc.) */
        });
    }
  } catch {
    /* window closed mid-flight */
  }
});

// A tab became its window's active tab (user click on the tab strip,
// Ctrl+Tab, or programmatic activation). This is the browser's OWN
// definition of a tab switch — stronger than the Page Visibility API, whose
// in-renderer events don't always arrive (a screencast/capture session keeps
// background pages composited, so visibilitychange never fires; the desktop
// e2e's video recording hit exactly that). Same pattern as window focus
// above: the authoritative signal originates here and every affected tab is
// told, including the one that just LOST active status — it gets no renderer
// event either.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (tab.id == null || tab.windowId !== windowId) continue;
      chrome.tabs
        .sendMessage(tab.id, { type: 'dogsh-tab-active', active: tab.id === tabId })
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
  // Ground truth for "is my Chrome window focused at the OS level" and "am I
  // my window's active tab". document.hasFocus() in the page LIES on macOS
  // (app deactivation often delivers no blur to the renderer), and the Page
  // Visibility API LIES under any capture session (background tabs stay
  // composited, so a hidden tab still reports 'visible'). Content scripts
  // bootstrap both facts from here instead.
  if (msg && msg.type === 'query-window-focus') {
    const tab = sender.tab;
    if (!tab || tab.windowId == null || tab.id == null) {
      sendResponse({ focused: false, active: false });
      return;
    }
    Promise.all([chrome.windows.get(tab.windowId), chrome.tabs.get(tab.id)])
      .then(([w, t]) => sendResponse({ focused: !!w.focused, active: !!t.active }))
      .catch(() => sendResponse({ focused: false, active: false }));
    return true; // async response
  }
});
