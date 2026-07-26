// LeaseEngine: single source of truth for which face holds the INPUT/DISPLAY
// lease on the terminal (not Session Host lifetime — see session-mux).
// Level-based: faces report {visible, focused}; lease is derived and
// broadcast. Echo-cancellation doctrine: downlink never re-enters uplink
// as a talkspurt; reject/classify/coalesce — never delay grants.
//
// Derivation rules (order):
//   1. Doghouse on            -> native
//   2. Host focused           -> native (exclusive over LOCAL faces);
//      remote with strictly newer seq may outrank
//   3. Newest engaged tab     -> that tab
//   4. Else                   -> lease stays / home if owner gone
//
// OWNER-ONLY INPUT: non-owners cannot mint or steal by typing.
export interface LeaseEngineHooks {
  ownerChanged(prev: DogshOwner, next: DogshOwner): void;
  bark(): void;
  scheduleGhostExpiry(faceKey: string): void;
  trace?(ev: string, who?: string | number, note?: string): void;
}

/** @deprecated use LeaseEngineHooks */
export type ArbiterHooks = LeaseEngineHooks;

interface TabRow {
  clientId: number;
  visible: boolean;
  focused: boolean;
  engagedSeq: number;
  ghosted: boolean;
  remote: boolean;
}

interface Sig {
  visible?: boolean;
  focused?: boolean;
}

const BARK_THROTTLE_MS = 450;
export const GHOST_GRACE_MS = 1500;

/**
 * Uplink policy (AEC): who may mint / write / report focus.
 * Downlink never re-enters uplink as a talkspurt — faces must not signal
 * from owner-state paint. Grants stay immediate (no hold).
 */
export const UPLINK_POLICY = {
  /** Rising-edge or seq-0 heal may mint engagement; duplicates rejected. */
  mint: { ownerOnlyInput: true, risingEdgeOrSeq0: true },
  /** PTY write: lease holder only (double-talk reject). */
  write: { ownerOnly: true },
  /** Focus/visibility reports: coalesce; never from downlink paint. */
  reportFocus: { coalesceMs: 16, noSignalFromOwnerState: true },
} as const;

export interface HowlCounters {
  grants: number;
  signals: number;
  inputAccepted: number;
  inputDropped: number;
  mintRejectedDuplicate: number;
  mintRejectedNotOwner: number;
  /** Peak grants observed in any 100ms window. */
  maxGrantBurst: number;
}

export class LeaseEngine {
  private readonly hooks: LeaseEngineHooks;
  private ownerKey: 'native' | string = 'native';
  generation = 1;
  nativeBounds: DogshRect | null = null;
  doghouse = false;
  barkCount = 0;
  private lastBarkAt = 0;

  private tabs = new Map<string, TabRow>();
  private host: { visible: boolean; focused: boolean; engagedSeq: number } | null = null;
  private hostSeqCarry = 0;
  private engagedClock = 0;

  /** Last lease-change cause for owner-state (AEC reference). */
  lastCause: DogshLeaseCause = 'attach';

  journal: Array<{ at: number; ev: string; who?: string | number; note?: string }> = [];

  howl: HowlCounters = {
    grants: 0,
    signals: 0,
    inputAccepted: 0,
    inputDropped: 0,
    mintRejectedDuplicate: 0,
    mintRejectedNotOwner: 0,
    maxGrantBurst: 0,
  };
  private grantBurstWindowStart = 0;
  private grantBurstCount = 0;

  constructor(hooks: LeaseEngineHooks) {
    this.hooks = hooks;
  }

  private note(ev: string, who?: string | number, note?: string): void {
    this.journal.push({ at: Date.now(), ev, who, note });
    if (this.journal.length > 120) this.journal.splice(0, this.journal.length - 120);
    this.hooks.trace?.(ev, who, note);
  }

  private bumpGrantBurst(): void {
    const now = Date.now();
    if (now - this.grantBurstWindowStart > 100) {
      this.grantBurstWindowStart = now;
      this.grantBurstCount = 0;
    }
    this.grantBurstCount++;
    if (this.grantBurstCount > this.howl.maxGrantBurst) {
      this.howl.maxGrantBurst = this.grantBurstCount;
    }
  }

  get owner(): DogshOwner {
    if (this.ownerKey === 'native') return 'native';
    const row = this.tabs.get(this.ownerKey);
    return row ? row.clientId : 'native';
  }

  ownerState(): { owner: DogshOwner; gen: number } {
    return { owner: this.owner, gen: this.generation };
  }

  /** sole = lease holder; monitor = remote non-owner; mute = local non-owner. */
  leaseRoleFor(opts: { surface: DogshSurface; clientId: number; remote: boolean }): DogshLeaseRole {
    if (opts.surface === 'native-host') return 'mute';
    const sole =
      this.owner === 'native' ? opts.surface === 'native' : opts.clientId === this.owner;
    if (sole) return 'sole';
    if (opts.remote) return 'monitor';
    return 'mute';
  }

  resetHowl(): void {
    this.howl = {
      grants: 0,
      signals: 0,
      inputAccepted: 0,
      inputDropped: 0,
      mintRejectedDuplicate: 0,
      mintRejectedNotOwner: 0,
      maxGrantBurst: 0,
    };
    this.grantBurstWindowStart = 0;
    this.grantBurstCount = 0;
  }

  attachTab(clientId: number, faceKey: string, sig?: Sig, remote = false): void {
    this.lastCause = 'attach';
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
      existing.remote = remote;
      this.note('adopt-tab', clientId, `key=${faceKey} v=${visible} f=${focused} seq=${existing.engagedSeq}`);
      if (wasOwnerClientId != null && wasOwnerClientId !== clientId) {
        this.generation++;
        this.note('re-grant', clientId, `adopted gen=${this.generation}`);
        this.hooks.ownerChanged(wasOwnerClientId, clientId);
      }
      this.derive();
      return;
    }
    this.tabs.set(faceKey, { clientId, visible, focused, engagedSeq: 0, ghosted: false, remote });
    this.note('attach-tab', clientId, `key=${faceKey} v=${visible} f=${focused}${remote ? ' remote' : ''}`);
    this.derive();
  }

  attachHost(sig?: Sig): void {
    this.lastCause = 'attach';
    this.host = {
      visible: !!(sig && sig.visible),
      focused: !!(sig && sig.focused),
      engagedSeq: this.hostSeqCarry,
    };
    this.note(
      'attach-host',
      'native',
      `v=${this.host.visible} f=${this.host.focused} seq=${this.host.engagedSeq}`
    );
    this.derive();
  }

  signalTab(clientId: number, sig: Sig): void {
    this.howl.signals++;
    this.lastCause = 'signal';
    const row = this.rowByClient(clientId);
    if (!row || row.ghosted) return;
    const nextVis = !!sig.visible;
    const nextFoc = !!sig.focused;
    const wasEngaged = row.visible && row.focused;
    const levelsChanged = row.visible !== nextVis || row.focused !== nextFoc;
    const nowEngaged = nextVis && nextFoc;
    if (!levelsChanged && !(nowEngaged && row.engagedSeq === 0)) {
      this.howl.mintRejectedDuplicate++;
      return;
    }
    row.visible = nextVis;
    row.focused = nextFoc;
    const rising = nowEngaged && !wasEngaged;
    const healBaseline = nowEngaged && row.engagedSeq === 0;
    if (rising || healBaseline) {
      row.engagedSeq = ++this.engagedClock;
      if (this.doghouse) this.barkThrottled();
    }
    this.note('signal-tab', clientId, `v=${row.visible} f=${row.focused} seq=${row.engagedSeq}`);
    this.derive();
  }

  signalHost(sig: Sig): void {
    this.howl.signals++;
    this.lastCause = 'signal';
    if (!this.host) return;
    const nextVis = !!sig.visible;
    const nextFoc = !!sig.focused;
    const wasFocused = this.host.focused;
    const levelsChanged = this.host.visible !== nextVis || this.host.focused !== nextFoc;
    if (!levelsChanged && !(nextFoc && this.host.engagedSeq === 0)) {
      this.howl.mintRejectedDuplicate++;
      return;
    }
    this.host.visible = nextVis;
    this.host.focused = nextFoc;
    if (nextFoc && (!wasFocused || this.host.engagedSeq === 0)) {
      this.host.engagedSeq = this.hostSeqCarry = ++this.engagedClock;
    }
    this.note('signal-host', 'native', `v=${this.host.visible} f=${this.host.focused} seq=${this.host.engagedSeq}`);
    this.derive();
  }

  noteInput(source: 'native' | number): void {
    this.lastCause = 'input';
    const newest = (seq: number): boolean => this.engagedClock > 0 && seq === this.engagedClock;
    if (source === 'native') {
      if (!this.host) return;
      if (this.ownerKey !== 'native') {
        this.howl.inputDropped++;
        this.howl.mintRejectedNotOwner++;
        this.note('input-host-ignored', 'native', 'not owner');
        return;
      }
      if (!this.host.focused) {
        this.howl.inputDropped++;
        this.note('input-host-ignored', 'native', 'host not focused');
        return;
      }
      const mint = !newest(this.host.engagedSeq);
      if (!mint && this.host.visible && this.host.focused) {
        this.howl.mintRejectedDuplicate++;
        return;
      }
      this.host.visible = true;
      if (mint) this.host.engagedSeq = this.hostSeqCarry = ++this.engagedClock;
      this.howl.inputAccepted++;
      this.note('input-host', 'native', `seq=${this.host.engagedSeq}`);
      this.derive();
      return;
    }
    const row = this.rowByClient(source);
    if (!row || row.ghosted) return;
    if (this.owner !== source) {
      this.howl.inputDropped++;
      this.howl.mintRejectedNotOwner++;
      this.note('input-tab-ignored', source, 'not owner');
      return;
    }
    const mint = !newest(row.engagedSeq);
    if (!mint && row.visible && row.focused) {
      this.howl.mintRejectedDuplicate++;
      return;
    }
    row.visible = true;
    row.focused = true;
    if (mint) {
      row.engagedSeq = ++this.engagedClock;
      if (this.doghouse) this.barkThrottled();
    }
    this.howl.inputAccepted++;
    this.note('input-tab', source, `seq=${row.engagedSeq}`);
    this.derive();
  }

  detachTab(clientId: number): void {
    for (const [key, row] of this.tabs) {
      if (row.clientId !== clientId) continue;
      if (this.ownerKey === key && !row.ghosted) {
        row.ghosted = true;
        this.note('ghost-tab', clientId, `key=${key}`);
        this.hooks.scheduleGhostExpiry(key);
        return;
      }
      this.tabs.delete(key);
      this.note('detach-tab', clientId, `key=${key}`);
      this.derive();
      return;
    }
  }

  expireGhost(faceKey: string): void {
    this.lastCause = 'expire-ghost';
    const row = this.tabs.get(faceKey);
    if (!row || !row.ghosted) return;
    this.tabs.delete(faceKey);
    this.note('expire-ghost', row.clientId, `key=${faceKey}`);
    this.derive();
  }

  detachHost(): void {
    this.host = null;
    this.note('detach-host', 'native');
    this.derive();
  }

  setDoghouse(on: boolean): void {
    if (on === this.doghouse) return;
    this.lastCause = 'doghouse';
    this.doghouse = on;
    this.note('doghouse', undefined, on ? 'on' : 'off');
    this.derive();
  }

  private derive(): void {
    let next: 'native' | string;
    if (this.doghouse) {
      next = 'native';
    } else if (this.host && this.host.focused) {
      let bestRemote: { key: string; seq: number } | null = null;
      for (const [key, row] of this.tabs) {
        if (!row.remote || row.ghosted || !(row.visible && row.focused)) continue;
        if (!bestRemote || row.engagedSeq > bestRemote.seq) bestRemote = { key, seq: row.engagedSeq };
      }
      next =
        bestRemote && bestRemote.seq > this.host.engagedSeq ? bestRemote.key : 'native';
    } else {
      let best: { key: string; seq: number } | null = null;
      for (const [key, row] of this.tabs) {
        if (row.ghosted || !(row.visible && row.focused)) continue;
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
        const ownerEngaged = !!ownerRow && !ownerRow.ghosted && ownerRow.visible && ownerRow.focused;
        next = ownerEngaged && ownerRow!.engagedSeq >= best.seq ? this.ownerKey : best.key;
      } else if (this.ownerKey !== 'native' && !ownerRow) {
        next = 'native';
      } else {
        next = this.ownerKey;
      }
    }
    if (next === this.ownerKey) return;
    const prevExt = this.owner;
    this.ownerKey = next;
    this.generation++;
    this.howl.grants++;
    this.bumpGrantBurst();
    this.note('grant', this.owner, `prev=${prevExt} gen=${this.generation} cause=${this.lastCause}`);
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

  debugLedger(): Record<string, unknown> {
    return {
      host: this.host,
      tabs: [...this.tabs.entries()].map(([key, row]) => ({ key, ...row })),
      engagedClock: this.engagedClock,
      ownerKey: this.ownerKey,
      lastCause: this.lastCause,
      howl: { ...this.howl },
    };
  }
}

/** @deprecated use LeaseEngine */
export const Arbiter = LeaseEngine;
