// Arbiter: single source of truth for which face "owns" (visibly hosts) the
// terminal. Replaces the edge-triggered Choreographer after three desktop-e2e
// runs each exposed a new ordering bug in it (2026-07-15: eviction race,
// steal-then-blur, self-heal metronome). The failure pattern was structural:
// faces sent CONCLUSIONS ("I claim the terminal") and the daemon sent
// COMMANDS ("reveal", "hide"), so correctness depended on every edge arriving
// in order exactly once — and every compensating mechanism (parked claims,
// handbacks, self-heal re-claims) was an attempt to reconstruct state from
// missed edges. One of them oscillated.
//
// This design is level-based:
//
//   FACTS IN.  Faces report raw signals — {visible, focused} — never claims.
//   The arbiter keeps a ledger of last-reported levels per face, plus a
//   monotonic engagement sequence: when a face's levels transition to
//   "engaged" (visible AND focused) in a LIVE report, it takes the next
//   sequence number. Baseline levels delivered with hello take sequence 0:
//   a reconnect describes the world, it does not act in it — so reconnect
//   artifacts can never win a recency contest (desktop bug class #2).
//
//   STATE OUT. The owner is DERIVED, by a pure function, from the current
//   ledger — recomputed after every mutation. The daemon broadcasts the
//   result; faces render themselves from it. A dropped broadcast costs one
//   re-assert tick of latency, not a stranded overlay.
//
// Derivation rules, in order (the whole protocol fits in six lines):
//   1. Doghouse on            -> 'native' (the island). Tab engagement
//      transitions BARK instead of moving ownership.
//   2. Host focused (level)   -> 'native'. OS focus is exclusive: while the
//      user is demonstrably on the real window, no tab report — however
//      confused — can take the terminal. This is the old "parked claim"
//      dance derived declaratively: when the host's focused level drops,
//      re-derivation hands the terminal to the newest engaged tab, with no
//      timers and nothing to void.
//   3. Newest engaged tab     -> that tab. Recency by engagement SEQUENCE,
//      incumbent wins ties. A stale level cannot generate new sequence
//      numbers (levels only transition once), so a face lying at rest can
//      hold at most the position it already has — the metronome (desktop
//      bug class #3) is impossible by construction, not by gating.
//   4. No engaged face        -> owner unchanged (user is on some unrelated
//      app; the terminal stays where they left it), unless the owner is a
//      tab whose face is gone — then 'native' (bring it home).
//
// Face identity is durable: a tab face names itself with a random per-page
// faceKey in hello, and the ledger is keyed by it. When the OWNING face's
// socket drops, its row is kept as a GHOST for a short grace instead of
// being deleted — MV3 kills idle extension service workers, which drops
// every bridge port; without the grace, each such blip would yank the
// terminal home (and steal OS focus revealing the window). A reconnect
// inside the grace ADOPTS the row — same levels, same engagement seq, new
// socket — and ownership never moved. Grace expiry means the face really
// died (tab closed): the row is dropped and rule 4 brings the terminal
// home. This is the one timer in the design, and it debounces
// infrastructure churn — it never adjudicates user intent. The arbiter
// itself stays pure: the DAEMON schedules the expiry and calls
// expireGhost(); the simulator injects it deterministically.
//
// Notably absent, on purpose: claim reasons, pending-claim parking + TTL
// timers, recent-claim windows, handback special cases, face-side self-heal.
// Rule 4 covers host-gone-while-owning (the ledger loses the host row, rule
// 2 stops matching, rule 3 finds the user's tab); rules 2+3 cover every
// return-to-browser ordering (host blur and tab engagement commute — they
// both just update the ledger).

export interface ArbiterHooks {
  /** Derived owner changed (external ids: 'native' | clientId). The daemon
   *  resizes the session for the new owner and broadcasts owner-state
   *  (including prev, for flights). Also fires when the owning FACE is
   *  adopted by a new socket — same face, new clientId — so the reconnected
   *  client learns it owns. */
  ownerChanged(prev: DogshOwner, next: DogshOwner): void;
  /** Doghoused terminal would have followed a tab; the island barks. */
  bark(): void;
  /** The owning face's socket dropped; call arbiter.expireGhost(faceKey)
   *  after the grace unless it reattached. */
  scheduleGhostExpiry(faceKey: string): void;
}

interface TabRow {
  clientId: number;
  visible: boolean;
  focused: boolean;
  /** Monotonic sequence assigned when (visible && focused) most recently
   *  became true via a live report. 0 = engaged at baseline (hello). */
  engagedSeq: number;
  ghosted: boolean;
}

interface Sig {
  visible?: boolean;
  focused?: boolean;
}

const BARK_THROTTLE_MS = 450;
export const GHOST_GRACE_MS = 1500;

export class Arbiter {
  private readonly hooks: ArbiterHooks;
  /** Internal owner: 'native' or a ledger faceKey. */
  private ownerKey: 'native' | string = 'native';
  generation = 1;
  // Last content bounds reported by the native host — the fly-in origin
  // (native->tab) and fly-out target (tab->native) for overlay flights.
  nativeBounds: DogshRect | null = null;
  doghouse = false;
  barkCount = 0;
  private lastBarkAt = 0;

  private tabs = new Map<string, TabRow>();
  private host: { visible: boolean; focused: boolean } | null = null;
  private engagedClock = 0; // sequence source; never wall-clock (no skew, no ties)

  // Bounded event journal, oldest first: every report and every derivation
  // outcome. debug-state exposes it; it is the post-mortem the e2e dumps on
  // failure.
  journal: Array<{ at: number; ev: string; who?: string | number; note?: string }> = [];

  constructor(hooks: ArbiterHooks) {
    this.hooks = hooks;
  }

  private note(ev: string, who?: string | number, note?: string): void {
    this.journal.push({ at: Date.now(), ev, who, note });
    if (this.journal.length > 120) this.journal.splice(0, this.journal.length - 120);
  }

  /** External owner: 'native' or the owning face's CURRENT clientId. */
  get owner(): DogshOwner {
    if (this.ownerKey === 'native') return 'native';
    const row = this.tabs.get(this.ownerKey);
    return row ? row.clientId : 'native'; // unreachable in practice; safe default
  }

  ownerState(): { owner: DogshOwner; gen: number } {
    return { owner: this.owner, gen: this.generation };
  }

  // ---------------------------------------------------------------------
  // Ledger mutations. Every one ends in derive().
  // ---------------------------------------------------------------------

  /** A tab face attached (or REattached after a bridge blip). `sig` is its
   *  baseline — trusted as a description of the present, never as a user
   *  action: it can keep an engagement the face already held (continuity
   *  across reconnect), but it cannot mint a new sequence number. */
  attachTab(clientId: number, faceKey: string, sig?: Sig): void {
    const visible = !!(sig && sig.visible);
    const focused = !!(sig && sig.focused);
    const existing = this.tabs.get(faceKey);
    if (existing) {
      const wasOwnerClientId = this.ownerKey === faceKey ? existing.clientId : null;
      const keptSeq = existing.visible && existing.focused && visible && focused;
      existing.clientId = clientId;
      existing.visible = visible;
      existing.focused = focused;
      if (!keptSeq) existing.engagedSeq = 0;
      existing.ghosted = false;
      this.note('adopt-tab', clientId, `key=${faceKey} v=${visible} f=${focused} seq=${existing.engagedSeq}`);
      // Same face, new socket, still the owner: nothing to re-derive, but
      // the EXTERNAL owner id changed — the new client must be told it owns.
      if (wasOwnerClientId != null && wasOwnerClientId !== clientId) {
        this.generation++;
        this.note('re-grant', clientId, `adopted gen=${this.generation}`);
        this.hooks.ownerChanged(wasOwnerClientId, clientId);
      }
      this.derive();
      return;
    }
    this.tabs.set(faceKey, { clientId, visible, focused, engagedSeq: 0, ghosted: false });
    this.note('attach-tab', clientId, `key=${faceKey} v=${visible} f=${focused}`);
    this.derive();
  }

  attachHost(sig?: Sig): void {
    this.host = { visible: !!(sig && sig.visible), focused: !!(sig && sig.focused) };
    this.note('attach-host', 'native', `v=${this.host.visible} f=${this.host.focused}`);
    this.derive();
  }

  /** Live signal report from a tab face. Live reports are EVENT-BACKED by
   *  protocol: faces only send them from real arrival/departure events
   *  (visibilitychange, window focus/blur, pageshow, service-worker focus
   *  push, one hasFocus-gated reconnect check) — never from timers or from
   *  reactions to daemon broadcasts. So an engaged live report is evidence
   *  the user is there NOW and always mints a fresh sequence — including
   *  engaged->engaged, which heals a face whose baseline already looked
   *  engaged (a level that never transitions would otherwise never outrank
   *  a stale rival; the fuzz found exactly that). Each real event moves
   *  ownership at most once: no feedback loop, no metronome. */
  signalTab(clientId: number, sig: Sig): void {
    const row = this.rowByClient(clientId);
    if (!row || row.ghosted) return;
    row.visible = !!sig.visible;
    row.focused = !!sig.focused;
    if (row.visible && row.focused) {
      row.engagedSeq = ++this.engagedClock;
      if (this.doghouse) this.barkThrottled();
    }
    this.note('signal-tab', clientId, `v=${row.visible} f=${row.focused} seq=${row.engagedSeq}`);
    this.derive();
  }

  /** Live signal report from the native host. */
  signalHost(sig: Sig): void {
    if (!this.host) return;
    this.host.visible = !!sig.visible;
    this.host.focused = !!sig.focused;
    this.note('signal-host', 'native', `v=${this.host.visible} f=${this.host.focused}`);
    this.derive();
  }

  /** A tab face's socket closed. The owner gets a grace ghost (bridge blips
   *  from MV3 service-worker restarts reconnect within it); everyone else
   *  is forgotten immediately. */
  detachTab(clientId: number): void {
    for (const [key, row] of this.tabs) {
      if (row.clientId !== clientId) continue;
      if (this.ownerKey === key && !row.ghosted) {
        row.ghosted = true;
        this.note('ghost-tab', clientId, `key=${key}`);
        this.hooks.scheduleGhostExpiry(key);
        return; // ownership intentionally unmoved during the grace
      }
      this.tabs.delete(key);
      this.note('detach-tab', clientId, `key=${key}`);
      this.derive();
      return;
    }
  }

  /** Grace expired without a reattach: the face really died. */
  expireGhost(faceKey: string): void {
    const row = this.tabs.get(faceKey);
    if (!row || !row.ghosted) return;
    this.tabs.delete(faceKey);
    this.note('expire-ghost', row.clientId, `key=${faceKey}`);
    this.derive();
  }

  detachHost(): void {
    this.host = null;
    this.note('detach-host', 'native');
    // The app quitting is a non-event for the session (it lives in the
    // daemon). Rule 2 stops matching and rules 3/4 place the terminal.
    this.derive();
  }

  setDoghouse(on: boolean): void {
    if (on === this.doghouse) return;
    this.doghouse = on;
    this.note('doghouse', undefined, on ? 'on' : 'off');
    this.derive();
  }

  // ---------------------------------------------------------------------
  // Derivation: pure function of (doghouse, host levels, tab ledger).
  // ---------------------------------------------------------------------
  private derive(): void {
    let next: 'native' | string;
    if (this.doghouse) {
      next = 'native';
    } else if (this.host && this.host.focused) {
      next = 'native';
    } else {
      let best: { key: string; seq: number } | null = null;
      for (const [key, row] of this.tabs) {
        if (row.ghosted || !(row.visible && row.focused)) continue;
        // Ties (only baselines, seq 0): the incumbent keeps the terminal;
        // between non-owners, lowest clientId — arbitrary but deterministic.
        const beats =
          !best ||
          row.engagedSeq > best.seq ||
          (row.engagedSeq === best.seq &&
            (key === this.ownerKey ||
              (best.key !== this.ownerKey &&
                row.clientId < this.tabs.get(best.key)!.clientId)));
        if (beats) best = { key, seq: row.engagedSeq };
      }
      const ownerRow = this.ownerKey !== 'native' ? this.tabs.get(this.ownerKey) : undefined;
      if (best) {
        // Incumbent hysteresis: an engaged owner only loses to a STRICTLY
        // newer engagement (the tie rule above already prefers the owner).
        const ownerEngaged = !!ownerRow && !ownerRow.ghosted && ownerRow.visible && ownerRow.focused;
        next = ownerEngaged && ownerRow!.engagedSeq >= best.seq ? this.ownerKey : best.key;
      } else if (this.ownerKey !== 'native' && !ownerRow) {
        next = 'native'; // owning face is gone and nobody is engaged: come home
      } else {
        next = this.ownerKey; // nobody engaged: the terminal stays put
      }
    }
    if (next === this.ownerKey) return;
    const prevExt = this.owner;
    this.ownerKey = next;
    this.generation++;
    this.note('grant', this.owner, `prev=${prevExt} gen=${this.generation}`);
    this.hooks.ownerChanged(prevExt, this.owner);
  }

  private rowByClient(clientId: number): TabRow | null {
    for (const row of this.tabs.values()) if (row.clientId === clientId) return row;
    return null;
  }

  private barkThrottled(): void {
    this.barkCount++;
    const now = Date.now();
    if (now - this.lastBarkAt > BARK_THROTTLE_MS) {
      this.lastBarkAt = now;
      this.note('bark');
      this.hooks.bark();
    }
  }

  /** Ledger snapshot for debug-state. */
  debugLedger(): Record<string, unknown> {
    return {
      host: this.host,
      tabs: [...this.tabs.entries()].map(([key, row]) => ({ key, ...row })),
      engagedClock: this.engagedClock,
      ownerKey: this.ownerKey,
    };
  }
}
