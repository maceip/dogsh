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

export class Session {
  readonly id: number;
  cols: number;
  rows: number;
  exited: boolean;
  title: string;

  private readonly pty: pty.IPty;
  private readonly mirror: HeadlessTerminal;
  private readonly serializer: SerializeAddon;
  private _disposed = false;
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
      this.mirror.write(data);
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
    if (!this.exited) this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
    return true;
  }

  snapshot(): string {
    if (this._disposed) return '';
    return this.serializer.serialize({ scrollback: CONFIG.scrollback });
  }

  clear(): void {
    if (this._disposed) return;
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
