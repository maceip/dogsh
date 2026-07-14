// dogsh — Electron main process.
// Plays two roles: the session daemon (real pty + WebSocket fan-out + headless
// mirror for snapshots + handoff choreographer) and the host of the native face.
const {
  app,
  BrowserWindow,
  nativeTheme,
  Menu,
  ipcMain,
  screen,
  clipboard,
  shell: electronShell,
} = require('electron');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const CONFIG = require('./shared/config.js');
const SMOKE = process.argv.includes('--smoke');
app.setName('dogsh');
// e2e mode: never show/focus the native window, so automated runs don't steal
// the user's keyboard (real keystrokes would land in the real shell).
const HIDDEN = process.env.DOGSH_HIDDEN === '1';

// ---------------------------------------------------------------------------
// Session: one real pty, mirrored into a headless xterm so any surface that
// attaches gets a pixel-exact snapshot (scrollback, colors, cursor, alt-screen)
// in a single write instead of a replay.
// ---------------------------------------------------------------------------
const shell = process.env.SHELL || '/bin/zsh';
const ptyProc = pty.spawn(shell, ['-l'], {
  name: 'xterm-256color',
  cols: CONFIG.cols,
  rows: CONFIG.rows,
  cwd: os.homedir(),
  env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
});

const mirror = new HeadlessTerminal({
  cols: CONFIG.cols,
  rows: CONFIG.rows,
  scrollback: CONFIG.scrollback,
  allowProposedApi: true,
});
const serializer = new SerializeAddon();
mirror.loadAddon(serializer);

// ---------------------------------------------------------------------------
// WebSocket fan-out. Every face (native renderer, every tab overlay) is a
// client. Clients stay attached even while hidden — handoff only reveals.
// ---------------------------------------------------------------------------
const clients = new Map(); // ws -> { surface: 'native'|'tab', id, meta }
let nextClientId = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

// Durable clear (Cmd+K / context menu on any face): wipes scrollback in the
// mirror — so future snapshots are clean — and on every attached face at
// once. The terminal is one object; "clear" can't mean "clear this face only".
function clearEverywhere() {
  mirror.clear();
  broadcast({ type: 'clear' });
}

ptyProc.onData((data) => {
  mirror.write(data);
  broadcast({ type: 'data', data });
});
ptyProc.onExit(({ exitCode }) => {
  broadcast({ type: 'session-exit', exitCode });
  if (!SMOKE) app.quit();
});

// DOGSH_PORT overrides the daemon port. The e2e suite uses this so a test
// daemon can NEVER be reached by the user's real extension (which retries
// the default port every 2s — during one test run it attached the user's
// live Chrome to the test session and typed escape codes at them).
const PORT = Number(process.env.DOGSH_PORT) || CONFIG.port;
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('listening', () => {
  console.log(`[dogsh] daemon listening on ws://127.0.0.1:${PORT}`);
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(ws, msg);
  });
  ws.on('close', () => {
    const client = clients.get(ws);
    clients.delete(ws);
    if (client) choreographer.onSurfaceGone(client);
  });
});

function handleMessage(ws, msg) {
  const client = clients.get(ws);
  switch (msg.type) {
    case 'hello': {
      const c = {
        surface: msg.surface === 'native' ? 'native' : 'tab',
        id: nextClientId++,
        proto: msg.proto | 0,
        meta: { href: msg.href || null },
        ws,
      };
      // Snapshot first, then subscribe — ws.send is ordered per socket, so the
      // client always sees snapshot before any live data.
      send(ws, {
        type: 'snapshot',
        data: serializer.serialize({ scrollback: CONFIG.scrollback }),
        cols: CONFIG.cols,
        rows: CONFIG.rows,
      });
      clients.set(ws, c);
      // Stale-face detection: a face built against an older protocol still
      // "works" enough to look connected while missing fixes/UI — the classic
      // "rebuilt dist/ but never hit Reload at chrome://extensions". Warn
      // inside that client's terminal (client-local write; it is NOT in the
      // mirror, so other faces and future snapshots are unaffected).
      if (c.proto !== CONFIG.protocolVersion) {
        send(ws, { type: 'stale', expected: CONFIG.protocolVersion, got: c.proto });
        send(ws, {
          type: 'data',
          data:
            `\r\n\x1b[30;43m dogsh: this ${c.surface} face is outdated ` +
            `(v${c.proto || '?'}, daemon v${CONFIG.protocolVersion}). ` +
            (c.surface === 'tab'
              ? 'Reload the extension at chrome://extensions, then reload this page. '
              : 'Restart the dogsh app. ') +
            `\x1b[0m\r\n`,
        });
      }
      break;
    }
    case 'input':
      ptyProc.write(msg.data);
      break;
    case 'clear':
      clearEverywhere();
      break;
    case 'focus':
      if (client) choreographer.onSurfaceFocus(client);
      break;
    case 'blur':
      if (client) choreographer.onSurfaceBlur(client);
      break;
    case 'debug':
      // Test-only control channel (e2e cannot synthesize OS-level app focus).
      if (process.env.DOGSH_DEBUG === '1') {
        if (msg.action === 'claim-native') choreographer.claimNative();
        else if (msg.action === 'doghouse-on') choreographer.setDoghouse(true);
        else if (msg.action === 'doghouse-off') choreographer.setDoghouse(false);
        else if (msg.action === 'state') {
          send(ws, {
            type: 'debug-state',
            owner: choreographer.owner,
            doghouse: choreographer.doghouse,
            barkCount: choreographer.barkCount,
            win: win
              ? { visible: win.isVisible(), focused: win.isFocused() }
              : null,
            clients: [...clients.values()].map((c) => ({
              id: c.id,
              surface: c.surface,
              proto: c.proto,
            })),
          });
        }
      }
      break;
    case 'measure':
      // Native renderer reports the pixel size of the fixed terminal grid so
      // the window can shrink-wrap it.
      if (client && client.surface === 'native' && win) {
        win.setContentSize(Math.ceil(msg.w), Math.ceil(msg.h));
        choreographer.rememberNativeBounds();
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Choreographer: single source of truth for which surface "owns" (visibly
// hosts) the terminal. Handoffs are driven by focus claims, never by timers.
// ---------------------------------------------------------------------------
const choreographer = {
  owner: 'native', // 'native' | tab client id
  nativeBounds: null,
  // Doghouse mode: the terminal sleeps in the island above the dock. Focus
  // claims from tabs do NOT move the terminal — they make the island bark.
  doghouse: false,
  barkCount: 0,
  lastBarkAt: 0,

  rememberNativeBounds() {
    // Works for hidden windows too (returns last bounds) — needed so the
    // fly-in rect exists even in e2e hidden mode.
    if (win) this.nativeBounds = win.getContentBounds();
  },

  nativeFocused() {
    return win && !win.isDestroyed() && win.isFocused();
  },

  onSurfaceFocus(client) {
    if (client.surface !== 'tab') return;
    // A tab claim while the user is actively focused on the native window is
    // almost always a reconnect artifact (extension reload, daemon restart),
    // not a user switch — a background Chrome tab still reports itself
    // "visible". Don't yank the terminal out from under the user's cursor:
    // re-check once after the dust settles; a real switch to Chrome will have
    // defocused this window by then.
    if (this.nativeFocused()) {
      setTimeout(() => {
        if (!this.nativeFocused()) this.claimTab(client);
      }, 250);
      return;
    }
    this.claimTab(client);
  },

  setDoghouse(on) {
    if (on === this.doghouse) return;
    this.doghouse = on;
    if (on) {
      // The terminal comes home (silently) before it goes to the doghouse:
      // whoever owned it hides, and no reveal is sent anywhere.
      if (this.owner !== 'native') {
        const prev = this.findClient(this.owner);
        if (prev) send(prev.ws, { type: 'hide', mode: 'instant' });
        this.owner = 'native';
      }
      enterDoghouse();
    } else {
      exitDoghouse();
    }
  },

  bark(client) {
    this.barkCount++;
    // The visual is throttled (rapid tab switches would look like a seizure),
    // but every would-have-followed event still counts.
    const now = Date.now();
    if (now - this.lastBarkAt > 450) {
      this.lastBarkAt = now;
      if (island && !island.isDestroyed()) island.webContents.send('dogsh:bark');
    }
    void client;
  },

  onSurfaceBlur() {
    // Blur alone never triggers a handoff; only a focus claim by another
    // surface does. This means switching to an unrelated app (or a chrome://
    // tab with no content script) leaves the current owner in place.
  },

  onSurfaceGone(client) {
    if (this.owner === client.id) {
      // Owning tab closed — bring the terminal home.
      this.claimNative({ animate: false });
    }
  },

  claimTab(client) {
    if (this.doghouse) return this.bark(client); // it would have followed; it barks instead
    if (this.owner === client.id) return;
    if (this.owner === 'native') {
      // native -> tab: the overlay flies in from where the real window sits
      // (screen coords; the face converts to viewport and falls back to an
      // instant reveal if the rect is unusable). The real window hides
      // immediately — it's behind Chrome already, nobody sees it go.
      this.rememberNativeBounds();
      send(client.ws, { type: 'reveal', mode: 'fly', from: this.nativeBounds });
      // app.hide() (not win.hide()) keeps dogsh in cmd-tab; macOS auto-unhides
      // it — firing 'show'/'activate' — when the user switches back.
      if (!HIDDEN) app.hide();
    } else {
      // tab -> tab: same dock position in both tabs; appears not to have moved.
      const prev = this.findClient(this.owner);
      if (prev) send(prev.ws, { type: 'hide', mode: 'instant' });
      send(client.ws, { type: 'reveal', mode: 'instant' });
    }
    this.owner = client.id;
  },

  claimNative() {
    // Make the native window the visible owner and repaint it. Idempotent:
    // safe to call from every reactivation signal (focus/show/activate/
    // did-become-active). Repaints even if we already own it, because the
    // window may have been hidden and its GPU context suspended.
    if (this.doghouse) {
      // Explicitly summoning the terminal (cmd-tab to dogsh, dock click)
      // lets it out of the doghouse; exitDoghouse re-enters here after the
      // window is restored.
      this.setDoghouse(false);
      return;
    }
    if (HIDDEN || !win) {
      if (this.owner !== 'native') {
        const prev = this.findClient(this.owner);
        this.owner = 'native';
        if (prev) send(prev.ws, { type: 'hide', mode: 'instant' });
      }
      return;
    }
    const prev = this.owner === 'native' ? null : this.findClient(this.owner);
    this.owner = 'native';
    if (app.isHidden && app.isHidden()) app.show();
    if (!win.isVisible()) win.show();
    // show() alone doesn't reliably make the window key when the app was
    // hidden/inactive — without this, cmd-tabbing back leaves keystrokes
    // going nowhere until the user clicks the window.
    if (!win.isFocused()) win.focus();
    win.webContents.send('dogsh:reveal'); // force repaint
    if (prev) {
      // The overlay in the (now background) tab flies toward the real window
      // before hiding, so a glance back at Chrome shows it leaving.
      this.rememberNativeBounds();
      send(prev.ws, { type: 'hide', mode: 'fly', to: this.nativeBounds });
    }
  },

  findClient(id) {
    for (const c of clients.values()) if (c.id === id) return c;
    return null;
  },
};

// ---------------------------------------------------------------------------
// Native face window.
// ---------------------------------------------------------------------------
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 520,
    useContentSize: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: CONFIG.theme.background,
    resizable: false,
    fullscreenable: false,
    show: !HIDDEN,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { port: String(PORT) },
  });

  // Any way the native window comes to the foreground -> it owns the terminal.
  win.on('focus', () => choreographer.claimNative());
  win.on('show', () => choreographer.claimNative());
  win.on('move', () => choreographer.rememberNativeBounds());
  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------------------
// Doghouse: an always-on-top island (black pill, yellow border) resting on
// top of the Dock. The terminal window animates down into it; while doghoused,
// handoffs are suppressed and the island barks instead. If the ChatGPT
// desktop app's island is on screen we wrap ours around theirs; if it isn't
// (or they close it), we draw it ourselves at the dock.
// ---------------------------------------------------------------------------
let island = null;
let islandTracker = null;
let savedWinBounds = null;

// Pill sizes measured from ref/ screenshots of OpenAI's island: it RESTS as
// a thin ~38x8pt slit and only grows on interaction. Ours rests slightly
// larger (yellow border needs room) and expands on hover/bark. Wrapped mode
// ignores both and hugs their actual window.
const PILL_REST = { w: 44, h: 10 };
const PILL_EXPANDED = { w: 132, h: 30 };
const WAVE = 110; // room for bark sound-waves (100px + stroke)
let currentPill = { ...PILL_REST }; // what the shrink/restore animations aim at
let currentWrapped = false;

function createIsland() {
  if (island && !island.isDestroyed()) return island;
  island = new BrowserWindow({
    width: PILL_EXPANDED.w + WAVE * 2,
    height: PILL_EXPANDED.h + WAVE * 2,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // never steals focus; clicking it must not activate dogsh
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-island.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  island.setAlwaysOnTop(true, 'screen-saver');
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through everywhere except the pill; the renderer flips this on
  // pill hover so the vast transparent wave-margin never eats clicks.
  island.setIgnoreMouseEvents(true, { forward: true });
  island.loadFile(path.join(__dirname, 'renderer', 'island.html'));
  island.on('closed', () => {
    island = null;
    // "Even if they close their island we re-draw it": doghouse mode without
    // an island is not a thing.
    if (choreographer.doghouse) setTimeout(() => {
      if (choreographer.doghouse) showIsland(null);
    }, 150);
  });
  return island;
}

// Docked island window rect. Sized for the EXPANDED pill (so hover/bark can
// grow the pill without a window resize); the pill's bottom edge is anchored
// WAVE px above the window bottom, resting on top of the Dock (or 16px above
// the display bottom when the Dock is hidden).
function islandRectAtDock() {
  const disp = win
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay();
  const dockTop = disp.workArea.y + disp.workArea.height; // = screen bottom if no dock
  const hasDock = dockTop < disp.bounds.y + disp.bounds.height;
  const pillBottom = hasDock ? dockTop - 4 : disp.bounds.y + disp.bounds.height - 16;
  const w = PILL_EXPANDED.w + WAVE * 2;
  const h = PILL_EXPANDED.h + WAVE * 2;
  return {
    x: Math.round(disp.workArea.x + (disp.workArea.width - w) / 2),
    y: Math.round(pillBottom - (h - WAVE)),
    width: w,
    height: h,
  };
}

// Show the island either wrapped around another rect (ChatGPT's island, in
// screen coords) or docked. Sends the pill geometry to the renderer.
function showIsland(wrapRect) {
  const isl = createIsland();
  let rect;
  let cfg;
  if (wrapRect) {
    // Our border hugs their island; fixed size, centered on theirs.
    const pill = { w: wrapRect.width + 12, h: wrapRect.height + 12 };
    rect = {
      x: Math.round(wrapRect.x + wrapRect.width / 2 - (pill.w / 2 + WAVE)),
      y: Math.round(wrapRect.y + wrapRect.height / 2 - (pill.h / 2 + WAVE)),
      width: pill.w + WAVE * 2,
      height: pill.h + WAVE * 2,
    };
    cfg = { wrapped: true, pillW: pill.w, pillH: pill.h };
    currentPill = pill;
  } else {
    rect = islandRectAtDock();
    cfg = {
      wrapped: false,
      restW: PILL_REST.w,
      restH: PILL_REST.h,
      expW: PILL_EXPANDED.w,
      expH: PILL_EXPANDED.h,
    };
    currentPill = { ...PILL_EXPANDED };
  }
  currentWrapped = !!wrapRect;
  isl.setBounds(rect);
  if (isl.webContents.isLoading()) {
    isl.webContents.once('did-finish-load', () => isl.webContents.send('dogsh:island-config', cfg));
  } else {
    isl.webContents.send('dogsh:island-config', cfg);
  }
  if (!isl.isVisible()) isl.showInactive();
  return rect;
}

// The pill rect (screen coords) inside the island window — the target the
// terminal window shrinks into.
function pillScreenRect() {
  if (!island || island.isDestroyed()) return null;
  const b = island.getBounds();
  if (currentWrapped) {
    return {
      x: Math.round(b.x + (b.width - currentPill.w) / 2),
      y: Math.round(b.y + (b.height - currentPill.h) / 2),
      width: currentPill.w,
      height: currentPill.h,
    };
  }
  // Docked: bottom-anchored expanded pill box.
  return {
    x: Math.round(b.x + (b.width - currentPill.w) / 2),
    y: b.y + b.height - WAVE - currentPill.h,
    width: currentPill.w,
    height: currentPill.h,
  };
}

// "Play with them": look for the ChatGPT desktop app's island — a small
// borderless pill window — via System Events. Needs the user to grant dogsh
// Automation+Accessibility access; any failure (no permission, no ChatGPT,
// no pill-shaped window) quietly falls back to our own docked island.
function probeOpenAIIsland(cb) {
  const script =
    'tell application "System Events"\n' +
    'if not (exists process "ChatGPT") then return ""\n' +
    'set out to ""\n' +
    'repeat with w in windows of process "ChatGPT"\n' +
    'set {px, py} to position of w\n' +
    'set {sw, sh} to size of w\n' +
    'set out to out & px & "," & py & "," & sw & "," & sh & ";"\n' +
    'end repeat\n' +
    'return out\n' +
    'end tell';
  execFile('/usr/bin/osascript', ['-e', script], { timeout: 2000 }, (err, stdout) => {
    if (err || !stdout) return cb(null);
    for (const chunk of stdout.trim().split(';')) {
      const [x, y, w, h] = chunk.split(',').map((n) => parseInt(n, 10));
      // Pill-shaped: short, definitely not a document window. Their island
      // RESTS as a ~38x8pt slit (see ref/island.png), so the floor must be
      // tiny; it grows during dictation states, hence the generous ceiling.
      if (Number.isFinite(h) && h >= 6 && h <= 80 && w >= 20 && w <= 600) {
        return cb({ x, y, width: w, height: h });
      }
    }
    cb(null);
  });
}

function startIslandTracking() {
  stopIslandTracking();
  // Their island never moves (always-on, parked above the Dock — see
  // ref/island.png), so this only watches for it appearing/disappearing.
  // Dedupe: re-configuring the island with an unchanged state would restart
  // the docked pill's "arrive expanded, settle" animation every tick.
  let lastKey = 'dock'; // enterDoghouse just drew the docked pill
  const tick = () =>
    probeOpenAIIsland((rect) => {
      if (!choreographer.doghouse) return;
      const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : 'dock';
      if (key === lastKey) return;
      lastKey = key;
      showIsland(rect); // rect === null -> our docked pill ("we re-draw it for them")
    });
  tick();
  islandTracker = setInterval(tick, 2000);
}
function stopIslandTracking() {
  if (islandTracker) clearInterval(islandTracker);
  islandTracker = null;
}

// Stepped window-bounds animation (Electron has no native window tween).
function animateWindow(from, to, ms, fade, done) {
  const steps = 14;
  let i = 0;
  win.setResizable(true); // programmatic resize of a resizable:false window is flaky
  const timer = setInterval(() => {
    if (!win) return clearInterval(timer);
    i++;
    const t = i / steps;
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    win.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: Math.max(60, Math.round(from.width + (to.width - from.width) * e)),
      height: Math.max(40, Math.round(from.height + (to.height - from.height) * e)),
    });
    win.setOpacity(fade === 'out' ? 1 - 0.92 * e : 0.08 + 0.92 * e);
    if (i >= steps) {
      clearInterval(timer);
      win.setResizable(false);
      done();
    }
  }, Math.max(8, ms / steps));
}

function enterDoghouse() {
  if (HIDDEN) return; // e2e: state machine only — no windows, no osascript prompts
  showIsland(null);
  startIslandTracking();
  if (!win || !win.isVisible()) return;
  savedWinBounds = win.getBounds();
  const target = pillScreenRect() || islandRectAtDock();
  animateWindow(savedWinBounds, target, 260, 'out', () => {
    win.hide();
    win.setOpacity(1);
    win.setBounds(savedWinBounds);
  });
}

function exitDoghouse() {
  stopIslandTracking();
  const from = pillScreenRect();
  if (island && !island.isDestroyed()) island.hide();
  if (HIDDEN || !win) return;
  const home = savedWinBounds || win.getBounds();
  if (from) {
    win.setBounds(from);
    win.setOpacity(0.08);
    win.show();
    animateWindow(from, home, 260, 'in', () => {
      win.setOpacity(1);
      choreographer.claimNative(); // focus + repaint via the normal path
    });
  } else {
    win.setBounds(home);
    choreographer.claimNative();
  }
}

ipcMain.on('dogsh:island-ignore', (_e, ignore) => {
  if (island && !island.isDestroyed()) {
    island.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
});
ipcMain.on('dogsh:island-exit', () => choreographer.setDoghouse(false));

// --- Native-face editing plumbing -----------------------------------------
// Clipboard runs through the main process (deterministic, no permission
// prompts); the context menu is a real NSMenu so it feels native.
function sendEdit(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('dogsh:edit', cmd);
}
ipcMain.on('dogsh:clipboard-write', (_e, text) => clipboard.writeText(String(text ?? '')));
ipcMain.handle('dogsh:clipboard-read', () => clipboard.readText());
ipcMain.on('dogsh:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) electronShell.openExternal(url);
});
ipcMain.handle('dogsh:context-menu', (_e, opts) => {
  return new Promise((resolve) => {
    let done = false;
    const pick = (cmd) => {
      done = true;
      resolve(cmd);
    };
    const menu = Menu.buildFromTemplate([
      { label: 'Copy', enabled: !!(opts && opts.hasSelection), click: () => pick('copy') },
      { label: 'Paste', click: () => pick('paste') },
      { label: 'Select All', click: () => pick('selectAll') },
      { type: 'separator' },
      { label: 'Clear', click: () => pick('clear') },
    ]);
    menu.popup({
      window: win,
      // Fires after any click handler; resolve null on dismiss-without-pick.
      callback: () => setTimeout(() => !done && resolve(null), 0),
    });
  });
});

// Dock + cmd-tab icon for DEV RUNS ONLY (`electron .`, where the dock shows
// the stock Electron icon). The packaged app must NOT override its icon at
// runtime: app.dock.setIcon() bypasses macOS 26's Liquid Glass pipeline
// (squircle, tint modes), which is exactly what made the icon look pasted-on.
// The bundle ships assets/dogsh.icon (compiled by actool) + dogsh.icns.
function updateDockIcon() {
  if (process.platform !== 'darwin' || !app.dock || app.isPackaged) return;
  const variant = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  try {
    app.dock.setIcon(path.join(__dirname, 'assets', `dogsh_tile_${variant}_1024.png`));
  } catch (_) { /* missing asset shouldn't kill the daemon */ }
}

app.whenReady().then(() => {
  if (SMOKE) return runSmokeTest();
  updateDockIcon();
  nativeTheme.on('updated', updateDockIcon);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'dogsh',
        submenu: [
          {
            label: 'Doghouse Mode',
            accelerator: 'Command+D',
            click: () => choreographer.setDoghouse(!choreographer.doghouse),
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          // Not `role:` items — those operate on the DOM selection, which is
          // always empty (xterm keeps its own selection model). Route through
          // the renderer so Cmd+C/V act on the terminal's selection/clipboard.
          { label: 'Copy', accelerator: 'Command+C', click: () => sendEdit('copy') },
          { label: 'Paste', accelerator: 'Command+V', click: () => sendEdit('paste') },
          { label: 'Select All', accelerator: 'Command+A', click: () => sendEdit('selectAll') },
          { type: 'separator' },
          { label: 'Clear', accelerator: 'Command+K', click: () => clearEverywhere() },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
  createWindow();
  // Any way the user returns to dogsh (cmd-tab, dock click, unhide) brings the
  // terminal home. did-become-active is the reliable macOS signal for cmd-tab.
  const bringHome = () => {
    if (HIDDEN) return;
    if (!win) return createWindow();
    choreographer.claimNative();
  };
  app.on('activate', bringHome);
  app.on('did-become-active', bringHome);
});

app.on('window-all-closed', () => {
  // Keep the daemon alive even with the native window closed; the terminal
  // may be living in a tab. Quit from the dock/menu.
});

// ---------------------------------------------------------------------------
// Smoke mode: no window. Verifies (1) WS server up, (2) a real command runs in
// the real pty and its output round-trips through the headless mirror.
// Output-gated: prints SMOKE PASS only after observing expected bytes.
// ---------------------------------------------------------------------------
function runSmokeTest() {
  const MARKER = '__DOGSH_SMOKE_OK__';
  let sawMarker = false;
  const timeout = setTimeout(() => {
    console.error('[smoke] FAIL: marker not observed within 20s');
    app.exit(1);
  }, 20000);

  ptyProc.onData((data) => {
    if (sawMarker) return;
    if (data.includes(MARKER)) {
      sawMarker = true;
      // Confirm the mirror captured it too (snapshot path works).
      setTimeout(() => {
        const snap = serializer.serialize();
        const inMirror = snap.includes(MARKER);
        clearTimeout(timeout);
        if (inMirror) {
          console.log(`[smoke] PASS: pty roundtrip + mirror snapshot OK (ws://127.0.0.1:${CONFIG.port})`);
          app.exit(0);
        } else {
          console.error('[smoke] FAIL: marker seen on pty but missing from mirror snapshot');
          app.exit(1);
        }
      }, 250);
    }
  });

  setTimeout(() => {
    ptyProc.write(`echo ${MARKER}\r`);
  }, 1200);
}
