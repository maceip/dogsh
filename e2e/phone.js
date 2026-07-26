// Phone setup + follow assert for the singular glass e2e (run.js).
// Edge Canary on emulator/device, packed crx id, same daemon/session.
// Does NOT close Edge or wipe daemonUrl — leave the overlay on screen.
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
const WSClient = require(path.join(__dirname, '..', 'app', 'node_modules', 'ws'));
const CONFIG = require('../app/shared/config.js');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = 9224;
const EDGE_PKG = 'com.microsoft.emmx.canary';
const PHONE_URL = process.env.DOGSH_E2E_PHONE_URL || 'https://x.com/';
const AVD = process.env.DOGSH_E2E_AVD || 'codex_cosmo_api35';
const CRX = path.join(ROOT, 'extension', 'build', 'dogsh.crx');
const PEM = path.join(ROOT, 'extension', 'build', 'dogsh.pem');
const REMOTE_CRX = '/sdcard/Download/dogsh.crx';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' });

function extensionId() {
  const pem = fs.readFileSync(PEM, 'utf8');
  const spki = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(spki).digest();
  return [...hash.slice(0, 16)]
    .map((b) => 'abcdefghijklmnop'[b >> 4] + 'abcdefghijklmnop'[b & 15])
    .join('');
}

function daemonState(port) {
  return new Promise((resolve) => {
    const ws = new WSClient(`ws://127.0.0.1:${port}`);
    const bail = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve(null);
    }, 2000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'debug', action: 'state' })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'debug-state') {
        clearTimeout(bail);
        ws.close();
        resolve(m);
      }
    });
    ws.on('error', () => {});
  });
}

function demoEnvReady() {
  return !!(
    process.env.DOGSH_DEMO_EDGE_PKG &&
    process.env.DOGSH_DEMO_HAMBURGER_X &&
    process.env.DOGSH_DEMO_HAMBURGER_Y &&
    process.env.DOGSH_DEMO_SEARCH_X &&
    process.env.DOGSH_DEMO_SEARCH_Y &&
    process.env.DOGSH_DEMO_SWIPE
  );
}

function deviceReady() {
  try {
    return adb('get-state').trim() === 'device';
  } catch {
    return false;
  }
}

/** Start the AVD if no device is attached. */
async function ensureDevice() {
  if (deviceReady()) return;
  console.log(`[e2e] no adb device — starting emulator -avd ${AVD}`);
  const emuBin = process.env.ANDROID_HOME
    ? path.join(process.env.ANDROID_HOME, 'emulator', 'emulator')
    : 'emulator';
  spawn(emuBin, ['-avd', AVD, '-no-snapshot-load'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (deviceReady()) {
      console.log('[e2e] emulator online');
      return;
    }
    await sleep(2000);
  }
  throw new Error(`emulator ${AVD} did not come online in 180s`);
}

function unforwardCdp() {
  try {
    execFileSync('adb', ['forward', '--remove', `tcp:${CDP_PORT}`], { stdio: 'ignore' });
  } catch {}
}

function devtoolsSockets() {
  const unix = adb('shell', 'cat', '/proc/net/unix');
  return [...new Set(unix.match(/chrome_devtools_remote[^\s@]*/g) || [])];
}

async function forwardLiveCdp(marker) {
  for (let attempt = 0; attempt < 40; attempt++) {
    for (const sock of devtoolsSockets()) {
      unforwardCdp();
      try {
        adb('forward', `tcp:${CDP_PORT}`, `localabstract:${sock}`);
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        if (list.some((t) => (t.url || '').includes(marker))) return sock;
      } catch {}
    }
    await sleep(300);
  }
  return null;
}

/**
 * Open Edge Canary, push newest crx, force-install when DOGSH_DEMO_* is set,
 * otherwise require a prior sideload (options page reachable). Point at test daemon.
 * @returns {{ extId: string, browser: import('playwright').Browser, cdpReady: boolean }}
 */
async function setupPhone({ port }) {
  await ensureDevice();
  if (!adb('shell', 'pm', 'list', 'packages').includes(EDGE_PKG)) {
    throw new Error('Edge Canary not installed (com.microsoft.emmx.canary)');
  }
  if (!fs.existsSync(PEM) || !fs.existsSync(CRX)) {
    throw new Error('extension/build/dogsh.crx (+ dogsh.pem) missing — pack failed');
  }
  const extId = extensionId();

  try {
    adb('shell', 'input', 'keyevent', '224');
    adb('shell', 'wm', 'dismiss-keyguard');
  } catch {}

  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  adb('push', CRX, REMOTE_CRX);
  console.log(`[e2e] pushed ${CRX} → ${REMOTE_CRX}`);

  if (demoEnvReady()) {
    console.log('[e2e] DOGSH_DEMO_* set — force-install via deploy-phone.js');
    execFileSync(process.execPath, [path.join(ROOT, 'extension', 'deploy-phone.js')], {
      stdio: 'inherit',
      env: { ...process.env, DOGSH_DEMO_EDGE_PKG: process.env.DOGSH_DEMO_EDGE_PKG || EDGE_PKG },
    });
  } else {
    console.log(
      '[e2e] DOGSH_DEMO_* unset — requiring prior Edge Canary sideload of packed id ' + extId
    );
  }

  adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `'https://example.com/?dogsh_setup=${Date.now()}'`,
    EDGE_PKG
  );
  await sleep(1500);

  const marker = `dogsh_setup=${crypto.randomBytes(4).toString('hex')}`;
  adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `'https://example.com/?${marker}'`,
    EDGE_PKG
  );
  const liveSock = await forwardLiveCdp(marker);
  if (!liveSock) throw new Error('no live Edge DevTools socket (zombie socket trap?)');

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, {
    timeout: 120000,
  });
  const pages = () => browser.contexts().flatMap((c) => c.pages());

  const bcdp = await browser.newBrowserCDPSession();
  await bcdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  let optionsPage = null;
  for (let i = 0; i < 25 && !optionsPage; i++) {
    optionsPage = pages().find((p) => p.url().startsWith(`chrome-extension://${extId}`));
    if (!optionsPage) await sleep(300);
  }
  if (!optionsPage) {
    throw new Error(
      `phone extension ${extId} not installed — set DOGSH_DEMO_* and re-run, or sideload dogsh.crx once via Edge Developer options`
    );
  }
  await optionsPage.evaluate(
    (cfg) => new Promise((res) => chrome.storage.local.set(cfg, () => res(null))),
    { daemonUrl: `ws://localhost:${port}`, daemonToken: '', opacity: 1 }
  );
  console.log(`[e2e] phone extension ${extId} → ws://localhost:${port}`);
  await optionsPage.close().catch(() => {});

  // Park Edge OFF x.com for the desktop A/B dance. Leftover tabs from a prior
  // run (or a mid-setup navigate) would outrank Chrome-for-Testing on the same
  // host via adb-reverse loopback — tab A never reveals, tab B (HN) looks fine.
  for (const p of pages()) {
    const u = p.url() || '';
    if (/x\.com|twitter\.com/i.test(u)) {
      await p.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
  }
  adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `'https://example.com/?dogsh_park=${Date.now()}'`,
    EDGE_PKG
  );
  await sleep(800);
  // Leave the home screen — if Edge stays foregrounded, its tab face steals
  // the lease (adb-reverse = loopback) and native sessionInput is dropped.
  try {
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  } catch {}
  await sleep(400);

  // Keep CDP forward + browser handle for the later follow assert.
  return { extId, browser, cdpReady: true };
}

/**
 * After desktop idle: foreground x.com, assert durable overlay + live agent session, no flicker.
 */
async function assertPhoneFollow({ port, check, artifactsDir, browser, prompt }) {
  if (!browser) throw new Error('assertPhoneFollow: setupPhone must run first');

  // Idle laptop host so the phone face can own (adb-reverse looks like loopback).
  const host = new WSClient(`ws://127.0.0.1:${port}`);
  await new Promise((r) => host.on('open', r));
  host.send(
    JSON.stringify({
      type: 'hello',
      surface: 'native-host',
      proto: CONFIG.protocolVersion,
      sig: { visible: true, focused: false },
    })
  );
  host.send(JSON.stringify({ type: 'signal', visible: true, focused: false }));

  const pages = () => browser.contexts().flatMap((c) => c.pages());
  const siteHost = new URL(PHONE_URL).host;
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${PHONE_URL}'`, EDGE_PKG);

  let overlayTab = null;
  for (let i = 0; !overlayTab; i++) {
    for (const p of pages().filter((q) => q.url().includes(siteHost))) {
      const vis = await p.evaluate(() => document.visibilityState === 'visible').catch(() => false);
      if (vis) {
        overlayTab = p;
        break;
      }
    }
    if (!overlayTab) {
      if (i > 50) throw new Error('phone never foregrounded ' + PHONE_URL);
      await sleep(300);
    }
  }
  await overlayTab.bringToFront();

  let phoneFaces = [];
  for (let i = 0; i < 40 && !phoneFaces.length; i++) {
    const s = await daemonState(port);
    phoneFaces =
      (s &&
        s.clients.filter(
          (c) => c.surface === 'tab' && (c.href || '').includes(siteHost)
        )) ||
      [];
    if (!phoneFaces.length) await sleep(400);
  }
  check(
    'phone: extension face joined on ' + siteHost,
    phoneFaces.length > 0,
    phoneFaces.length ? `clients ${phoneFaces.map((c) => '#' + c.id).join(',')}` : 'missing'
  );

  let hostState = null;
  for (let i = 0; i < 40; i++) {
    hostState = await overlayTab
      .evaluate(() => {
        const h = document.querySelector('[data-dogsh]');
        return (
          h && {
            vis: h.style.visibility,
            rows: Number(h.getAttribute('data-rows') || 0),
            flips: h.getAttribute('data-flips') || '0',
            version: h.getAttribute('data-version'),
          }
        );
      })
      .catch(() => null);
    if (hostState && hostState.vis === 'visible' && hostState.rows > 0) break;
    await sleep(400);
  }
  check(
    'phone: overlay revealed on x.com',
    !!(hostState && hostState.vis === 'visible' && hostState.rows > 0),
    hostState ? `vis=${hostState.vis} rows=${hostState.rows}` : ''
  );

  const st = await daemonState(port);
  const ownerOnPhone =
    st &&
    st.clients.find(
      (c) => c.id === st.owner && c.surface === 'tab' && (c.href || '').includes(siteHost)
    );
  check(
    'phone: daemon owner is a face on the phone page',
    !!ownerOnPhone,
    st ? `owner=${JSON.stringify(st.owner)}` : 'no state'
  );

  // Hold the OWNER id (not the first x.com face — a stale desktop tab on the
  // same host can still be listed briefly after close and is the wrong id).
  const phoneId = ownerOnPhone && ownerOnPhone.id;
  let held = 0;
  const flipsBefore = (hostState && hostState.flips) || '0';
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const s = await daemonState(port);
    if (phoneId != null && s && s.owner === phoneId) held++;
    else held = 0;
    if (held >= 8) break;
  }
  check(
    'phone: overlay ownership held (≥4s, not a one-tick flash)',
    held >= 8,
    `owner=#${phoneId} heldTicks=${held} want≥8`
  );

  hostState = await overlayTab
    .evaluate(() => {
      const h = document.querySelector('[data-dogsh]');
      return (
        h && {
          vis: h.style.visibility,
          rows: Number(h.getAttribute('data-rows') || 0),
          flips: h.getAttribute('data-flips') || '0',
        }
      );
    })
    .catch(() => null);
  check(
    'phone: overlay still visible after ownership hold',
    !!(hostState && hostState.vis === 'visible' && hostState.rows > 0),
    hostState ? `vis=${hostState.vis} rows=${hostState.rows}` : ''
  );
  check(
    'phone: no ownership flicker during hold (data-flips stable)',
    !!(hostState && hostState.flips === flipsBefore),
    `flips ${flipsBefore} → ${hostState && hostState.flips}`
  );

  // Cursor agent still active in the shared session (prompt and/or mid-run UI).
  const snap = await new Promise((resolve) => {
    const ws = new WSClient(`ws://127.0.0.1:${port}`);
    const bail = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve('');
    }, 5000);
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'hello', surface: 'tab', proto: CONFIG.protocolVersion }))
    );
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'snapshot') {
        clearTimeout(bail);
        ws.close();
        resolve(
          String(m.data || '')
            .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .replace(/[\x00-\x08\x0b-\x1f]/g, '')
        );
      }
    });
    ws.on('error', () => {});
  });
  const agentLive =
    (prompt && snap.includes(prompt)) ||
    /Working|ctrl\+c to stop|Add a follow-up|Cursor Agent/i.test(snap);
  check(
    'phone: Cursor agent output still active in the session',
    agentLive,
    agentLive ? 'session has agent content' : 'snapshot missing prompt/agent UI'
  );

  try {
    adb('shell', 'input', 'keyevent', 'KEYCODE_ESCAPE');
    await sleep(300);
    const shot = execFileSync('adb', ['exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'phone-follow.png'), shot);
    console.log('[e2e] wrote artifacts/phone-follow.png');
  } catch {}

  try {
    host.close();
  } catch {}
  // Do NOT browser.close() — that kills Edge Canary on Android.
  unforwardCdp();
}

module.exports = { setupPhone, assertPhoneFollow, EDGE_PKG, PHONE_URL };
