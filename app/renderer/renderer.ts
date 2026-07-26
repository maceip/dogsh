// Native face: a plain xterm.js client of the local daemon. Identical grid,
// font, and theme to the browser faces so handoffs read as one object.
//
// SCRIPT-KIND FILE (no import/export): loaded via a bare <script> tag after
// xterm's UMD bundles and shared/config.js. Types come from the ambient
// declarations in ../types/ (globals.d.ts, protocol.d.ts).
(async () => {
  const C = DOGSH_CONFIG;

  // Load the bundled Nerd Font before the terminal measures cell metrics —
  // the shell prompt (p10k) and eza --icons use private-use glyphs.
  try {
    const fonts = await Promise.all([
      new FontFace('MesloLGS NF', 'url(../shared/fonts/MesloLGS-NF-Regular.ttf)').load(),
      new FontFace('MesloLGS NF', 'url(../shared/fonts/MesloLGS-NF-Bold.ttf)', {
        weight: 'bold',
      }).load(),
    ]);
    fonts.forEach((f) => document.fonts.add(f));
  } catch (e) {
    console.warn('nerd font load failed, falling back to Menlo', e);
  }

  const term = new Terminal({
    cols: C.cols,
    rows: C.rows,
    scrollback: C.scrollback,
    fontSize: C.fontSize,
    lineHeight: C.lineHeight,
    fontFamily: C.fontFamily,
    theme: C.theme,
    cursorBlink: true,
    allowProposedApi: true,
    ...C.termBehavior,
  });
  term.open(document.getElementById('term')!);

  // Cmd+click opens URLs in the default browser (never inside this window).
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.dogsh.openExternal(uri)));

  // Dynamic grid: fit proposes {cols, rows} for the #term box (it accounts
  // for the padding). Clamps mirror the daemon's Session.resize() bounds so
  // a proposal is never silently corrected server-side.
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  function fittedDims(): { cols: number; rows: number } | null {
    try {
      const d = fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
      return {
        cols: Math.max(20, Math.min(500, d.cols)),
        rows: Math.max(5, Math.min(200, d.rows)),
      };
    } catch {
      return null;
    }
  }

  let webgl: InstanceType<typeof WebglAddon.WebglAddon> | null = null;
  function loadWebgl(): void {
    try {
      webgl = new WebglAddon.WebglAddon();
      term.loadAddon(webgl);
      // If the GPU context is lost (window hidden/suspended), drop to the DOM
      // renderer instead of showing a blank terminal.
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
    } catch (e) {
      console.warn('webgl renderer unavailable, using DOM renderer', e);
      webgl = null;
    }
  }
  loadWebgl();

  function repaint(): void {
    if (!webgl) loadWebgl(); // GPU context may have been lost while hidden
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      /* not ready yet */
    }
    term.focus();
  }

  // Main process asks us to repaint whenever the window is (re)shown.
  // Caps reporting is wired below so reveal also refits the PTY.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') repaint();
  });

  let ws: WebSocket | undefined;
  // v5 attachment identity, learned from hello-ack; rides on every
  // session-scoped message this face sends.
  let sessionId: number | null = null;
  // Display + input authority: only the owning face shows the live grid and
  // accepts keystrokes. Window stays visible when away (tiled demos); #away
  // covers the pixels so the terminal isn't drawn in two places.
  let owned = true;
  const awayEl = document.getElementById('away');
  function setOwned(next: boolean): void {
    owned = next;
    if (awayEl) {
      if (next) awayEl.removeAttribute('data-on');
      else awayEl.setAttribute('data-on', '');
    }
    if (!next) {
      try {
        term.blur();
      } catch {
        /* ignore */
      }
    } else {
      try {
        term.focus();
      } catch {
        /* ignore */
      }
    }
  }
  if (awayEl) {
    awayEl.addEventListener('mousedown', () => {
      // Click-to-reclaim: preload already sends user-present; focus so the
      // host focus signal can land after quiet clears.
      try {
        term.focus();
      } catch {
        /* ignore */
      }
    });
  }

  // Session tab strip (max 2 for now) — same strip as the browser overlay's;
  // the daemon keeps them in lockstep across every face.
  const tabsEl = document.getElementById('tabs')!;
  function sendJ(msg: DogshClientMsg): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
  function renderTabs(list: DogshSessionListMsg): void {
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
          sendJ({ type: 'session-close', sessionId: s.id });
        });
        tab.appendChild(x);
      }
      tab.addEventListener('click', () => {
        if (s.id !== list.active) sendJ({ type: 'session-switch', sessionId: s.id });
        term.focus();
      });
      tabsEl.appendChild(tab);
    }
    if (list.sessions.length < list.max) {
      const plus = document.createElement('div');
      plus.id = 'newtab';
      plus.textContent = '+';
      plus.title = 'New session (Cmd+T)';
      plus.addEventListener('click', () => {
        sendJ({ type: 'session-create' });
        term.focus();
      });
      tabsEl.appendChild(plus);
    }
  }

  // Port arrives via query so a DOGSH_PORT-overridden daemon (e2e isolation)
  // reaches its own renderer without touching the shared config.
  const wsPort = Number(new URLSearchParams(location.search).get('port')) || C.port;
  // Hot-potato redirect (v9): may be replaced by host-fenced.redirectUrl.
  let daemonWsUrl = `ws://127.0.0.1:${wsPort}`;

  // Window geometry is the source of truth. FitAddon measures #term (which
  // fills the window below the dragbar); we report those cols/rows as caps
  // so the owning PTY matches. Never shrink-wrap the window back onto a
  // hardcoded or foreign grid — tiling / user sizing must stick.
  let lastCapsKey = '';
  let capsTimer: ReturnType<typeof setTimeout> | null = null;
  function reportCaps(force = false): void {
    const d = fittedDims();
    if (!d) return;
    const key = `${d.cols}x${d.rows}`;
    if (!force && key === lastCapsKey) return;
    lastCapsKey = key;
    sendJ({ type: 'caps', caps: { cols: d.cols, rows: d.rows, canResize: true } });
  }
  function reportCapsSoon(): void {
    if (capsTimer) clearTimeout(capsTimer);
    capsTimer = setTimeout(() => {
      capsTimer = null;
      reportCaps();
    }, 90);
  }

  function connect(): void {
    ws = new WebSocket(daemonWsUrl);
    ws.onopen = () => {
      const dims = fittedDims();
      sendJ({
        type: 'hello',
        surface: 'native',
        proto: C.protocolVersion,
        // Fitted to the real window — config cols/rows are fallback only.
        caps: {
          cols: dims ? dims.cols : term.cols,
          rows: dims ? dims.rows : term.rows,
          canResize: true,
        },
      });
      if (dims) lastCapsKey = `${dims.cols}x${dims.rows}`;
    };
    ws.onmessage = (ev) => {
      const msg: DogshDaemonMsg = JSON.parse(ev.data);
      if (msg.type === 'hello-ack') {
        sessionId = msg.sessionId;
        const role =
          msg.leaseRole === 'sole' || msg.leaseRole === 'mute' || msg.leaseRole === 'monitor'
            ? msg.leaseRole
            : msg.owner === 'native'
              ? 'sole'
              : 'mute';
        setOwned(role === 'sole');
        reportCaps(true);
      } else if (msg.type === 'host-fenced') {
        // Hard mute: drop session identity before redirect (no late lease).
        sessionId = null;
        setOwned(false);
        if (typeof msg.redirectUrl === 'string' && msg.redirectUrl) {
          daemonWsUrl = msg.redirectUrl;
        }
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        ws = undefined;
        setTimeout(connect, 200);
      } else if (msg.type === 'session-list') {
        sessionId = msg.active; // every face displays the active session
        renderTabs(msg);
      } else if (msg.type === 'owner-state') {
        const role =
          msg.leaseRole === 'sole' || msg.leaseRole === 'mute' || msg.leaseRole === 'monitor'
            ? msg.leaseRole
            : msg.owner === 'native'
              ? 'sole'
              : 'mute';
        setOwned(role === 'sole');
      } else if (msg.type === 'snapshot') {
        // Snapshots (re)attach this face to a session: initial hello, a
        // backpressure resync, or a session SWITCH (tabs) all land here.
        if (msg.sessionId != null) sessionId = msg.sessionId;
        // Match the session's grid before writing, or the snapshot wraps
        // wrong (another face may have owned — and resized — the session).
        applyGrid(msg.cols, msg.rows);
        term.reset();
        term.write(msg.data);
      } else if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'grid') {
        // Owner-drives-size: follow the owner's grid so buffers reflow
        // identically on every face and a later handoff needs no resync.
        applyGrid(msg.cols, msg.rows);
      } else if (msg.type === 'clear') {
        term.clear();
      } else if (msg.type === 'session-exit') {
        // Only annotate the buffer the user is LOOKING at; a background
        // session dying just disappears from the tab strip.
        if (msg.sessionId == null || msg.sessionId === sessionId) {
          term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n');
        }
      }
    };
    ws.onclose = () => setTimeout(connect, 500);
  }
  connect();

  term.onData((data) => {
    if (!owned) return; // tab/phone owns — don't steal via input-host
    sendJ({ type: 'input', sessionId, data });
  });

  // Edit commands: Cmd+C/V/A arrive from the app menu (accelerators fire in
  // main before the renderer sees the keydown); right-click uses the same
  // dispatcher so both paths behave identically.
  async function doEdit(cmd: string): Promise<void> {
    if (cmd === 'copy') {
      if (term.hasSelection()) window.dogsh.clipboardWrite(term.getSelection());
    } else if (cmd === 'paste') {
      const text = await window.dogsh.clipboardRead();
      if (text) term.paste(text);
    } else if (cmd === 'selectAll') {
      term.selectAll();
    } else if (cmd === 'clear') {
      sendJ({ type: 'clear', sessionId });
    } else if (cmd === 'newTab') {
      sendJ({ type: 'session-create' });
    }
  }
  if (window.dogsh.onEdit) window.dogsh.onEdit(doEdit);
  document.getElementById('term')!.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const cmd = await window.dogsh.contextMenu({ hasSelection: term.hasSelection() });
    if (cmd) doEdit(cmd);
  });

  // Follow a session grid set elsewhere (another face owned). Resize the
  // local xterm only — do NOT shrink-wrap the Electron window to that grid.
  function applyGrid(cols?: number, rows?: number): void {
    if (!cols || !rows || (term.cols === cols && term.rows === rows)) return;
    term.resize(cols, rows);
  }

  // Any change to the #term box (user drag, macOS tile, DPI, reveal after
  // hide) → report fitted caps. Daemon applies them only while native owns;
  // when we don't own they're still stored so the next ownership tick sizes
  // the PTY to this window.
  const termBox = document.getElementById('term')!;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => reportCapsSoon()).observe(termBox);
  }
  window.addEventListener('resize', reportCapsSoon);
  if (window.dogsh.onUserResize) window.dogsh.onUserResize(reportCapsSoon);
  if (window.dogsh.onReveal) {
    window.dogsh.onReveal(() => {
      repaint();
      reportCapsSoon();
    });
  }

  term.focus();
})();
