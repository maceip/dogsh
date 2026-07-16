// Shared by: Electron main (require), Electron renderer (script tag),
// extension bundle (esbuild import). Keep dependency-free.
const DOGSH_CONFIG = {
  // Bumped whenever the face<->daemon protocol or face UI changes materially.
  // The daemon warns (inside the terminal) any face that reports an older
  // version — catches "rebuilt dist/ but never reloaded the extension".
  // v6: level-based ownership. Clients report raw {visible,focused} signals
  // (never claims); the daemon derives the owner and broadcasts owner-state;
  // faces render themselves from it (reveal/hide commands are gone). Faces
  // carry a durable faceKey so reconnects keep their ledger row.
  protocolVersion: 6,
  // Handoff flight (native->tab fly-in, tab->native fly-out), milliseconds.
  flyMs: 280,
  // Interaction behavior shared by every face, so muscle memory transfers
  // across surfaces. Spread into the Terminal(...) constructor options.
  termBehavior: {
    // Option = Meta (readline alt-b/alt-f etc.), the setting shell users
    // expect from iTerm/VS Code.
    macOptionIsMeta: true,
    // When a TUI captures the mouse (vim/htop), Option+drag still selects
    // text locally instead of being swallowed by mouse reporting.
    macOptionClickForcesSelection: true,
    // Right-clicking a word selects it (macOS terminal convention) before
    // the context menu opens over it.
    rightClickSelectsWord: true,
  },
  port: 47703,
  cols: 90,
  rows: 26,
  scrollback: 5000,
  fontSize: 13,
  lineHeight: 1.2,
  fontFamily: "'MesloLGS NF', Menlo, Monaco, 'Courier New', monospace",
  theme: {
    background: '#0d1117',
    foreground: '#e6edf3',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: '#264f78',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DOGSH_CONFIG;
}
