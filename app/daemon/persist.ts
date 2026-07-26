// Session + host persistence for the relocatable Session Host.
//
// Per-session files: scrollback mirrors (tmux-lite — processes die with the
// host; the next host restores what the user could SEE).
// Host meta: generation (fencing), activeSessionId, optional redirect URL
// after a hot-potato handoff so crash restart is already a baby potato.
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { GuestCheckpoint } from './shell-backend.js';

export interface SavedSession {
  v: 1;
  savedAt: number;
  cols: number;
  rows: number;
  title: string;
  data: string;
}

/** Durable host authority — survives daemon crash on the same machine. */
export interface HostMeta {
  v: 1;
  /** Monotonic fence counter. A host only accepts input if its live
   *  generation matches disk (or is the importer that just bumped it). */
  hostGeneration: number;
  activeSessionId: number | null;
  /** When set, this host has yielded authority; faces should reconnect. */
  fenced: boolean;
  redirectUrl: string | null;
  updatedAt: number;
}

/** Portable bundle for Phase 2 host relocation (export/import). */
export interface SessionHostBundle {
  v: 1;
  hostGeneration: number;
  activeSessionId: number | null;
  sessions: Array<{ id: number; state: SavedSession }>;
  guestCheckpoints: Record<string, GuestCheckpoint>;
}

const STATE_DIR_DEFAULT = path.join(os.homedir(), '.dogsh', 'state');

export function stateDir(): string {
  return process.env.DOGSH_STATE_DIR || STATE_DIR_DEFAULT;
}

const fileFor = (id: number) => path.join(stateDir(), `session-${id}.json`);
const metaFile = () => path.join(stateDir(), 'host.json');

export function saveSession(id: number, state: SavedSession): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = fileFor(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, fileFor(id));
  } catch (e) {
    console.error(`[dogshd] state save failed for session ${id}:`, e);
  }
}

export function deleteSession(id: number): void {
  try {
    fs.unlinkSync(fileFor(id));
  } catch {
    /* never saved, or already gone */
  }
}

/** All restorable sessions, oldest id first. Unreadable/foreign files are
 *  removed — they'd otherwise resurrect on every boot forever. */
export function loadSessions(): Array<{ id: number; state: SavedSession }> {
  let names: string[];
  try {
    names = fs.readdirSync(stateDir());
  } catch {
    return []; // no state dir yet: first boot
  }
  const out: Array<{ id: number; state: SavedSession }> = [];
  for (const name of names) {
    const m = /^session-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const id = Number(m[1]);
    try {
      const state = JSON.parse(fs.readFileSync(path.join(stateDir(), name), 'utf8'));
      if (state && state.v === 1 && typeof state.data === 'string') {
        out.push({ id, state });
        continue;
      }
    } catch {
      /* corrupt: fall through to removal */
    }
    deleteSession(id);
  }
  return out.sort((a, b) => a.id - b.id);
}

export function defaultHostMeta(): HostMeta {
  return {
    v: 1,
    hostGeneration: 1,
    activeSessionId: null,
    fenced: false,
    redirectUrl: null,
    updatedAt: Date.now(),
  };
}

export function loadHostMeta(): HostMeta {
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
    if (raw && raw.v === 1 && typeof raw.hostGeneration === 'number') {
      return {
        v: 1,
        hostGeneration: Math.max(1, raw.hostGeneration | 0),
        activeSessionId:
          typeof raw.activeSessionId === 'number' ? raw.activeSessionId : null,
        fenced: !!raw.fenced,
        redirectUrl: typeof raw.redirectUrl === 'string' ? raw.redirectUrl : null,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      };
    }
  } catch {
    /* missing or corrupt */
  }
  return defaultHostMeta();
}

export function saveHostMeta(meta: HostMeta): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const next = { ...meta, v: 1 as const, updatedAt: Date.now() };
    const tmp = metaFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, metaFile());
  } catch (e) {
    console.error('[dogshd] host meta save failed:', e);
  }
}
