// Ambient declarations for the renderer processes, which run as plain
// <script> tags (no bundler, no modules): xterm's UMD globals and the
// preload bridges exposed via contextBridge.
import type * as XTerm from '@xterm/xterm';
import type * as XTermWebgl from '@xterm/addon-webgl';
import type * as XTermWebLinks from '@xterm/addon-web-links';
import type * as XTermFit from '@xterm/addon-fit';

declare global {
  // <script src="../node_modules/@xterm/xterm/lib/xterm.js"> etc.
  const Terminal: typeof XTerm.Terminal;
  const WebglAddon: typeof XTermWebgl;
  const WebLinksAddon: typeof XTermWebLinks;
  const FitAddon: typeof XTermFit;

  // preload.ts (native face window)
  interface DogshBridge {
    onReveal(cb: () => void): void;
    onEdit(cb: (cmd: string) => void): void;
    onUserResize(cb: () => void): void;
    contextMenu(opts: { hasSelection: boolean }): Promise<string | null>;
    clipboardWrite(text: string): void;
    clipboardRead(): Promise<string>;
    openExternal(url: string): void;
  }

  // preload-island.ts (doghouse island window)
  interface IslandConfig {
    wrapped: boolean;
    pillW?: number;
    pillH?: number;
    restW?: number;
    restH?: number;
    expW?: number;
    expH?: number;
  }
  interface DogshIslandBridge {
    onBark(cb: () => void): void;
    onConfig(cb: (cfg: IslandConfig) => void): void;
    setIgnoreMouse(ignore: boolean): void;
    exitDoghouse(): void;
  }

  interface Window {
    dogsh: DogshBridge;
    dogshIsland: DogshIslandBridge;
  }
}

export {};
