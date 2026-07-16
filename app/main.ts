// dogsh — Electron main process, now a pure NATIVE HOST.
// The session (pty + mirror + fan-out + choreography) lives in the standalone
// daemon (daemon/index.ts). This process only: ensures the daemon is running,
// hosts the native face window, and executes window-level choreography the
// daemon asks for (show/hide/focus/resize/doghouse/bark). Quit this app and
// the shell keeps running; relaunch and the face reattaches mid-session.
import {
  app,
  BrowserWindow,
  nativeTheme,
  Menu,
  ipcMain,
  screen,
  clipboard,
  shell as electronShell,
} from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execFile } from 'child_process';
import WebSocket from 'ws';

import CONFIG from './shared/config.js';

app.setName('dogsh');
// e2e mode: never show/focus the native window, so automated runs don't steal
// the user's keyboard (real keystrokes would land in the real shell).
const HIDDEN = process.env.DOGSH_HIDDEN === '1';
const PORT = Number(process.env.DOGSH_PORT) || CONFIG.port;
const DAEMON_PATH = path.join(__dirname, 'daemon', 'index.js');

// ---------------------------------------------------------------------------
// Daemon lifecycle. The daemon is Node code but runs under THIS Electron
// binary with ELECTRON_RUN_AS_NODE (node-pty in app/node_modules is built
// against Electron's ABI). Spawned detached: the app quitting is a non-event
// for the session. Spawning is idempotent — a daemon that finds its port
// already served exits immediately.
// ---------------------------------------------------------------------------
let lastDaemonSpawn = 0;

function spawnDaemon(): void {
  const now = Date.now();
  if (now - lastDaemonSpawn < 3000) return; // reconnect loop, not a dead daemon
  lastDaemonSpawn = now;
  const child = spawn(process.execPath, [DAEMON_PATH], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DOGSH_PORT: String(PORT) },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// --- launchd install (survivability beyond "app was run at least once") ----
// `dogsh --install-daemon` registers the daemon as a LaunchAgent: starts at
// login, KeepAlive restarts it if the shell dies or it crashes.
const LAUNCHD_LABEL = 'sh.dogsh.daemon';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

function launchdPlist(): string {
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'dogsh');
  fs.mkdirSync(logDir, { recursive: true });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${DAEMON_PATH}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'daemon.log')}</string>
</dict>
</plist>
`;
}

function installDaemon(done: (code: number) => void): void {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, launchdPlist());
  const uid = process.getuid!();
  // bootout first so re-install picks up a moved binary; failure = not loaded.
  execFile('/bin/launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], () => {
    execFile('/bin/launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH], (err) => {
      console.log(
        err
          ? `[dogsh] launchctl bootstrap failed: ${err.message}`
          : `[dogsh] daemon installed as LaunchAgent (${LAUNCHD_LABEL})`
      );
      done(err ? 1 : 0);
    });
  });
}

function uninstallDaemon(done: (code: number) => void): void {
  const uid = process.getuid!();
  execFile('/bin/launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], () => {
    try {
      fs.unlinkSync(PLIST_PATH);
    } catch {
      /* was not installed */
    }
    console.log(`[dogsh] daemon LaunchAgent removed (${LAUNCHD_LABEL})`);
    done(0);
  });
}

// ---------------------------------------------------------------------------
// Host link: this process is a ws client of the daemon, surface 'native-host'.
// It renders nothing; it executes window choreography the daemon decides on.
// ---------------------------------------------------------------------------
let hostWs: WebSocket | null = null;
let doghouseOn = false;
// Owner as of the last owner-state we rendered. null = no state received on
// this socket yet (fresh connect); the first message initializes it.
let lastOwner: DogshOwner | null = null;

function hostSend(msg: DogshClientMsg): void {
  if (hostWs && hostWs.readyState === WebSocket.OPEN) hostWs.send(JSON.stringify(msg));
}

function reportBounds(): void {
  if (win && !win.isDestroyed()) {
    hostSend({ type: 'native-bounds', bounds: win.getContentBounds() });
  }
}

// v6: the host never claims and never gets commanded — it reports the real
// window's raw levels and renders whatever owner the daemon derives.
function currentSig(): { visible: boolean; focused: boolean } {
  const alive = !!(win && !win.isDestroyed());
  return {
    visible: alive && win!.isVisible() && !doghouseOn,
    focused: alive && win!.isFocused(),
  };
}
function sendSignal(): void {
  hostSend({ type: 'signal', ...currentSig() });
}

function connectHost(): void {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on('open', () => {
    hostWs = ws;
    lastOwner = null;
    ws.send(
      JSON.stringify({
        type: 'hello',
        surface: 'native-host',
        proto: CONFIG.protocolVersion,
        // Baseline levels: a description of the window as it stands. If the
        // user is already looking at it (fresh app start), the daemon's
        // host-focused rule makes it the owner — no claim needed.
        sig: currentSig(),
      })
    );
    reportBounds();
  });
  ws.on('message', (raw) => {
    let msg: DogshDaemonMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleDaemonMessage(msg);
  });
  const retry = () => {
    if (hostWs === ws) hostWs = null;
    spawnDaemon(); // no-op if one is already serving the port
    setTimeout(connectHost, 700);
  };
  ws.on('close', retry);
  ws.on('error', () => {
    /* close fires next; retry happens there */
  });
}

function handleDaemonMessage(msg: DogshDaemonMsg): void {
  switch (msg.type) {
    case 'owner-state': {
      // Render the derived state; act only on TRANSITIONS. The 2s re-assert
      // repeats the same owner — reacting to it (revealNative focuses the
      // window) would steal OS focus on a timer.
      const owner = msg.owner;
      if (lastOwner === null) {
        // First state on this socket. Render the reveal direction only: if
        // the terminal lives here, show it. If it lives in a tab, do NOT
        // hide a window the user may have just opened — their focus (a real
        // signal) is what decides where the terminal goes next.
        lastOwner = owner;
        if (owner === 'native' && !msg.doghouse) revealNative();
        break;
      }
      if (owner === lastOwner) break;
      const prev = lastOwner;
      lastOwner = owner;
      if (owner === 'native') {
        // msg.doghouse guards the doghouse-entry grant: ownership pins to
        // native while the window animates INTO the island — revealing
        // (show + focus) here would fight that animation.
        if (!msg.doghouse) revealNative();
      } else if (prev === 'native') {
        // native -> tab handoff: the real window hides. app.hide() (not
        // win.hide()) keeps dogsh in cmd-tab; macOS auto-unhides it — firing
        // 'show'/'activate' — when the user switches back.
        if (!HIDDEN) app.hide();
      }
      break;
    }
    case 'bark':
      if (island && !island.isDestroyed()) island.webContents.send('dogsh:bark');
      break;
    case 'set-content-size':
      // Native renderer's measured grid, forwarded by the daemon: shrink-wrap.
      if (win && !win.isDestroyed()) {
        win.setContentSize(Math.ceil(msg.w), Math.ceil(msg.h));
        reportBounds();
      }
      break;
    case 'doghouse-changed':
      applyDoghouse(!!msg.on);
      break;
  }
}

// Make the native window the visible owner and repaint it. Idempotent: safe
// to run on every reveal, because the window may have been hidden with its
// GPU context suspended.
function revealNative(): void {
  if (HIDDEN || !win || win.isDestroyed()) return;
  if (app.isHidden && app.isHidden()) app.show();
  if (!win.isVisible()) win.show();
  // show() alone doesn't reliably make the window key when the app was
  // hidden/inactive — without this, cmd-tabbing back leaves keystrokes
  // going nowhere until the user clicks the window.
  if (!win.isFocused()) win.focus();
  win.webContents.send('dogsh:reveal'); // force repaint
}

// Doghouse state is owned by the daemon (it must suppress handoffs even if
// this app dies mid-doghouse); the host only animates on its confirmation.
function requestDoghouse(on: boolean): void {
  hostSend({ type: 'doghouse', on: !!on });
}

function applyDoghouse(on: boolean): void {
  if (on === doghouseOn) return;
  doghouseOn = on;
  if (on) enterDoghouse();
  else exitDoghouse();
}

// ---------------------------------------------------------------------------
// Native face window.
// ---------------------------------------------------------------------------
let win: BrowserWindow | null = null;

function createWindow(): void {
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

  // Raw facts only: every real window event reports current levels; the
  // daemon derives ownership. Focus is the decisive one — the arbiter's
  // host-focused rule brings the terminal home whenever the user is
  // demonstrably here.
  win.on('focus', () => sendSignal());
  win.on('show', () => sendSignal());
  win.on('hide', () => sendSignal());
  win.on('blur', () => {
    // Bounds refresh first: a tab is about to take over, and the fly-in
    // origin should be where the window sits right now.
    reportBounds();
    sendSignal();
  });
  win.on('move', () => reportBounds());
  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------------------
// Doghouse: an always-on-top island (black pill, yellow border) resting on
// top of the Dock. The terminal window animates down into it; while doghoused,
// the daemon suppresses handoffs and asks us to bark instead. If the ChatGPT
// desktop app's island is on screen we wrap ours around theirs; if it isn't
// (or they close it), we draw it ourselves at the dock.
// ---------------------------------------------------------------------------
let island: BrowserWindow | null = null;
let islandTracker: ReturnType<typeof setInterval> | null = null;
let savedWinBounds: Electron.Rectangle | null = null;

// Pill sizes measured from ref/ screenshots of OpenAI's island: it RESTS as
// a thin ~38x8pt slit and only grows on interaction. Ours rests slightly
// larger (yellow border needs room) and expands on hover/bark. Wrapped mode
// ignores both and hugs their actual window.
const PILL_REST = { w: 44, h: 10 };
const PILL_EXPANDED = { w: 132, h: 30 };
const WAVE = 110; // room for bark sound-waves (100px + stroke)
let currentPill = { ...PILL_REST }; // what the shrink/restore animations aim at
let currentWrapped = false;

function createIsland(): BrowserWindow {
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
    if (doghouseOn)
      setTimeout(() => {
        if (doghouseOn) showIsland(null);
      }, 150);
  });
  return island;
}

// Docked island window rect. Sized for the EXPANDED pill (so hover/bark can
// grow the pill without a window resize); the pill's bottom edge is anchored
// WAVE px above the window bottom, resting on top of the Dock (or 16px above
// the display bottom when the Dock is hidden).
function islandRectAtDock(): Electron.Rectangle {
  const disp = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
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
function showIsland(wrapRect: DogshRect | null): Electron.Rectangle {
  const isl = createIsland();
  let rect: Electron.Rectangle;
  let cfg: Record<string, unknown>;
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
function pillScreenRect(): Electron.Rectangle | null {
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
function probeOpenAIIsland(cb: (rect: DogshRect | null) => void): void {
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

function startIslandTracking(): void {
  stopIslandTracking();
  // Their island never moves (always-on, parked above the Dock — see
  // ref/island.png), so this only watches for it appearing/disappearing.
  // Dedupe: re-configuring the island with an unchanged state would restart
  // the docked pill's "arrive expanded, settle" animation every tick.
  let lastKey = 'dock'; // enterDoghouse just drew the docked pill
  const tick = () =>
    probeOpenAIIsland((rect) => {
      if (!doghouseOn) return;
      const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : 'dock';
      if (key === lastKey) return;
      lastKey = key;
      showIsland(rect); // rect === null -> our docked pill ("we re-draw it for them")
    });
  tick();
  islandTracker = setInterval(tick, 2000);
}
function stopIslandTracking(): void {
  if (islandTracker) clearInterval(islandTracker);
  islandTracker = null;
}

// Stepped window-bounds animation (Electron has no native window tween).
function animateWindow(
  w: BrowserWindow,
  from: Electron.Rectangle,
  to: Electron.Rectangle,
  ms: number,
  fade: 'in' | 'out',
  done: () => void
): void {
  const steps = 14;
  let i = 0;
  w.setResizable(true); // programmatic resize of a resizable:false window is flaky
  const timer = setInterval(() => {
    if (w.isDestroyed()) return clearInterval(timer);
    i++;
    const t = i / steps;
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    w.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: Math.max(60, Math.round(from.width + (to.width - from.width) * e)),
      height: Math.max(40, Math.round(from.height + (to.height - from.height) * e)),
    });
    w.setOpacity(fade === 'out' ? 1 - 0.92 * e : 0.08 + 0.92 * e);
    if (i >= steps) {
      clearInterval(timer);
      w.setResizable(false);
      done();
    }
  }, Math.max(8, ms / steps));
}

function enterDoghouse(): void {
  if (HIDDEN) return; // e2e: state machine only — no windows, no osascript prompts
  showIsland(null);
  startIslandTracking();
  if (!win || !win.isVisible()) return;
  const w = win;
  savedWinBounds = w.getBounds();
  const home = savedWinBounds;
  const target = pillScreenRect() || islandRectAtDock();
  animateWindow(w, home, target, 260, 'out', () => {
    w.hide();
    w.setOpacity(1);
    w.setBounds(home);
  });
}

function exitDoghouse(): void {
  stopIslandTracking();
  const from = pillScreenRect();
  if (island && !island.isDestroyed()) island.hide();
  if (HIDDEN || !win) return;
  const w = win;
  const home = savedWinBounds || w.getBounds();
  if (from) {
    w.setBounds(from);
    w.setOpacity(0.08);
    w.show();
    animateWindow(w, from, home, 260, 'in', () => {
      w.setOpacity(1);
      reportBounds();
      revealNative(); // focus + repaint; the focus signal keeps the terminal home
    });
  } else {
    w.setBounds(home);
    reportBounds();
    revealNative();
  }
}

ipcMain.on('dogsh:island-ignore', (_e, ignore) => {
  if (island && !island.isDestroyed()) {
    island.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
});
ipcMain.on('dogsh:island-exit', () => requestDoghouse(false));

// --- Native-face editing plumbing -----------------------------------------
// Clipboard runs through the main process (deterministic, no permission
// prompts); the context menu is a real NSMenu so it feels native.
function sendEdit(cmd: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('dogsh:edit', cmd);
}
ipcMain.on('dogsh:clipboard-write', (_e, text) => clipboard.writeText(String(text ?? '')));
ipcMain.handle('dogsh:clipboard-read', () => clipboard.readText());
ipcMain.on('dogsh:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) electronShell.openExternal(url);
});
ipcMain.handle('dogsh:context-menu', (_e, opts: { hasSelection?: boolean } | undefined) => {
  return new Promise<string | null>((resolve) => {
    let done = false;
    const pick = (cmd: string) => {
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
      window: win ?? undefined,
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
function updateDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock || app.isPackaged) return;
  const variant = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  try {
    app.dock.setIcon(path.join(__dirname, 'assets', `dogsh_tile_${variant}_1024.png`));
  } catch {
    /* missing asset shouldn't kill the app */
  }
}

app.whenReady().then(() => {
  // Daemon management flags run headless and exit.
  if (process.argv.includes('--install-daemon')) return installDaemon((code) => app.exit(code));
  if (process.argv.includes('--uninstall-daemon')) return uninstallDaemon((code) => app.exit(code));

  spawnDaemon();
  connectHost();
  updateDockIcon();
  nativeTheme.on('updated', updateDockIcon);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'dogsh',
        submenu: [
          {
            label: 'New Session Tab',
            accelerator: 'Command+T',
            // Routed through the renderer: it owns the daemon socket and the
            // sessionId bookkeeping, same as every other session command.
            click: () => sendEdit('newTab'),
          },
          { type: 'separator' },
          {
            label: 'Doghouse Mode',
            accelerator: 'Command+D',
            click: () => requestDoghouse(!doghouseOn),
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
          {
            label: 'Clear',
            accelerator: 'Command+K',
            click: () => hostSend({ type: 'clear' }),
          },
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
    // Explicitly summoning the terminal lets it out of the doghouse;
    // exitDoghouse restores + focuses the window, whose focus signal
    // brings the terminal home.
    if (doghouseOn) return requestDoghouse(false);
    revealNative();
  };
  app.on('activate', bringHome);
  app.on('did-become-active', bringHome);
});

app.on('window-all-closed', () => {
  // Keep the host alive: the terminal may be living in a tab, and coming
  // home (cmd-tab/dock) needs this process to recreate the window. The
  // SESSION no longer depends on us either way — it lives in the daemon.
});
