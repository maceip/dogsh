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
//   2. REAL RENDERING. Headed Chrome, real extension, GPU on. Never
//      headless, never noWebgl. Pixel assertions catch the whole "working
//      but shows nothing" class (black WebGL canvas, blank reveal).
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
// NOTE: this suite takes over the desktop for ~90 seconds. Windows will
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

// Run a command in the live session while the NATIVE face owns it. Typing
// real keystrokes into the Electron window needs the Accessibility permission
// (osascript System Events), which this suite deliberately does not require.
// So the command is injected through the daemon's public protocol — the exact
// bytes the native face sends after a keystroke. Everything downstream (pty,
// shell, mirror, snapshot, overlay render) is real; only the native window's
// DOM key handling is skipped (listed in MANUAL-ONLY).
function sessionRun(command) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('session input: daemon unreachable'));
    }, 5000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'input', data: command + '\r' }));
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
  await page.evaluate((s) => navigator.clipboard.writeText(s).catch(() => {}), CLIP_SENTINEL);
  await menuAction(page, at, 2); // Select All
  await menuAction(page, at, 0); // Copy
  return page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
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
  console.log(`[e2e] starting in ${Math.round(grace / 1000)}s — hands off for ~90s after that`);
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

  // Daemon stdout/stderr -> artifact. The daemon logs its choreography
  // decisions under DOGSH_DEBUG; when a reveal doesn't happen, this log says
  // whether the claim never arrived, was guarded away, or was sent and lost.
  const daemonLog = fs.createWriteStream(path.join(ARTIFACTS, 'daemon.log'), { flags: 'w' });
  let appProc = null;
  const launchApp = () =>
    new Promise((resolve, reject) => {
      appProc = spawn(APP_BIN, [], {
        env: { ...process.env, DOGSH_PORT: String(TEST_PORT), DOGSH_DEBUG: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const t = setTimeout(() => reject(new Error('daemon did not start')), 15000);
      appProc.stdout.on('data', (d) => {
        daemonLog.write(d);
        if (d.toString().includes('daemon listening')) {
          clearTimeout(t);
          resolve();
        }
      });
      appProc.stderr.on('data', (d) => daemonLog.write(d));
    });

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

    // Do real work in the FIRST terminal (the native window) before any
    // handoff. This output is the payload for the follow test below: the
    // window following is worthless if the session data doesn't follow too.
    await sessionRun('ls -la');
    await sleep(1500); // shell runs, output lands in pty -> mirror -> faces

    // =====================================================================
    // Scenario 2 — "I switched to Chrome; the terminal followed, and it
    // actually RENDERED." (GPU-real: catches the black-WebGL-canvas bug.)
    // =====================================================================
    await ensureFrontmost(chromiumApp, 'Google Chrome for Testing');
    const revealed = await waitFor(() => overlayVisible(pageA), 5000);
    check('follow: overlay revealed after real app switch to Chrome', !!revealed);
    await sleep(1200); // snapshot + evidence + renderer settle
    const rows = Number(await overlayAttr(pageA, 'data-rows'));
    const webgl = await overlayAttr(pageA, 'data-webgl');
    const variance = await overlayPixelVariance(pageA);
    check('follow: terminal shows the ls -la listing rows', rows >= 3, `data-rows=${rows}`);
    check('follow: WebGL renderer active for the focused tab', webgl === '1', `data-webgl=${webgl}`);
    check(
      'follow: TEXT pixels actually rendered (not a blank/black canvas)',
      variance > 5,
      `text-area luminance stddev=${variance && variance.toFixed(1)}`
    );
    await pageA.screenshot({ path: path.join(ARTIFACTS, '1-follow-rendered.png') });

    // THE data-continuity assertion: the `ls -la` that ran while the NATIVE
    // window owned the terminal must be readable in the browser overlay.
    // A window that follows without its session is a different bug class
    // than no window at all — and a worse illusion.
    const ptFollow = await termPoint(pageA);
    const clipFollow = await copyAllToClipboard(pageA, ptFollow);
    check(
      'follow: session DATA followed — native-window ls -la output is in the overlay',
      clipFollow.includes('drwx') && clipFollow.includes('ls -la'),
      clipFollow === CLIP_SENTINEL ? 'copy did not happen' : `clipboard=${clipFollow.length}b`
    );

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
    // Scenario 6 — "I switched tabs; it came with me."
    // =====================================================================
    const pageB = await context.newPage();
    await pageB.goto(`http://127.0.0.1:${PAGE_PORT}/b`);
    await pageB.bringToFront(); // a real tab switch in the focused window
    const onB = await waitFor(() => overlayVisible(pageB), 5000);
    check('tab switch: overlay revealed on the new tab', !!onB);
    check('tab switch: overlay left the old tab', !(await overlayVisible(pageA)));
    await sleep(900);
    const rowsB = Number(await overlayAttr(pageB, 'data-rows'));
    const varB = await overlayPixelVariance(pageB);
    check(
      'tab switch: new tab renders real TEXT pixels',
      rowsB > 0 && varB > 5,
      `rows=${rowsB} text-area stddev=${varB && varB.toFixed(1)}`
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
    // Scenario 8 — "The app died; the overlay vanished. I reopened the app
    // (it comes up frontmost, as reopened apps do), switched back to my
    // tab, and the terminal was there again."
    // =====================================================================
    await ensureFrontmost(chromiumApp, 'Google Chrome for Testing');
    await waitFor(() => overlayVisible(pageB), 5000); // follow back first
    appProc.kill();
    const vanished = await waitFor(async () => !(await overlayVisible(pageB)), 5000);
    check('resilience: overlay vanished everywhere when the app quit', !!vanished);
    await launchApp();
    // The daemon listens before the window/LS registration settle; `open` on
    // a just-relaunched bundle can hit Launch Services error -600. Give it a
    // beat (ensureFrontmost also tolerates and retries failed activations).
    await sleep(1500);
    await ensureFrontmost(APP_BUNDLE, 'dogsh'); // a reopened app comes up frontmost
    await sleep(2500); // extension bridge retries every 2s; let it reattach
    // While the user is IN the reopened app, the reattaching bridge must not
    // flash the overlay into the background tab (the original steal bug,
    // re-tested here under reconnect conditions).
    check(
      'resilience: reattach while in the app does not steal',
      !(await overlayVisible(pageB))
    );
    await ensureFrontmost(chromiumApp, 'Google Chrome for Testing'); // real switch back
    const back = await waitFor(() => overlayVisible(pageB), 8000);
    check('resilience: overlay returned after reopening app + switching back', !!back);
    const rowsBack = Number(await overlayAttr(pageB, 'data-rows'));
    check('resilience: restored terminal has content', rowsBack > 0, `rows=${rowsBack}`);
  } catch (e) {
    if (e instanceof DeskContestedError) {
      // Not a product failure: a human had the desk. Say so and stop.
      console.error(
        `\n[e2e] ABORTED — DESKTOP CONTESTED: "${e.front}" was frontmost. ` +
          `A human is using the machine; results would be meaningless. ` +
          `Re-run when the desk is free (the run takes ~90s, hands off).`
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
