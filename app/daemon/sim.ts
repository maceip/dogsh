// Arbiter simulator: the rewrite's contract, executable. Two halves:
//
//  1. SCRIPTED REPLAYS — every arbitration bug the desktop e2e ever caught,
//     replayed as signal traffic in its original order, plus the guard cases
//     that must NOT move the terminal. These are regression pins.
//
//  2. SEEDED FUZZ — thousands of randomized interleavings of a modeled user
//     moving between faces while the environment misbehaves in the ways it
//     REALLY misbehaves: Chrome tabs missing their blur reports and holding
//     stale-engaged levels at rest, bridge blips dropping and re-issuing
//     sockets mid-session, lying baselines from background tabs, doghouse
//     toggles, host attach/detach. Signals modeled as reliable stay
//     reliable: Electron's host focus/blur are OS-level events, and a
//     genuinely visible tab reports truthfully — encoding those guarantees
//     here is what makes convergence provable rather than lucky.
//
// Invariants (checked after EVERY event):
//   I1  owner is 'native' or a currently-connected client id
//   I2  doghouse            => owner === 'native'
//   I3  host focused level  => owner === 'native', OR (v8) a REMOTE face
//       that is engaged with a strictly newer engagement seq than the host
//   I4  no input => no movement: repeated derivation without any report
//       never changes the owner (the metronome is impossible, proven, not
//       hoped)
//   convergence: once the noise settles, the terminal is where the user is
//       — including on the phone, which coexists with a focused laptop.
//
// Run: npm run sim   (pure logic, no sockets, no pty — a full fuzz run takes
// well under a second)
import { LeaseEngine as Arbiter, GHOST_GRACE_MS } from './lease-engine.js';

let failures = 0;
function check(name: string, ok: boolean, note?: string): void {
  if (!ok) {
    failures++;
    console.log(`FAIL: ${name}${note ? ` — ${note}` : ''}`);
  }
}
function pass(name: string): void {
  console.log(`PASS: ${name}`);
}

interface Harness {
  arb: Arbiter;
  grants: Array<{ prev: DogshOwner; next: DogshOwner }>;
  barks: number;
  ghosts: string[]; // faceKeys awaiting expiry, in schedule order
}
function makeArbiter(): Harness {
  const h: Harness = { arb: null as unknown as Arbiter, grants: [], barks: 0, ghosts: [] };
  h.arb = new Arbiter({
    ownerChanged: (prev, next) => h.grants.push({ prev, next }),
    bark: () => h.barks++,
    scheduleGhostExpiry: (faceKey) => h.ghosts.push(faceKey),
  });
  return h;
}

// ---------------------------------------------------------------------------
// Scripted replays. Tab faces: clientId + stable faceKey ("A", "B", ...).
// ---------------------------------------------------------------------------

function scripted(): void {
  // --- desktop bug #1 (run 1): eviction race -----------------------------
  // Return to Chrome landing on tab B, instant switch to tab A. Old design:
  // B's late window-focus claim evicted A's parked claim; native blur granted
  // the terminal to hidden B. Level world: order cannot matter.
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.attachTab(1, 'A', { visible: false, focused: false });
    arb.attachTab(2, 'B', { visible: true, focused: false }); // B was the front tab
    // Reports arrive in the WORST historical order: B's focus, then A's
    // engagement, then B's correction, then the host's blur — late.
    arb.signalTab(2, { visible: true, focused: true });
    arb.signalTab(1, { visible: true, focused: true });
    arb.signalTab(2, { visible: false, focused: true });
    arb.signalHost({ visible: true, focused: false });
    check('bug1 eviction race: owner is tab A', arb.owner === 1, `owner=${arb.owner}`);
  }
  // --- desktop bug #2 (run 2): steal-then-blur ---------------------------
  // A owns; B's stale-gated claim steals; B then reports blur. Old design
  // needed the "owner-blur handback" special case. Level world: B's blur is
  // a level drop; re-derivation lands on A (still engaged, newest remaining).
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.attachTab(2, 'B');
    arb.signalTab(1, { visible: true, focused: true });
    check('bug2 setup: A owns', arb.owner === 1);
    arb.signalTab(2, { visible: true, focused: true }); // fabricated engagement
    check('bug2: B stole (a fabricated live engagement is undetectable)', arb.owner === 2);
    arb.signalTab(2, { visible: false, focused: true }); // the thief owns up
    check('bug2 steal-then-blur: terminal back on A', arb.owner === 1, `owner=${arb.owner}`);
  }
  // --- desktop bug #3 (run 3): self-heal metronome -----------------------
  // Two faces with STALE levels both looking engaged. Old design: each 2s
  // owner-state tick triggered a fresh claim from whichever face didn't own,
  // flipping ownership forever. Level world: a face at rest sends nothing
  // (reports are event-backed), so derivation without reports is a fixed
  // point — checked here by churning no-op mutations.
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.attachTab(2, 'B');
    arb.signalTab(2, { visible: true, focused: true }); // B engaged (lying at rest)
    arb.signalTab(1, { visible: true, focused: true }); // A engaged (real, newer)
    const before = arb.owner;
    const genBefore = arb.generation;
    for (let i = 0; i < 100; i++) arb.setDoghouse(arb.doghouse); // no-op churn
    check(
      'bug3 metronome: owner fixed without input',
      arb.owner === before && arb.generation === genBefore
    );
  }
  // --- duplicate engaged→engaged must NOT remint / steal (flicker_again) --
  // Chrome SW re-pushes, OS focus storms, and agent window storms used
  // to remint on every identical signal and ping-pong A↔B↔phone.
  {
    const { arb, grants } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.attachTab(2, 'B');
    arb.signalTab(1, { visible: true, focused: true }); // A owns
    grants.length = 0;
    for (let i = 0; i < 50; i++) {
      arb.signalTab(1, { visible: true, focused: true }); // duplicate
      arb.signalTab(2, { visible: false, focused: false }); // idle B spam
    }
    check(
      'dup-signal: no steal from identical engaged reports',
      arb.owner === 1 && grants.length === 0,
      `owner=${arb.owner} grants=${grants.length}`
    );
    // Rising edge on B still steals once.
    arb.signalTab(1, { visible: false, focused: false });
    arb.signalTab(2, { visible: true, focused: true });
    check('dup-signal: rising edge on B still takes ownership', arb.owner === 2, `owner=${arb.owner}`);
  }
  // --- owner-only input: non-owner keystrokes cannot ping-pong ownership ---
  {
    const { arb, grants } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.attachTab(2, 'B');
    arb.signalTab(1, { visible: true, focused: true }); // A owns
    arb.signalTab(2, { visible: true, focused: true }); // B owns via signal (instant)
    grants.length = 0;
    // Alternating keystrokes from both — only the owner may mint; no steal,
    // no hold delay. Signal path above already proved grants stay instant.
    arb.noteInput(1);
    arb.noteInput(2);
    arb.noteInput(1);
    check(
      'owner-only-input: keystroke storm cannot ping-pong',
      arb.owner === 2 && grants.length === 0,
      `owner=${arb.owner} grants=${grants.length}`
    );
    // Real tab switch still moves ownership immediately (no hold).
    // Rising edge required — a duplicate engaged signal is a no-op by design.
    arb.signalTab(1, { visible: true, focused: false });
    arb.signalTab(1, { visible: true, focused: true });
    check('owner-only-input: focus signal still steals instantly', arb.owner === 1, `owner=${arb.owner}`);
  }
  // --- native keystrokes while not owner must NOT steal (demo regression) --
  {
    const { arb, grants } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.signalTab(1, { visible: true, focused: true }); // A owns
    grants.length = 0;
    arb.noteInput('native'); // spurious keys in visible-but-quiet native window
    check(
      'input-host-ignored: non-owner host cannot steal via keystrokes',
      arb.owner === 1 && grants.length === 0,
      `owner=${arb.owner} grants=${grants.length}`
    );
    // Real reclaim: focus signal (instant — no grant hold).
    arb.signalHost({ visible: true, focused: true });
    check('input-host-ignored: focus signal reclaims native', arb.owner === 'native', `owner=${arb.owner}`);
  }
  // --- host-gone handback (scenario 8 class) -----------------------------
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.attachTab(1, 'A');
    arb.signalTab(1, { visible: true, focused: true }); // engaged, but host focused
    check('host-exclusive: owner native while host focused', arb.owner === 'native');
    arb.detachHost(); // app killed while owning
    check('host-gone: terminal lands on the engaged tab', arb.owner === 1, `owner=${arb.owner}`);
  }
  // --- host-gone, nobody engaged: stays native, no crash -----------------
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.attachTab(1, 'A', { visible: true, focused: true }); // baseline-engaged only
    arb.signalTab(1, { visible: false, focused: false });
    arb.detachHost();
    check('host-gone idle: owner stays native', arb.owner === 'native', `owner=${arb.owner}`);
  }
  // --- reconnect artifact: baselines never steal -------------------------
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.signalTab(1, { visible: true, focused: true });
    check('reconnect setup: A owns', arb.owner === 1);
    // B attaches claiming engaged in its hello baseline (stale gates lie
    // exactly like this). A baseline is a description, not an act.
    arb.attachTab(2, 'B', { visible: true, focused: true });
    check('reconnect baseline cannot steal', arb.owner === 1, `owner=${arb.owner}`);
    // But if the owner face truly dies, a baseline-engaged face beats a
    // terminal that exists nowhere.
    arb.detachTab(1);
    check('owner death: ghost holds through the grace', arb.owner === 1);
  }
  // --- bridge blip: MV3 service worker restart ----------------------------
  // Every port drops; sockets reconnect with NEW client ids ~200ms later.
  // The terminal must not move, and the adopted socket must be told it owns.
  {
    const h = makeArbiter();
    const { arb } = h;
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.attachTab(2, 'B');
    arb.signalTab(1, { visible: true, focused: true }); // A owns
    arb.detachTab(2); // non-owner: forgotten immediately
    arb.detachTab(1); // owner: ghosted
    check('blip: owner ghost holds ownership', arb.owner === 1);
    arb.attachTab(11, 'A', { visible: true, focused: true }); // A reattaches, new id
    arb.attachTab(12, 'B', { visible: false, focused: false });
    check('blip: adopted face still owns under its new id', arb.owner === 11, `owner=${arb.owner}`);
    const g = h.grants[h.grants.length - 1];
    check('blip: re-grant notified for the new socket', g && g.next === 11, JSON.stringify(g));
    // The scheduled expiry fires AFTER adoption: must be a no-op.
    for (const key of h.ghosts) arb.expireGhost(key);
    check('blip: stale ghost expiry is a no-op', arb.owner === 11, `owner=${arb.owner}`);
  }
  // --- owner tab really closes: grace expires, terminal comes home --------
  {
    const h = makeArbiter();
    const { arb } = h;
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.signalTab(1, { visible: true, focused: true });
    arb.detachTab(1);
    check('close: ghost holds during grace', arb.owner === 1);
    for (const key of h.ghosts) arb.expireGhost(key);
    check('close: after grace the terminal comes home', arb.owner === 'native', `owner=${arb.owner}`);
  }
  // --- parked-claim class: tab engagement while host focused -------------
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.attachTab(1, 'A');
    arb.signalTab(1, { visible: true, focused: true }); // arrives BEFORE host blur
    check('exclusivity: host focused holds the terminal', arb.owner === 'native');
    arb.signalHost({ visible: true, focused: false }); // host blur lands
    check('exclusivity release: newest engaged tab takes over', arb.owner === 1);
  }
  // --- user really stayed on native: no blur ever comes -------------------
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.attachTab(1, 'A');
    arb.signalTab(1, { visible: true, focused: true }); // spurious
    arb.signalTab(1, { visible: false, focused: false }); // corrected
    check('spurious engagement expires via its own correction', arb.owner === 'native');
  }
  // --- doghouse: engagement barks, never moves ---------------------------
  {
    const h = makeArbiter();
    const { arb } = h;
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.setDoghouse(true);
    arb.signalTab(1, { visible: true, focused: true });
    check('doghouse: owner pinned native', arb.owner === 'native');
    check('doghouse: bark fired', h.barks === 1, `barks=${h.barks}`);
    arb.setDoghouse(false);
    check('doghouse exit: engaged tab takes the terminal', arb.owner === 1);
  }
  // --- tab->tab switch (the everyday path) --------------------------------
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.attachTab(2, 'B');
    arb.signalTab(1, { visible: true, focused: true });
    arb.signalTab(1, { visible: false, focused: true }); // visibilitychange: hidden
    arb.signalTab(2, { visible: true, focused: true }); // visibilitychange: shown
    check('tab switch: B owns', arb.owner === 2);
  }

  // ------------------------------------------------------------------ v8 —
  // --- phone pickup: remote engagement outranks an IDLE focused host ------
  // The user walks away from a focused laptop window and unlocks the phone.
  // No laptop event will ever fire (nothing blurred); the phone's live
  // engagement must win anyway. This is the scenario rule 2 (v7) made
  // impossible by construction — the whole reason v8 exists.
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.signalHost({ visible: true, focused: true }); // launch focus: host mints
    arb.attachTab(1, 'P', { visible: true, focused: true }, true); // phone, baseline
    check('pickup: engaged baseline cannot steal from a focused host', arb.owner === 'native');
    arb.signalTab(1, { visible: true, focused: true }); // unlock: LIVE engagement
    check('pickup: live remote engagement outranks idle-focused host', arb.owner === 1, `owner=${arb.owner}`);
  }
  // --- laptop reclaim via focus event -------------------------------------
  // Phone owns; the user sits back down and clicks/cmd-tabs to the window.
  // The OS focus event is live: the host mints and outranks the phone.
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'P', undefined, true);
    arb.signalTab(1, { visible: true, focused: true });
    check('reclaim setup: phone owns', arb.owner === 1);
    arb.signalHost({ visible: true, focused: true }); // real focus event
    check('reclaim: host focus event brings the terminal home', arb.owner === 'native');
  }
  // --- reclaim is signal-driven (owner-only input cannot steal) -----------
  // Phone took the terminal while the window stayed OS-focused; the user
  // returns. Focus/visibility is the reclaim path — typing alone must not
  // yank, or desktop faces steal from each other via ghost keystrokes.
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.signalHost({ visible: true, focused: true });
    arb.attachTab(1, 'P', undefined, true);
    arb.signalTab(1, { visible: true, focused: true }); // pickup
    check('signal-reclaim setup: phone owns', arb.owner === 1);
    arb.noteInput('native'); // host still focused in ledger but not owner — ignored
    check('signal-reclaim: typing alone does not yank from phone', arb.owner === 1);
    arb.signalHost({ visible: true, focused: true }); // rising-edge / remint via live report
    // Host was already focused: anti-metronome may not remint. Force blur+focus.
    arb.signalHost({ visible: true, focused: false });
    arb.signalHost({ visible: true, focused: true });
    check('signal-reclaim: host focus edge brings terminal home', arb.owner === 'native');
    arb.signalTab(1, { visible: true, focused: false });
    arb.signalTab(1, { visible: true, focused: true });
    check('signal-reclaim: phone engagement takes it back', arb.owner === 1);
  }
  // --- input from non-owner cannot re-prove a stale remote ----------------
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'P', undefined, true);
    arb.signalTab(1, { visible: true, focused: true });
    arb.signalTab(1, { visible: false, focused: false }); // screen locked
    check('stale-phone setup: terminal parked (hysteresis)', arb.owner === 1);
    arb.attachTab(2, 'A');
    arb.signalTab(2, { visible: true, focused: true }); // user visits a tab
    check('stale-phone: laptop tab takes over', arb.owner === 2);
    arb.noteInput(1); // phone types while not owner — ignored
    check('stale-phone: non-owner input cannot reclaim', arb.owner === 2, `owner=${arb.owner}`);
    arb.signalTab(1, { visible: true, focused: true }); // real engagement
    check('stale-phone: live signal reclaims instantly', arb.owner === 1, `owner=${arb.owner}`);
  }
  // --- input from a LOCAL tab still cannot beat a focused host ------------
  // (One keyboard: if the host is focused, "input from a local tab" is a
  // confused or malicious face, exactly the bug2 class. Exclusivity holds.)
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.signalHost({ visible: true, focused: true });
    arb.attachTab(1, 'A');
    arb.noteInput(1);
    check('local-input: focused host still holds against local tab input', arb.owner === 'native');
  }
  // --- doghouse pins against the phone too (I2) ---------------------------
  {
    const h = makeArbiter();
    const { arb } = h;
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'P', undefined, true);
    arb.setDoghouse(true);
    arb.signalTab(1, { visible: true, focused: true });
    check('doghouse vs phone: owner pinned native', arb.owner === 'native');
    check('doghouse vs phone: bark fired', h.barks === 1, `barks=${h.barks}`);
  }
  // --- two remote faces: newest engagement wins under a focused host ------
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: true });
    arb.signalHost({ visible: true, focused: true });
    arb.attachTab(1, 'P1', undefined, true);
    arb.attachTab(2, 'P2', undefined, true);
    arb.signalTab(1, { visible: true, focused: true });
    arb.signalTab(2, { visible: true, focused: true });
    check('two phones: newest remote engagement owns', arb.owner === 2, `owner=${arb.owner}`);
  }
  // --- howl suite: fabricated dual-input / quiet flap / reassert spam -----
  {
    const { arb, grants } = makeArbiter();
    arb.resetHowl();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.attachTab(2, 'B');
    arb.signalTab(1, { visible: true, focused: true });
    grants.length = 0;
    arb.resetHowl();
    for (let i = 0; i < 50; i++) {
      arb.noteInput(1);
      arb.noteInput(2);
    }
    check('howl: dual fabricated input grants=0', arb.howl.grants === 0 && grants.length === 0);
    check('howl: non-owner drops counted', arb.howl.mintRejectedNotOwner > 0);
  }
  {
    const { arb, grants } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.signalTab(1, { visible: true, focused: true });
    grants.length = 0;
    arb.resetHowl();
    // Focus flap while tab owns — without rising edge on host (already false),
    // duplicate host focus reports must not grant.
    for (let i = 0; i < 30; i++) {
      arb.signalHost({ visible: true, focused: false });
    }
    check('howl: focus flap under tab-owner grants=0', grants.length === 0 && arb.owner === 1);
  }
  {
    const { arb } = makeArbiter();
    arb.attachHost({ visible: true, focused: false });
    arb.attachTab(1, 'A');
    arb.signalTab(1, { visible: true, focused: true });
    const gen = arb.generation;
    arb.resetHowl();
    // Duplicate engaged signals (reassert spam): must not remint / grant.
    for (let i = 0; i < 100; i++) {
      arb.signalTab(1, { visible: true, focused: true });
    }
    check('howl: reassert-equivalent churn grants=0', arb.howl.grants === 0 && arb.generation === gen);
  }
  pass('scripted replays (13 v6/v7 + 7 v8 scenarios + howl)');
}

// ---------------------------------------------------------------------------
// Seeded fuzz
// ---------------------------------------------------------------------------

// xorshift32 — deterministic across runs and platforms.
function prng(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0xffffffff;
  };
}

function fuzz(seed: number, events: number): string | null {
  const rnd = prng(seed);
  const h = makeArbiter();
  const { arb } = h;
  const KEYS = ['A', 'B', 'C'];
  // The phone: a REMOTE face on its own device. Its engagement coexists
  // with host focus (nothing on the laptop blurs when it's picked up).
  const PHONE = 'P';
  const isRemote = (key: string): boolean => key === PHONE;
  // faceKey -> live clientId (undefined = not connected)
  const live = new Map<string, number>();
  let nextId = 1;
  let hostAttached = false;
  let hostFocused = false;
  // Ground truth: where the user REALLY is ('native' | faceKey | 'away').
  let user: string | 'away' = 'away';
  const clientOf = (key: string): number | undefined => live.get(key);
  const trace: string[] = [];
  const t = (s: string): void => {
    trace.push(s);
    if (trace.length > 60) trace.shift();
  };
  const fail = (msg: string): string =>
    process.env.SIM_TRACE ? `${msg}\n  trace:\n    ${trace.join('\n    ')}` : msg;

  // Reliable physics of the modeled world:
  //  - host focus/blur are OS events: always reported, always truthful
  //  - a tab the user is ON reports truthfully (visible tabs don't lie)
  //  - tabs the user is NOT on may hold stale levels or lie in baselines
  //  - the PHONE is on another device: moving to/from it never touches
  //    host levels; its own departure report (screen lock) is often LATE
  //  - input comes only from where the user really is (fabricated input is
  //    the accepted bug2 trust boundary, not modeled noise)
  const userMovesTo = (dest: string | 'native'): void => {
    t(`move ${String(user)} -> ${String(dest)}`);
    // Leaving the old place. Chrome tabs miss their disengage report 20% of
    // the time (the missed-blur specialty); the phone's screen lock is late
    // 40% of the time; the host never misses.
    if (user === 'native' && hostAttached && dest !== 'native' && !isRemote(dest as string)) {
      // Chrome taking OS focus on the SAME machine blurs the host: reliable.
      hostFocused = false;
      arb.signalHost({ visible: true, focused: false });
    } else if (user !== 'away' && user !== 'native') {
      const id = clientOf(user);
      const missRate = isRemote(user) ? 0.4 : 0.2;
      if (id != null && rnd() > missRate) {
        arb.signalTab(id, { visible: false, focused: dest !== 'native' && rnd() < 0.5 });
      }
    }
    if (dest === 'native') {
      user = 'native';
      if (hostFocused) {
        // Window stayed focused while user was on a remote face — no OS
        // focus event will fire. Force a focus edge so reclaim is instant
        // (owner-only input must not steal; signals do).
        arb.signalHost({ visible: true, focused: false });
        arb.signalHost({ visible: true, focused: true });
      } else {
        hostFocused = true;
        arb.signalHost({ visible: true, focused: true });
      }
    } else {
      if (hostFocused && !isRemote(dest)) {
        // Chrome taking OS focus means the host blurred: reliable.
        hostFocused = false;
        arb.signalHost({ visible: true, focused: false });
      }
      user = dest;
      const id = clientOf(dest);
      if (id != null) {
        // Rising-edge mint: if the face was already stale-engaged, a plain
        // engaged signal is a no-op under anti-metronome — dip then rise so
        // arrival always remints instantly (no input-steal, no grant hold).
        arb.signalTab(id, { visible: true, focused: false });
        arb.signalTab(id, { visible: true, focused: true });
      }
    }
  };

  const invariants = (step: number): string | null => {
    const owner = arb.owner;
    if (owner !== 'native') {
      const ownedKey = [...live.entries()].find(([, id]) => id === owner)?.[0];
      const isGhost = h.ghosts.includes(
        // a ghosted owner's clientId is no longer in `live` — allowed during grace
        ownedKey ?? ''
      );
      if (!ownedKey && !ghostOwnerAllowed()) {
        return `I1 broken @${step}: owner=${owner} not connected (ghosts=${h.ghosts.join(',')})`;
      }
      void isGhost;
    }
    if (arb.doghouse && owner !== 'native') return `I2 broken @${step}`;
    if (hostAttached && hostFocused && owner !== 'native') {
      // v8: a focused host yields only to a REMOTE row engaged with a
      // strictly newer seq — read straight from the arbiter's own ledger.
      const ledger = arb.debugLedger() as {
        host: { engagedSeq: number } | null;
        tabs: Array<{
          clientId: number;
          engagedSeq: number;
          remote: boolean;
          visible: boolean;
          focused: boolean;
        }>;
      };
      const row = ledger.tabs.find((r) => r.clientId === owner);
      const hostSeq = ledger.host ? ledger.host.engagedSeq : 0;
      if (!row || !row.remote || !(row.engagedSeq > hostSeq)) {
        return `I3 broken @${step}: owner=${owner} while host focused (row=${JSON.stringify(row)}, hostSeq=${hostSeq})`;
      }
    }
    return null;
  };
  // During a ghost grace the owner id refers to a dropped socket — that is
  // the designed behavior (ownership held for the reattach), not a leak.
  const ghostOwnerAllowed = (): boolean => h.ghosts.length > 0;

  for (let i = 0; i < events; i++) {
    const r = rnd();
    if (r < 0.08) {
      hostAttached = true;
      // Baselines are truthful (the host reads real window state): if the
      // user is AT the window it is focused, full stop. Otherwise it can
      // attach focused only when nobody LOCAL holds OS focus (one machine,
      // one focus) — the user being on the phone or away doesn't conflict.
      // Attaching does not move the user: a baseline describes the window,
      // not their attention.
      hostFocused =
        user === 'native' || (rnd() < 0.4 && (user === 'away' || isRemote(user)));
      t(`attach-host f=${hostFocused}`);
      arb.attachHost({ visible: true, focused: hostFocused });
    } else if (r < 0.13) {
      if (hostAttached) {
        hostAttached = false;
        hostFocused = false;
        t('detach-host');
        arb.detachHost();
        if (user === 'native') user = 'away';
      }
    } else if (r < 0.25) {
      // (re)attach a tab face — sometimes the phone. Baseline: truthful if
      // it's where the user is, possibly lying if not. A page the user is
      // actually LOOKING AT emits real load/focus events right after
      // attach (pageshow, the hasFocus-gated check), so a truthful attach
      // is followed by a live engaged signal.
      const pool = rnd() < 0.25 ? [PHONE] : KEYS;
      const key = pool[Math.floor(rnd() * pool.length)];
      if (!live.has(key)) {
        const id = ++nextId;
        live.set(key, id);
        const truthful = user === key;
        const sig = truthful
          ? { visible: true, focused: true }
          : { visible: rnd() < 0.4, focused: rnd() < 0.4 };
        t(`attach ${key}#${id} v=${sig.visible} f=${sig.focused}${truthful ? ' (truthful)' : ''}`);
        arb.attachTab(id, key, sig, isRemote(key));
        // Reattach consumed a pending ghost for this key, if any.
        h.ghosts = h.ghosts.filter((k) => k !== key);
        if (truthful) arb.signalTab(id, { visible: true, focused: true });
      }
    } else if (r < 0.33) {
      // a tab face's socket drops: real close (tab gone) or bridge blip
      const keys = [...live.keys()];
      if (keys.length) {
        const key = keys[Math.floor(rnd() * keys.length)];
        const id = live.get(key)!;
        live.delete(key);
        arb.detachTab(id);
        if (rnd() < 0.5) {
          t(`close ${key}#${id}`);
          // real close: the user was not on it (you can't close a tab you're
          // not on without being on it — if they were, they're now 'away')
          if (user === key) user = 'away';
          // expire any ghost for it now (grace elapses with no reattach)
          if (h.ghosts.includes(key)) {
            h.ghosts = h.ghosts.filter((k) => k !== key);
            arb.expireGhost(key);
          }
        } else {
          t(`blip ${key}#${id}`);
        }
        // else: bridge blip — ghost (if owner) stays pending; a later attach
        // or a later expiry decides.
      }
    } else if (r < 0.38) {
      // pending ghost grace elapses
      if (h.ghosts.length) {
        const key = h.ghosts.shift()!;
        t(`expire-ghost ${key}`);
        arb.expireGhost(key);
        if (user === key && !live.has(key)) user = 'away';
      }
    } else if (r < 0.46) {
      arb.setDoghouse(rnd() < 0.5);
    } else if (r < 0.72) {
      // THE USER MOVES somewhere real.
      if (hostAttached && rnd() < 0.35) {
        userMovesTo('native');
      } else {
        const keys = [...live.keys()];
        if (keys.length) userMovesTo(keys[Math.floor(rnd() * keys.length)]);
      }
    } else if (r < 0.82) {
      // NOISE that must never move the terminal: disengaged-level reports
      // from faces the user is not on (blur corrections, visibility flips).
      const keys = [...live.keys()].filter((k) => k !== user);
      if (keys.length) {
        const key = keys[Math.floor(rnd() * keys.length)];
        arb.signalTab(live.get(key)!, { visible: rnd() < 0.3, focused: false });
      }
    } else if (r < 0.88) {
      // THE USER TYPES where they already own (owner-only mint refreshes
      // engagement; cannot steal). Fabricated input from elsewhere is not
      // modeled — non-owner input is ignored by the arbiter.
      if (user === 'native' && hostAttached) {
        t('input native');
        hostFocused = true;
        arb.noteInput('native');
      } else if (user !== 'away' && user !== 'native' && live.has(user)) {
        t(`input ${user}`);
        arb.noteInput(live.get(user)!);
      }
    } else {
      // Quiescence probe (I4): repeated derivation with zero input.
      const owner = arb.owner;
      const gen = arb.generation;
      for (let k = 0; k < 20; k++) arb.setDoghouse(arb.doghouse);
      if (arb.owner !== owner || arb.generation !== gen) {
        return `I4 broken @${i}: owner moved with no input (${owner} -> ${arb.owner})`;
      }
    }
    const broken = invariants(i);
    if (broken) return broken;
  }

  // Convergence oracle: settle the world (expire pending ghosts), then — if
  // the user is genuinely somewhere attached and not doghoused — the
  // terminal must be with them. The phone case rides the same check: a
  // user genuinely ON the phone always out-minted the host (their move
  // there was a live signal or input), focused laptop window or not.
  for (const key of h.ghosts.splice(0)) arb.expireGhost(key);
  if (!arb.doghouse) {
    if (user === 'native' && hostAttached && hostFocused && arb.owner !== 'native') {
      return fail(`convergence broken: user on native, terminal on ${arb.owner}`);
    }
    if (user !== 'away' && user !== 'native' && live.has(user)) {
      const id = live.get(user)!;
      if (arb.owner !== id) {
        return fail(`convergence broken: user on ${user}(#${id}), terminal on ${arb.owner}`);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
scripted();

const RUNS = Number(process.env.SIM_RUNS) || 2000;
const EVENTS = 300;
let fuzzFailures = 0;
for (let seed = 1; seed <= RUNS; seed++) {
  const err = fuzz(seed, EVENTS);
  if (err) {
    fuzzFailures++;
    console.log(`FAIL: fuzz seed=${seed}: ${err}`);
    if (fuzzFailures > 5) break;
  }
}
if (fuzzFailures === 0) pass(`fuzz: ${RUNS} runs x ${EVENTS} events, invariants + convergence held`);
failures += fuzzFailures;

console.log(failures === 0 ? '\nSIM PASS' : `\nSIM: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
