// Hand-maintained types for ./config.js, which stays plain JavaScript on
// purpose: it is consumed three ways — require() in the daemon/host, a bare
// <script> tag in the native renderer (global DOGSH_CONFIG), and an esbuild
// import in the extension bundle — and no single tsc emit shape survives all
// three. Keep this in lockstep with config.js.

interface DogshTermBehavior {
  macOptionIsMeta: boolean;
  macOptionClickForcesSelection: boolean;
  rightClickSelectsWord: boolean;
}

interface DogshTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

interface DogshConfig {
  protocolVersion: number;
  flyMs: number;
  termBehavior: DogshTermBehavior;
  port: number;
  cols: number;
  rows: number;
  scrollback: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  theme: DogshTheme;
}

declare const DOGSH_CONFIG: DogshConfig;

export = DOGSH_CONFIG;
// Script-tag consumers (the native renderer) see the same value as the
// global DOGSH_CONFIG.
export as namespace DOGSH_CONFIG;
