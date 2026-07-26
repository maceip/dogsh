// SessionMux: owns the set of ShellBackends, active tab, export/import, and
// the host fence. Face gateway + lease arbiter talk to sessions only through
// this module — never spawn PTYs themselves.
import * as persist from './persist.js';
import type { HostMeta, SavedSession, SessionHostBundle } from './persist.js';
import { createShellBackend } from './guest-backend.js';
import type { GuestCheckpoint, ShellBackend } from './shell-backend.js';

export const MAX_SESSIONS = 2;

export interface SessionMuxHooks {
  onSessionData(sessionId: number, data: string): void;
  onSessionTitle(): void;
  onSessionExit(sessionId: number, exitCode: number): void;
  /** Called after activeSessionId changes (persist + notify faces). */
  onActiveChanged(activeId: number | null): void;
  onFenced(redirectUrl: string | null): void;
}

export class SessionMux {
  readonly sessions = new Map<number, ShellBackend>();
  private nextSessionId = 1;
  activeSessionId: number | null = null;
  hostGeneration: number;
  fenced = false;
  redirectUrl: string | null = null;
  private importing = false;
  private readonly hooks: SessionMuxHooks;

  constructor(hooks: SessionMuxHooks) {
    this.hooks = hooks;
    const meta = persist.loadHostMeta();
    this.hostGeneration = meta.hostGeneration;
    // A fenced host that restarts without import stays fenced until import
    // or an explicit unfence (admin). Crash of an UNfenced host continues.
    this.fenced = meta.fenced;
    this.redirectUrl = meta.redirectUrl;
  }

  private persistMeta(): void {
    const meta: HostMeta = {
      v: 1,
      hostGeneration: this.hostGeneration,
      activeSessionId: this.activeSessionId,
      fenced: this.fenced,
      redirectUrl: this.redirectUrl,
      updatedAt: Date.now(),
    };
    persist.saveHostMeta(meta);
  }

  /** Boot: restore scrolls from disk, pick active from meta when valid. */
  bootstrap(opts: { smoke?: boolean } = {}): void {
    const restorable = opts.smoke ? [] : persist.loadSessions().slice(0, MAX_SESSIONS);
    for (const r of restorable) this.createSession(r);
    if (this.sessions.size === 0) this.createSession();

    const meta = persist.loadHostMeta();
    if (meta.activeSessionId != null && this.sessions.has(meta.activeSessionId)) {
      this.activeSessionId = meta.activeSessionId;
    } else {
      this.activeSessionId = Math.min(...this.sessions.keys());
    }
    this.persistMeta();
    if (restorable.length > 0) {
      console.log(
        `[dogshd] restored ${restorable.length} session(s) gen=${this.hostGeneration}` +
          (this.fenced ? ' FENCED' : '') +
          `: ${restorable.map((r) => `#${r.id}`).join(', ')}`
      );
    }
  }

  activeSession(): ShellBackend | null {
    return (this.activeSessionId != null && this.sessions.get(this.activeSessionId)) || null;
  }

  createSession(restore?: { id: number; state: SavedSession; checkpoint?: GuestCheckpoint }): ShellBackend | null {
    if (this.sessions.size >= MAX_SESSIONS) return null;
    const id = restore ? restore.id : this.nextSessionId++;
    if (restore) this.nextSessionId = Math.max(this.nextSessionId, id + 1);
    const s = createShellBackend({
      id,
      cols: restore ? Math.max(20, Math.min(500, restore.state.cols | 0)) : undefined,
      rows: restore ? Math.max(5, Math.min(200, restore.state.rows | 0)) : undefined,
    });
    if (restore?.checkpoint && s.restoreCheckpoint) {
      s.restoreCheckpoint(restore.checkpoint);
    } else if (restore) {
      s.restore(restore.state.data, restore.state.savedAt);
    }
    this.sessions.set(id, s);
    s.onData((data) => this.hooks.onSessionData(id, data));
    s.onTitle(() => this.hooks.onSessionTitle());
    s.onExit((exitCode) => {
      if (this.importing) return;
      this.sessions.delete(id);
      persist.deleteSession(id);
      this.hooks.onSessionExit(id, exitCode);
      if (this.sessions.size === 0) {
        setTimeout(() => process.exit(0), 300);
        return;
      }
      if (id === this.activeSessionId) {
        this.activateSession([...this.sessions.keys()][0]);
      } else {
        this.persistMeta();
        this.hooks.onActiveChanged(this.activeSessionId);
      }
    });
    return s;
  }

  activateSession(id: number): boolean {
    const s = this.sessions.get(id);
    if (!s || id === this.activeSessionId) return false;
    this.activeSessionId = id;
    this.persistMeta();
    this.hooks.onActiveChanged(id);
    return true;
  }

  /** Refuse stdin / session mutations when this host has yielded. */
  acceptsInput(): boolean {
    return !this.fenced;
  }

  saveDirtySessions(): void {
    for (const s of this.sessions.values()) {
      const state = s.persistState();
      if (state) persist.saveSession(s.id, state);
    }
    this.persistMeta();
  }

  /** Snapshot the whole host for relocation (Phase 2). */
  exportBundle(): SessionHostBundle {
    this.saveDirtySessions();
    const sessions: SessionHostBundle['sessions'] = [];
    const guestCheckpoints: Record<string, GuestCheckpoint> = {};
    for (const s of this.sessions.values()) {
      sessions.push({
        id: s.id,
        state: {
          v: 1,
          savedAt: Date.now(),
          cols: s.cols,
          rows: s.rows,
          title: s.title,
          data: s.snapshot(),
        },
      });
      const cp = s.checkpoint();
      if (cp) guestCheckpoints[String(s.id)] = cp;
    }
    return {
      v: 1,
      hostGeneration: this.hostGeneration,
      activeSessionId: this.activeSessionId,
      sessions,
      guestCheckpoints,
    };
  }

  /**
   * Yield authority: stop accepting input, bump generation on disk for the
   * importer, tell faces to reconnect (optional redirectUrl).
   */
  fence(redirectUrl?: string | null): void {
    this.fenced = true;
    this.redirectUrl = redirectUrl ?? this.redirectUrl;
    this.saveDirtySessions();
    this.persistMeta();
    this.hooks.onFenced(this.redirectUrl);
  }

  /**
   * Take over from an exported bundle. Bumps hostGeneration past the
   * exporter's so the old host (if still alive) is stale.
   */
  importBundle(bundle: SessionHostBundle): { ok: true } | { ok: false; error: string } {
    if (!bundle || bundle.v !== 1 || !Array.isArray(bundle.sessions)) {
      return { ok: false, error: 'bad bundle' };
    }
    this.importing = true;
    try {
      for (const s of [...this.sessions.values()]) {
        // Drop hooks before kill — pty onExit is async and must not delete
        // the replacement session that reuses the same numeric id.
        s.onData(() => {});
        s.onExit(() => {});
        s.onTitle(() => {});
        try {
          s.kill();
        } catch {
          /* ignore */
        }
      }
      this.sessions.clear();
      this.nextSessionId = 1;

      for (const row of bundle.sessions.slice(0, MAX_SESSIONS)) {
        const cp = bundle.guestCheckpoints?.[String(row.id)];
        this.createSession({ id: row.id, state: row.state, checkpoint: cp });
      }
      if (this.sessions.size === 0) this.createSession();

      this.hostGeneration = Math.max(this.hostGeneration, bundle.hostGeneration) + 1;
      this.fenced = false;
      this.redirectUrl = null;
      if (bundle.activeSessionId != null && this.sessions.has(bundle.activeSessionId)) {
        this.activeSessionId = bundle.activeSessionId;
      } else {
        this.activeSessionId = Math.min(...this.sessions.keys());
      }
      this.saveDirtySessions();
      this.persistMeta();
    } finally {
      this.importing = false;
    }
    this.hooks.onActiveChanged(this.activeSessionId);
    return { ok: true };
  }
}
