# dogsh — a terminal that follows you around

Demo of terminal-session continuity across surfaces on one machine: a **real
pty** (your login shell — htop, vim, any ncurses app works) with two faces:

- **Native face** — an Electron window (same architecture as Hyper/VS Code's
  terminal: xterm.js + node-pty, no mocked terminal anywhere).
- **Tab face** — a Chrome extension overlay injected into every page,
  rendering the *same* live session.

Switch from the app to Chrome and the terminal flies onto the page you're
looking at, with all scrollback and streaming output intact. Switch tabs and
it's simply already there. Switch back to the app and it comes home.

## How it works

The session lives in a standalone daemon (`app/daemon/`, run as Node under the
Electron binary); the Electron app (`app/main.ts`) is just the native host +
face. Sources are TypeScript 7 — `tsc` emits the runtime `.js` next to each
source (the extension bundles straight from `.ts` via esbuild):

```
                                     ┌── native face (Electron renderer, xterm.js WebGL)
real pty (zsh) ── headless xterm ────┤
  node-pty        + serialize       WS└── every tab (content-script overlay, xterm.js)
                  (snapshots)      127.0.0.1:47703
```

- Every face stays **attached and rendered while hidden**; a handoff only
  reveals. Nothing loads at transition time — that's what makes frames matter.
- New faces get a pixel-exact snapshot (scrollback/colors/cursor/alt-screen)
  in one write via the xterm serialize addon, then join the live stream.
- Ownership is **derived, never claimed** (protocol v6): faces report raw
  `{visible, focused}` signals from real events; the daemon's arbiter
  (`app/daemon/arbiter.ts`) derives which face owns the terminal from that
  ledger and broadcasts `owner-state`; every face renders itself from the
  broadcast. Handoffs involving the native window run a FLIP transform
  animation against the window's last screen rect (converted to viewport
  coords in the overlay). The arbiter's contract is executable:
  `cd app && npm run sim` (scripted replays of every historical arbitration
  bug + seeded fuzz), and `node e2e/wire-probe.js` replays the same cases
  against the real daemon over real sockets.
- Extension internals: content scripts talk through a `chrome.runtime` port to
  an offscreen document that owns the WebSockets (immune to page CSP and
  service-worker idling). WebGL rendering is enabled only in the visible tab.

## Run it

Requires macOS, Node 20+, Xcode CLT (for node-pty), Chrome 116+.

```bash
# 1. Native app + daemon (npm start compiles the TypeScript first)
cd app && npm install && npm start

# 2. Extension (separate terminal; build = tsc --noEmit type-check + esbuild)
cd extension && npm install && npm run build
# then: chrome://extensions -> Developer mode -> Load unpacked -> extension/dist
```

## Demo script

1. In the dogsh window, run something alive: `htop`, or `while true; do date; sleep 1; done`.
2. Cmd-tab to Chrome with any normal website open → the terminal flies from
   the window's position into the page, still streaming.
3. Type into it (it's the same shell). Quit htop, start `vim`.
4. Switch tabs → it's already there, same spot, same session.
5. Cmd-tab back to dogsh → the overlay flies out, the native window returns
   with everything you did in the browser.

## Protocol smoke tests (no GUI interaction needed)

```bash
cd app
npm run smoke          # compiles, then pty roundtrip + mirror snapshot, output-gated
npm run sim            # ownership arbiter: scripted bug replays + seeded fuzz
node ../e2e/wire-probe.js  # same contract against the real daemon over real sockets
```

## Known limitations (deliberate demo scope)

- Fixed terminal grid (90×26, `shared/config.js`) — no resize negotiation, so
  every face is pixel-identical, which strengthens the illusion.
- Content scripts can't run on `chrome://`, Web Store, or PDF tabs; the
  terminal stays wherever it was when you focus those.
- The daemon accepts any localhost WebSocket client (no auth) — fine for a
  demo, not for shipping.
- Sessions survive the app (they live in the daemon; `dogsh --install-daemon`
  registers it with launchd), but not a daemon crash or reboot — no tmux-style
  on-disk persistence.
- Screen→viewport mapping approximates Chrome's toolbar height
  (`outerHeight - innerHeight`); devtools docked top/left will skew it.

See `RESEARCH.md` for the full surface-by-surface feasibility study.
