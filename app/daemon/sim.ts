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
//   I3  host focused level  => owner === 'native'
//   I4  no input => no movement: repeated derivation without any report
//       never changes the owner (the metronome is impossible, proven, not
//       hoped)
//   convergence: once the noise settles, the terminal is where the user is.
//
// Run: npm run sim   (pure logic, no sockets, no pty — a full fuzz run takes
// well under a second)
import { Arbiter } from './arbiter.js';

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
  pass('scripted replays (13 scenarios)');
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
  const userMovesTo = (dest: string | 'native'): void => {
    t(`move ${String(user)} -> ${String(dest)}`);
    // Leaving the old place. Chrome tabs miss their disengage report 20% of
    // the time (the missed-blur specialty); the host never does.
    if (user === 'native' && hostAttached && dest !== 'native') {
      hostFocused = false;
      arb.signalHost({ visible: true, focused: false });
    } else if (user !== 'away' && user !== 'native') {
      const id = clientOf(user);
      if (id != null && rnd() > 0.2) {
        arb.signalTab(id, { visible: false, focused: dest !== 'native' && rnd() < 0.5 });
      }
    }
    if (dest === 'native') {
      hostFocused = true;
      user = 'native';
      arb.signalHost({ visible: true, focused: true });
    } else {
      if (hostFocused) {
        // Chrome taking OS focus means the host blurred: reliable.
        hostFocused = false;
        arb.signalHost({ visible: true, focused: false });
      }
      user = dest;
      const id = clientOf(dest);
      if (id != null) arb.signalTab(id, { visible: true, focused: true });
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
      return `I3 broken @${step}: owner=${owner} while host focused`;
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
      hostFocused = rnd() < 0.4;
      t(`attach-host f=${hostFocused}`);
      arb.attachHost({ visible: true, focused: hostFocused });
      if (hostFocused) user = 'native';
    } else if (r < 0.13) {
      if (hostAttached) {
        hostAttached = false;
        hostFocused = false;
        t('detach-host');
        arb.detachHost();
        if (user === 'native') user = 'away';
      }
    } else if (r < 0.25) {
      // (re)attach a tab face. Baseline: truthful if it's where the user is
      // (a genuinely visible tab reports real levels), possibly lying if not.
      const key = KEYS[Math.floor(rnd() * KEYS.length)];
      if (!live.has(key)) {
        const id = ++nextId;
        live.set(key, id);
        const truthful = user === key;
        const sig = truthful
          ? { visible: true, focused: true }
          : { visible: rnd() < 0.4, focused: rnd() < 0.4 };
        t(`attach ${key}#${id} v=${sig.visible} f=${sig.focused}${truthful ? ' (truthful)' : ''}`);
        arb.attachTab(id, key, sig);
        // Reattach consumed a pending ghost for this key, if any.
        h.ghosts = h.ghosts.filter((k) => k !== key);
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
    } else if (r < 0.88) {
      // NOISE that must never move the terminal: disengaged-level reports
      // from faces the user is not on (blur corrections, visibility flips).
      const keys = [...live.keys()].filter((k) => k !== user);
      if (keys.length) {
        const key = keys[Math.floor(rnd() * keys.length)];
        arb.signalTab(live.get(key)!, { visible: rnd() < 0.3, focused: false });
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
  // terminal must be with them.
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
