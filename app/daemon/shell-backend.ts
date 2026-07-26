// ShellBackend: the relocatable unit behind a session. Faces never talk to
// a PTY or guest runtime directly — only through SessionMux → this interface.
//
// kind 'pty'  — host-local node-pty (today's default; cannot migrate live).
// kind 'guest' — checkpointable backend (Phase 3 plug point; see guest-backend).
import type { SavedSession } from './persist.js';

export type ShellKind = 'pty' | 'guest';

/** Opaque blob a guest backend can round-trip across host handoff. */
export interface GuestCheckpoint {
  v: 1;
  kind: 'guest';
  savedAt: number;
  cols: number;
  rows: number;
  title: string;
  /** Serialized terminal mirror (scrollback). */
  mirror: string;
  /** Backend-private payload (rootfs checkpoint id, etc.). Empty for stub. */
  payload: string;
}

export interface ShellFlow {
  pendingMirror: number;
  ptyPaused: boolean;
  ptyPauseCount: number;
}

export interface ShellBackend {
  readonly id: number;
  readonly kind: ShellKind;
  cols: number;
  rows: number;
  exited: boolean;
  title: string;

  write(data: string): void;
  resize(cols: number, rows: number): boolean;
  snapshot(): string;
  /** Seed scrollback from a prior host (processes already dead). */
  restore(data: string, savedAt: number): void;
  clear(): void;
  kill(): void;
  flow(): ShellFlow;
  persistState(): SavedSession | null;

  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  onTitle(cb: (title: string) => void): void;

  /** Guest backends return a relocatable checkpoint; pty returns null. */
  checkpoint(): GuestCheckpoint | null;
  /** Apply a guest checkpoint after construction (guest only). */
  restoreCheckpoint?(cp: GuestCheckpoint): void;
}

export interface SpawnOpts {
  id: number;
  cols?: number;
  rows?: number;
}
