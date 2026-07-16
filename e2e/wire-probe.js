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

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'app', 'node_modules', '.bin', 'electron');
const DAEMON = path.join(ROOT, 'app', 'daemon', 'index.js');
// Own port: never the real daemon's, never the desktop e2e's.
const PORT = 47717;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`[wire] ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// A protocol client. Collects every message; exposes waits.
class Peer {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.ws = null;
    this.clientId = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const t = setTimeout(() => reject(new Error(`${this.label}: connect timeout`)), 4000);
      this.ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data.toString());
        this.msgs.push(m);
        if (m.type === 'hello-ack') this.clientId = m.clientId;
      };
      this.ws.onerror = () => {
        clearTimeout(t);
        reject(new Error(`${this.label}: connect failed`));
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

async function tabPeer(faceKey, sig) {
  const p = new Peer(faceKey);
  await p.connect();
  p.send({ type: 'hello', surface: 'tab', proto: 6, href: `probe://${faceKey}`, faceKey, sig });
  await sleep(150); // hello-ack + attach derivation settle
  if (p.clientId == null) throw new Error(`${faceKey}: no hello-ack`);
  return p;
}

async function hostPeer(sig) {
  const p = new Peer('host');
  await p.connect();
  p.send({ type: 'hello', surface: 'native-host', proto: 6, sig });
  await sleep(150);
  return p;
}

async function owner() {
  const p = new Peer('debug');
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

async function main() {
  const daemon = spawn(ELECTRON, [DAEMON], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DOGSH_PORT: String(PORT),
      DOGSH_DEBUG: '1',
    },
    stdio: 'ignore',
  });
  // Wait until the port answers.
  for (let i = 0; i < 40; i++) {
    try {
      const p = new Peer('ping');
      await p.connect();
      p.close();
      break;
    } catch {
      await sleep(250);
    }
  }

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
  } finally {
    daemon.kill();
  }

  console.log(failures === 0 ? '\n[wire] ALL PASS' : `\n[wire] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[wire] fatal:', e);
  process.exit(1);
});
