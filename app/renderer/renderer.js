/* global Terminal, WebglAddon, WebLinksAddon, DOGSH_CONFIG */
// Native face: a plain xterm.js client of the local daemon. Identical grid,
// font, and theme to the browser faces so handoffs read as one object.
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
  term.open(document.getElementById('term'));

  // Cmd+click opens URLs in the default browser (never inside this window).
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((_e, uri) => window.dogsh.openExternal(uri))
  );

  let webgl = null;
  function loadWebgl() {
    try {
      webgl = new WebglAddon.WebglAddon();
      term.loadAddon(webgl);
      // If the GPU context is lost (window hidden/suspended), drop to the DOM
      // renderer instead of showing a blank terminal.
      webgl.onContextLoss(() => {
        webgl.dispose();
        webgl = null;
      });
    } catch (e) {
      console.warn('webgl renderer unavailable, using DOM renderer', e);
      webgl = null;
    }
  }
  loadWebgl();

  function repaint() {
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

  let ws;
  // Port arrives via query so a DOGSH_PORT-overridden daemon (e2e isolation)
  // reaches its own renderer without touching the shared config.
  const wsPort = Number(new URLSearchParams(location.search).get('port')) || C.port;
  function connect() {
    ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', surface: 'native', proto: C.protocolVersion }));
      reportMeasure();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        term.reset();
        term.write(msg.data);
      } else if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'clear') {
        term.clear();
      } else if (msg.type === 'session-exit') {
        term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n');
      }
    };
    ws.onclose = () => setTimeout(connect, 500);
  }
  connect();

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Edit commands: Cmd+C/V/A arrive from the app menu (accelerators fire in
  // main before the renderer sees the keydown); right-click uses the same
  // dispatcher so both paths behave identically.
  async function doEdit(cmd) {
    if (cmd === 'copy') {
      if (term.hasSelection()) window.dogsh.clipboardWrite(term.getSelection());
    } else if (cmd === 'paste') {
      const text = await window.dogsh.clipboardRead();
      if (text) term.paste(text);
    } else if (cmd === 'selectAll') {
      term.selectAll();
    } else if (cmd === 'clear') {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'clear' }));
    }
  }
  if (window.dogsh.onEdit) window.dogsh.onEdit(doEdit);
  document.getElementById('term').addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const cmd = await window.dogsh.contextMenu({ hasSelection: term.hasSelection() });
    if (cmd) doEdit(cmd);
  });

  // Shrink-wrap the window to the fixed terminal grid.
  function reportMeasure() {
    const termEl = document.querySelector('#term .xterm-screen');
    if (!termEl || !ws || ws.readyState !== WebSocket.OPEN) return;
    const r = termEl.getBoundingClientRect();
    const dragbar = document.getElementById('dragbar').getBoundingClientRect();
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
