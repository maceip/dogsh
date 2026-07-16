// dogsh tab face. Pre-warmed, always-attached xterm.js overlay in a Shadow DOM.
//
// v6 role, exactly two jobs (see app/daemon/arbiter.ts for the design):
//   REPORT FACTS — raw {visible, focused} signals from real events, never
//   claims, never from timers, never in reaction to daemon broadcasts.
//   RENDER STATE — reveal/hide/fly purely from daemon owner-state.
// Everything this file must NOT do again lives in the arbiter's header: the
// eviction race, steal-then-blur, and the self-heal metronome all came from
// this script drawing conclusions instead of reporting facts.
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import xtermCss from '@xterm/xterm/css/xterm.css';
import CONFIG from '../../app/shared/config.js';

declare global {
  interface Window {
    // Injection guard: survives this script world, set on the page's window.
    __dogshInjected?: boolean;
  }
}

(async () => {
  if (window.top !== window) return;
  if (window.__dogshInjected) return;
  window.__dogshInjected = true;

  // An extension reload orphans the previous instance's overlay in the DOM
  // (its script world is destroyed, the elements aren't). We are the live
  // instance now — remove the corpses before building ours.
  for (const el of document.querySelectorAll('[data-dogsh]')) el.remove();

  // Bundled Nerd Font, loaded before the terminal measures cell metrics so
  // prompt/eza icon glyphs render and metrics match the native face.
  try {
    const fonts = await Promise.all([
      new FontFace(
        'MesloLGS NF',
        `url(${chrome.runtime.getURL('fonts/MesloLGS-NF-Regular.ttf')})`
      ).load(),
      new FontFace('MesloLGS NF', `url(${chrome.runtime.getURL('fonts/MesloLGS-NF-Bold.ttf')})`, {
        weight: 'bold',
      }).load(),
    ]);
    fonts.forEach((f) => document.fonts.add(f));
  } catch (e) {
    console.debug('[dogsh] nerd font load failed, falling back to Menlo:', (e as Error)?.message);
  }

  // ---------------------------------------------------------------------
  // Overlay DOM (Shadow root isolates us from page CSS in both directions)
  // ---------------------------------------------------------------------
  const host = document.createElement('div');
  host.setAttribute('data-dogsh', '');
  host.setAttribute('data-proto', String(CONFIG.protocolVersion));
  Object.assign(host.style, {
    position: 'fixed',
    zIndex: '2147483647',
    visibility: 'hidden',
    right: '24px',
    bottom: '24px',
    left: 'auto',
    top: 'auto',
    // Host never captures pointer events; only the (interactive) frame does, so
    // the rest of the page stays clickable around the overlay.
    pointerEvents: 'none',
  });
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      ${xtermCss}
      /* macOS-style window chrome, matching the native face. */
      #frame {
        position: relative; /* context menu positions against the frame */
        background: ${CONFIG.theme.background};
        border-radius: 10px;
        box-shadow: 0 12px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.10);
        overflow: hidden;
        transform-origin: 0 0;
        opacity: 0.72; /* overridden inline by applyOpacity() */
        transition: opacity .15s ease;
        pointer-events: auto; /* host is pointer-events:none; frame re-enables */
      }
      #bar {
        position: relative;
        height: 34px;
        /* Keep the lights inside the frame when #term collapses (min mode
           shrink-wraps the frame to the bar; overflow:hidden would clip). */
        min-width: 220px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(#20262e, #171c22);
        border-bottom: 1px solid rgba(255,255,255,.06);
        cursor: grab;
        user-select: none;
      }
      #bar:active { cursor: grabbing; }
      #lights { position: absolute; left: 12px; display: flex; gap: 8px; }
      .light {
        width: 12px; height: 12px; border-radius: 50%;
        cursor: pointer; -webkit-app-region: no-drag;
      }
      .light.red { background: #ff5f57; }
      .light.yellow { background: #febc2e; }
      .light.green { background: #28c840; }
      #title {
        color: #9aa4af;
        font: 600 11px -apple-system, BlinkMacSystemFont, sans-serif;
        letter-spacing: .04em;
      }
      /* Session tabs: one strip shared by every face — a tab switch here
         switches the native window too (the terminal is one object). */
      #tabs { position: absolute; right: 10px; display: flex; gap: 6px; align-items: center; }
      .tab {
        display: flex; align-items: center; gap: 5px;
        height: 20px; padding: 0 8px; border-radius: 5px;
        background: rgba(255,255,255,.06); color: #9aa4af;
        font: 600 10px -apple-system, BlinkMacSystemFont, sans-serif;
        cursor: pointer; max-width: 110px;
      }
      .tab[data-active] { background: rgba(88,166,255,.22); color: #dfe6ee; }
      .tab .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tab .x { opacity: .55; padding: 0 1px; }
      .tab .x:hover { opacity: 1; }
      #newtab {
        width: 18px; height: 18px; border-radius: 5px;
        background: rgba(255,255,255,.06); color: #9aa4af;
        font: 600 13px/18px -apple-system, BlinkMacSystemFont, sans-serif;
        text-align: center; cursor: pointer;
      }
      #newtab:hover { background: rgba(255,255,255,.12); color: #dfe6ee; }
      #term { padding: 8px 10px 10px 10px; }
      /* Context menu. Fixed 28px item height + 6px vertical padding — the e2e
         suite drives this menu by coordinates through the closed shadow root,
         so this geometry is part of the contract. */
      #menu {
        position: absolute;
        z-index: 10;
        display: none;
        min-width: 160px;
        padding: 6px 0;
        background: #1b2129;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 8px;
        box-shadow: 0 10px 30px rgba(0,0,0,.5);
        font: 500 12px -apple-system, BlinkMacSystemFont, sans-serif;
        color: #dfe6ee;
        user-select: none;
      }
      #menu .mi {
        box-sizing: border-box;
        height: 28px;
        line-height: 28px;
        padding: 0 14px;
        cursor: pointer;
        white-space: nowrap;
      }
      #menu .mi:hover { background: rgba(88,166,255,.18); }
      #menu .mi[data-disabled] { opacity: .38; pointer-events: none; }
      #menu .sep { height: 1px; margin: 5px 0; background: rgba(255,255,255,.08); }
      /* Ghost: the terminal area is click-through so the page underneath
         stays usable, but the title bar (and its lights) MUST stay
         interactive — it's the only mouse path out of ghost mode.
         (Opacity is applied inline by applyOpacity().) */
      :host([data-mode="ghost"]) #term { pointer-events: none; }
      /* Minimized: collapse to just the title bar. */
      :host([data-mode="min"]) #term { display: none; }
    </style>
    <div id="frame">
      <div id="bar">
        <div id="lights">
          <span class="light red" id="l-red" title="Hide everywhere (Ctrl+Shift+\\ restores)"></span>
          <span class="light yellow" id="l-yellow" title="Minimize to title bar"></span>
          <span class="light green" id="l-green" title="Toggle ghost (click-through terminal)"></span>
        </div>
        <span id="title">dogsh</span>
        <div id="tabs"></div>
      </div>
      <div id="term"></div>
      <div id="menu"></div>
    </div>
  `;
  const frame = shadow.getElementById('frame')!;
  const bar = shadow.getElementById('bar')!;
  const termEl = shadow.getElementById('term')!;
  const menuEl = shadow.getElementById('menu')!;
  const tabsEl = shadow.getElementById('tabs')!;
  (document.body || document.documentElement).appendChild(host);

  // ---------------------------------------------------------------------
  // Page-awareness: the overlay is translucent, and its three "traffic
  // lights" let the user get it out of the way without leaving the page.
  //   red    = dismiss the overlay on this tab
  //   yellow = ghost mode (click-through + more transparent)
  //   green  = solid & interactive
  // ---------------------------------------------------------------------
  let opacity = 0.72; // see-through by default (60–80% range)
  let mode = 'normal'; // normal | ghost | min | off  (persisted, synced)

  function applyOpacity(): void {
    // Inline on the frame so it reliably wins over stylesheet rules.
    frame.style.opacity = String(mode === 'ghost' ? 0.4 : opacity);
  }

  function setMode(next: string, { persist = true } = {}): void {
    mode = next;
    if (persist) {
      try {
        chrome.storage.local.set({ mode });
      } catch {
        /* extension gone */
      }
    }
    render();
  }

  // Traffic lights: red = dismiss everywhere, yellow = minimize to bar,
  // green = toggle ghost/normal (and un-minimize).
  shadow.getElementById('l-red')!.addEventListener('click', (e) => {
    e.stopPropagation();
    setMode('off');
  });
  shadow.getElementById('l-yellow')!.addEventListener('click', (e) => {
    e.stopPropagation();
    setMode(mode === 'min' ? 'normal' : 'min');
  });
  shadow.getElementById('l-green')!.addEventListener('click', (e) => {
    e.stopPropagation();
    setMode(mode === 'ghost' ? 'normal' : 'ghost');
  });

  // Keyboard escape hatch, works even when the overlay isn't focused:
  //   Ctrl+Shift+\  toggles the overlay off/on everywhere.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault();
        setMode(mode === 'off' ? 'normal' : 'off');
      }
    },
    true
  );

  // ---------------------------------------------------------------------
  // Terminal (identical grid/font/theme to the native face)
  // ---------------------------------------------------------------------
  const term = new Terminal({
    cols: CONFIG.cols,
    rows: CONFIG.rows,
    scrollback: CONFIG.scrollback,
    fontSize: CONFIG.fontSize,
    lineHeight: CONFIG.lineHeight,
    fontFamily: CONFIG.fontFamily,
    theme: CONFIG.theme,
    cursorBlink: true,
    allowProposedApi: true,
    ...CONFIG.termBehavior,
  });
  term.open(termEl);

  // Cmd+click opens URLs in a new tab (never navigates the page under us).
  term.loadAddon(
    new WebLinksAddon((_e, uri) => {
      if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener');
    })
  );

  function cellSize(): { w: number; h: number } | null {
    try {
      // Private API, best-effort debug telemetry only.
      const d = (term as any)._core._renderService.dimensions.css.cell;
      return { w: +d.width.toFixed(2), h: +d.height.toFixed(2) };
    } catch {
      return null;
    }
  }

  // Blank-terminal evidence for tests: the shadow root is closed, so expose
  // "how many viewport rows actually contain text" as a data attribute on the
  // page-DOM host. A revealed overlay with data-rows="0" is the exact bug
  // "the browser terminal doesn't display anything".
  let evidenceTimer: ReturnType<typeof setTimeout> | null = null;
  function updateEvidence(): void {
    if (evidenceTimer) return;
    evidenceTimer = setTimeout(() => {
      evidenceTimer = null;
      let rows = 0;
      try {
        const buf = term.buffer.active;
        for (let i = 0; i < term.rows; i++) {
          const line = buf.getLine(buf.viewportY + i);
          if (line && line.translateToString(true).trim()) rows++;
        }
      } catch {
        /* buffer not ready */
      }
      host.setAttribute('data-rows', String(rows));
      host.setAttribute('data-webgl', webgl ? '1' : '0');
    }, 200);
  }

  // Renderer policy: DOM renderer by default. WebGL was the default and
  // produced repeated "buffer full, screen empty" failures — most damningly,
  // a desk run where the terminal followed with all its data (clipboard
  // readback proved it) while the canvas never painted one glyph. The DOM
  // renderer paints correctly everywhere and is plenty for our fixed grid.
  // WebGL remains available as an explicit opt-in (chrome.storage
  // {webgl:true}) for performance experiments.
  let webgl: WebglAddon | null = null;
  let webglOptIn = false;
  // OS-level focus of this tab's Chrome WINDOW. document.hasFocus() cannot be
  // trusted for this: on macOS, app deactivation often delivers no blur to
  // the renderer, so a tab under another app's window still claims focus.
  // The truth comes from the service worker (chrome.windows API): a startup
  // query plus dogsh-window-focused/blurred pushes. DOM events refine it.
  let windowFocused = document.hasFocus();
  // Am I my window's ACTIVE tab (chrome.tabs truth). The Page Visibility API
  // cannot be trusted for this either: under a capture/screencast session
  // background tabs stay composited, so visibilityState stays 'visible' and
  // visibilitychange never fires. Startup query + dogsh-tab-active pushes.
  let tabActive = document.visibilityState === 'visible';
  try {
    chrome.runtime.sendMessage({ type: 'query-window-focus' }, (res) => {
      void chrome.runtime.lastError;
      if (res && typeof res.focused === 'boolean') {
        windowFocused = res.focused;
        if (typeof res.active === 'boolean') tabActive = res.active;
        updateRenderer();
        // If hello already went out with a baseline the DOM lied about
        // (background tab under a capture session claims 'visible'), heal
        // the ledger — but only DOWNWARD. A disengage correction can only
        // release ownership, never take it, so this stays claim-free.
        const sig = currentSig();
        if (
          bridgeUp &&
          sentBaseline &&
          !(sig.visible && sig.focused) &&
          (sig.visible !== sentBaseline.visible || sig.focused !== sentBaseline.focused)
        ) {
          post({ type: 'signal', ...sig });
        }
      }
    });
  } catch {
    /* extension context torn down */
  }
  function repaint(): void {
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      /* not ready yet */
    }
  }
  function updateRenderer(): void {
    // Even opted-in, WebGL only for a tab the user is actually looking at: a
    // context created for a background/occluded window can composite black
    // and STAY black. Any other state falls back to the DOM renderer.
    const wantWebgl = webglOptIn && document.visibilityState === 'visible' && windowFocused;
    if (wantWebgl && !webgl) {
      try {
        webgl = new WebglAddon();
        term.loadAddon(webgl);
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = null;
          repaint();
        });
      } catch (e) {
        console.debug('[dogsh] webgl unavailable, DOM renderer fallback:', (e as Error)?.message);
        webgl = null; // DOM renderer fallback
      }
      repaint();
    } else if (!wantWebgl && webgl) {
      webgl.dispose();
      webgl = null;
      repaint();
    }
  }
  // ---------------------------------------------------------------------
  // Bridge to daemon via the offscreen document
  // ---------------------------------------------------------------------
  let port: chrome.runtime.Port | null = null;
  let alive = true;
  let bridgeUp = false;
  // The baseline sig the last hello carried; lets the startup truth query
  // correct a DOM lie that already reached the daemon (see below).
  let sentBaseline: { visible: boolean; focused: boolean } | null = null;

  // Durable face identity (v6): random per page load. The daemon's ledger is
  // keyed by it, so a bridge blip (MV3 killing the extension service worker
  // drops every port) reconnects as the SAME face — ownership held, no
  // flicker, no re-arbitration. A real navigation is a genuinely new face.
  const faceKey = `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

  function post(msg: DogshClientMsg): void {
    try {
      if (port) port.postMessage(msg);
    } catch {
      /* disconnected mid-flight */
    }
  }

  function connect(): void {
    if (!alive) return;
    let extensionGone = false;
    try {
      chrome.runtime.sendMessage({ type: 'ensure-offscreen' }, () => {
        void chrome.runtime.lastError;
        try {
          // e2e isolation: a portOverride (set only in the test browser's
          // profile) rides in the port NAME because the offscreen document
          // that owns the socket can only use chrome.runtime APIs.
          port = chrome.runtime.connect({
            name: portOverride ? `dogsh-tab#${portOverride}` : 'dogsh-tab',
          });
        } catch {
          extensionGone = true;
          return;
        }
        port.onMessage.addListener(onBridgeMessage);
        port.onDisconnect.addListener(() => {
          port = null;
          bridgeUp = false;
          hideNow();
          if (alive) setTimeout(connect, 2000);
        });
      });
    } catch {
      extensionGone = true;
    }
    if (extensionGone) alive = false; // extension reloaded; this world is dead
  }

  // Identity/attachment, learned from hello-ack. sessionId rides on every
  // session-scoped message we send; myId lets owner-state tell us whether WE
  // are the owner; lastGen drops a stale owner-state that reordered across a
  // reconnect window.
  let myId: number | null = null;
  let sessionId: number | null = null;
  let lastGen = 0;

  // Session tab strip (max 2 sessions for now). One strip shared by every
  // face: switching here switches everywhere, because all faces display the
  // daemon's single ACTIVE session.
  function renderTabs(list: DogshSessionListMsg): void {
    // e2e evidence (the shadow root is closed by design): what the strip
    // SHOWS — session count and which tab is marked active. Same pattern as
    // data-rows: coarse, observable, no content leaves the shadow root.
    host.setAttribute('data-sessions', String(list.sessions.length));
    host.setAttribute('data-session-active', String(list.active));
    tabsEl.textContent = '';
    for (const s of list.sessions) {
      const tab = document.createElement('div');
      tab.className = 'tab';
      if (s.id === list.active) tab.setAttribute('data-active', '');
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = s.title || `shell ${s.id}`;
      tab.title = s.title || `shell ${s.id}`;
      tab.appendChild(label);
      if (list.sessions.length > 1) {
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.title = 'Close this session (kills its shell)';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          post({ type: 'session-close', sessionId: s.id });
        });
        tab.appendChild(x);
      }
      tab.addEventListener('click', () => {
        if (s.id !== list.active) post({ type: 'session-switch', sessionId: s.id });
        term.focus();
      });
      tabsEl.appendChild(tab);
    }
    if (list.sessions.length < list.max) {
      const plus = document.createElement('div');
      plus.id = 'newtab';
      plus.textContent = '+';
      plus.title = 'New session';
      plus.addEventListener('click', () => {
        post({ type: 'session-create' });
        term.focus();
      });
      tabsEl.appendChild(plus);
    }
  }

  // Stale-ordering guard: returns false (and the message must be ignored) if
  // a newer generation has already been seen. Messages without gen (from the
  // daemon's non-ownership paths) always pass.
  function freshGen(msg: { gen?: number }): boolean {
    if (typeof msg.gen !== 'number') return true;
    if (msg.gen < lastGen) return false;
    lastGen = msg.gen;
    return true;
  }

  function onBridgeMessage(msg: DogshBridgeMsg): void {
    switch (msg.type) {
      case 'bridge-up':
        bridgeUp = true;
        sentBaseline = currentSig();
        post({
          type: 'hello',
          surface: 'tab',
          href: location.href,
          proto: CONFIG.protocolVersion,
          faceKey,
          // Baseline levels ride in the hello: a DESCRIPTION of this tab as
          // it stands. The daemon trusts it as state, never as a user action
          // — a reconnect cannot win ownership with it.
          sig: sentBaseline,
          // Fixed grid today; the dynamic-resize milestone starts computing
          // this from the frame size. canResize flags that this face could.
          caps: { cols: CONFIG.cols, rows: CONFIG.rows, canResize: false },
        });
        // If a REAL event fired while the bridge was down (user switched to
        // this tab mid-blip), deliver it now as one live signal — exactly
        // once, exactly the event that couldn't be delivered at the time. A
        // tab where nothing happened has nothing pending, so reconnect storms
        // move nothing.
        if (signalPending) {
          signalPending = false;
          post({ type: 'signal', ...currentSig() });
        }
        updateRenderer();
        break;
      case 'hello-ack':
        myId = msg.clientId;
        sessionId = msg.sessionId;
        if (typeof msg.gen === 'number') lastGen = msg.gen;
        // If the daemon already considers this tab the owner (reattach after
        // an extension reload mid-ownership), restore the overlay.
        if (msg.owner === myId && !owned) reveal();
        break;
      case 'session-list':
        sessionId = msg.active; // every face displays the active session
        renderTabs(msg);
        break;
      case 'owner-state': {
        // THE single source of display truth (v6): render it, never react to
        // it with reports — a report triggered by a broadcast is a feedback
        // loop, and one of those was the old self-heal metronome. Transitions
        // involving the native window fly (prevOwner/nativeBounds); tab->tab
        // cuts instantly so the "it never moved" illusion holds. The 2s
        // re-assert repeats prevOwner === owner, so it can only correct a
        // wrong DISPLAY, never replay a flight.
        if (!freshGen(msg)) break;
        const iOwn = msg.owner === myId;
        if (iOwn && !owned) {
          if (msg.prevOwner === 'native') flyIn(msg.nativeBounds);
          else reveal();
        } else if (!iOwn && owned) {
          if (msg.owner === 'native') flyOut(msg.nativeBounds);
          else hideNow();
        }
        break;
      }
      case 'stale':
        // Daemon says this build is outdated (it also printed instructions
        // into this terminal). Make it impossible to miss in the chrome too.
        shadow.getElementById('title')!.textContent = 'dogsh — extension outdated, reload it';
        shadow.getElementById('title')!.style.color = '#e3b341';
        break;
      case 'bridge-down':
        hideNow();
        break;
      case 'snapshot':
        // Snapshots (re)attach this face to a session: initial hello, a
        // backpressure resync, or a session SWITCH (tabs) all land here.
        if (msg.sessionId != null) sessionId = msg.sessionId;
        // The session may be running a different grid than this face's
        // default (another face owned it and resized); match before writing
        // or the snapshot wraps wrong.
        if (msg.cols && msg.rows && (term.cols !== msg.cols || term.rows !== msg.rows)) {
          term.resize(msg.cols, msg.rows);
        }
        term.reset();
        term.write(msg.data, () => {
          console.debug(
            `[dogsh] snapshot applied: ${msg.data.length}b, cell=${JSON.stringify(
              cellSize()
            )}, webgl=${!!webgl}`
          );
          updateEvidence();
        });
        break;
      case 'grid':
        // Owner-drives-size: whoever owns the terminal set this grid; every
        // face follows so the buffers reflow identically everywhere and a
        // later handoff needs no resync.
        if (msg.cols && msg.rows && (term.cols !== msg.cols || term.rows !== msg.rows)) {
          term.resize(msg.cols, msg.rows);
          repaint();
          updateEvidence();
        }
        break;
      case 'data':
        term.write(msg.data, updateEvidence);
        break;
      case 'clear':
        // Another face (or this one) cleared the session; the daemon already
        // wiped its mirror so future snapshots agree.
        term.clear();
        updateEvidence();
        break;
      case 'session-exit':
        // Only annotate the buffer the user is LOOKING at; a background
        // session dying just disappears from the tab strip (the daemon
        // follows up with an updated session-list).
        if (msg.sessionId == null || msg.sessionId === sessionId) {
          term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n');
        }
        break;
    }
  }

  term.onData((data) => post({ type: 'input', sessionId, data }));

  // ---------------------------------------------------------------------
  // Editing: same commands as the native face (menu bar there, context menu
  // and Cmd-keys here), same daemon-side semantics.
  // ---------------------------------------------------------------------
  async function writeClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* insecure page or focus quirk — fall through */
    }
    // Fallback: a transient textarea inside our shadow root + execCommand.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    frame.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* nothing left to try */
    }
    ta.remove();
    term.focus();
  }

  async function doEdit(cmd: string): Promise<void> {
    if (cmd === 'copy') {
      if (term.hasSelection()) await writeClipboard(term.getSelection());
    } else if (cmd === 'paste') {
      let text: string | null = null;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        /* fall through */
      }
      if (text) {
        term.paste(text); // handles bracketed paste with the running app
      } else {
        // Insecure page fallback: let the browser paste into xterm's own
        // textarea (works because the manifest holds clipboardRead).
        term.focus();
        try {
          document.execCommand('paste');
        } catch {
          /* nothing left to try */
        }
      }
    } else if (cmd === 'selectAll') {
      term.selectAll();
    } else if (cmd === 'clear') {
      post({ type: 'clear', sessionId }); // durable: daemon wipes mirror + every face
    }
  }

  // Cmd shortcuts, resolved before xterm turns keys into pty input. Plain
  // Ctrl+C/Ctrl+V still reach the shell as ^C/^V like any terminal.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey || e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) {
      e.preventDefault();
      doEdit('copy');
      return false;
    }
    if (k === 'v') {
      e.preventDefault();
      doEdit('paste');
      return false;
    }
    if (k === 'a') {
      e.preventDefault();
      doEdit('selectAll');
      return false;
    }
    if (k === 'k') {
      e.preventDefault();
      doEdit('clear');
      return false;
    }
    return true;
  });

  // Context menu (shadow DOM — page CSS can't touch it, we can't use a native
  // menu from a content script). Item order is fixed: tests click by index.
  const MENU_ITEMS = [
    { cmd: 'copy', label: 'Copy' },
    { cmd: 'paste', label: 'Paste' },
    { cmd: 'selectAll', label: 'Select All' },
    { cmd: 'clear', label: 'Clear' },
  ];
  function closeMenu(): void {
    menuEl.style.display = 'none';
    menuEl.textContent = '';
  }
  function openMenu(clientX: number, clientY: number): void {
    menuEl.textContent = '';
    for (const item of MENU_ITEMS) {
      const el = document.createElement('div');
      el.className = 'mi';
      el.textContent = item.label;
      if (item.cmd === 'copy' && !term.hasSelection()) el.setAttribute('data-disabled', '');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        doEdit(item.cmd);
        term.focus();
      });
      menuEl.appendChild(el);
    }
    const fr = frame.getBoundingClientRect();
    menuEl.style.left = '0px';
    menuEl.style.top = '0px';
    menuEl.style.display = 'block';
    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    const x = Math.max(0, Math.min(clientX - fr.left, fr.width - mw));
    const y = Math.max(0, Math.min(clientY - fr.top, fr.height - mh));
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
  }
  // Chrome moves focus on mousedown over non-focusable elements — which would
  // blur xterm's hidden textarea and kill keyboard input after any menu use.
  menuEl.addEventListener('mousedown', (e) => e.preventDefault());
  termEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  });
  // Any press outside the menu dismisses it (capture: shadow keeps it local).
  shadow.addEventListener(
    'pointerdown',
    (e) => {
      if (menuEl.style.display !== 'none' && !menuEl.contains(e.target as Node)) closeMenu();
    },
    true
  );
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuEl.style.display !== 'none') {
      e.stopPropagation();
      closeMenu();
    }
  });

  // ---------------------------------------------------------------------
  // Signal reports (v6): ONE reporter, fed only by real events. Every source
  // below is edge-triggered by something that actually happened — a DOM
  // visibility/focus event or a service-worker push from a real
  // chrome.windows focus change. Nothing here fires on a timer, and nothing
  // fires in reaction to daemon traffic; that discipline (each real event
  // moves ownership at most once) is what makes oscillation impossible.
  //
  // The two facts and where their truth comes from:
  //   visible — "I am my window's active tab AND the renderer says visible".
  //     Both legs are needed: chrome.tabs.onActivated (relayed by the
  //     service worker) is the browser's own definition of a tab switch and
  //     works even when a capture session keeps background tabs composited
  //     (which freezes the Page Visibility API — no visibilitychange ever
  //     fires); visibilityState still covers minimized/occluded windows
  //     where the active tab genuinely isn't displayed.
  //   focused — OS-level focus of this tab's Chrome WINDOW, owned by the
  //     service worker (chrome.windows API): a startup query plus
  //     focused/blurred pushes. document.hasFocus() cannot be trusted for
  //     this: on macOS, app deactivation often delivers no blur to the
  //     renderer, so a tab under another app's window still claims focus.
  //     DOM focus/blur refine it between pushes.
  // ---------------------------------------------------------------------
  function currentSig(): { visible: boolean; focused: boolean } {
    return {
      visible: tabActive && document.visibilityState === 'visible',
      focused: windowFocused,
    };
  }
  let signalPending = false; // a real event fired while the bridge was down
  function reportSignal(): void {
    if (bridgeUp) post({ type: 'signal', ...currentSig() });
    else signalPending = true; // delivered once, right after reconnect
    updateRenderer();
    // Hidden tabs throttle rendering; never come back stale.
    if (document.visibilityState === 'visible') repaint();
  }
  window.addEventListener('focus', () => {
    windowFocused = true;
    reportSignal();
  });
  window.addEventListener('blur', () => {
    windowFocused = false;
    reportSignal();
  });
  window.addEventListener('pageshow', () => reportSignal());
  document.addEventListener('visibilitychange', () => reportSignal());
  // Chrome-window-level focus pushes, relayed by the service worker from
  // chrome.windows.onFocusChanged (to every tab of the affected windows).
  // When the user cmd-tabs back to Chrome the renderer often gets NO DOM
  // event (its focus state never changed from its own point of view), so
  // without this relay the terminal fails to follow. Same relay for
  // chrome.tabs.onActivated: a tab switch under a capture session produces
  // no renderer event either (see the visible-fact comment above).
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'dogsh-window-focused') {
        windowFocused = true;
        reportSignal();
      } else if (msg.type === 'dogsh-window-blurred') {
        windowFocused = false;
        reportSignal();
      } else if (msg.type === 'dogsh-tab-active') {
        tabActive = !!msg.active;
        reportSignal();
      }
    });
  } catch {
    /* extension context torn down */
  }

  // ---------------------------------------------------------------------
  // Visibility model.
  //   owned : does the daemon currently place the terminal in THIS tab
  //   mode  : user's display preference, persisted + synced across tabs
  //           'normal' interactive & translucent
  //           'ghost'  click-through & more transparent
  //           'min'    collapsed to the title bar (terminal hidden)
  //           'off'    hidden everywhere until explicitly restored
  // The overlay is visible only when (owned && mode !== 'off').
  // Native<->tab handoffs fly (FLIP against the real window's screen rect);
  // tab->tab stays instant so the "it never moved" illusion holds. Every fly
  // path degrades to the instant reveal/hide if anything about the rect or
  // the environment is unusable.
  // ---------------------------------------------------------------------
  let owned = false;

  // The daemon reports the native window in *screen* coordinates. Convert to
  // this tab's viewport, accounting for Chrome's window chrome (tab strip +
  // toolbar are all above the viewport).
  function screenToViewport(rect: DogshRect | null | undefined): DogshRect | null {
    if (!rect || !Number.isFinite(rect.x) || !(rect.width > 50) || !(rect.height > 50)) {
      return null;
    }
    const chromeTop = window.outerHeight - window.innerHeight;
    const chromeLeft = (window.outerWidth - window.innerWidth) / 2;
    return {
      x: rect.x - (window.screenX + chromeLeft),
      y: rect.y - (window.screenY + chromeTop),
      width: rect.width,
      height: rect.height,
    };
  }

  let anim: Animation | null = null;
  function animateFrame(keyframes: Keyframe[], onDone?: () => void): void {
    if (anim) anim.cancel();
    anim = frame.animate(keyframes, {
      duration: CONFIG.flyMs,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
    anim.onfinish = () => {
      anim = null;
      if (onDone) onDone();
    };
    anim.oncancel = () => {
      anim = null;
    };
  }

  interface FlipDelta {
    dx: number;
    dy: number;
    sx: number;
    sy: number;
  }

  function flipDelta(fromRect: DogshRect, toRect: DogshRect): FlipDelta | null {
    const dx = fromRect.x - toRect.x;
    const dy = fromRect.y - toRect.y;
    // A rect on another display (or a bogus conversion) would fling the frame
    // across half the desktop; treat it as unusable instead.
    if (Math.abs(dx) > 5000 || Math.abs(dy) > 5000) return null;
    return {
      dx,
      dy,
      sx: fromRect.width / toRect.width,
      sy: fromRect.height / toRect.height,
    };
  }

  function flyIn(fromScreen: DogshRect | null | undefined): void {
    reveal(); // instant reveal first: the fly is decoration on top of it
    if (mode === 'off' || mode === 'min') return;
    const from = screenToViewport(fromScreen);
    if (!from || document.visibilityState !== 'visible') return;
    try {
      const last = frame.getBoundingClientRect();
      if (!last.width || !last.height) return;
      const d = flipDelta(from, last);
      if (!d) return;
      animateFrame([
        { transform: `translate(${d.dx}px, ${d.dy}px) scale(${d.sx}, ${d.sy})` },
        { transform: 'translate(0, 0) scale(1, 1)' },
      ]);
    } catch {
      /* already visible via reveal() */
    }
  }

  function flyOut(toScreen: DogshRect | null | undefined): void {
    const to = screenToViewport(toScreen);
    const animatable =
      owned && mode !== 'off' && mode !== 'min' && to && document.visibilityState === 'visible';
    if (!animatable) return hideNow();
    // Whatever happens to the animation (throttled tab, context torn down),
    // the overlay must end hidden.
    const failsafe = setTimeout(hideNow, CONFIG.flyMs + 150);
    try {
      const first = frame.getBoundingClientRect();
      const d = first.width && first.height ? flipDelta(to, first) : null;
      if (!d) {
        clearTimeout(failsafe);
        return hideNow();
      }
      animateFrame(
        [
          { transform: 'translate(0, 0) scale(1, 1)', opacity: frame.style.opacity || 1 },
          {
            transform: `translate(${d.dx}px, ${d.dy}px) scale(${d.sx}, ${d.sy})`,
            opacity: 0.15,
          },
        ],
        () => {
          clearTimeout(failsafe);
          hideNow();
        }
      );
    } catch {
      clearTimeout(failsafe);
      hideNow();
    }
  }

  function render(): void {
    const show = owned && mode !== 'off';
    host.style.visibility = show ? 'visible' : 'hidden';
    host.setAttribute('data-mode', mode);
    applyOpacity();
    if (!show) {
      term.blur();
      return;
    }
    applyDock();
    if (mode !== 'min') {
      updateRenderer();
      term.focus();
      repaint(); // never reveal a stale/black frame
      // Again on the next frame: writes that landed while this tab was
      // hidden/throttled may have been coalesced away; the post-visibility
      // frame is the one the compositor actually shows.
      requestAnimationFrame(() => repaint());
    }
    updateEvidence();
  }

  // Ownership-transition counter, exposed like data-rows (the shadow root is
  // closed). A stable overlay flips exactly once per handoff; a climbing
  // counter with no user action is the "ownership metronome" bug class made
  // observable — the e2e asserts stability windows against it.
  let flipCount = 0;
  function noteFlip(nowOwned: boolean): void {
    if (nowOwned === owned) return;
    flipCount++;
    host.setAttribute('data-flips', String(flipCount));
  }
  function reveal(): void {
    noteFlip(true);
    owned = true;
    render();
  }
  function hideNow(): void {
    noteFlip(false);
    owned = false;
    if (anim) anim.cancel(); // a hide always beats an in-flight fly
    render();
  }

  // ---------------------------------------------------------------------
  // Dock position: anchored bottom-right, draggable, synced across tabs so
  // the tab->tab illusion ("it never moved") holds.
  // ---------------------------------------------------------------------
  let dock = { right: 24, bottom: 24 };
  let portOverride = 0;

  function applyDock(): void {
    host.style.right = `${dock.right}px`;
    host.style.bottom = `${dock.bottom}px`;
  }

  function loadSettings(done: () => void): void {
    applyOpacity();
    try {
      chrome.storage.local.get(['dock', 'webgl', 'mode', 'opacity', 'portOverride'], (res) => {
        void chrome.runtime.lastError;
        if (res && Number(res.portOverride)) portOverride = Number(res.portOverride);
        if (res && res.dock) {
          dock = res.dock as typeof dock;
          applyDock();
        }
        if (res && typeof res.opacity === 'number') opacity = res.opacity;
        if (res && typeof res.mode === 'string') mode = res.mode;
        webglOptIn = !!(res && res.webgl);
        render();
        done();
      });
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.mode && typeof changes.mode.newValue === 'string') {
          setMode(changes.mode.newValue, { persist: false });
        }
        if (changes.opacity && typeof changes.opacity.newValue === 'number') {
          opacity = changes.opacity.newValue;
          applyOpacity();
        }
        if (changes.dock) {
          dock = changes.dock.newValue as typeof dock;
          applyDock();
        }
        if (changes.webgl) {
          webglOptIn = !!changes.webgl.newValue;
          updateRenderer();
        }
      });
    } catch {
      done(); // storage unavailable; keep defaults
    }
  }

  bar.addEventListener('pointerdown', (e) => {
    // preventDefault() on pointerdown suppresses the derived click event —
    // running it for presses on the traffic lights made every button dead.
    // Same rule for the session tabs.
    const target = e.target as Element | null;
    if (target && target.closest && target.closest('#lights, #tabs')) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, right: dock.right, bottom: dock.bottom };
    const onMove = (ev: PointerEvent) => {
      dock.right = Math.max(0, start.right - (ev.clientX - start.x));
      dock.bottom = Math.max(0, start.bottom - (ev.clientY - start.y));
      applyDock();
    };
    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      try {
        chrome.storage.local.set({ dock });
      } catch {
        /* extension gone */
      }
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
  });

  // Settings first, then connect — renderer choice must be known before the
  // first reveal.
  loadSettings(connect);
})();
