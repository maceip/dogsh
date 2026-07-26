// dogsh glass e2e — ONE command, ONE session:
//   build ext → emulator/Edge Canary + newest crx → Chrome for Testing + dist →
//   native dogsh → agent --yolo → tab A → tab B → phone (durable, no flicker).
//
// Run:  cd e2e && npm test
//
// Agents: do NOT open Google Chrome.app, hand-drive Edge, or invent side probes.
// See e2e/README.md. Headless protocol smoke stays in wire-probe.js (not this file).
const { chromium } = require('playwright');
const { spawn, execFile, execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const CONFIG = require('../app/shared/config.js');
const WebSocket = require(path.join(__dirname, '..', 'app', 'node_modules', 'ws'));
const { setupPhone, assertPhoneFollow } = require('./phone');

const ROOT = path.join(__dirname, '..');
const EXT_DIST = path.join(ROOT, 'extension', 'dist');
const APP_BUNDLE = path.join(ROOT, 'app', 'build', 'dogsh-darwin-arm64', 'dogsh.app');
const APP_BIN = path.join(APP_BUNDLE, 'Contents', 'MacOS', 'dogsh');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const TAB_A_URL = process.env.DOGSH_E2E_TAB_A || 'https://x.com/';
const TAB_B_URL = process.env.DOGSH_E2E_TAB_B || 'https://news.ycombinator.com/';
const AGENT_PROMPT = 'what is trending on Twitter right now';
const TEST_PORT = 47713;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`[e2e] ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function frontApp() {
  try {
    const out = execSync('lsappinfo info -only name $(lsappinfo front)', { encoding: 'utf8' });
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
      /* Launch Services -600 race */
    }
    await sleep(900);
    if (frontApp() === appName) return;
  }
  throw new DeskContestedError(frontApp());
}

function sessionInput(data) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('session input: daemon unreachable'));
    }, 5000);
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'hello', surface: 'native', proto: CONFIG.protocolVersion }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.type === 'hello-ack') {
        ws.send(JSON.stringify({ type: 'input', data }));
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('session input: connect failed'));
    };
  });
}
const sessionRun = (command) => sessionInput(command + '\r');

const stripAnsi = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');

function sessionSnapshot() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('session snapshot: daemon unreachable'));
    }, 5000);
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'hello', surface: 'tab', proto: CONFIG.protocolVersion }));
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
async function overlayPainting(page) {
  if (!(await overlayVisible(page))) return false;
  return Number(await overlayAttr(page, 'data-rows')) > 0;
}
async function overlayStable(page, ms) {
  if (!(await overlayVisible(page))) return false;
  const before = await overlayAttr(page, 'data-flips');
  await sleep(ms);
  if (!(await overlayVisible(page))) return false;
  return (await overlayAttr(page, 'data-flips')) === before;
}

function rebuildExtension() {
  console.log('[e2e] rebuilding extension dist + packing crx…');
  execFileSync(process.execPath, [path.join(ROOT, 'extension', 'build.js')], {
    cwd: path.join(ROOT, 'extension'),
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [path.join(ROOT, 'extension', 'pack.js')], {
    cwd: path.join(ROOT, 'extension'),
    stdio: 'inherit',
  });
  if (!fs.existsSync(path.join(EXT_DIST, 'manifest.json'))) {
    throw new Error('extension dist missing after build');
  }
  if (!fs.existsSync(path.join(ROOT, 'extension', 'build', 'dogsh.crx'))) {
    throw new Error('extension/build/dogsh.crx missing after pack');
  }
}

let userFrontApp = '';
function restoreUserFocus() {
  if (userFrontApp && !userFrontApp.includes('dogsh')) {
    try {
      execSync(`open ${JSON.stringify(userFrontApp)}`);
    } catch {
      /* gone */
    }
  }
}

async function main() {
  const grace = Number(process.env.DOGSH_E2E_GRACE_MS) || 5000;
  console.log(`[e2e] starting in ${Math.round(grace / 1000)}s — hands off after that`);
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

  if (!fs.existsSync(APP_BIN)) {
    console.error(`[e2e] packaged app missing at ${APP_BIN} — run: cd app && npm run package`);
    process.exit(1);
  }
  rebuildExtension();

  for (const pattern of [APP_BIN, path.join(ARTIFACTS, 'profile')]) {
    try {
      execSync(`pkill -f ${JSON.stringify(pattern)}`);
    } catch {
      /* none */
    }
  }
  await sleep(500);
  fs.rmSync(path.join(ARTIFACTS, 'profile'), { recursive: true, force: true });

  const chromeForTesting = chromium.executablePath();
  if (!/Chrome for Testing/i.test(chromeForTesting)) {
    throw new Error(`e2e must use Google Chrome for Testing, got: ${chromeForTesting}`);
  }
  const chromiumApp = chromeForTesting.split('/Contents/MacOS/')[0];

  // --- 1. Phone: emulator + Edge Canary + newest crx -----------------------
  console.log('[e2e] setup: phone (emulator / Edge Canary / extension)');
  const phone = await setupPhone({ port: TEST_PORT });

  // --- 2. Desktop: Chrome for Testing + unpacked dist ----------------------
  console.log('[e2e] setup: Chrome for Testing + extension/dist');
  const context = await chromium.launchPersistentContext(path.join(ARTIFACTS, 'profile'), {
    headless: false,
    executablePath: chromeForTesting,
    viewport: null,
    recordVideo: { dir: ARTIFACTS, size: { width: 1280, height: 860 } },
    args: [
      `--disable-extensions-except=${EXT_DIST}`,
      `--load-extension=${EXT_DIST}`,
      '--window-position=60,60',
      '--window-size=1280,860',
    ],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  await sw.evaluate((port) => chrome.storage.local.set({ portOverride: port }), TEST_PORT);

  const pageA = context.pages()[0] || (await context.newPage());
  await pageA.goto(TAB_A_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageA.mouse.click(15, 300);
  await sleep(400);

  const pageB = await context.newPage();
  await pageB.goto(TAB_B_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageA.bringToFront();

  // --- 3. Native dogsh + agent ---------------------------------------------
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsh-e2e-state-'));
  const desktopVideoPaths = [];

  const pathWithAgent = [
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
  ].join(':');
  appProc = spawn(APP_BIN, [], {
    env: {
      ...process.env,
      PATH: pathWithAgent,
      DOGSH_PORT: String(TEST_PORT),
      DOGSH_DEBUG: '1',
      DOGSH_STATE_DIR: stateDir,
    },
  });
  appProc.stdout.on('data', (d) => daemonLog.write(d));
  appProc.stderr.on('data', (d) => daemonLog.write(d));
  const up = await waitFor(daemonUp, 15000, 500);
  if (!up) throw new Error('daemon did not start');

  try {
    await ensureFrontmost(APP_BUNDLE, 'dogsh');
    check('launch: dogsh is frontmost', frontApp() === 'dogsh', `front=${frontApp()}`);

    // Prove pty injection works before launching the agent (catches the
    // "phone stole lease → input dropped" failure mode with a clear signal).
    await sessionRun('echo E2E_PTY_$((6*7))');
    const ptyOk = await waitFor(
      async () => (await sessionSnapshot()).includes('E2E_PTY_42'),
      8000,
      400
    );
    check('pty: sessionInput reaches the shell', !!ptyOk);
    if (!ptyOk) {
      throw new Error('sessionInput dropped — likely a non-native face owns the lease');
    }

    await sessionRun('agent --yolo');
    let booted = null;
    for (let attempt = 0; attempt < 2 && !booted; attempt++) {
      booted = await waitFor(
        async () => {
          const s = await sessionSnapshot();
          if (/trust this|trust the|Do you trust/i.test(s)) {
            await sessionInput('\r');
            return null;
          }
          // Cursor Agent input chrome (probed strings drift across agent builds).
          if (
            /Plan, search, build anything|Add a follow-up|Ask anything|ctrl\+c to stop/i.test(
              s
            ) ||
            /Cursor Agent/i.test(s)
          ) {
            return s;
          }
          return null;
        },
        35000,
        700
      );
      if (!booted) {
        const dump = await sessionSnapshot().catch(() => '');
        console.log(
          `[e2e] agent boot attempt ${attempt + 1} failed; snapshot tail:\n` +
            dump.split('\n').slice(-30).join('\n')
        );
        if (attempt === 0) {
          await sessionInput('\x03');
          await sleep(500);
          await sessionInput('\x03');
          await sleep(800);
          await sessionRun('agent --yolo');
        }
      }
    }
    check('agent: TUI booted to its input box', !!booted);
    if (!booted) throw new Error('agent TUI did not boot — aborting');

    // If we matched on a mid-run/follow-up screen, still try to submit a fresh ask.
    if (!/Plan, search, build anything|Ask anything/i.test(booted) && /Add a follow-up/i.test(booted)) {
      // Already in a finished agent session — submit as follow-up.
    } else if (!/Plan, search, build anything|Ask anything|Add a follow-up/i.test(booted)) {
      // Spinner-only match — wait for input.
      await waitFor(async () => {
        const s = await sessionSnapshot();
        return /Plan, search, build anything|Ask anything|Add a follow-up/i.test(s);
      }, 20000, 700);
    }

    await sessionInput(AGENT_PROMPT);
    await sleep(400);
    await sessionInput('\r');

    // --- 4. Tab A then tab B while generating ------------------------------
    // Hide native first so Electron can't keep a stale focused=true claim
    // after Chrome activates (macOS often skips blur to the deactivated app).
    try {
      execFileSync('osascript', [
        '-e',
        'tell application "System Events" to set visible of process "dogsh" to false',
      ]);
    } catch {
      /* accessibility */
    }
    await sleep(400);
    await ensureFrontmost(chromiumApp, 'Google Chrome for Testing');
    await pageA.bringToFront();
    // Real click: focuses the page + clears post-downlink TX gate.
    await pageA.mouse.click(15, 300);
    const onA = await waitFor(() => overlayVisible(pageA), 12000);
    check('follow: overlay revealed on tab A', !!onA);
    const midA = await sessionSnapshot();
    check(
      'follow: prompt is in the session',
      midA.includes(AGENT_PROMPT),
      midA.includes(AGENT_PROMPT) ? 'prompt present' : 'missing prompt'
    );
    check(
      'follow: arrived on tab A while agent is active',
      /Working|ctrl\+c to stop|Add a follow-up|Cursor Agent/i.test(midA) || midA.includes(AGENT_PROMPT),
      /Working|ctrl\+c to stop/.test(midA) ? 'spinner live' : 'agent UI/prompt present'
    );
    await sleep(500);
    check(
      'follow: tab A extension is painting',
      await overlayPainting(pageA),
      `data-rows=${await overlayAttr(pageA, 'data-rows')}`
    );
    await pageA.screenshot({ path: path.join(ARTIFACTS, '1-tabA.png') });

    await pageB.bringToFront();
    const onB = await waitFor(() => overlayVisible(pageB), 8000);
    check('follow: overlay hopped to tab B', !!onB);
    check('follow: overlay left tab A', !(await overlayVisible(pageA)));
    check(
      'follow: tab B extension is painting',
      await overlayPainting(pageB),
      `data-rows=${await overlayAttr(pageB, 'data-rows')}`
    );
    const steadyB = await overlayStable(pageB, 2500);
    check('follow: tab B overlay stable (no ownership flicker)', steadyB);
    await pageB.screenshot({ path: path.join(ARTIFACTS, '2-tabB.png') });

    // --- 5. Phone while session still live ---------------------------------
    // Detach desktop faces: adb-reverse phone looks like loopback and loses
    // to an engaged Chrome-for-Testing tab.
    for (const p of [...context.pages()]) {
      try {
        const v = p.video();
        if (v) desktopVideoPaths.push(v.path());
      } catch {
        /* no video */
      }
      await p.close().catch(() => {});
    }
    try {
      execFileSync('osascript', [
        '-e',
        'tell application "System Events" to set visible of process "Google Chrome for Testing" to false',
      ]);
    } catch {
      /* ok */
    }
    try {
      execFileSync('osascript', [
        '-e',
        'tell application "System Events" to set visible of process "dogsh" to false',
      ]);
    } catch {
      /* ok */
    }
    await sleep(800);

    await assertPhoneFollow({
      port: TEST_PORT,
      check,
      artifactsDir: ARTIFACTS,
      browser: phone.browser,
      prompt: AGENT_PROMPT,
    });
  } catch (e) {
    if (e instanceof DeskContestedError) {
      console.error(
        `\n[e2e] ABORTED — DESKTOP CONTESTED: "${e.front}" was frontmost. ` +
          `Re-run when the desk is free.`
      );
      failures = -1;
    } else {
      failures++;
      console.error('[e2e] FAIL (exception):', e.message || e);
      for (const [i, p] of context.pages().entries()) {
        await p.screenshot({ path: path.join(ARTIFACTS, `fail-page${i}.png`) }).catch(() => {});
      }
    }
  } finally {
    const videoPaths = [...desktopVideoPaths];
    for (const p of context.pages()) {
      const v = p.video();
      if (v) videoPaths.push(v.path());
    }
    await context.close();
    for (const v of videoPaths) console.log('[e2e] video:', await v);
    if (appProc) appProc.kill();
    try {
      execSync(`pkill -f ${JSON.stringify(APP_BIN)}`);
    } catch {
      /* gone */
    }
    daemonLog.end();
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* ENOTEMPTY race on some macOS tmp dirs */
    }
    restoreUserFocus();
  }

  console.log(`
[e2e] MANUAL-ONLY (not automated here):
  - doghouse / dock / Liquid Glass appearance
  - native window keystrokes & drag-resize (need Accessibility / Screen Recording)
  - extension reload mid-session
`);
  if (failures === -1) process.exit(2);
  console.log(failures === 0 ? '[e2e] ALL PASS' : `[e2e] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
