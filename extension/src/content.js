// dogsh tab face. Pre-warmed, always-attached xterm.js overlay in a Shadow DOM.
// The daemon decides when this tab owns the terminal; we only reveal/hide.
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import xtermCss from '@xterm/xterm/css/xterm.css';
import CONFIG from '../../app/shared/config.js';

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
    console.debug('[dogsh] nerd font load failed, falling back to Menlo:', e && e.message);
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
      </div>
      <div id="term"></div>
      <div id="menu"></div>
    </div>
  `;
  const frame = shadow.getElementById('frame');
  const bar = shadow.getElementById('bar');
  const termEl = shadow.getElementById('term');
  const menuEl = shadow.getElementById('menu');
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

  function applyOpacity() {
    // Inline on the frame so it reliably wins over stylesheet rules.
    frame.style.opacity = String(mode === 'ghost' ? 0.4 : opacity);
  }

  function setMode(next, { persist = true } = {}) {
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
  shadow.getElementById('l-red').addEventListener('click', (e) => {
    e.stopPropagation();
    setMode('off');
  });
  shadow.getElementById('l-yellow').addEventListener('click', (e) => {
    e.stopPropagation();
    setMode(mode === 'min' ? 'normal' : 'min');
  });
  shadow.getElementById('l-green').addEventListener('click', (e) => {
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

  function cellSize() {
    try {
      const d = term._core._renderService.dimensions.css.cell;
      return { w: +d.width.toFixed(2), h: +d.height.toFixed(2) };
    } catch {
      return null;
    }
  }

  // Blank-terminal evidence for tests: the shadow root is closed, so expose
  // "how many viewport rows actually contain text" as a data attribute on the
  // page-DOM host. A revealed overlay with data-rows="0" is the exact bug
  // "the browser terminal doesn't display anything".
  let evidenceTimer = null;
  function updateEvidence() {
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

  // WebGL renderer only while this tab is visible — Chrome caps live WebGL
  // contexts, and a hidden tab does not need GPU rendering. `noWebgl` (set in
  // chrome.storage) forces the DOM renderer: needed for headless video
  // capture, where WebGL canvases composite as black frames.
  let webgl = null;
  let noWebgl = false;
  // OS-level focus of this tab's Chrome WINDOW. document.hasFocus() cannot be
  // trusted for this: on macOS, app deactivation often delivers no blur to
  // the renderer, so a tab under another app's window still claims focus.
  // The truth comes from the service worker (chrome.windows API): a startup
  // query plus dogsh-window-focused/blurred pushes. DOM events refine it.
  let windowFocused = document.hasFocus();
  try {
    chrome.runtime.sendMessage({ type: 'query-window-focus' }, (res) => {
      void chrome.runtime.lastError;
      if (res && typeof res.focused === 'boolean') {
        windowFocused = res.focused;
        updateRenderer();
      }
    });
  } catch {
    /* extension context torn down */
  }
  function repaint() {
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      /* not ready yet */
    }
  }
  function updateRenderer() {
    // WebGL only for a tab the user is actually looking at: a context created
    // for a background/occluded window can composite black and STAY black —
    // buffer full, screen empty (found on desk: ls -la followed as data but
    // painted nothing). Hence the strict windowFocused gate.
    // The DOM renderer always paints correctly and is plenty for our grid, so
    // any other state falls back to it.
    const wantWebgl =
      document.visibilityState === 'visible' && windowFocused && !noWebgl;
    if (wantWebgl && !webgl) {
      try {
        webgl = new WebglAddon();
        term.loadAddon(webgl);
        webgl.onContextLoss(() => {
          webgl.dispose();
          webgl = null;
          repaint();
        });
      } catch (e) {
        console.debug('[dogsh] webgl unavailable, DOM renderer fallback:', e && e.message);
        webgl = null; // DOM renderer fallback
      }
      repaint();
    } else if (!wantWebgl && webgl) {
      webgl.dispose();
      webgl = null;
      repaint();
    }
  }
  window.addEventListener('blur', () => {
    windowFocused = false;
    updateRenderer();
  });

  // ---------------------------------------------------------------------
  // Bridge to daemon via the offscreen document
  // ---------------------------------------------------------------------
  let port = null;
  let alive = true;

  function post(msg) {
    try {
      if (port) port.postMessage(msg);
    } catch {
      /* disconnected mid-flight */
    }
  }

  function connect() {
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
          hideNow();
          if (alive) setTimeout(connect, 2000);
        });
      });
    } catch {
      extensionGone = true;
    }
    if (extensionGone) alive = false; // extension reloaded; this world is dead
  }

  function onBridgeMessage(msg) {
    switch (msg.type) {
      case 'bridge-up':
        post({
          type: 'hello',
          surface: 'tab',
          href: location.href,
          proto: CONFIG.protocolVersion,
        });
        // A bridge (re)connect is NOT a user action. Claim only if the user is
        // demonstrably here (window OS-focused), otherwise a visible-but-
        // background tab steals the terminal from the native window the user
        // is typing in. (visibility alone is the right signal for tab
        // *switches*; window focus is the right signal for *connects* —
        // and windowFocused, not document.hasFocus(), because the latter
        // stays true on macOS when another app's window covers this one.)
        if (document.visibilityState === 'visible' && windowFocused) {
          post({ type: 'focus' });
        }
        updateRenderer();
        break;
      case 'stale':
        // Daemon says this build is outdated (it also printed instructions
        // into this terminal). Make it impossible to miss in the chrome too.
        shadow.getElementById('title').textContent = 'dogsh — extension outdated, reload it';
        shadow.getElementById('title').style.color = '#e3b341';
        break;
      case 'bridge-down':
        hideNow();
        break;
      case 'snapshot':
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
      case 'data':
        term.write(msg.data, updateEvidence);
        break;
      case 'clear':
        // Another face (or this one) cleared the session; the daemon already
        // wiped its mirror so future snapshots agree.
        term.clear();
        updateEvidence();
        break;
      case 'reveal':
        if (msg.mode === 'fly') flyIn(msg.from);
        else reveal();
        break;
      case 'hide':
        if (msg.mode === 'fly') flyOut(msg.to);
        else hideNow();
        break;
      case 'session-exit':
        term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n');
        break;
    }
  }

  term.onData((data) => post({ type: 'input', data }));

  // ---------------------------------------------------------------------
  // Editing: same commands as the native face (menu bar there, context menu
  // and Cmd-keys here), same daemon-side semantics.
  // ---------------------------------------------------------------------
  async function writeClipboard(text) {
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

  async function doEdit(cmd) {
    if (cmd === 'copy') {
      if (term.hasSelection()) await writeClipboard(term.getSelection());
    } else if (cmd === 'paste') {
      let text = null;
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
      post({ type: 'clear' }); // durable: daemon wipes mirror + every face
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
  function closeMenu() {
    menuEl.style.display = 'none';
    menuEl.textContent = '';
  }
  function openMenu(clientX, clientY) {
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
      if (menuEl.style.display !== 'none' && !menuEl.contains(e.target)) closeMenu();
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
  // Focus claims: a *visible* tab = "the user is looking at this tab".
  // Visibility (not document.hasFocus) is the reliable signal — an in-window
  // tab switch fires visibilitychange without a window 'focus' event, and
  // hasFocus() is often still false the instant the tab becomes visible, which
  // was silently dropping tab->tab handoffs. The daemon dedups repeat claims.
  // ---------------------------------------------------------------------
  function reportFocus() {
    if (document.visibilityState === 'visible') {
      post({ type: 'focus' });
    }
    updateRenderer();
    repaint(); // hidden tabs throttle rendering; never come back stale
  }
  window.addEventListener('focus', () => {
    windowFocused = true;
    reportFocus();
  });
  window.addEventListener('pageshow', reportFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reportFocus();
    else {
      post({ type: 'blur' });
      updateRenderer();
    }
  });
  // Chrome-window-level focus, relayed by the service worker from
  // chrome.windows.onFocusChanged. When the user cmd-tabs back to Chrome the
  // renderer often gets NO DOM event (its focus state never changed from its
  // own point of view), so without this relay the terminal fails to follow.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'dogsh-window-focused') {
        windowFocused = true;
        // A context created while this window was occluded can be composited
        // black permanently. Now that the window truly has OS focus, throw
        // away any existing context; updateRenderer (via reportFocus) builds
        // a fresh one that is guaranteed born on a visible surface.
        if (webgl) {
          webgl.dispose();
          webgl = null;
        }
        reportFocus();
      } else if (msg.type === 'dogsh-window-blurred') {
        windowFocused = false;
        post({ type: 'blur' });
        updateRenderer();
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
  function screenToViewport(rect) {
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

  let anim = null;
  function animateFrame(keyframes, onDone) {
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

  function flipDelta(fromRect, toRect) {
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

  function flyIn(fromScreen) {
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

  function flyOut(toScreen) {
    const to = screenToViewport(toScreen);
    const animatable =
      owned && mode !== 'off' && mode !== 'min' && to && document.visibilityState === 'visible';
    if (!animatable) return hideNow();
    // Whatever happens to the animation (throttled tab, context torn down),
    // the overlay must end hidden.
    const failsafe = setTimeout(hideNow, CONFIG.flyMs + 150);
    try {
      const first = frame.getBoundingClientRect();
      const d = first.width && first.height && flipDelta(to, first);
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

  function render() {
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
    }
    updateEvidence();
  }

  function reveal() {
    owned = true;
    render();
  }
  function hideNow() {
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

  function applyDock() {
    host.style.right = `${dock.right}px`;
    host.style.bottom = `${dock.bottom}px`;
  }

  function loadSettings(done) {
    applyOpacity();
    try {
      chrome.storage.local.get(['dock', 'noWebgl', 'mode', 'opacity', 'portOverride'], (res) => {
        void chrome.runtime.lastError;
        if (res && Number(res.portOverride)) portOverride = Number(res.portOverride);
        if (res && res.dock) {
          dock = res.dock;
          applyDock();
        }
        if (res && typeof res.opacity === 'number') opacity = res.opacity;
        if (res && typeof res.mode === 'string') mode = res.mode;
        noWebgl = !!(res && res.noWebgl);
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
          dock = changes.dock.newValue;
          applyDock();
        }
        if (changes.noWebgl) {
          noWebgl = !!changes.noWebgl.newValue;
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
    if (e.target && e.target.closest && e.target.closest('#lights')) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, right: dock.right, bottom: dock.bottom };
    const onMove = (ev) => {
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
