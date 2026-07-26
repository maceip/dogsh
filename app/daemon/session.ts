// A Session is one real shell: pty + headless xterm mirror + serializer.
// The mirror exists so ANY face can be brought to a pixel-exact state
// (scrollback, colors, cursor, alt-screen) with a single snapshot write, at
// any time — attach, resize, lag-resync, session-switch all lean on it.
//
// Pure Node (no Electron APIs): this file runs inside the standalone daemon.
import os from 'os';
import * as pty from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

import CONFIG from '../shared/config.js';
import type { SavedSession } from './persist.js';
import type { GuestCheckpoint, ShellBackend, ShellFlow, ShellKind } from './shell-backend.js';

// Mirror-ingest flow control (the official xterm.js recipe): count bytes
// handed to mirror.write() until its parse callback returns them, and pause
// the pty above the high-water mark. Without this, a `yes`/`cat bigfile`
// flood grows xterm's internal write queue without bound — the pty produces
// at pipe speed while the parser drains at parse speed, and the difference
// accumulates in daemon memory. pty.pause() stops reading the pty fd, the
// kernel buffer fills, the flooding process blocks on write(2): the flood
// runs at the mirror's pace end-to-end, which is also the fastest any face
// could honestly render it. Marks are code units, not bytes — close enough.
// Env-tunable so the wire probe can prove the mechanism with a tight budget
// (at real pty speeds the parser usually keeps up, so the default watermarks
// rarely trip outside genuinely hostile content).
const MIRROR_HIGH_WATER = Number(process.env.DOGSH_MIRROR_HIGH_WATER) || 1024 * 1024;
const MIRROR_LOW_WATER = Number(process.env.DOGSH_MIRROR_LOW_WATER) || 128 * 1024;

/** Host-local PTY shell backend. Live processes do not migrate; only the
 *  mirror (via persistState) is hot-potato portable until a guest backend
 *  supplies real checkpoints. */
export class Session implements ShellBackend {
  readonly id: number;
  readonly kind: ShellKind = 'pty';
  cols: number;
  rows: number;
  exited: boolean;
  title: string;

  private readonly pty: pty.IPty;
  private readonly mirror: HeadlessTerminal;
  private readonly serializer: SerializeAddon;
  private _disposed = false;
  private _dirty = false; // mirror changed since the last persistence save
  private _pendingMirror = 0; // code units written to the mirror, not yet parsed
  private _ptyPaused = false;
  private _ptyPauseCount = 0; // cumulative: pause windows are too short to poll
  private _onData: ((data: string) => void) | null = null;
  private _onExit: ((exitCode: number) => void) | null = null;
  private _onTitle: ((title: string) => void) | null = null;

  constructor({ id, cols = CONFIG.cols, rows = CONFIG.rows }: { id: number; cols?: number; rows?: number }) {
    this.id = id;
    this.cols = cols;
    this.rows = rows;
    this.exited = false;

    const shell = process.env.SHELL || '/bin/zsh';
    // Tab label until the shell sets a real one via OSC title.
    this.title = shell.split('/').pop() || 'shell';

    this.pty = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    this.mirror = new HeadlessTerminal({
      cols,
      rows,
      scrollback: CONFIG.scrollback,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);
    // Shells title their terminal constantly (cwd, running command); the
    // mirror parses those OSC sequences anyway, so tabs get labels for free.
    this.mirror.onTitleChange((t) => {
      this.title = String(t || '').trim() || this.title;
      if (this._onTitle) this._onTitle(this.title);
    });

    this.pty.onData((data) => {
      if (this._disposed) return; // straggler bytes after kill()
      this._dirty = true;
      this._pendingMirror += data.length;
      this.mirror.write(data, () => {
        this._pendingMirror -= data.length;
        if (this._ptyPaused && this._pendingMirror < MIRROR_LOW_WATER) {
          this._ptyPaused = false;
          try {
            this.pty.resume();
          } catch {
            /* pty already gone */
          }
        }
      });
      if (!this._ptyPaused && this._pendingMirror > MIRROR_HIGH_WATER) {
        this._ptyPaused = true;
        this._ptyPauseCount++;
        try {
          this.pty.pause();
        } catch {
          /* pty already gone */
        }
      }
      if (this._onData) this._onData(data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      if (this._onExit) this._onExit(exitCode);
    });
  }

  onData(cb: (data: string) => void): void {
    this._onData = cb;
  }
  onExit(cb: (exitCode: number) => void): void {
    this._onExit = cb;
  }
  onTitle(cb: (title: string) => void): void {
    this._onTitle = cb;
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  // Owner-drives-size: exactly one face is visible at a time, so the pty can
  // always match the visible face's grid (no tmux smallest-client compromise).
  resize(cols: number, rows: number): boolean {
    if (this._disposed) return false;
    cols = Math.max(20, Math.min(500, cols | 0));
    rows = Math.max(5, Math.min(200, rows | 0));
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    this._dirty = true;
    if (!this.exited) this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
    return true;
  }

  snapshot(): string {
    if (this._disposed) return '';
    return this.serializer.serialize({ scrollback: CONFIG.scrollback });
  }

  /** Scrollback persistence: seed the mirror with a previous daemon's saved
   *  buffer, above a divider. History only — the processes died with the old
   *  daemon (that is physics, not policy); the fresh shell prompts below.
   *  Called right after construction, before the new pty's first bytes can
   *  arrive (they land on a later event-loop turn). */
  restore(data: string, savedAt: number): void {
    if (this._disposed || !data) return;
    const when = new Date(savedAt).toLocaleString();
    const leaveAlt =
      data.lastIndexOf('\x1b[?1049h') > data.lastIndexOf('\x1b[?1049l')
        ? '\x1b[?1049l'
        : '';
    const seam =
      `\x1b[0m\r\n\x1b[33m[dogsh: restored ${when} — previous shell exited]\x1b[0m\r\n`;
    // Chain writes so the seam cannot land before the scrollback parse finishes.
    this.mirror.write(data, () => {
      if (this._disposed) return;
      const finish = () => {
        if (!this._disposed) this.mirror.write(seam);
      };
      if (leaveAlt) this.mirror.write(leaveAlt, finish);
      else finish();
    });
  }

  /** Flow-control telemetry for debug-state (and the flood probes). */
  flow(): ShellFlow {
    return {
      pendingMirror: this._pendingMirror,
      ptyPaused: this._ptyPaused,
      ptyPauseCount: this._ptyPauseCount,
    };
  }

  /** PTY cannot relocate live; SessionMux exports scrollback only. */
  checkpoint(): GuestCheckpoint | null {
    return null;
  }

  /** Everything a future daemon needs to put this session's scrollback back
   *  on screen. Reads the dirty flag destructively: the caller saves iff
   *  something changed since it last asked. */
  persistState(): SavedSession | null {
    if (this._disposed || !this._dirty) return null;
    this._dirty = false;
    return {
      v: 1,
      savedAt: Date.now(),
      cols: this.cols,
      rows: this.rows,
      title: this.title,
      data: this.snapshot(),
    };
  }

  clear(): void {
    if (this._disposed) return;
    this._dirty = true;
    this.mirror.clear();
  }

  kill(): void {
    this._disposed = true;
    if (!this.exited) {
      this.exited = true;
      try {
        this.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.mirror.dispose();
  }
}
