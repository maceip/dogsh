#!/usr/bin/env node
// Demo/e2e only: redeploy the extension to a phone browser over adb.
//
//   DOGSH_DEMO_EDGE_PKG=… DOGSH_DEMO_HAMBURGER_X=… … node deploy-phone.js
//
// All device geometry / package names come from DOGSH_DEMO_* env.
// Missing env → SKIP (exit 0). Never hardcode ADB targets in product paths.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = process.env.DOGSH_DEMO_EDGE_PKG || '';
const HAMBURGER_X = Number(process.env.DOGSH_DEMO_HAMBURGER_X || '');
const HAMBURGER_Y = Number(process.env.DOGSH_DEMO_HAMBURGER_Y || '');
const SEARCH_X = Number(process.env.DOGSH_DEMO_SEARCH_X || '');
const SEARCH_Y = Number(process.env.DOGSH_DEMO_SEARCH_Y || '');
const SWIPE = (process.env.DOGSH_DEMO_SWIPE || '').split(',').map(Number);

const MANIFEST = path.join(__dirname, 'static', 'manifest.json');
const CRX = path.join(__dirname, 'build', 'dogsh.crx');
const REMOTE_CRX = process.env.DOGSH_DEMO_REMOTE_CRX || '/sdcard/Download/dogsh.crx';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireDemoEnv() {
  const missing = [];
  if (!EDGE) missing.push('DOGSH_DEMO_EDGE_PKG');
  if (!Number.isFinite(HAMBURGER_X) || !Number.isFinite(HAMBURGER_Y)) {
    missing.push('DOGSH_DEMO_HAMBURGER_X', 'DOGSH_DEMO_HAMBURGER_Y');
  }
  if (!Number.isFinite(SEARCH_X) || !Number.isFinite(SEARCH_Y)) {
    missing.push('DOGSH_DEMO_SEARCH_X', 'DOGSH_DEMO_SEARCH_Y');
  }
  if (SWIPE.length !== 5 || SWIPE.some((n) => !Number.isFinite(n))) {
    missing.push('DOGSH_DEMO_SWIPE (x1,y1,x2,y2,durationMs)');
  }
  if (missing.length) {
    console.error('[deploy] SKIP — set DOGSH_DEMO_* for device specifics:', missing.join(', '));
    process.exit(0);
  }
}

const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8' });
const tap = (x, y) => adb('shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y)));

function dump() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  return adb('shell', 'cat', '/sdcard/ui.xml');
}
function find(xml, text, exact = false) {
  const re = /text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, t, a, b, c, d] = m;
    if (exact ? t === text : t.includes(text)) return { t, cx: (+a + +c) / 2, cy: (+b + +d) / 2 };
  }
  return null;
}
async function tapText(text, { exact = false, scrolls = 6 } = {}) {
  for (let i = 0; i <= scrolls; i++) {
    const el = find(dump(), text, exact);
    if (el) {
      tap(el.cx, el.cy);
      await sleep(900);
      return true;
    }
    adb(
      'shell',
      'input',
      'swipe',
      String(SWIPE[0]),
      String(SWIPE[1]),
      String(SWIPE[2]),
      String(SWIPE[3]),
      String(SWIPE[4])
    );
    await sleep(350);
  }
  return false;
}
async function waitText(text, { exact = false, tries = 12, gap = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const el = find(dump(), text, exact);
    if (el) return el;
    await sleep(gap);
  }
  return null;
}

function bumpVersion() {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const p = m.version.split('.').map(Number);
  p[2] = (p[2] || 0) + 1;
  m.version = p.join('.');
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  return m.version;
}

async function openMainMenu() {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (let i = 0; i < 3; i++) {
      adb('shell', 'input', 'keyevent', '4');
      await sleep(300);
    }
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'https://example.com', EDGE);
    await sleep(2500);
    tap(HAMBURGER_X, HAMBURGER_Y);
    await sleep(1400);
    if (find(dump(), 'Settings', true)) return true;
  }
  return false;
}

async function installFromCrx() {
  if (!(await openMainMenu())) throw new Error('could not open the main menu (Settings)');
  if (!(await tapText('Settings', { exact: true }))) throw new Error('Settings not found');
  if (!(await tapText('Developer options'))) throw new Error('Developer options not found');
  if (!(await tapText('Extension install by crx'))) throw new Error('install-by-crx row not found');
  await sleep(1000);
  if (!(await tapText('Choose .crx file'))) throw new Error('Choose .crx button not found');
  console.log('[deploy]   picker opening…');
  await sleep(2200);

  tap(SEARCH_X, SEARCH_Y);
  await sleep(1200);
  adb('shell', 'input', 'text', 'dogsh');
  await sleep(1500);
  const entry = await waitText('dogsh.crx');
  if (!entry) throw new Error('dogsh.crx not visible in the file picker');
  console.log('[deploy]   picking dogsh.crx');
  tap(entry.cx, entry.cy);
  await sleep(2500);

  const midOk = await waitText('OK', { exact: true, tries: 8 });
  if (!midOk) throw new Error('install screen OK button not found');
  console.log('[deploy]   confirming OK on the install screen');
  tap(midOk.cx, midOk.cy);

  const add = await waitText('Add', { exact: true, tries: 10 });
  if (add) {
    console.log('[deploy]   first install: confirming Add');
    tap(add.cx, add.cy);
    const added = await waitText('has been added', { tries: 16, gap: 400 });
    const gotit = find(dump(), 'Got it');
    if (gotit) tap(gotit.cx, gotit.cy);
    return added ? 'installed' : null;
  }
  const xml = dump();
  if (/text="[^"]*(error|failed|invalid)[^"]*"/i.test(xml)) throw new Error('install screen reported an error');
  if (find(xml, 'Extension install by crx')) throw new Error('install screen never dismissed');
  return 'updated';
}

(async () => {
  requireDemoEnv();
  let deviceOk = false;
  try {
    deviceOk = adb('get-state').trim() === 'device';
  } catch {
    /* no adb */
  }
  if (!deviceOk) {
    console.error('[deploy] SKIP — no authorized adb device');
    process.exit(0);
  }

  const version = bumpVersion();
  console.log('[deploy] version', version);
  execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'pack.js')], { stdio: 'inherit' });
  if (!fs.existsSync(CRX)) throw new Error('pack did not produce ' + CRX);
  adb('push', CRX, REMOTE_CRX);
  console.log('[deploy] pushed crx to', REMOTE_CRX);

  console.log('[deploy] installing via the crx picker (deterministic path)');
  const outcome = await installFromCrx();
  if (outcome === 'installed') {
    console.log(`[deploy] CONFIRMED — v${version} freshly installed ("has been added" toast seen)`);
  } else if (outcome === 'updated') {
    console.log(`[deploy] CONFIRMED — v${version} updated in place (silent update, screen dismissed cleanly)`);
  } else {
    console.error('[deploy] could not confirm the install — check the phone');
    process.exit(2);
  }
})().catch((e) => {
  console.error('[deploy] failed:', e.message);
  process.exit(1);
});
