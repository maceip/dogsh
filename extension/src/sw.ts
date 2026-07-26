// Service worker: guarantees a WebSocket hub exists. On desktop Chrome that
// hub is the offscreen document (immune to SW idling); on browsers WITHOUT
// the offscreen API (Edge for Android) this worker hosts the sockets itself
// — live WebSocket traffic resets the MV3 idle timer (Chromium 116+), and
// the daemon's 2s owner-state re-assert keeps traffic flowing, so the
// worker stays alive exactly as long as a daemon is attached.
const HAS_OFFSCREEN = typeof chrome.offscreen !== 'undefined';

async function ensureOffscreen(): Promise<void> {
  if (!HAS_OFFSCREEN) return; // this worker IS the hub (Edge Android)
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

// Fallback hub (Edge Android): identical contract to offscreen.ts — port
// name selects the e2e override port, the first port message carries the
// daemon URL config, everything else is forwarded verbatim. Registered only
// when the offscreen API is missing, so exactly ONE context ever answers a
// 'dogsh-tab' port.
if (!HAS_OFFSCREEN) {
  const DEFAULT_PORT = 47703;
  chrome.runtime.onConnect.addListener((port) => {
    const m = /^dogsh-tab(?:#(\d+))?$/.exec(port.name);
    if (!m) return;
    const defaultUrl = `ws://127.0.0.1:${Number(m[1]) || DEFAULT_PORT}`;
    let ws: WebSocket | null = null;
    let daemonUrl: string | null = null;
    let closedByPort = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function openSocket(): void {
      ws = new WebSocket(daemonUrl || defaultUrl);
      ws.onopen = () => port.postMessage({ type: 'bridge-up' });
      ws.onmessage = (ev) => {
        try {
          port.postMessage(JSON.parse(ev.data as string));
        } catch {
          /* port gone mid-flight */
        }
      };
      ws.onclose = () => {
        if (closedByPort) return;
        try {
          port.postMessage({ type: 'bridge-down' });
        } catch {
          /* port gone */
        }
        retryTimer = setTimeout(() => {
          if (!closedByPort) openSocket();
        }, 2000);
      };
      ws.onerror = () => ws?.close();
    }

    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'dogsh-config') {
        if (ws) return;
        daemonUrl = typeof msg.url === 'string' && msg.url ? msg.url : null;
        openSocket();
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    port.onDisconnect.addListener(() => {
      closedByPort = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) ws.close();
    });
  });
}

// Injection coverage beyond the manifest. The manifest content script IS
// honored on desktop Chrome AND on Edge for Android — empirically audited,
// see EDGE-ANDROID-EXTENSION-SUPPORT.md. (An earlier claim here that Edge
// "never schedules it" was an artifact of probing the zombie devtools socket
// of a dead Edge instance; it looked like no isolated world was ever
// created.) Two redundant layers are kept anyway: Android extension support
// is officially experimental and has shifted under us before, and content.js
// is idempotent (window.__dogshInjected + it removes stale hosts), so
// duplicate delivery costs nothing:
//   1. a dynamically registered content script (survives a browser that
//      honors chrome.scripting registration but drops manifest scripts), and
//   2. a tabs.onUpdated executeScript pass on every completed navigation.
async function ensureDynamicContentScript(): Promise<void> {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['dogsh-cs'] });
    if (existing && existing.length) return;
  } catch {
    /* getRegistered not supported; fall through and try to register */
  }
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: 'dogsh-cs',
        matches: ['http://*/*', 'https://*/*'],
        js: ['content.js'],
        runAt: 'document_idle',
        allFrames: false,
      },
    ]);
  } catch {
    /* already registered or unsupported — the onUpdated fallback still covers us */
  }
}

function injectInto(tabId: number): void {
  chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {
    /* chrome://, web store, PDF viewer, or a tab that navigated away — fine */
  });
}

// Redundant delivery on every completed top-frame load; an idempotent no-op
// wherever the manifest script already ran.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;
  injectInto(tabId);
});

// On install/reload/update: re-arm every open tab. Reloading an extension
// kills its content scripts everywhere and Chrome never reinjects them on its
// own — without this, "reload the extension" silently means "the overlay is
// gone until you also refresh every tab by hand".
chrome.runtime.onInstalled.addListener(async () => {
  ensureOffscreen();
  ensureDynamicContentScript();
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
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
  ensureDynamicContentScript();
});

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
