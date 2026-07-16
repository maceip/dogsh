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
  if (window.dogsh && window.dogsh.onReveal) window.dogsh.onReveal(repaint);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') repaint();
  });

  let ws: WebSocket | undefined;
  // v5 attachment identity, learned from hello-ack; rides on every
  // session-scoped message this face sends.
  let sessionId: number | null = null;

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
  function connect(): void {
    ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    ws.onopen = () => {
      sendJ({
        type: 'hello',
        surface: 'native',
        proto: C.protocolVersion,
        // Fixed grid today; the dynamic-resize milestone starts computing
        // this from the window size. canResize flags that this face could.
        caps: { cols: C.cols, rows: C.rows, canResize: false },
      });
      reportMeasure();
    };
    ws.onmessage = (ev) => {
      const msg: DogshDaemonMsg = JSON.parse(ev.data);
      if (msg.type === 'hello-ack') {
        sessionId = msg.sessionId;
      } else if (msg.type === 'session-list') {
        sessionId = msg.active; // every face displays the active session
        renderTabs(msg);
      } else if (msg.type === 'snapshot') {
        // Snapshots (re)attach this face to a session: initial hello, a
        // backpressure resync, or a session SWITCH (tabs) all land here.
        if (msg.sessionId != null) sessionId = msg.sessionId;
        // Match the session's grid before writing, or the snapshot wraps
        // wrong (another face may have owned — and resized — the session).
        if (msg.cols && msg.rows && (term.cols !== msg.cols || term.rows !== msg.rows)) {
          term.resize(msg.cols, msg.rows);
          reportMeasure(); // shrink-wrap the window to the new grid
        }
        term.reset();
        term.write(msg.data);
      } else if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'grid') {
        // Owner-drives-size: follow the owner's grid so buffers reflow
        // identically on every face and a later handoff needs no resync.
        if (msg.cols && msg.rows && (term.cols !== msg.cols || term.rows !== msg.rows)) {
          term.resize(msg.cols, msg.rows);
          reportMeasure();
        }
      } else if (msg.type === 'clear') {
        term.clear();
      } else if (msg.type === 'session-exit') {
        // Only annotate the buffer the user is LOOKING at; a background
        // session dying just disappears from the tab strip.
        if (msg.sessionId == null || msg.sessionId === sessionId) {
          term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n');
        }
      }
      // owner-state is ignored here on purpose: native visibility is the
      // HOST's job (it gets reveal/hide), never the face's.
    };
    ws.onclose = () => setTimeout(connect, 500);
  }
  connect();

  term.onData((data) => {
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

  // Shrink-wrap the window to the fixed terminal grid.
  function reportMeasure(): void {
    const termEl = document.querySelector('#term .xterm-screen');
    if (!termEl || !ws || ws.readyState !== WebSocket.OPEN) return;
    const r = termEl.getBoundingClientRect();
    const dragbar = document.getElementById('dragbar')!.getBoundingClientRect();
    ws.send(
      JSON.stringify({
        type: 'measure',
        w: r.width + 20, // #term left+right padding (10+10)
        h: dragbar.height + r.height + 18, // #term top+bottom padding (8+10)
      })
    );
  }
  window.addEventListener('load', () => setTimeout(reportMeasure, 100));

  term.focus();
})();
