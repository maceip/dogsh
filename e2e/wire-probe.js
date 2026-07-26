// Full-stack wire probe: the arbiter's contract (proven in isolation by
// app/daemon/sim.ts) replayed against the REAL daemon over REAL sockets —
// pty, mirror, fan-out, serialization, timers and all. Headless: no windows,
// no focus changes, safe to run any time. The desktop e2e (run.js) stays the
// judge of OS-level truth; this probe is the fast regression layer between
// "sim passed" and "took over the desk for two minutes".
//
// Every scripted case is a bug the desktop e2e actually caught (2026-07-15),
// replayed in its original arrival order. Run: node e2e/wire-probe.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
// The REAL Electron binary, not node_modules/.bin/electron: that's a Node
// wrapper which spawns Electron as a child and forwards only SIGINT/SIGTERM.
// kill -9 on the wrapper ORPHANS the daemon — the persistence scenario's
// kill would test nothing (and leak a live daemon per run).
const ELECTRON = require(path.join(ROOT, 'app', 'node_modules', 'electron'));
const DAEMON = path.join(ROOT, 'app', 'daemon', 'index.js');
const CONFIG = require(path.join(ROOT, 'app', 'shared', 'config.js'));
// The ws client lib (daemon's own dependency): unlike the platform WebSocket
// it exposes the underlying socket, which the flood scenarios pause to make
// an honestly SLOW face (TCP backpressure, not a mock).
const WSClient = require(path.join(ROOT, 'app', 'node_modules', 'ws'));
// Own port: never the real daemon's, never the desktop e2e's.
const PORT = 47717;
const PROTO = CONFIG.protocolVersion;
// Zombie cut grace, shortened for the probe (env-tunable in the daemon;
// same mechanism, just not a 20s wait).
const ZOMBIE_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`[wire] ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// A protocol client. Collects every message; exposes waits. `url` defaults
// to the main probe daemon; the remote-face scenarios point it at other
// daemons (LAN address, TLS port).
class Peer {
  constructor(label, url) {
    this.label = label;
    this.url = url || `ws://127.0.0.1:${PORT}`;
    this.msgs = [];
    this.ws = null;
    this.clientId = null;
    this.closeCode = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      const t = setTimeout(() => reject(new Error(`${this.label}: connect timeout`)), 4000);
      this.ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data.toString());
        this.msgs.push(m);
        if (m.type === 'hello-ack') this.clientId = m.clientId;
        // Rolling window: the flood scenarios stream far more data than any
        // check needs (they scan recent tails / small counts only), and the
        // probe must not itself become the unbounded buffer it's hunting.
        if (this.msgs.length > 6000) this.msgs.splice(0, 3000);
      };
      this.ws.onerror = () => {
        clearTimeout(t);
        reject(new Error(`${this.label}: connect failed`));
      };
      this.ws.onclose = (ev) => {
        this.closeCode = ev.code;
      };
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
  count(type) {
    return this.msgs.filter((m) => m.type === type).length;
  }
}

async function tabPeer(faceKey, sig, caps) {
  const p = new Peer(faceKey);
  await p.connect();
  p.send({
    type: 'hello',
    surface: 'tab',
    proto: PROTO,
    href: `probe://${faceKey}`,
    faceKey,
    sig,
    caps,
  });
  await sleep(150); // hello-ack + attach derivation settle
  if (p.clientId == null) throw new Error(`${faceKey}: no hello-ack`);
  return p;
}

async function hostPeer(sig) {
  const p = new Peer('host');
  await p.connect();
  p.send({ type: 'hello', surface: 'native-host', proto: PROTO, sig });
  await sleep(150);
  return p;
}

async function nativePeer(caps) {
  const p = new Peer('native-face');
  await p.connect();
  p.send({ type: 'hello', surface: 'native', proto: PROTO, caps });
  await sleep(150);
  if (p.clientId == null) throw new Error('native-face: no hello-ack');
  return p;
}

// A tab face whose reads can be paused: real TCP backpressure builds on the
// daemon side (kernel buffers fill, then ws.bufferedAmount climbs).
function pausableTabPeer(faceKey) {
  return new Promise((resolve, reject) => {
    const ws = new WSClient(`ws://127.0.0.1:${PORT}`);
    const p = {
      ws,
      msgs: [],
      clientId: null,
      closed: false,
      pause: () => ws._socket.pause(),
      resume: () => ws._socket.resume(),
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
      count: (t) => p.msgs.filter((m) => m.type === t).length,
    };
    const t = setTimeout(() => reject(new Error(`${faceKey}: connect timeout`)), 4000);
    ws.on('open', () => {
      clearTimeout(t);
      p.send({
        type: 'hello',
        surface: 'tab',
        proto: PROTO,
        href: `probe://${faceKey}`,
        faceKey,
        sig: { visible: false, focused: false },
      });
      setTimeout(() => resolve(p), 150);
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      p.msgs.push(m);
      if (m.type === 'hello-ack') p.clientId = m.clientId;
    });
    ws.on('close', () => {
      p.closed = true;
    });
    ws.on('error', () => {
      clearTimeout(t);
      reject(new Error(`${faceKey}: connect failed`));
    });
  });
}

async function owner(url) {
  const p = new Peer('debug', url);
  await p.connect();
  return new Promise((resolve) => {
    p.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.type === 'debug-state') {
        p.close();
        resolve(m);
      }
    });
    p.send({ type: 'debug', action: 'state' });
    setTimeout(() => {
      p.close();
      resolve(null);
    }, 2000);
  });
}

// Isolated persistence dir: the probe must never read (or pollute) the real
// ~/.dogsh/state — restoring the USER's sessions into a test daemon would be
// this suite's own version of the bug it exists to catch.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsh-probe-state-'));

const DAEMON_ENV = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  DOGSH_PORT: String(PORT),
  DOGSH_DEBUG: '1',
  DOGSH_LAG_ZOMBIE_MS: String(ZOMBIE_MS),
  // Tight mirror watermarks so the pause/resume path PROVABLY engages:
  // at production defaults the macOS pty (small kernel buffer) delivers
  // slower than xterm parses, so the queue rarely accumulates — the
  // mechanism exists for hostile content/slow machines, and this run
  // exercises the exact code path with a budget the flood can exceed.
  DOGSH_MIRROR_HIGH_WATER: '16384',
  DOGSH_MIRROR_LOW_WATER: '4096',
  // Heartbeat sweeps every 8s (cut = one full missed sweep, so between
  // 8s and 16s of silence): long enough that the SLOW face — paused ~6s
  // before it resumes and answers its queued ping — survives, short
  // enough to observe the zombie cut inside the probe's budget.
  DOGSH_HEARTBEAT_MS: '8000',
  // Fast saves so the kill -9 window is small enough to test.
  DOGSH_STATE_DIR: STATE_DIR,
  DOGSH_SAVE_MS: '500',
};

function spawnDaemon(extraEnv) {
  return spawn(ELECTRON, [DAEMON], {
    env: extraEnv ? { ...DAEMON_ENV, ...extraEnv } : DAEMON_ENV,
    stdio: 'ignore',
  });
}

async function waitPort() {
  for (let i = 0; i < 40; i++) {
    try {
      const p = new Peer('ping');
      await p.connect();
      p.close();
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('daemon port never answered');
}

async function main() {
  let daemon = spawnDaemon();
  await waitPort();

  try {
    // --- boot: terminal starts native --------------------------------------
    let st = await owner();
    check('boot: owner is native', st && st.owner === 'native', `owner=${st && st.owner}`);

    // --- bug #1 replay: eviction race, worst historical order --------------
    const host = await hostPeer({ visible: true, focused: true });
    const A = await tabPeer('face-A', { visible: false, focused: false });
    const B = await tabPeer('face-B', { visible: true, focused: false });
    st = await owner();
    check('exclusivity: host focused holds native', st.owner === 'native', `owner=${st.owner}`);
    B.send({ type: 'signal', visible: true, focused: true }); // B engages (stale)
    A.send({ type: 'signal', visible: true, focused: true }); // A engages (newer)
    B.send({ type: 'signal', visible: false, focused: true }); // B corrects
    host.send({ type: 'signal', visible: true, focused: false }); // host blur LAST
    await sleep(200);
    st = await owner();
    check('bug1 order: terminal on tab A', st.owner === A.clientId, `owner=${st.owner} A=${A.clientId}`);

    // --- bug #2 replay: steal-then-blur -------------------------------------
    B.send({ type: 'signal', visible: true, focused: true }); // fabricated steal
    await sleep(120);
    st = await owner();
    check('bug2: fabricated engagement steals (undetectable by design)', st.owner === B.clientId);
    B.send({ type: 'signal', visible: false, focused: true }); // thief owns up
    await sleep(120);
    st = await owner();
    check('bug2: terminal back on A after the thief blurs', st.owner === A.clientId, `owner=${st.owner}`);

    // --- bug #3 replay: metronome window ------------------------------------
    // Both faces hold engaged-looking levels at rest. Nothing may move across
    // multiple 2s re-assert ticks.
    B.send({ type: 'signal', visible: true, focused: true });
    A.send({ type: 'signal', visible: true, focused: true }); // A newest again
    await sleep(150);
    const genBefore = (await owner()).gen;
    const flipsBeforeA = A.count('owner-state');
    await sleep(5200); // > two re-assert ticks
    st = await owner();
    check('bug3 metronome: owner still A after 5s of silence', st.owner === A.clientId, `owner=${st.owner}`);
    check('bug3 metronome: generation frozen (no hidden churn)', st.gen === genBefore, `gen ${genBefore} -> ${st.gen}`);
    const reasserts = A.count('owner-state') - flipsBeforeA;
    check('re-assert tick alive (owner-state flowing)', reasserts >= 2, `${reasserts} ticks`);

    // --- reconnect baseline cannot steal ------------------------------------
    const C = await tabPeer('face-C', { visible: true, focused: true }); // lying baseline
    st = await owner();
    check('reconnect baseline: C did not steal from A', st.owner === A.clientId, `owner=${st.owner}`);
    C.close();

    // --- ghost adoption: owner's socket blips, same faceKey returns ---------
    const oldId = A.clientId;
    A.close();
    await sleep(300); // inside the 1.5s grace
    const A2 = await tabPeer('face-A', { visible: true, focused: true });
    st = await owner();
    check(
      'blip: same face adopted under new socket, still owner',
      st.owner === A2.clientId && A2.clientId !== oldId,
      `owner=${st.owner} newId=${A2.clientId}`
    );
    await sleep(1700); // stale ghost expiry must be a no-op
    st = await owner();
    check('blip: stale ghost expiry is a no-op', st.owner === A2.clientId, `owner=${st.owner}`);

    // --- host-gone handback --------------------------------------------------
    host.send({ type: 'signal', visible: true, focused: true }); // user on native
    await sleep(120);
    st = await owner();
    check('host focused: terminal home', st.owner === 'native');
    host.close(); // app killed while owning
    await sleep(200);
    st = await owner();
    check('host-gone: terminal lands on the engaged tab', st.owner === A2.clientId, `owner=${st.owner}`);

    // --- owner tab closes, another face still engaged: it inherits ----------
    // (Closing Chrome's active tab activates a neighbor — if that neighbor
    // reports engaged, the terminal belongs there, not on a possibly-dead
    // native window. The host is GONE at this point; 'native' would mean the
    // terminal exists nowhere.)
    A2.close();
    await sleep(2000); // > grace
    st = await owner();
    check('owner closed: engaged neighbor inherits', st.owner === B.clientId, `owner=${st.owner}`);

    // --- owner closes with NOBODY engaged: terminal comes home --------------
    B.send({ type: 'signal', visible: true, focused: true }); // B owns now
    await sleep(120);
    B.send({ type: 'signal', visible: false, focused: false }); // ...then hides
    await sleep(120);
    st = await owner();
    check('hysteresis: disengaged owner keeps the terminal', st.owner === B.clientId, `owner=${st.owner}`);
    B.close();
    await sleep(2000); // > grace, nobody engaged anywhere
    st = await owner();
    check('owner closed, nobody engaged: terminal comes home', st.owner === 'native', `owner=${st.owner}`);
    // Reattach B for the doghouse case below.
    const B2 = await tabPeer('face-B', { visible: false, focused: false });

    // --- doghouse: pinned native, engagement barks ---------------------------
    const host2 = await hostPeer({ visible: true, focused: false });
    host2.send({ type: 'doghouse', on: true });
    await sleep(150);
    B2.send({ type: 'signal', visible: true, focused: true }); // would follow; must bark
    await sleep(200);
    st = await owner();
    check('doghouse: owner pinned native', st.owner === 'native', `owner=${st.owner}`);
    check('doghouse: host received bark', host2.count('bark') >= 1, `barks=${host2.count('bark')}`);
    host2.send({ type: 'doghouse', on: false });
    await sleep(200);
    st = await owner();
    check('doghouse exit: engaged tab takes the terminal', st.owner === B2.clientId, `owner=${st.owner}`);

    // --- faces rendered from broadcasts: B saw its grant ---------------------
    const grants = B2.msgs.filter((m) => m.type === 'owner-state' && m.owner === B2.clientId);
    check('face got owner-state naming it owner', grants.length >= 1, `${grants.length} broadcasts`);

    B2.close();
    host2.close();
    await sleep(2000); // B2 owned; let its ghost expire so the ledger is clean

    // ========================================================================
    // Dynamic grid: owner-drives-size over the real wire.
    // ========================================================================
    const host3 = await hostPeer({ visible: true, focused: true }); // native owns
    const N = await nativePeer({ cols: 90, rows: 26, canResize: true });
    const T = await tabPeer('face-T', { visible: false, focused: false }, { cols: 120, rows: 36, canResize: true });

    // Native face resized (user dragged the window edge): caps -> session
    // resize -> grid broadcast to every face.
    N.send({ type: 'caps', caps: { cols: 100, rows: 30, canResize: true } });
    await sleep(250);
    st = await owner();
    check(
      'grid: owner caps resize the session',
      st.sessions[0].cols === 100 && st.sessions[0].rows === 30,
      `session=${st.sessions[0].cols}x${st.sessions[0].rows}`
    );
    const tGrid = T.msgs.filter((m) => m.type === 'grid' && m.cols === 100 && m.rows === 30);
    check('grid: non-owner face received the grid broadcast', tGrid.length >= 1);

    // Handoff to a tab with different caps: ITS grid takes over, and the
    // now-non-owner faces get a settle snapshot at the new grid.
    const nSnapsBefore = N.msgs.filter((m) => m.type === 'snapshot').length;
    host3.send({ type: 'signal', visible: true, focused: false }); // host blurs
    T.send({ type: 'signal', visible: true, focused: true }); //     tab engages
    await sleep(600); // grant + resize + 300ms settle snapshot
    st = await owner();
    check('grid: handoff owner is the tab', st.owner === T.clientId, `owner=${st.owner}`);
    check(
      'grid: session resized to the new owner caps',
      st.sessions[0].cols === 120 && st.sessions[0].rows === 36,
      `session=${st.sessions[0].cols}x${st.sessions[0].rows}`
    );
    const nSettle = N.msgs
      .slice(0)
      .filter((m) => m.type === 'snapshot' && m.cols === 120 && m.rows === 36);
    check(
      'grid: non-owner got a settle snapshot at the new grid',
      N.msgs.filter((m) => m.type === 'snapshot').length > nSnapsBefore && nSettle.length >= 1,
      `snapshots=${N.msgs.filter((m) => m.type === 'snapshot').length}`
    );

    // Hostile caps are clamped, never obeyed raw.
    T.send({ type: 'caps', caps: { cols: 9999, rows: 1, canResize: true } });
    await sleep(250);
    st = await owner();
    check(
      'grid: hostile caps clamped (500x5)',
      st.sessions[0].cols === 500 && st.sessions[0].rows === 5,
      `session=${st.sessions[0].cols}x${st.sessions[0].rows}`
    );
    // Back to a sane grid for the flood below.
    T.send({ type: 'caps', caps: { cols: 100, rows: 30, canResize: true } });
    await sleep(250);

    // ========================================================================
    // Flow control: a hostile flood must not sink the daemon or any face.
    // The flood is base64 </dev/zero — pure ASCII at pipe speed, far beyond
    // xterm's parse rate, so the pty-pause watermarks MUST engage.
    // ========================================================================
    const slow = await pausableTabPeer('face-slow');
    const zombie = await pausableTabPeer('face-zombie');
    const rssBefore = (await owner()).rss;

    slow.pause(); //   stops reading now; resumes after the flood
    zombie.pause(); // never resumes; must be cut, not accommodated
    T.send({ type: 'input', data: 'base64 < /dev/zero\r' });

    // Poll mid-flood evidence: bounded mirror queue, pty pause engaging,
    // bounded daemon memory, lagging faces marked. The SLOW face resumes
    // mid-flood (a ~2s stall — long enough to lag and need a resync, short
    // enough to never be mistaken for a zombie).
    let maxPending = 0;
    let sawPaused = false;
    let maxRss = 0;
    let slowLagged = false;
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      if (i === 5) slow.resume();
      const s = await owner();
      if (!s) continue;
      const flow = s.sessions[0] && s.sessions[0].flow;
      if (flow) {
        maxPending = Math.max(maxPending, flow.pendingMirror);
        sawPaused = sawPaused || flow.ptyPaused;
      }
      maxRss = Math.max(maxRss, s.rss || 0);
      if ((s.clients || []).some((c) => c.id === slow.clientId && c.lagging)) slowLagged = true;
    }
    T.send({ type: 'input', data: '\x03' }); // Ctrl+C ends the flood
    await sleep(900);
    // Proof the flood actually STOPPED (marker echoes can't prove it: the tty
    // echoes typed input even while a flood runs): the mirror queue must be
    // drained and stay drained across consecutive samples.
    const calmSt1 = await owner();
    await sleep(600);
    const calmSt2 = await owner();
    const calm1 = calmSt1 && calmSt1.sessions[0] && calmSt1.sessions[0].flow;
    const calm2 = calmSt2 && calmSt2.sessions[0] && calmSt2.sessions[0].flow;
    check(
      'flood: Ctrl+C stopped the flood (mirror queue drained and stayed drained)',
      !!calm1 &&
        !!calm2 &&
        calm1.pendingMirror < 4096 &&
        calm2.pendingMirror < 4096 &&
        !calm1.ptyPaused &&
        !calm2.ptyPaused,
      calm1 && calm2 ? `pending=${calm1.pendingMirror},${calm2.pendingMirror}` : 'no debug-state'
    );
    const MARKER = 'WIRE_FLOOD_CONVERGED';
    T.send({ type: 'input', data: `echo ${MARKER}\r` });
    await sleep(700);

    check(
      'flood: mirror ingest bounded (pty flow control)',
      maxPending <= 8 * 1024 * 1024,
      `maxPending=${(maxPending / 1024).toFixed(0)}KB`
    );
    // Pause windows are microseconds wide (parse drains fast); the sampled
    // flag is best-effort, the cumulative counter is the proof.
    const pauses = (calm1 && calm1.ptyPauseCount) || 0;
    check('flood: pty pause engaged under load', sawPaused || pauses > 0, `pauses=${pauses}`);
    check(
      'flood: daemon memory bounded',
      maxRss > 0 && maxRss - rssBefore < 300 * 1024 * 1024,
      `rss ${(rssBefore / 1e6).toFixed(0)}MB -> peak ${(maxRss / 1e6).toFixed(0)}MB`
    );
    check('flood: stalled face marked lagging (not buffered forever)', slowLagged);

    // Ctrl+C actually worked and the LIVE face converged: the marker arrives
    // as streamed data (or inside a lag-resync snapshot — both are honest).
    const tConverged = T.msgs.some(
      (m) =>
        (m.type === 'data' || m.type === 'snapshot') &&
        typeof m.data === 'string' &&
        m.data.includes(MARKER)
    );
    check('flood: Ctrl+C killed the flood; live face saw the marker', tConverged);

    // A fresh attach right after the storm gets a bounded, current snapshot.
    const F = await tabPeer('face-fresh', { visible: false, focused: false });
    const fSnap = F.msgs.find((m) => m.type === 'snapshot');
    check(
      'flood: fresh attach converges via snapshot',
      !!fSnap && fSnap.data.includes(MARKER),
      `snapshot=${fSnap ? (fSnap.data.length / 1024).toFixed(0) + 'KB' : 'none'}`
    );
    check(
      'flood: snapshot bounded by scrollback, not the flood',
      !!fSnap && fSnap.data.length < 4 * 1024 * 1024,
      fSnap ? `${(fSnap.data.length / 1024).toFixed(0)}KB` : 'none'
    );
    F.close();

    // The slow face (resumed mid-flood) drained and was brought to the
    // present by a resync snapshot; once calm it must be a normal face again
    // — still connected, not lagging, and holding the marker.
    await sleep(500);
    const slowSnap = slow.msgs.some(
      (m) => m.type === 'snapshot' && typeof m.data === 'string' && m.data.includes(MARKER)
    );
    const slowData = slow.msgs.some(
      (m) => m.type === 'data' && typeof m.data === 'string' && m.data.includes(MARKER)
    );
    check(
      'flood: slow face resynced after draining (snapshot or live stream)',
      !slow.closed && (slowSnap || slowData),
      `closed=${slow.closed} snap=${slowSnap} data=${slowData}`
    );
    const stAfter = await owner();
    const slowRow = (stAfter.clients || []).find((c) => c.id === slow.clientId);
    check(
      'flood: slow face no longer lagging',
      !!slowRow && !slowRow.lagging,
      slowRow ? `lagging=${slowRow.lagging}` : 'client gone'
    );

    // The zombie never drains: the daemon must cut it loose (memory is not
    // hostage to a dead peer), and the cut must not disturb anyone else.
    // Two mechanisms may fire — bufferedAmount stuck past LAG_ZOMBIE_MS, or
    // the ping/pong heartbeat (backlog small enough to hide in kernel
    // buffers, which is exactly how this probe first caught the gap). Judge
    // by the SERVER's ledger: the zombie's own socket is paused, so the
    // client side never even notices it was killed — that's the point.
    const cutDeadline = Date.now() + 18000;
    let zombieGone = false;
    while (!zombieGone && Date.now() < cutDeadline) {
      await sleep(400);
      const s = await owner();
      if (s && !(s.clients || []).some((c) => c.id === zombie.clientId)) zombieGone = true;
    }
    check('flood: zombie face cut by the daemon', zombieGone);
    const stFinal = await owner();
    check(
      'flood: owner undisturbed by the storm',
      stFinal.owner === T.clientId,
      `owner=${stFinal.owner}`
    );

    slow.close();
    T.close();
    N.close();
    host3.close();

    // ========================================================================
    // Remote faces (v8): the phone. A second daemon binds beyond loopback
    // with a token; the probe reaches it via the machine's REAL LAN address,
    // so the daemon sees a genuinely non-loopback socket — remoteness is
    // observed, not simulated. Covers: token accept/reject, loopback
    // exemption, the phone-pickup handoff against an idle-focused host,
    // both reclaim paths (focus event, input), and local-exclusivity
    // holding against local tabs while the phone competes.
    // ========================================================================
    const lanIp = (() => {
      const ifs = os.networkInterfaces();
      const all = Object.entries(ifs).flatMap(([name, addrs]) =>
        (addrs || []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, ip: a.address }))
      );
      const en0 = all.find((a) => a.name === 'en0');
      return (en0 || all[0] || {}).ip || null;
    })();
    if (!lanIp) {
      console.log('[wire] SKIP: remote-face scenarios (no LAN interface up)');
    } else {
      const RPORT = 47718;
      const RTOKEN = 'probe-secret-777';
      const RSTATE = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsh-probe-remote-'));
      const remoteUrl = `ws://${lanIp}:${RPORT}`;
      const localUrl = `ws://127.0.0.1:${RPORT}`;
      const rdaemon = spawnDaemon({
        DOGSH_PORT: String(RPORT),
        DOGSH_BIND: '0.0.0.0',
        DOGSH_TOKEN: RTOKEN,
        DOGSH_STATE_DIR: RSTATE,
      });
      try {
        // waitPort against the remote daemon's loopback side.
        for (let i = 0; i < 40; i++) {
          try {
            const ping = new Peer('rping', localUrl);
            await ping.connect();
            ping.close();
            break;
          } catch {
            await sleep(250);
          }
        }

        // --- auth: no token / bad token / good token / loopback exemption --
        const noTok = new Peer('phone-notoken', remoteUrl);
        await noTok.connect();
        noTok.send({ type: 'hello', surface: 'tab', proto: PROTO, faceKey: 'ph-x', sig: {} });
        await sleep(400);
        check(
          'remote auth: tokenless hello from the LAN is rejected (4401, no ack)',
          noTok.closeCode === 4401 && noTok.clientId == null,
          `code=${noTok.closeCode} ack=${noTok.clientId}`
        );
        const badTok = new Peer('phone-badtoken', remoteUrl);
        await badTok.connect();
        badTok.send({ type: 'hello', surface: 'tab', proto: PROTO, faceKey: 'ph-x', token: 'wrong', sig: {} });
        await sleep(400);
        check(
          'remote auth: wrong token rejected',
          badTok.closeCode === 4401 && badTok.clientId == null,
          `code=${badTok.closeCode}`
        );
        // Unauthenticated sockets must not be able to INJECT either: type a
        // marker through a tokenless socket, then look for it via a real face.
        const inject = new Peer('phone-inject', remoteUrl);
        await inject.connect();
        inject.send({ type: 'input', data: 'echo INJECTED_WITHOUT_HELLO\r' });
        await sleep(500);
        inject.close();

        const rhost = new Peer('rhost', localUrl);
        await rhost.connect();
        rhost.send({ type: 'hello', surface: 'native-host', proto: PROTO, sig: { visible: true, focused: true } });
        rhost.send({ type: 'signal', visible: true, focused: true }); // live focus: host mints
        const rlocal = new Peer('rlocal-tab', localUrl);
        await rlocal.connect();
        rlocal.send({ type: 'hello', surface: 'tab', proto: PROTO, faceKey: 'local-A', sig: {} });
        await sleep(300);
        check('remote auth: loopback faces stay tokenless', rlocal.clientId != null);
        const injSnap = rlocal.msgs.find((m) => m.type === 'snapshot');
        check(
          'remote auth: un-helloed socket could not inject input',
          !!injSnap && !injSnap.data.includes('INJECTED_WITHOUT_HELLO'),
          injSnap ? 'snapshot clean' : 'no snapshot'
        );

        const phone = new Peer('phone', remoteUrl);
        await phone.connect();
        phone.send({
          type: 'hello',
          surface: 'tab',
          proto: PROTO,
          href: 'probe://phone',
          faceKey: 'phone-1',
          token: RTOKEN,
          // Baseline engaged — a description, never a steal.
          sig: { visible: true, focused: true },
          caps: { cols: 48, rows: 20, canResize: true },
        });
        await sleep(300);
        check('remote auth: right token admitted', phone.clientId != null);
        let rst = await owner(localUrl);
        const phoneRow = rst && rst.clients && rst.clients.find((c) => c.id === phone.clientId);
        check(
          'remote: daemon marked the phone remote from its socket address',
          !!phoneRow && phoneRow.remote === true,
          JSON.stringify(phoneRow)
        );
        const localRow = rst && rst.clients && rst.clients.find((c) => c.id === rlocal.clientId);
        check('remote: loopback face NOT marked remote', !!localRow && localRow.remote === false);
        check(
          'pickup: engaged baseline cannot steal from a focused host',
          rst.owner === 'native',
          `owner=${rst.owner}`
        );

        // --- the pickup: a LIVE engaged report from the phone -------------
        phone.send({ type: 'signal', visible: true, focused: true });
        await sleep(300);
        rst = await owner(localUrl);
        check(
          'pickup: phone outranks the idle-focused host (v8 rule 2)',
          rst.owner === phone.clientId,
          `owner=${rst.owner} phone=${phone.clientId}`
        );
        // Owner drives the grid: the session must now be the phone's 48x20.
        const rsess = rst.sessions && rst.sessions.find((s) => s.id === rst.activeSessionId);
        check(
          'pickup: session grid follows the phone caps',
          !!rsess && rsess.cols === 48 && rsess.rows === 20,
          rsess ? `${rsess.cols}x${rsess.rows}` : 'no session'
        );

        // --- local exclusivity still holds while the phone owns -----------
        rlocal.send({ type: 'signal', visible: true, focused: true }); // local tab lies/arrives
        await sleep(250);
        rst = await owner(localUrl);
        check(
          'pickup: local tab cannot take the terminal while host is focused',
          rst.owner === phone.clientId,
          `owner=${rst.owner}`
        );

        // --- reclaim #1: a real host focus event ---------------------------
        rhost.send({ type: 'signal', visible: true, focused: true });
        await sleep(250);
        rst = await owner(localUrl);
        check('reclaim: host focus event brings the terminal home', rst.owner === 'native');

        // --- reclaim #2 (reverse): typing on the phone takes it back -------
        const RMARK = 'PHONE_INPUT_MARK_42';
        phone.send({ type: 'input', data: `echo ${RMARK}\r` });
        const rDeadline = Date.now() + 6000;
        let phoneSaw = false;
        while (!phoneSaw && Date.now() < rDeadline) {
          await sleep(250);
          phoneSaw = phone.msgs.some(
            (m) => m.type === 'data' && typeof m.data === 'string' && m.data.includes(RMARK)
          );
        }
        rst = await owner(localUrl);
        check('input: typing on the phone reclaims (input mints engagement)', rst.owner === phone.clientId, `owner=${rst.owner}`);
        check('input: phone input executes and streams back to the phone', phoneSaw);

        // --- the phone face itself is served by this same port -------------
        const http = require('http');
        const page = await new Promise((resolve) => {
          http
            .get(`http://127.0.0.1:${RPORT}/`, (res) => {
              let body = '';
              res.on('data', (d) => (body += d));
              res.on('end', () => resolve({ code: res.statusCode, body }));
            })
            .on('error', () => resolve({ code: 0, body: '' }));
        });
        check(
          'serve: phone face page comes from the daemon port',
          page.code === 200 && page.body.includes('phone.js'),
          `http=${page.code}`
        );

        phone.close();
        rlocal.close();
        rhost.close();
      } finally {
        try {
          rdaemon.kill('SIGKILL');
        } catch {
          /* gone */
        }
        fs.rmSync(RSTATE, { recursive: true, force: true });
      }
    }

    // ========================================================================
    // wss: the TLS path the phone uses over the tailnet, with a throwaway
    // self-signed cert (same code path as a tailscale cert: files in,
    // https server out).
    // ========================================================================
    const TLSPORT = 47719;
    const TLSDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsh-probe-tls-'));
    let tlsdaemon = null;
    try {
      const { execSync } = require('child_process');
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 1 -nodes -subj /CN=localhost`,
        { cwd: TLSDIR, stdio: 'ignore' }
      );
      tlsdaemon = spawnDaemon({
        DOGSH_PORT: String(TLSPORT),
        DOGSH_TLS_CERT: path.join(TLSDIR, 'cert.pem'),
        DOGSH_TLS_KEY: path.join(TLSDIR, 'key.pem'),
        DOGSH_STATE_DIR: path.join(TLSDIR, 'state'),
      });
      // wss handshake with the ws client lib (it can skip verification for
      // the self-signed cert; a phone against a tailscale cert verifies).
      let tlsAck = null;
      for (let i = 0; i < 40 && !tlsAck; i++) {
        await sleep(250);
        tlsAck = await new Promise((resolve) => {
          const sock = new WSClient(`wss://127.0.0.1:${TLSPORT}`, { rejectUnauthorized: false });
          const bail = setTimeout(() => {
            try {
              sock.terminate();
            } catch {
              /* noop */
            }
            resolve(null);
          }, 1500);
          sock.on('open', () =>
            sock.send(
              JSON.stringify({ type: 'hello', surface: 'tab', proto: PROTO, faceKey: 'tls-face', sig: {} })
            )
          );
          sock.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.type === 'hello-ack') {
              clearTimeout(bail);
              sock.close();
              resolve(m);
            }
          });
          sock.on('error', () => {
            clearTimeout(bail);
            resolve(null);
          });
        });
      }
      check('wss: TLS daemon completes a face handshake', !!tlsAck, tlsAck ? `clientId=${tlsAck.clientId}` : 'no ack');
      const httpsMod = require('https');
      const tlsPage = await new Promise((resolve) => {
        httpsMod
          .get(`https://127.0.0.1:${TLSPORT}/`, { rejectUnauthorized: false }, (res) => {
            res.resume();
            resolve(res.statusCode);
          })
          .on('error', () => resolve(0));
      });
      check('wss: phone face served over https on the same port', tlsPage === 200, `http=${tlsPage}`);
    } finally {
      if (tlsdaemon) {
        try {
          tlsdaemon.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
      fs.rmSync(TLSDIR, { recursive: true, force: true });
    }

    // ========================================================================
    // Scrollback persistence: what the user could SEE survives a daemon
    // kill -9; what they closed stays closed.
    // ========================================================================
    const PMARK = 'PERSIST_PROBE_MARKER_777';
    // Explicit caps: typing below makes this face the OWNER (v8: input mints
    // engagement), which sizes the session to ITS grid — so the restore
    // check proves a non-default grid survives the kill, not an accident.
    const P1 = await tabPeer(
      'face-persist',
      { visible: false, focused: false },
      { cols: 100, rows: 30, canResize: true }
    );
    P1.send({ type: 'input', data: `echo ${PMARK}\r` });
    await sleep(400); // marker rendered into the mirror
    await sleep(1200); // > DOGSH_SAVE_MS: the debounced save must have fired
    const savedFiles = fs.readdirSync(STATE_DIR).filter((f) => /^session-\d+\.json$/.test(f));
    check('persist: state file exists after the save interval', savedFiles.length === 1, savedFiles.join(','));
    P1.close();

    // kill -9: no SIGTERM flush, no goodbye — the periodic save is all there is.
    daemon.kill('SIGKILL');
    await sleep(600);
    daemon = spawnDaemon();
    await waitPort();

    const P2 = await tabPeer('face-persist', { visible: false, focused: false });
    const restoreSnap = P2.msgs.find((m) => m.type === 'snapshot');
    check(
      'persist: scrollback survived kill -9 (marker in the restored snapshot)',
      !!restoreSnap && restoreSnap.data.includes(PMARK),
      restoreSnap ? `snapshot=${(restoreSnap.data.length / 1024).toFixed(0)}KB` : 'no snapshot'
    );
    check(
      'persist: the seam is marked (restore divider present)',
      !!restoreSnap && restoreSnap.data.includes('[dogsh: restored'),
    );
    check(
      'persist: restored at the saved grid',
      !!restoreSnap && restoreSnap.cols === 100 && restoreSnap.rows === 30,
      restoreSnap ? `${restoreSnap.cols}x${restoreSnap.rows}` : 'no snapshot'
    );
    // The restored session runs a LIVE shell (history above, working prompt
    // below): a fresh command must execute and stream.
    const PMARK2 = 'PERSIST_ALIVE_AFTER_RESTORE';
    P2.send({ type: 'input', data: `echo ${PMARK2}\r` });
    const liveDeadline = Date.now() + 8000;
    let liveAgain = false;
    while (!liveAgain && Date.now() < liveDeadline) {
      await sleep(300);
      liveAgain = P2.msgs.some(
        (m) => m.type === 'data' && typeof m.data === 'string' && m.data.includes(PMARK2)
      );
    }
    check('persist: restored session runs a live shell', liveAgain);

    // No-resurrect: end the shell CLEANLY (typed exit). Its state file dies
    // with it — and since it was the last session, so does the daemon.
    const daemonExited = new Promise((r) => daemon.once('exit', r));
    P2.send({ type: 'input', data: 'exit\r' });
    await Promise.race([daemonExited, sleep(8000)]);
    const filesAfterExit = fs
      .readdirSync(STATE_DIR)
      .filter((f) => /^session-\d+\.json$/.test(f));
    check('persist: clean close deleted the state file', filesAfterExit.length === 0, filesAfterExit.join(','));
    P2.close();

    daemon = spawnDaemon();
    await waitPort();
    const P3 = await tabPeer('face-persist', { visible: false, focused: false });
    const freshSnap = P3.msgs.find((m) => m.type === 'snapshot');
    check(
      'persist: closed session did NOT resurrect (fresh boot, no marker, no divider)',
      !!freshSnap && !freshSnap.data.includes(PMARK) && !freshSnap.data.includes('[dogsh: restored'),
      freshSnap ? `snapshot=${(freshSnap.data.length / 1024).toFixed(0)}KB` : 'no snapshot'
    );
    P3.close();
  } finally {
    try {
      daemon.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\n[wire] ALL PASS' : `\n[wire] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[wire] fatal:', e);
  process.exit(1);
});
