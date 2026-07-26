// Guest shell backend: Phase 3 plug point for a checkpointable relocatable
// runtime (webshell/rootfs). TODAY this still wraps a host PTY for demo
// continuity — it is NOT a live process migrator. It always emits
// GuestCheckpoint blobs so host export/import can round-trip guest-shaped
// state. Swap the spawn path here when a real guest runtime lands.
import { Session } from './session.js';
import type { GuestCheckpoint, ShellBackend, ShellFlow, SpawnOpts } from './shell-backend.js';
import type { SavedSession } from './persist.js';

/** @deprecated name kept for DOGSH_SHELL_BACKEND=guest; see file header. */
export class GuestShellBackend implements ShellBackend {
  readonly kind = 'guest' as const;
  private readonly inner: Session;
  private guestPayload = '';

  constructor(opts: SpawnOpts) {
    this.inner = new Session(opts);
  }

  get id(): number {
    return this.inner.id;
  }
  get cols(): number {
    return this.inner.cols;
  }
  set cols(v: number) {
    this.inner.cols = v;
  }
  get rows(): number {
    return this.inner.rows;
  }
  set rows(v: number) {
    this.inner.rows = v;
  }
  get exited(): boolean {
    return this.inner.exited;
  }
  get title(): string {
    return this.inner.title;
  }
  set title(v: string) {
    this.inner.title = v;
  }

  write(data: string): void {
    this.inner.write(data);
  }
  resize(cols: number, rows: number): boolean {
    return this.inner.resize(cols, rows);
  }
  snapshot(): string {
    return this.inner.snapshot();
  }
  restore(data: string, savedAt: number): void {
    this.inner.restore(data, savedAt);
  }
  clear(): void {
    this.inner.clear();
  }
  kill(): void {
    this.inner.kill();
  }
  flow(): ShellFlow {
    return this.inner.flow();
  }
  persistState(): SavedSession | null {
    return this.inner.persistState();
  }
  onData(cb: (data: string) => void): void {
    this.inner.onData(cb);
  }
  onExit(cb: (exitCode: number) => void): void {
    this.inner.onExit(cb);
  }
  onTitle(cb: (title: string) => void): void {
    this.inner.onTitle(cb);
  }

  checkpoint(): GuestCheckpoint {
    return {
      v: 1,
      kind: 'guest',
      savedAt: Date.now(),
      cols: this.inner.cols,
      rows: this.inner.rows,
      title: this.inner.title,
      mirror: this.inner.snapshot(),
      payload: this.guestPayload,
    };
  }

  restoreCheckpoint(cp: GuestCheckpoint): void {
    if (!cp || cp.kind !== 'guest') return;
    this.guestPayload = typeof cp.payload === 'string' ? cp.payload : '';
    if (cp.mirror) this.inner.restore(cp.mirror, cp.savedAt || Date.now());
    if (cp.title) this.inner.title = cp.title;
  }
}

/** Factory: DOGSH_SHELL_BACKEND=guest selects the guest plug point. */
export function createShellBackend(opts: SpawnOpts): ShellBackend {
  const kind = (process.env.DOGSH_SHELL_BACKEND || 'pty').toLowerCase();
  if (kind === 'guest') return new GuestShellBackend(opts);
  return new Session(opts);
}
