// Append-only + ring-buffer ownership/howl trace. Under a residual storm,
// sync logging must not become part of the load — sample to disk.
import fs from 'fs';
import os from 'os';
import path from 'path';

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'dogsh');
export const FLICKER_LOG = path.join(LOG_DIR, 'flicker.log');

const RING = 200;
const ring: string[] = [];
let ready = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let pendingFlush = false;

function ensure(): void {
  if (ready) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    ready = true;
  } catch {
    /* best-effort */
  }
}

function enqueue(line: string): void {
  ring.push(line);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  pendingFlush = true;
}

function flushNow(): void {
  if (!pendingFlush || ring.length === 0) return;
  pendingFlush = false;
  ensure();
  const chunk = ring.join('');
  try {
    fs.appendFileSync(FLICKER_LOG, chunk);
  } catch {
    /* ignore */
  }
}

/** Start periodic sampler (call once from daemon boot). */
export function startFlickerFlush(ms = 100): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushNow, ms);
  if (typeof flushTimer === 'object' && 'unref' in flushTimer) {
    try {
      (flushTimer as NodeJS.Timeout).unref();
    } catch {
      /* ignore */
    }
  }
}

export function flickerLog(tag: string, detail?: string): void {
  const line = `${new Date().toISOString()} [${tag}]${detail ? ` ${detail}` : ''}\n`;
  enqueue(line);
  // Immediate flush for grants / howl / fence — post-mortem must not wait.
  if (tag === 'GRANT' || tag === 'howl' || tag === 'host-fenced' || tag === 'daemon') {
    flushNow();
  }
  try {
    process.stdout.write(line);
  } catch {
    /* ignore */
  }
}

/** Dump ring for howl post-mortem. */
export function flickerRingDump(): string {
  return ring.join('');
}
