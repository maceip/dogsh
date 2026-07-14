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

One process (`app/main.js`) is both the daemon and the native host:

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
- Handoffs are **focus claims**: a face saying "the user is looking at me."
  The daemon (choreographer) turns claims into reveal/hide commands carrying
  screen rects; the tab overlay converts screen→viewport coords and runs a
  FLIP transform animation from the native window's last position.
- Extension internals: content scripts talk through a `chrome.runtime` port to
  an offscreen document that owns the WebSockets (immune to page CSP and
  service-worker idling). WebGL rendering is enabled only in the visible tab.

## Run it

Requires macOS, Node 20+, Xcode CLT (for node-pty), Chrome 116+.

```bash
# 1. Native app + daemon
cd app && npm install && npm start

# 2. Extension (separate terminal)
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
npm run smoke          # pty roundtrip + mirror snapshot, output-gated
npx electron . &       # then, in another shell:
node test-handoff.js   # fake tab claims focus; verifies snapshot->reveal->hide sequencing
```

## Known limitations (deliberate demo scope)

- Fixed terminal grid (90×26, `shared/config.js`) — no resize negotiation, so
  every face is pixel-identical, which strengthens the illusion.
- Content scripts can't run on `chrome://`, Web Store, or PDF tabs; the
  terminal stays wherever it was when you focus those.
- The daemon accepts any localhost WebSocket client (no auth) — fine for a
  demo, not for shipping.
- Session lives and dies with the app (no tmux persistence layer yet).
- Screen→viewport mapping approximates Chrome's toolbar height
  (`outerHeight - innerHeight`); devtools docked top/left will skew it.

See `RESEARCH.md` for the full surface-by-surface feasibility study.
