# Is it possible? Yes. Nobody has built the illusion part.

Research findings for the "terminal that follows you around your laptop" concept
(`is_possible.md`), July 2026.

## TL;DR

- **The state-sync half is a solved, commodity problem.** One pty on a local
  daemon, many xterm.js frontends, every frontend sees identical history and
  live streams. At least six active open-source projects do exactly this today.
- **The continuity illusion half — the "alt-tab onto the page" animation —
  does not exist anywhere we could find.** Not on GitHub, not in shipped
  products, not in HCI literature. The closest academic work (Gluey, CHI 2015;
  XDBrowser, CHI 2016; Deep Shot, CHI 2011) migrates UI across *devices*, not
  across *surfaces on one machine*, and none of them care about frame-perfect
  motion.
- **Every surface in the proof-of-concept and proof-of-capability lists (1–7)
  is technically reachable.** Two of them (anything *into* a popup) are
  degraded by hard platform limits, detailed below.
- The single most important architectural decision: **every frontend is always
  attached and always rendering (hidden), and the handoff only *reveals* it.**
  That is how you make every frame matter — there is nothing to load at
  transition time.

---

## 1. Prior art

### What already exists (state sync — steal this, don't build it)

| Project | What it proves |
|---|---|
| [tui-browser](https://github.com/AJV009/tui-browser) | A native terminal (Kitty) and browser tabs viewing the *same* live session, synced via tmux + node-pty + WebSocket. This is literally our native↔tab data layer. |
| [VeroFess/webshell](https://github.com/VeroFess/webshell) | Multiple simultaneous synchronized viewers of one pty, server-side xterm scrollback, viewers attach/detach freely. Solves the "new surface needs instant full state" problem with the xterm serialize addon. |
| [Tabminal](https://github.com/Leask/Tabminal), [DevBridge](https://github.com/mateuszsury/DevBridge), [remote-dev](https://github.com/btli/remote-dev), [roost](https://github.com/liamsysmind/roost) | Persistent tmux-backed sessions that survive refresh/device switch; "your work follows you" marketing, but the *UI* never follows — you manually open a URL. |
| sshx, tmate, ttyd, upterm | Mature transport/relay layer if we ever want off-machine surfaces (the level-3 list: mobile, TV). |
| Tactic Remote | Mac companion app streaming a tmux pane to iPhone over WebSocket — validates the "native daemon + remote frontend" split on macOS specifically. |

**Conclusion:** the backend is a weekend of glue: `tmux -d` (or a headless
node-pty) + a local daemon + WebSocket fan-out + xterm-headless with the
serialize addon for instant snapshots. Everything differentiated about this
project lives in the choreography layer.

### What does not exist

No project we found animates a terminal (or any app chrome) *between* a native
window, a page overlay, a side panel, and a popup so it reads as one object
moving. Loom-style "camera bubble follows you across tabs" extensions are the
closest shipped illusion, and they only do the tab↔tab case, with no native
leg and no transition animation (the bubble just exists in every tab at the
same fixed position).

### Academic prior art (for framing / related-work section)

- **Gluey** (CHI 2015) — head-worn display as "glue" to migrate content across
  displays. Concept match, hardware mismatch.
- **XDBrowser** (CHI 2016) — end-user re-distribution of web UIs across
  devices. Found users badly want "switch between interface distributions
  depending on task" — direct motivation for us.
- **Deep Shot** (CHI 2011, Google Research) — camera-based app-state migration
  across devices. Same continuity thesis, ancient mechanism.

So the pitch "Apple Continuity but for terminal sessions, on one machine,
frame-perfect" is genuinely novel.

---

## 2. The two core mechanisms

### A. State: one brain, many faces

```
                        ┌─ native app (SwiftUI/AppKit + xterm.js in WKWebView, or Tauri)
local daemon            ├─ content-script overlay (any tab, Shadow DOM + xterm.js WebGL)
pty/tmux ◄─► xterm-headless ├─ side panel page (xterm.js)
+ serialize addon ◄─WS──┼─ popup page (xterm.js)
                        └─ plain web tab (localhost page, for PoC #1/#2)
```

- Daemon owns the pty (wrap it in tmux for free crash-survival).
- Daemon also runs `@xterm/headless` + `@xterm/addon-serialize`: any frontend
  that connects gets **one write containing the exact current screen + scrollback
  + colors + cursor + alt-screen state**, then joins the live stream. This is
  what makes the "browser frontend has all the history they just saw" promise
  instant instead of replay-lagged.
- All frontends stay connected even when hidden (MV3 note: host the extension's
  WebSocket in an **offscreen document**, not the service worker — service
  workers idle out; Chrome 116+ keepalives work but the offscreen doc is the
  no-heartbeat-games answer).
- Input from any surface goes back over the same socket (`tmux send-keys`
  semantics). tmux natively handles multi-client, we get sync for free.

### B. Motion: a shared screen-space coordinate system

The illusion is a FLIP animation whose "First" and "Last" rects live in
**physical screen coordinates**, translated into whatever coordinate system the
destination surface uses:

- Native side: the app trivially knows its own `NSWindow.frame`. It publishes
  `{frame, focused}` to the daemon continuously. Detecting "user switched to
  Chrome" needs **zero permissions**: `NSWorkspace.didActivateApplicationNotification`.
- Web side: a content script can reconstruct its viewport's screen rect from
  `window.screenX/screenY + (outerHeight - innerHeight)` chrome-height
  correction and `devicePixelRatio`. This is the same trick the viral
  "particles flying between browser windows" demos use. It is approximate
  (devtools docked, bookmarks bar) but comfortably within "reads as smooth"
  tolerance; calibrate once per window and cache.
- The daemon is the choreographer: it knows every surface's screen rect and
  focus state, and broadcasts handoff events:
  `{from: {surface, rect}, to: {surface, rect}, session}`.

Then each transition is: destination surface already has a live, rendered,
hidden terminal → daemon says "go" → destination draws the terminal at the
*source's* screen rect (converted to local coords), transform-animates it into
its docked position (~250–350 ms, transform/opacity only, WebGL renderer), while
the source hides itself the same frame. One object, apparently in motion.

macOS gives you a bonus: `cmd-tab` has no system animation, so the window swap
is instant and *our* animation is the only motion on screen.

---

## 3. Per-surface verdict (the numbered list)

### Proof of concept

**1) native → tab — YES, and it's the flagship demo.**
Native app (menu-bar app hosting the terminal window) + daemon + either a
localhost-served page or the extension content-script overlay. NSWorkspace
tells us Chrome went frontmost; daemon pushes the native window's last frame;
the active tab's overlay FLIPs in from that rect; native window hides
(`orderOut`, or an 8-frame shrink-toward-the-tab first). Reverse direction:
overlay FLIPs toward the dock/native-frame rect, native window `orderFront`s at
the matching frame. No permissions beyond installing an extension.

**2) tab → tab — YES, and it's nearly free.**
Two content scripts in different tabs render the overlay at the same *fixed*
viewport position ⇒ when the user switches tabs the terminal appears not to
have moved at all — the strongest possible illusion is zero motion.
`chrome.tabs.onActivated` + a session-state read on reveal covers correctness;
BroadcastChannel/`chrome.storage` sync covers position/size dragging. Add a
subtle 100 ms "settle" scale (1.02→1.0) so it feels alive rather than static.
Caveat: content scripts can't run on `chrome://`, Web Store, or PDF pages —
have a fallback (side panel or PiP) for those.

### Proof of capability

**3) tab → sidepanel — YES.**
`chrome.sidePanel` is a full extension page (persistent across tab navigation,
all APIs, own WebSocket). `sidePanel.open({windowId})` from the worker on a
user gesture. Animation: the overlay FLIPs toward the panel's edge (right or
left — user-configurable in Chrome, detect by comparing panel `screenX` to
window center) and the panel's terminal slides in from that edge. You cannot
animate the panel's own width, so the motion story is "terminal slides into
the dock," which reads correctly.

**4) sidepanel → extension popup — YES, with an asterisk.**
`chrome.action.openPopup()` is stable since Chrome 127, callable from the
worker. `chrome.sidePanel.close()` exists (Chrome 141+). The popup is a normal
extension page and runs xterm.js fine (max 800×600). Asterisk: the popup
**cannot be kept open** — any focus loss kills it instantly, and you can't
position it (it's anchored to the toolbar icon). So the popup is a legitimate
*destination* but a fragile *residence*. Motion: side panel terminal collapses
upward toward the toolbar icon; popup opens with terminal already live.

**5) sidepanel → native — YES.**
Panel terminal FLIPs toward the panel edge / off-window; daemon tells the
native app to `orderFront` at a frame adjacent to where it exited, and the
native app can genuinely animate its own `NSWindow` frame (native windows are
the one surface where we fully control position — use it: slide/scale the real
window in). Optionally `NSApp.activate` to take focus.

**6) popup → tab — YES, and the popup's fragility helps.**
The popup dies the moment the user clicks the page — which *is* the handoff
trigger. Popup fires a "dying" beacon (`visibilitychange`/`pagehide` →
offscreen doc), active tab's overlay FLIPs in from the popup's anchor rect
(top-right, below toolbar — approximate from `window.screenX + outerWidth`).
Latency budget is tight (the beacon → overlay reveal must land within ~2
frames); pre-warmed hidden overlay makes this achievable.

**7) popup → native — YES, same pattern.**
Popup dies / user cmd-tabs away; NSWorkspace sees the native app (or any app)
activate; native window animates in from the popup-anchor screen rect. All
pieces already exist from #1 and #6.

### Not researched (per instructions), one note only

The Document Picture-in-Picture API is worth knowing about as a **cheat/
complement**: an always-on-top window hosting arbitrary HTML (xterm.js) that
floats over *every* tab and even other apps. It gets "terminal follows you
everywhere" for free — but it reads as a floating window rather than being
*on the page*, its position can't be script-controlled (so it can't participate
in FLIP choreography), and it dies with its opener tab. Good fallback surface
for `chrome://` pages and cheap mode for a v0 demo; not the product.

---

## 4. The "every frame matters" playbook

1. **Never attach at handoff. Attach always, reveal at handoff.** Every
   surface keeps a mounted, connected, rendered-but-hidden terminal. Handoff
   is `visibility: visible` + a transform, nothing else.
2. **Transform/opacity-only animation**, compositor-friendly; xterm.js WebGL
   renderer everywhere (it works in content scripts, panels, popups, and
   WKWebView).
3. **Serialize-addon snapshots** so a cold surface (popup, freshly injected
   tab) is pixel-correct in one write, then streams.
4. **Daemon as single choreographer** — one source of truth for who is
   visible, so two surfaces never both claim the terminal (the classic
   double-vision bug that murders the illusion).
5. **Continuous rect telemetry** — surfaces publish their screen rects on
   move/resize (throttled rAF), so the handoff never waits on a measurement.
6. **Latency budget:** focus-change signal (<1 ms native, ~10 ms extension
   event) + WebSocket hop on loopback (<1 ms) + reveal (1 frame). A 120 Hz
   ProMotion frame is 8.3 ms; landing the reveal within 2 frames of the OS
   window switch is realistic.

## 5. Honest risk list

- **Screen-coordinate reconstruction in Chrome is approximate** (no
  `mozInnerScreenX` equivalent). Mitigation: one-time calibration per window;
  errors under ~10 px are invisible mid-animation.
- **Popup surfaces are hostile** (auto-close, no positioning, 800×600 cap).
  Treat popup as a transient surface, never the resting home.
- **Content scripts blocked on privileged pages** (`chrome://`, Web Store).
  Fallback: side panel or Document PiP.
- **MV3 service worker lifetime** — solved via offscreen document, but it's a
  sharp edge to engineer around, not forget.
- **Multi-display + mixed devicePixelRatio** makes the coordinate math
  spicier; scope v0 to the laptop's built-in display ("only on the newest
  laptops" already implies this).
- **Fullscreen browser / Stage Manager** changes window-frame semantics; punt.

## 6. Suggested build order

1. Daemon: tmux + node-pty + xterm-headless/serialize + WS fan-out. (~solved
   problem, crib from tui-browser/webshell.)
2. PoC #2 (tab→tab) — no native code, proves the overlay + sync + "didn't
   move" illusion.
3. PoC #1 (native→tab) — menu-bar app (Tauri or Swift+WKWebView so xterm.js is
   the renderer on both sides ⇒ pixel-identical terminals), NSWorkspace focus
   hook, first real FLIP handoff. **This is the demo video.**
4. Surfaces #3/#5 (side panel ↔ native), then the popup pair (#4/#6/#7) last,
   since popups are the flakiest.
