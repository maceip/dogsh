// dogsh desktop e2e.
//
// WHAT AN E2E TEST IS (redefined 2026-07-13, after the old simulation suite
// passed 25 checks while a user found a terminal-stealing bug in the first
// ten seconds of actually opening the app). Ranked by bug-catching power —
// the top items are where the fast-moving choreography bugs live; the bottom
// is a slow-moving smoke layer:
//
//   1. REAL OS SIGNALS. Focus changes are driven by macOS (`open` activating
//      real apps) against visible windows. Never DOGSH_HIDDEN, never debug
//      messages faking focus. If the OS didn't deliver the signal, we didn't
//      test the signal. (This is the rule whose absence hid the steal bug.)
//   2. REAL RENDERING. Headed Chrome, real extension, never headless.
//      Pixel assertions over the TEXT area (not the frame chrome — that
//      once masked a fully blank canvas) catch the whole "working but
//      shows nothing" class, whichever renderer is active.
//   3. USER-STORY SCENARIOS, OBSERVABLE ASSERTIONS. Every scenario is
//      something a person did ("I opened the app and typed"), asserted only
//      through what a person could observe: frontmost app (lsappinfo),
//      overlay visibility, rendered pixels (luminance variance), and the
//      real system clipboard (also our honest content-readback channel).
//   4. ARTIFACT SMOKE. The suite launches the packaged .app once, which
//      catches the packaging failure class (e.g. stripped node-pty
//      binaries) as a side effect. This is deliberately LAST: packaging
//      bugs are fix-once/slow-moving, and launch mode contributes nothing
//      to catching choreography bugs — dev-mode inner loops are fine.
//
// Deliberately NOT covered here (manual checklist, printed at the end):
// doghouse visuals, extension mid-session reload, dock/cmd-tab appearance,
// native-window pixel capture (needs Screen Recording permission).
//
// NOTE: this suite takes over the desktop for ~2 minutes (the Cursor agent
// generation in scenario 2 is network-bound). Windows will
// appear and focus will move. That is the point.
const { chromium } = require('playwright');
const { spawn, execFile } = require('child_process');
const { execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const CONFIG = require('../app/shared/config.js');

const ROOT = path.join(__dirname, '..');
const EXT_DIST = path.join(ROOT, 'extension', 'dist');
const APP_BUNDLE = path.join(ROOT, 'app', 'build', 'dogsh-darwin-arm64', 'dogsh.app');
const APP_BIN = path.join(APP_BUNDLE, 'Contents', 'MacOS', 'dogsh');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const PAGE_PORT = 47791;
// The test daemon gets its own port. The user's REAL extension retries the
// default port every 2s — on a shared port it would attach to the test
// session and receive its keystrokes/escape codes (this happened; never
// again). The test browser is pointed here via a portOverride in ITS
// profile's storage.
const TEST_PORT = 47713;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`[e2e] ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// Real-desktop observation & control (no Accessibility permission needed)
// ---------------------------------------------------------------------------
function frontApp() {
  try {
    const out = execSync('lsappinfo info -only name $(lsappinfo front)', {
      encoding: 'utf8',
    });
    const m = out.match(/"LSDisplayName"="(.+)"/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}
function frontAppBundlePath() {
  try {
    const out = execSync('lsappinfo info -only bundlepath $(lsappinfo front)', {
      encoding: 'utf8',
    });
    const m = out.match(/"LSBundlePath"="(.+)"/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}
function activate(appBundlePath) {
  // `open` on a running app's bundle activates it — a real macOS app switch,
  // exactly what clicking its dock icon does.
  return new Promise((resolve, reject) => {
    execFile('open', [appBundlePath], (err) => (err ? reject(err) : resolve()));
  });
}
async function waitFor(fn, timeoutMs, everyMs = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

// A desktop e2e run is only meaningful on a free desk. If a human is
// actively using the machine, macOS (correctly) refuses to hand focus to
// test apps, and every downstream check reports garbage. Detect that and
// ABORT LOUDLY instead of emitting misleading FAILs.
class DeskContestedError extends Error {
  constructor(front) {
    super(`desktop contested: frontmost app is "${front}"`);
    this.front = front;
  }
}
async function ensureFrontmost(bundlePath, appName, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await activate(bundlePath);
    } catch {
      // Launch Services error -600 race: `open` on an app that was just
      // (re)launched can fail while the new instance is still registering.
      // That's an attempt, not a crash — retry.
    }
    await sleep(900);
    if (frontApp() === appName) return;
  }
  throw new DeskContestedError(frontApp());
}

// Write raw bytes into the live session while the NATIVE face owns it. Typing
// real keystrokes into the Electron window needs the Accessibility permission
// (osascript System Events), which this suite deliberately does not require.
// So bytes are injected through the daemon's public protocol — the exact
// bytes the native face sends after a keystroke. Everything downstream (pty,
// shell, mirror, snapshot, overlay render) is real; only the native window's
// DOM key handling is skipped (listed in MANUAL-ONLY).
function sessionInput(data) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('session input: daemon unreachable'));
    }, 5000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'input', data }));
      clearTimeout(timeout);
      ws.close();
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('session input: connect failed'));
    };
  });
}
// Run a shell command: command + Enter in one write. Fine for zsh — but NOT
// for TUI input boxes, whose paste heuristics treat a same-chunk CR as pasted
// text (probed against the Cursor CLI 2026-07-15). For TUIs, sessionInput the
// text and a separate '\r'.
const sessionRun = (command) => sessionInput(command + '\r');

const stripAnsi = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI (colors, cursor moves)
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');

// Read the current session screen (buffer + scrollback) through the daemon
// protocol: a fresh face hello is answered with a serialized snapshot. The
// connection never claims ownership, so choreography is untouched. Used ONLY
// to observe TUI state (trust dialog, busy spinner, run completion) where no
// honest user-observable channel exists while the NATIVE window owns the
// terminal (reading its real pixels needs the Screen Recording permission —
// listed in MANUAL-ONLY). Content assertions on browser surfaces still go
// through rendered pixels and the system clipboard.
function sessionSnapshot() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('session snapshot: daemon unreachable'));
    }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', surface: 'tab', proto: 5 }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.type === 'snapshot') {
        clearTimeout(timeout);
        ws.close();
        resolve(stripAnsi(m.data));
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('session snapshot: connect failed'));
    };
  });
}

// Drive the session tab strip's actions over the daemon protocol — the exact
// messages a strip click posts. Real strip CLICKS are MANUAL-ONLY: the strip
// lives in a closed shadow root with variable-width tabs, and a guessed
// coordinate can land on a tab's × (which kills that shell). Confirmation is
// the daemon's own broadcast for the change; the overlay's data-session-*
// evidence attributes then confirm the visible UI caught up.
function sessionCommand(cmd, confirmed) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`session ${cmd.type}: no confirmation from daemon`));
    }, 5000);
    let sent = false;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'hello', surface: 'tab', proto: CONFIG.protocolVersion }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data.toString());
      // Session mutations need a registered face client: wait for the ack.
      if (m.type === 'hello-ack' && !sent) {
        sent = true;
        ws.send(JSON.stringify(cmd));
        return;
      }
      if (sent && confirmed(m)) {
        clearTimeout(timeout);
        ws.close();
        resolve(m);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('session command: connect failed'));
    };
  });
}
const sessionCreate = () =>
  sessionCommand(
    { type: 'session-create' },
    (m) => m.type === 'session-list' && m.sessions.length === 2
  );
const sessionSwitch = (id) =>
  sessionCommand(
    { type: 'session-switch', sessionId: id },
    (m) => m.type === 'snapshot' && m.sessionId === id
  );

// Choreography post-mortem for failures: owner, generation, last granted
// claim, parked claims. DOGSH_DEBUG=1 (set by launchApp) unlocks it.
function daemonDebugState() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ error: 'daemon unreachable' });
    }, 3000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'debug', action: 'state' }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.type === 'debug-state') {
        clearTimeout(timeout);
        ws.close();
        resolve(m);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve({ error: 'connect failed' });
    };
  });
}

// ---------------------------------------------------------------------------
// Overlay observation through the page (the shadow root is closed by design;
// the host exposes only visibility + coarse evidence attributes)
// ---------------------------------------------------------------------------
const overlayVisible = (page) =>
  page.evaluate(() => {
    const h = document.querySelector('[data-dogsh]');
    return !!h && h.style.visibility === 'visible';
  });
const overlayAttr = (page, attr) =>
  page.evaluate((a) => {
    const h = document.querySelector('[data-dogsh]');
    return h ? h.getAttribute(a) : null;
  }, attr);

// Ownership-stability watch: visible now, still visible after `ms`, and the
// content script's data-flips transition counter unchanged in between. This
// is how the suite catches the "ownership metronome" bug class (two faces
// stealing the terminal from each other on a timer): a flicker mid-scenario
// silently corrupted every menu-driven interaction in the 2026-07-15 run,
// and only the videos gave it away after the fact.
async function overlayStable(page, ms) {
  if (!(await overlayVisible(page))) return false;
  const before = await overlayAttr(page, 'data-flips');
  await sleep(ms);
  if (!(await overlayVisible(page))) return false;
  return (await overlayAttr(page, 'data-flips')) === before;
}

// One-line-per-event journal render for failure dumps.
async function daemonJournal() {
  const st = await daemonDebugState();
  if (!st || !Array.isArray(st.journal)) return `daemon state: ${JSON.stringify(st)}`;
  const t0 = st.journal.length ? st.journal[0].at : 0;
  const lines = st.journal.map(
    (j) => `  +${String(j.at - t0).padStart(6)}ms ${j.ev}${j.who != null ? ` who=${j.who}` : ''}${j.note ? ` (${j.note})` : ''}`
  );
  const who = (st.clients || [])
    .map((c) => `  id=${c.id} ${c.surface}${c.href ? ` ${c.href}` : ''}`)
    .join('\n');
  return `owner=${st.owner} gen=${st.gen}\nclients:\n${who}\njournal:\n${lines.join('\n')}`;
}

// Luminance standard deviation over the overlay's TEXT area — not the whole
// frame. The first version measured the full overlay and passed a completely
// blank canvas: the traffic lights, scrollbar, and drop shadow alone scored
// stddev 23 while the text region measured exactly 0.0. Insets skip the
// title bar (34px + padding), the scrollbar, and the frame border; height is
// capped near the top because text fills top-down, so a near-empty terminal
// (one prompt line) still has its glyphs inside the sampled strip.
async function overlayPixelVariance(page) {
  const rect = await page.evaluate(() => {
    const h = document.querySelector('[data-dogsh]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return {
      x: r.x + 12,
      y: r.y + 48,
      w: r.width - 40,
      h: Math.min(180, r.height - 64),
    };
  });
  if (!rect || rect.w < 10 || rect.h < 10) return -1;
  const shot = await page.screenshot({ type: 'png' });
  return page.evaluate(
    async ({ b64, rect }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = 'data:image/png;base64,' + b64;
      });
      const scale = img.width / window.innerWidth; // handles retina scaling
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(rect.w * scale));
      c.height = Math.max(1, Math.floor(rect.h * scale));
      const ctx = c.getContext('2d');
      ctx.drawImage(
        img,
        rect.x * scale,
        rect.y * scale,
        rect.w * scale,
        rect.h * scale,
        0,
        0,
        c.width,
        c.height
      );
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 16) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l;
        sum2 += l * l;
        n++;
      }
      const mean = sum / n;
      return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    },
    { b64: shot.toString('base64'), rect }
  );
}

// Context-menu coordinate contract (menu top-left = right-click point, 6px
// pad, 28px items, order Copy/Paste/SelectAll/Clear).
async function menuAction(page, at, itemIndex) {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await sleep(300);
  await page.mouse.click(at.x + 80, at.y + 6 + 28 * itemIndex + 14);
  await sleep(400);
}
// Real terminal content readback, entirely through user-visible surfaces:
// Select All + Copy, then read the system clipboard. The clipboard is seeded
// with a sentinel first, so a copy that silently did nothing reads back as
// the sentinel instead of whatever stale content would vacuously pass
// assertions (the first run of this suite "passed" a check exactly that way).
const CLIP_SENTINEL = '__DOGSH_E2E_NO_COPY_HAPPENED__';
async function copyAllToClipboard(page, at) {
  // The menu is only reachable on a visible overlay; a copy attempted while
  // ownership is elsewhere would right-click the PAGE and read back the
  // sentinel. Failing here with the arbitration journal beats five
  // downstream scenarios failing with "copy did not happen".
  if (!(await overlayVisible(page))) {
    console.log(`[e2e] copy skipped — overlay not visible. post-mortem:\n${await daemonJournal()}`);
    return CLIP_SENTINEL;
  }
  await page.evaluate((s) => navigator.clipboard.writeText(s).catch(() => {}), CLIP_SENTINEL);
  await menuAction(page, at, 2); // Select All
  await menuAction(page, at, 0); // Copy
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  if (clip === CLIP_SENTINEL) {
    console.log(`[e2e] copy readback = sentinel. post-mortem:\n${await daemonJournal()}`);
  }
  return clip;
}
async function termPoint(page) {
  return page.evaluate(() => {
    const r = document.querySelector('[data-dogsh]').getBoundingClientRect();
    return { x: r.left + 200, y: r.top + 120 };
  });
}

// The suite necessarily commandeers desktop focus (that is what it tests).
// Be a good citizen: remember whose desktop this was and give it back on any
// exit — success, failure, or Ctrl+C.
let userFrontApp = '';
function restoreUserFocus() {
  if (userFrontApp && !userFrontApp.includes('dogsh')) {
    try {
      execSync(`open ${JSON.stringify(userFrontApp)}`);
    } catch {
      /* app quit meanwhile */
    }
  }
}

async function main() {
  // Grace period: the human who launched this needs a moment to take their
  // hands off the keyboard before the suite seizes the desk.
  const grace = Number(process.env.DOGSH_E2E_GRACE_MS) || 10000;
  console.log(`[e2e] starting in ${Math.round(grace / 1000)}s — hands off for ~2min after that`);
  await sleep(grace);

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  userFrontApp = frontAppBundlePath();
  process.on('SIGINT', () => {
    restoreUserFocus();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    restoreUserFocus();
    process.exit(143);
  });

  // --- preflight ---------------------------------------------------------
  if (!fs.existsSync(APP_BIN)) {
    console.error(`[e2e] packaged app missing at ${APP_BIN} — run: cd app && npm run package`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(EXT_DIST, 'manifest.json'))) {
    console.error(`[e2e] extension dist missing — run: cd extension && node build.js`);
    process.exit(1);
  }
  // Kill ONLY our own leftovers, matched by exact absolute paths. pkill -f
  // patterns are regexes over full command lines: anything looser (like
  // "node_modules/.bin/electron .") can and did kill unrelated processes.
  for (const pattern of [APP_BIN, path.join(ARTIFACTS, 'profile')]) {
    try {
      execSync(`pkill -f ${JSON.stringify(pattern)}`);
    } catch {
      /* nothing matched */
    }
  }
  await sleep(500);

  // Fresh browser profile EVERY run. A reused profile carries storage from
  // previous suites (the deleted headless suite left noWebgl:true in here,
  // which silently disabled the GPU renderer under test).
  fs.rmSync(path.join(ARTIFACTS, 'profile'), { recursive: true, force: true });

  // The suite's copy/paste scenarios use the one real system clipboard.
  // Save the user's clipboard now and restore it at the end.
  let savedClipboard = null;
  try {
    savedClipboard = execSync('pbpaste', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    /* non-text clipboard; nothing we can preserve */
  }

  // --- demo pages ---------------------------------------------------------
  const server = http
    .createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      const title = req.url.includes('b') ? 'Page B' : 'Page A';
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
          `<body style="margin:0;font:16px -apple-system,sans-serif;background:#f4f1ea">` +
          `<main style="max-width:640px;margin:60px auto"><h1>${title}</h1>` +
          `<p>An ordinary web page. The terminal is not part of it.</p></main></body></html>`
      );
    })
    .listen(PAGE_PORT);

  // --- real headed Chrome with the real extension, positioned so it stays
  // partially visible behind the dogsh window (the steal-bug precondition) --
  const chromiumApp = chromium.executablePath().split('/Contents/MacOS/')[0];
  const context = await chromium.launchPersistentContext(path.join(ARTIFACTS, 'profile'), {
    headless: false,
    viewport: null,
    recordVideo: { dir: ARTIFACTS, size: { width: 1280, height: 860 } },
    args: [
      `--disable-extensions-except=${EXT_DIST}`,
      `--load-extension=${EXT_DIST}`,
      '--window-position=60,60',
      '--window-size=1280,860',
    ],
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Point THIS browser's extension at the isolated test daemon before any
  // page connects.
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  await sw.evaluate((port) => chrome.storage.local.set({ portOverride: port }), TEST_PORT);

  const pageA = context.pages()[0] || (await context.newPage());
  await pageA.goto(`http://127.0.0.1:${PAGE_PORT}/a`);
  // Put renderer focus in the page content (not the omnibox) so real OS
  // window activation later restores focus to the page and fires its focus
  // events — the same state a user who has clicked the page once is in.
  await pageA.mouse.click(400, 300);
  await sleep(500);

  // App stdout/stderr -> artifact. Since the daemon extraction the daemon is
  // a DETACHED grandchild with ignored stdio, so there is no log line to
  // watch for readiness. Readiness = the daemon's port accepting a WebSocket
  // — the only definition a face cares about anyway.
  const daemonLog = fs.createWriteStream(path.join(ARTIFACTS, 'daemon.log'), { flags: 'w' });
  const daemonUp = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = () => resolve(false);
    });
  let appProc = null;
  const launchApp = async () => {
    appProc = spawn(APP_BIN, [], {
      env: { ...process.env, DOGSH_PORT: String(TEST_PORT), DOGSH_DEBUG: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    appProc.stdout.on('data', (d) => daemonLog.write(d));
    appProc.stderr.on('data', (d) => daemonLog.write(d));
    const up = await waitFor(daemonUp, 15000, 500);
    if (!up) throw new Error('daemon did not start');
  };

  try {
    // =====================================================================
    // Scenario 1 — "I opened the app and typed; it must stay put."
    // The exact bug from manual review: launching the app while Chrome sat
    // in the background let a reconnecting tab steal the terminal.
    // =====================================================================
    await launchApp();
    await sleep(2000); // app settles; first bridge retry fires
    await ensureFrontmost(APP_BUNDLE, 'dogsh');
    check('launch: dogsh app is frontmost after opening it', true);

    let stolenBy = null;
    let overlayAppeared = false;
    for (let i = 0; i < 6; i++) {
      await sleep(1000); // spans multiple 2s bridge-reconnect ticks
      const front = frontApp();
      if (front !== 'dogsh') stolenBy = front;
      if (await overlayVisible(pageA)) overlayAppeared = true;
    }
    // Only our own test browser counts as a steal; anything else frontmost
    // means a human grabbed the desk mid-run.
    if (stolenBy && !stolenBy.includes('Chrome')) throw new DeskContestedError(stolenBy);
    check(
      'stay put: 6s with background Chrome — dogsh never loses frontmost',
      !stolenBy,
      stolenBy ? `stolen by ${stolenBy}` : 'front=dogsh throughout'
    );
    check('stay put: overlay never appeared in the background tab', !overlayAppeared);

    // =====================================================================
    // Scenario 1.5 — "I opened a second session tab and did work in BOTH."
    // Two shells, each with its OWN text on screen, before any transition:
    // the dance below must carry a session STACK across surfaces, not one
    // lucky buffer. Markers use executed arithmetic ($((200+22)) -> 222) so
    // a match proves the shell RAN it, not that the keystrokes echoed.
    // (Input and switching go through the daemon protocol — the native
    // window owns the terminal here; see MANUAL-ONLY on native keystrokes.)
    // =====================================================================
    await sessionRun('echo TAB_ONE_TEXT_$((200+22))');
    const s1Loaded = await waitFor(
      async () => (await sessionSnapshot()).includes('TAB_ONE_TEXT_222'),
      8000,
      400
    );
    check('two tabs: session 1 loaded with its own text', !!s1Loaded);

    await sessionCreate(); // like every terminal: the new tab focuses
    await sessionRun('echo TAB_TWO_TEXT_$((300+33))');
    const s2Loaded = await waitFor(async () => {
      const s = await sessionSnapshot(); // snapshots read the ACTIVE session
      return s.includes('TAB_TWO_TEXT_333') && !s.includes('TAB_ONE_TEXT_222');
    }, 8000, 400);
    check("two tabs: session 2 loaded with its own text — and none of session 1's", !!s2Loaded);

    await sessionSwitch(1);
    const s1Active = await waitFor(async () => {
      const s = await sessionSnapshot();
      return s.includes('TAB_ONE_TEXT_222') && !s.includes('TAB_TWO_TEXT_333');
    }, 8000, 400);
    check('two tabs: switching back shows session 1 only', !!s1Active);

    // Do real work in the FIRST terminal (the native window) before any
    // handoff: launch the Cursor CLI agent and give it a REAL job. A live,
    // actively-generating TUI is the meanest payload a handoff can carry —
    // the terminal must cross three surfaces while a program is mid-flight
    // in the session (with a second loaded session riding along behind it).
    await sessionRun('agent --yolo');
    // Boot is network-dependent (login check), so poll the session until the
    // input box is up. If a trust-this-directory dialog appears first (fresh
    // machines paint one before the input box), accept it with Enter.
    const booted = await waitFor(
      async () => {
        const s = await sessionSnapshot();
        if (/trust/i.test(s)) {
          await sessionInput('\r'); // accept the default (trust) choice
          return null;
        }
        return s.includes('Plan, search, build anything'); // input placeholder
      },
      25000,
      700
    );
    check('agent: TUI booted to its input box in the native window', !!booted);
    if (!booted) throw new Error('agent TUI did not boot — aborting');

    // Submit the prompt. Text and Enter are SEPARATE pty writes: the TUI's
    // paste heuristics treat a same-chunk CR as pasted text, not a submit
    // (probed 2026-07-15 — one write leaves the prompt sitting unsent).
    await sessionInput('generate a haiku for july 15th');
    await sleep(400);
    await sessionInput('\r');

    // =====================================================================
    // Scenario 2 — "The agent is generating; I switched to Chrome tab A,
    // then tab B, then back to the app — the terminal followed every hop
    // with the run still in flight, and it actually RENDERED everywhere."
    // (GPU-real: catches the black-WebGL-canvas bug.)
    // =====================================================================
    // Hop 1: native -> Chrome tab A, immediately after the submit.
    await ensureFrontmost(chromiumApp, 'Google Chrome for Testing');
    const revealed = await waitFor(() => overlayVisible(pageA), 5000);
    check('follow: overlay revealed after real app switch to Chrome', !!revealed);
    // Busy strings probed 2026-07-15: a "Working" spinner row plus a
    // "ctrl+c to stop" hint while generating; both vanish on completion.
    // The haiku takes ~6s to generate and this hop lands ~2-3s after the
    // submit, so arriving mid-run is the expected case, not a lucky race.
    const midA = await sessionSnapshot();
    check(
      'follow: prompt was accepted — the submitted ask is in the session',
      midA.includes('generate a haiku for july 15th')
    );
    check(
      'follow: arrived on tab A while the agent was still generating',
      /Working|ctrl\+c to stop/.test(midA),
      /Working|ctrl\+c to stop/.test(midA) ? 'spinner live' : 'generation already finished'
    );
    await sleep(700); // renderer settle before pixel sampling
    const rows = Number(await overlayAttr(pageA, 'data-rows'));
    const webgl = await overlayAttr(pageA, 'data-webgl');
    const variance = await overlayPixelVariance(pageA);
    check('follow: terminal shows the live agent TUI rows', rows >= 3, `data-rows=${rows}`);
    // No renderer-identity assertion: which renderer runs is an implementation
    // choice (DOM by default after the WebGL blank-canvas bugs). What a user
    // can observe — and what we assert — is that text actually painted.
    // Threshold calibrated on desk runs: blank canvas = 0.0 exactly (uniform
    // fill), two sparse prompt lines = 4.5, a full listing = 40.6.
    // 2 cleanly separates "painted something" from "painted nothing".
    check(
      'follow: TEXT pixels actually rendered (not a blank/black canvas)',
      variance > 2,
      `text-area luminance stddev=${variance && variance.toFixed(1)} (webgl=${webgl})`
    );
    await pageA.screenshot({ path: path.join(ARTIFACTS, '1-follow-generating-tabA.png') });

    // Hop 2: tab A -> tab B (a real tab switch in the focused window),
    // still mid-run if the model is thinking.
    const pageB = await context.newPage();
    await pageB.goto(`http://127.0.0.1:${PAGE_PORT}/b`);
    await pageB.bringToFront();
    const onBGen = await waitFor(() => overlayVisible(pageB), 5000);
    check('follow: overlay hopped to tab B mid-run', !!onBGen);
    check('follow: overlay left tab A', !(await overlayVisible(pageA)));
    await sleep(700);
    const varBGen = await overlayPixelVariance(pageB);
    check(
      'follow: tab B renders real TEXT pixels mid-run',
      varBGen > 2,
      `text-area stddev=${varBGen && varBGen.toFixed(1)}`
    );
    await pageB.screenshot({ path: path.join(ARTIFACTS, '1b-follow-generating-tabB.png') });

    // Hop 3: tab B -> back to the native app. The overlay must get out of
    // the way; the run keeps living in the session either way.
    await ensureFrontmost(APP_BUNDLE, 'dogsh');
    const hidForNative = await waitFor(async () => !(await overlayVisible(pageB)), 5000);
    check('follow: overlay yielded when the native app took focus mid-run', !!hidForNative);
    check('follow: dogsh is frontmost again', frontApp() === 'dogsh', `front=${frontApp()}`);

    // Let the run finish (probed completion state: the "Add a follow-up"
    // input back WITHOUT the spinner/stop hint). Reading the NATIVE window's
    // pixels needs Screen Recording permission (MANUAL-ONLY), so completion
    // is observed through the daemon snapshot channel.
    const doneSnap = await waitFor(
      async () => {
        const s = await sessionSnapshot();
        return s.includes('Add a follow-up') && !s.includes('ctrl+c to stop') && !s.includes('Working')
          ? s
          : null;
      },
      90000,
      1000
    );
    check('agent: the run completed after the three-surface dance', !!doneSnap);
    if (doneSnap) {
      // A haiku is three lines; require at least that much real response
      // text between the prompt echo and the input box. (The content itself
      // is nondeterministic, so assert shape, not words.)
      const lines = doneSnap.split('\n').map((l) => l.trim());
      const pi = lines.findIndex((l) => l.includes('generate a haiku for july 15th'));
      const fi = lines.findIndex((l, i) => i > pi && l.includes('Add a follow-up'));
      const responseLines = pi >= 0 && fi > pi ? lines.slice(pi + 1, fi).filter(Boolean).length : 0;
      check(
        'agent: a haiku actually arrived (>=3 response lines above the input box)',
        responseLines >= 3,
        `${responseLines} response lines`
      );
    }

    // Exit the agent: Ctrl+C arms "Press Ctrl+C again to exit", the second
    // one returns to the shell (probed 2026-07-15). The native face owns the
    // terminal now, so the keystrokes go through the daemon protocol like
    // all native-owned input in this suite. Then PROVE the shell is back
    // with an executed (not just echoed) marker: $((40+2)) only becomes 42
    // if zsh ran it.
    await sessionInput('\x03');
    await sleep(900);
    await sessionInput('\x03');
    await sleep(1500);
    await sessionRun('echo E2E_SHELL_BACK_$((40+2))');
    const shellBack = await waitFor(
      async () => (await sessionSnapshot()).includes('E2E_SHELL_BACK_42'),
      8000,
      500
    );
    check('agent: double Ctrl+C exited the TUI back to a working shell', !!shellBack);
    // Every scenario below types into the session expecting a SHELL. Typing
    // into a still-alive --yolo agent would submit those lines as prompts to
    // an auto-approving agent in $HOME. Never proceed past this point.
    if (!shellBack) throw new Error('agent TUI did not verifiably exit — aborting shell scenarios');

    // Back to Chrome tab A for the shell scenarios — and THE data-continuity
    // assertion: everything that happened across the dance (banner painted
    // while native owned, the prompt, the agent's input box, the post-exit
    // shell marker) must be readable from the browser overlay's buffer.
    // A window that follows without its session is a different bug class
    // than no window at all — and a worse illusion.
    //
    // This exact transition — return to Chrome landing on tab B, then an
    // immediate switch to tab A — caught a real arbitration bug on
    // 2026-07-15: tab B's late window-focus claim evicted tab A's parked
    // tab-switch claim, the native blur granted the terminal to the now-
    // HIDDEN tab B, and the overlay was visible NOWHERE. Assert the reveal
    // explicitly (it used to be silently skipped) and dump the daemon's
    // arbitration state if it fails.
    await ensureFrontmost(chromiumApp, 'Google Chrome for Testing');
    await pageA.bringToFront();
    const backOnA = await waitFor(() => overlayVisible(pageA), 5000);
    if (!backOnA) console.log(`[e2e] daemon state: ${JSON.stringify(await daemonDebugState())}`);
    check('follow: overlay revealed on tab A after return-to-Chrome + tab switch', !!backOnA);
    await sleep(700);
    const ptFollow = await termPoint(pageA);
    const clipFollow = await copyAllToClipboard(pageA, ptFollow);
    check(
      'follow: session DATA followed — agent banner, prompt, and shell marker all readable on tab A',
      clipFollow.includes('Cursor Agent') &&
        clipFollow.includes('generate a haiku for july 15th') &&
        clipFollow.includes('E2E_SHELL_BACK_42'),
      clipFollow === CLIP_SENTINEL ? 'copy did not happen' : `clipboard=${clipFollow.length}b`
    );

    // =====================================================================
    // Scenario 2.5 — "My OTHER tab crossed the dance too — with ITS text,
    // and none of this one's." The strip must show both sessions in the
    // overlay, and switching must land on session 2's pre-dance content,
    // fully isolated from session 1's agent run.
    // =====================================================================
    check(
      'two tabs: overlay strip shows both sessions after the dance',
      (await overlayAttr(pageA, 'data-sessions')) === '2',
      `data-sessions=${await overlayAttr(pageA, 'data-sessions')}`
    );
    await sessionSwitch(2);
    const strip2 = await waitFor(
      async () => (await overlayAttr(pageA, 'data-session-active')) === '2',
      5000
    );
    check('two tabs: overlay strip marks session 2 active after the switch', !!strip2);
    // The 2026-07-15 run failed HERE without touching a single assertion
    // about sessions: ownership flickered to the hidden tab B on a 2s
    // metronome (both faces' self-heal claims passed a stale visible+focused
    // gate), the overlay vanished mid-copy, and every menu-driven scenario
    // downstream inherited the corruption. Assert stability across more
    // than one owner-state tick so that bug class fails THIS check, loudly,
    // instead of five unrelated ones.
    const steady = await overlayStable(pageA, 2500);
    if (!steady) console.log(`[e2e] flicker post-mortem:\n${await daemonJournal()}`);
    check('two tabs: overlay stayed put through the session switch (no ownership flicker)', steady);
    const clipS2 = await copyAllToClipboard(pageA, ptFollow);
    check(
      "two tabs: session 2's text survived the dance — isolated from session 1's agent run",
      clipS2.includes('TAB_TWO_TEXT_333') && !clipS2.includes('Cursor Agent'),
      clipS2 === CLIP_SENTINEL ? 'copy did not happen' : `clipboard=${clipS2.length}b`
    );
    await pageA.screenshot({ path: path.join(ARTIFACTS, '2b-session-two-after-dance.png') });
    // Back to session 1 for the shell scenarios below.
    await sessionSwitch(1);
    const strip1 = await waitFor(
      async () => (await overlayAttr(pageA, 'data-session-active')) === '1',
      5000
    );
    check('two tabs: overlay strip marks session 1 active again', !!strip1);
    await sleep(400);

    // =====================================================================
    // Scenario 3 — "I typed a command and copied its output."
    // keyboard -> pty -> shell -> render -> selection -> system clipboard.
    // =====================================================================
    const pt = await termPoint(pageA);
    await pageA.mouse.click(pt.x, pt.y); // focus the terminal like a user
    await sleep(200);
    await pageA.keyboard.type('echo E2E_DESKTOP_MARKER', { delay: 30 });
    await pageA.keyboard.press('Enter');
    await sleep(1200);
    const clip1 = await copyAllToClipboard(pageA, pt);
    check(
      'work: typed command output is real and copyable',
      clip1.includes('E2E_DESKTOP_MARKER'),
      `clipboard=${clip1.length}b`
    );

    // =====================================================================
    // Scenario 4 — "I clicked inside a TUI and it saw the mouse."
    // /bin/cat -v echoes its stdin, making mouse-protocol input visible.
    // =====================================================================
    await pageA.keyboard.type("printf '\\e[?1000h\\e[?1006h'; /bin/cat -v", { delay: 30 });
    await pageA.keyboard.press('Enter');
    await sleep(800);
    await pageA.mouse.click(pt.x, pt.y);
    await sleep(700);
    await pageA.keyboard.press('Control+C');
    await sleep(300);
    await pageA.keyboard.type("printf '\\e[?1000l\\e[?1006l'", { delay: 30 });
    await pageA.keyboard.press('Enter');
    await sleep(500);
    const clip2 = await copyAllToClipboard(pageA, pt);
    check(
      'TUI: real click delivered to the app as SGR mouse input',
      clip2.includes('[<0;'),
      `clipboard=${clip2.length}b`
    );

    // =====================================================================
    // Scenario 5 — "Cmd+K wiped the terminal — including the scrollback."
    // =====================================================================
    await pageA.mouse.click(pt.x, pt.y);
    await sleep(200);
    await pageA.keyboard.press('Meta+KeyK');
    await sleep(900);
    const clip3 = await copyAllToClipboard(pageA, pt);
    check(
      'clear: Cmd+K durably wipes content and scrollback',
      clip3 !== CLIP_SENTINEL && clip3.length > 0 && !clip3.includes('E2E_DESKTOP_MARKER'),
      clip3 === CLIP_SENTINEL ? 'copy did not happen' : `clipboard=${clip3.length}b`
    );
    await pageA.keyboard.press('Control+C'); // fresh prompt for later phases
    await sleep(300);

    // =====================================================================
    // Scenario 6 — "I switched tabs; it came with me — WITH my work."
    // The window appearing on the new tab is the lesser half; the session
    // content crossing with it is the actual product. (The Cmd+K scenario
    // above wiped the agent banner on purpose, so plant fresh work first.)
    // =====================================================================
    await pageA.mouse.click(pt.x, pt.y);
    await sleep(200);
    await pageA.keyboard.type('echo TAB_SWITCH_MARKER', { delay: 30 });
    await pageA.keyboard.press('Enter');
    await sleep(900);
    // pageB already exists from the mid-generation dance; switching back to
    // it is still a real tab switch in the focused window.
    await pageB.bringToFront();
    const onB = await waitFor(() => overlayVisible(pageB), 5000);
    check('tab switch: overlay revealed on the new tab', !!onB);
    check('tab switch: overlay left the old tab', !(await overlayVisible(pageA)));
    await sleep(900);
    const rowsB = Number(await overlayAttr(pageB, 'data-rows'));
    const varB = await overlayPixelVariance(pageB);
    check(
      'tab switch: new tab renders real TEXT pixels',
      rowsB > 0 && varB > 2, // calibration: blank=0.0, sparse prompt=4.5
      `rows=${rowsB} text-area stddev=${varB && varB.toFixed(1)}`
    );
    const ptB = await termPoint(pageB);
    const clipB = await copyAllToClipboard(pageB, ptB);
    check(
      'tab switch: session DATA followed — work typed on tab A is readable on tab B',
      clipB.includes('TAB_SWITCH_MARKER'),
      clipB === CLIP_SENTINEL ? 'copy did not happen' : `clipboard=${clipB.length}b`
    );
    await pageB.screenshot({ path: path.join(ARTIFACTS, '2-tab-switch.png') });

    // =====================================================================
    // Scenario 7 — "I went back to the app; the overlay got out of the way."
    // =====================================================================
    await ensureFrontmost(APP_BUNDLE, 'dogsh');
    const homeAgain = await waitFor(async () => !(await overlayVisible(pageB)), 5000);
    check('return: overlay hid when the real app took focus', !!homeAgain);
    check('return: dogsh is frontmost again', frontApp() === 'dogsh', `front=${frontApp()}`);

    // =====================================================================
    // Scenario 8 — "The app died; my session did NOT." Since the daemon
    // extraction the session lives in a standalone daemon; the app is just
    // a face + window host. Killing the app while the terminal lives in a
    // tab must leave that terminal alive AND still executing — the exact
    // opposite of this scenario's pre-daemon assertion (overlay vanishes
    // with the app), which described the old single-process architecture.
    // =====================================================================
    await ensureFrontmost(chromiumApp, 'Google Chrome for Testing');
    // The follow-back is a PRECONDITION, not scenery: killing the app while
    // the overlay never arrived makes the "overlay STAYS" check below fail
    // for a reason that has nothing to do with survivability (which is
    // exactly how the 2026-07-15 run's survive block turned misleading).
    const preKill = await waitFor(() => overlayVisible(pageB), 8000);
    if (!preKill) console.log(`[e2e] pre-kill follow-back missing:\n${await daemonJournal()}`);
    check('survive: overlay followed back to tab B before the kill (precondition)', !!preKill);
    appProc.kill();
    await sleep(2500); // long enough for any (wrong) bridge-down hide to fire
    check(
      'survive: overlay STAYS after the app quits (session lives in the daemon)',
      await overlayVisible(pageB)
    );
    const ptDead = await termPoint(pageB);
    await pageB.mouse.click(ptDead.x, ptDead.y);
    await sleep(200);
    await pageB.keyboard.type('echo APP_DEAD_STILL_ALIVE', { delay: 30 });
    await pageB.keyboard.press('Enter');
    await sleep(1200);
    const clipDead = await copyAllToClipboard(pageB, ptDead);
    check(
      'survive: session still executes commands with the app dead',
      clipDead.includes('APP_DEAD_STILL_ALIVE'),
      clipDead === CLIP_SENTINEL ? 'copy did not happen' : `clipboard=${clipDead.length}b`
    );
    // Reopen the app (it comes up frontmost, as reopened apps do): the
    // native window reclaims the terminal, so the overlay must get out of
    // the way — and the reattaching host must not fight the tab afterwards.
    await launchApp();
    // `open` on a just-relaunched bundle can hit Launch Services error -600.
    // Give it a beat (ensureFrontmost also retries failed activations).
    await sleep(1500);
    await ensureFrontmost(APP_BUNDLE, 'dogsh');
    const yielded = await waitFor(async () => !(await overlayVisible(pageB)), 8000);
    check('survive: overlay yielded to the reopened app', !!yielded);
    await ensureFrontmost(chromiumApp, 'Google Chrome for Testing'); // real switch back
    const back = await waitFor(() => overlayVisible(pageB), 8000);
    check('survive: overlay returned after switching back to Chrome', !!back);
    await sleep(800);
    const clipBack = await copyAllToClipboard(pageB, await termPoint(pageB));
    check(
      'survive: pre-death work is still in the session after the app relaunch',
      clipBack.includes('APP_DEAD_STILL_ALIVE'),
      clipBack === CLIP_SENTINEL ? 'copy did not happen' : `clipboard=${clipBack.length}b`
    );
  } catch (e) {
    if (e instanceof DeskContestedError) {
      // Not a product failure: a human had the desk. Say so and stop.
      console.error(
        `\n[e2e] ABORTED — DESKTOP CONTESTED: "${e.front}" was frontmost. ` +
          `A human is using the machine; results would be meaningless. ` +
          `Re-run when the desk is free (the run takes ~2min, hands off).`
      );
      failures = -1; // sentinel: aborted, not failed
    } else {
      failures++;
      console.error('[e2e] FAIL (exception):', e.message);
      for (const [i, p] of context.pages().entries()) {
        await p.screenshot({ path: path.join(ARTIFACTS, `fail-page${i}.png`) }).catch(() => {});
      }
    }
  } finally {
    const videoPaths = [];
    for (const p of context.pages()) {
      const v = p.video();
      if (v) videoPaths.push(v.path());
    }
    await context.close();
    for (const v of videoPaths) console.log('[e2e] video:', await v);
    if (appProc) appProc.kill();
    // The daemon is a detached grandchild — the app's death deliberately
    // does NOT take it down (that survivability is under test above). Kill
    // it by exact bundle path so the test session's shell doesn't outlive
    // the run. The user's real daemon (different binary path) can't match.
    try {
      execSync(`pkill -f ${JSON.stringify(APP_BIN)}`);
    } catch {
      /* already gone */
    }
    daemonLog.end();
    server.close();
    if (savedClipboard !== null) {
      try {
        execSync('pbcopy', { input: savedClipboard });
      } catch {
        /* clipboard restore is best-effort */
      }
    }
    restoreUserFocus();
  }

  console.log(`
[e2e] MANUAL-ONLY (cannot be honestly automated without extra macOS permissions):
  - doghouse: Cmd+D shrink-to-pill, bark on would-have-followed, island wrap
  - extension reload mid-session self-heal (chrome://extensions -> reload)
  - native window pixel-correctness after return (needs Screen Recording permission)
  - native window KEYSTROKES (needs Accessibility permission; the suite injects
    session input via the daemon protocol instead — pty/shell/mirror/overlay
    stay real, only Electron's DOM key handling is skipped)
  - session tab strip CLICKS (switch/close/+): closed shadow root, variable-
    width tabs — a guessed coordinate can hit a tab's × and kill that shell.
    The suite posts the strip's exact protocol messages instead and verifies
    the strip's rendered state via data-session-* evidence attributes.
  - dock icon / cmd-tab appearance, Liquid Glass icon
  - stale extension build warning (needs an actual old build installed)
`);
  if (failures === -1) process.exit(2); // contested: neither pass nor fail
  console.log(failures === 0 ? '[e2e] ALL PASS' : `[e2e] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
