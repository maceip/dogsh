# What actually works: MV3 extensions in Microsoft Edge for Android (sideloaded)

An empirical audit, run against a real device over the Chrome DevTools Protocol
(CDP). The web is full of "does Edge Android run extensions?" uncertainty and
hand-waving — including, embarrassingly, an earlier draft of my own analysis.
This is the measured answer for a **sideloaded** (developer-options CRX) MV3
extension.

**TL;DR — far more works than folklore suggests.** Content scripts inject,
the MV3 service worker runs, **offscreen documents work**, `chrome-extension://`
pages load, and `chrome.scripting` / `chrome.storage` / `chrome.tabs` /
`chrome.offscreen` are all present. A full extension (content script → offscreen
WebSocket → local server) ran end-to-end and rendered a live overlay on an
ordinary web page. The gaps are a handful of APIs (`declarativeNetRequest`,
`webRequest`, `alarms`, `webNavigation`) — and one nasty debugging trap (a
zombie DevTools socket) that makes everything *look* broken when it isn't.

## Environment

| | |
|---|---|
| Device | Android 10 (real hardware, USB) |
| Browser | Microsoft Edge Canary — `EdgA/152.0.4173.0` (Chromium 152) |
| UA | `Mozilla/5.0 (Linux; Android 10; K) … Chrome/152.0.0.0 Mobile Safari/537.36 EdgA/152.0.0.0` |
| Extension | Sideloaded **MV3** `.crx` via Edge's Developer options → "Extension install by crx" |
| Also present | MetaMask (store-installed) — used as a second data point |

Edge Android's extension support is Canary-only and gated behind
`edge://flags` → "Android extensions" + Developer options. It is officially
experimental. Everything below is what that experimental surface *actually did*,
not what the docs promise.

## Method

Everything was measured, not assumed. Edge exposes the standard Chromium
DevTools endpoint over an abstract unix socket; bridge it to the host and drive
raw CDP:

```bash
# find Edge's devtools socket(s) on the device
adb shell cat /proc/net/unix | grep -o 'chrome_devtools_remote[^ ]*'
# forward the LIVE one (see the gotcha below) and talk CDP
adb forward tcp:9222 localabstract:chrome_devtools_remote_<pid>
curl http://127.0.0.1:9222/json/version
```

From there: enumerate targets (`Target.getTargets`), attach to the service
worker / a content-script world / an extension page (`Target.attachToTarget`,
`flatten:true`), and evaluate an API-probe expression in each context
(`Runtime.evaluate`). Content-script injection was checked by opening a page and
looking for the isolated world (`Runtime.executionContextCreated` with
`auxData.type === "isolated"`) plus the DOM the script builds.

### ⚠️ The gotcha that wastes your whole day: the zombie DevTools socket

Edge Android can leave a **dead instance's** `chrome_devtools_remote` abstract
socket lingering next to the live one. If you forward CDP to the stale socket
(e.g. by blindly taking the first match), you get a *convincing simulation of
total failure*:

- `connectOverCDP` times out enumerating hundreds of stale tabs;
- freshly opened tabs never appear in `/json/list`;
- `Runtime.evaluate` hangs (the ghost pages are frozen/throttled);
- content scripts and service workers appear absent.

Every one of those symptoms is the socket, not the platform. **Pick the socket
that actually shows a tab you just opened**, e.g.:

```bash
for s in $(adb shell cat /proc/net/unix | grep -o 'chrome_devtools_remote[^ ]*' | sort -u); do
  adb forward --remove tcp:9222; adb forward tcp:9222 localabstract:$s
  curl -s http://127.0.0.1:9222/json/list | grep -q "$MY_TAB_MARKER" && echo "live: $s"
done
```

I lost a lot of time — and drew a flatly wrong early conclusion ("Edge won't run
the extension") — because I was inspecting a corpse. The moment I selected the
live socket, everything below lit up.

## Findings

### CDP target types exposed

`Target.getTargets({filter:[{}]})` returned targets of type: **`service_worker`,
`page`, `tab`, `iframe`, `other`.** Service workers and offscreen documents show
up as real, attachable targets (the offscreen doc appears as both `other` and
`tab` for the same `chrome-extension://…/offscreen.html`).

### Content scripts — ✅ inject (manifest + programmatic + dynamic)

On an ordinary page, the manifest-declared content script produced its own
isolated world and built its DOM:

```
executionContexts: [
  { type: "isolated", name: "dogsh — terminal that follows you" },  // our extension
  { type: "isolated", name: "MetaMask" },                            // another extension
  { type: "default",  name: "" }                                     // the page
]
isolatedWorld: true
[data-dogsh] host element: present
```

All injection paths work:

- **Manifest `content_scripts`** → isolated world created, DOM built.
- **`chrome.scripting.executeScript`** with `func` → `ok` (returned the page URL).
- **`chrome.scripting.executeScript`** with `files:['content.js']` → `ok`.
- **`chrome.scripting.registerContentScripts`** → registered (`getRegisteredContentScripts` lists it).

Note: injection can lag a beat after load (the script is real and large); poll
for the isolated world rather than checking once immediately.

### Service worker — ✅ runs, with a broad API surface

The MV3 background service worker (`chrome-extension://…/sw.js`) is a live,
attachable `service_worker` target. Evaluated inside it, `Object.keys(chrome)`:

```
action, clipboard, commands, csi, dom, extension, i18n, loadTimes,
management, offscreen, permissions, runtime, scripting, storage, tabs, windows
```

### Offscreen documents — ✅ work

This one surprised me most (I had assumed offscreen was desktop-only):
`chrome.offscreen` and `chrome.offscreen.createDocument` are present in the
service worker, and the created **`offscreen.html` is a live target** — i.e. the
SW successfully called `createDocument()` and the offscreen page is running. Our
extension uses the offscreen document to hold a persistent WebSocket; that is
exactly what worked.

### `chrome-extension://` pages — ✅ load

Opening `chrome-extension://<id>/options.html` as a target succeeded and the
page had the **full** `chrome.*` surface (same namespaces as the SW). Earlier I
reported `ERR_ABORTED` opening extension pages — that too was the zombie socket.

### API surface (measured in the service worker & an extension page)

| API | Present? |
|---|---|
| `runtime` (`connect`, `sendMessage`, `getURL`, `getManifest`) | ✅ |
| `storage.local` | ✅ |
| `offscreen` (+ `createDocument`) | ✅ |
| `scripting` (+ `executeScript`, `registerContentScripts`) | ✅ |
| `tabs` (+ `query`) | ✅ |
| `windows` | ✅ |
| `action` | ✅ |
| `commands` | ✅ |
| `i18n`, `management`, `permissions`, `clipboard`, `extension` | ✅ |
| `declarativeNetRequest` | ❌ |
| `webRequest` | ❌ |
| `alarms` | ❌ |
| `webNavigation` | ❌ |

(Absence is by `typeof chrome.<ns> === 'undefined'` in SW + extension-page
contexts. Content-script worlds see the usual reduced subset — `runtime`,
`storage`, `i18n`, `dom` — as on desktop.)

### End-to-end — ✅ a full extension actually works

The strongest result isn't any single API; it's that a complete, real extension
ran end to end on the phone:

1. the content script injected on an ordinary web page and built its overlay;
2. it handed off to the **offscreen document**, which opened a WebSocket to a
   local server (reached over an `adb reverse` loopback tunnel);
3. the server saw the connection (`clients 0 → 1`);
4. the face took ownership and the overlay **rendered visibly** on the page
   (`host = visible`, actively drawing) — a translucent panel over the site,
   mounted entirely by the extension.

No CDP injection, no CSP bypass — the genuine extension architecture (content
script + service worker + offscreen socket) works on Edge Android.

![The dogsh extension overlay (note the `zsh` tab) rendered by the extension's
own content script over an ordinary web page on Edge for Android](./edge-android-overlay.png)

## Practical gotchas (beyond the zombie socket)

- **An unconfigured extension looks identical to a broken one.** Ours injects a
  hidden overlay that only reveals once it connects and owns. Before it had a
  server URL configured, it was present-but-invisible on every page — easy to
  misread as "not running."
- **Background/locked tabs freeze.** A page that isn't foreground reports
  `visibilityState: hidden`; mobile throttles its timers/rAF, so anything that
  waits on `setTimeout` stalls and rendering pauses. Drive foreground tabs.
- **Edge Canary auto-updates mid-session** (we saw `4168 → 4173` during the
  run), which restarts the browser and drops your CDP socket. Re-resolve it.

## Reproduce it

Requirements: an authorized `adb` device, Edge Canary with "Android extensions"
enabled, a sideloaded MV3 `.crx`.

1. Enable `edge://flags` → *Android extensions*; install your `.crx` via
   Settings → About (tap build 5×) → Developer options → *Extension install by
   crx*.
2. Resolve the **live** devtools socket (see the gotcha) and
   `adb forward tcp:9222 localabstract:<socket>`.
3. Enumerate + attach with CDP; evaluate an API probe (e.g.
   `Object.keys(chrome)` and `typeof chrome.<api>`) in the service worker, a
   content-script isolated world, and an extension page.

## Bottom line

For a sideloaded MV3 extension on Edge Canary for Android (Chromium 152), the
core platform is real and usable: **content scripts, the service worker,
offscreen documents, `chrome-extension://` pages, and `scripting` / `storage` /
`tabs` / `offscreen` all work.** Missing pieces to plan around:
`declarativeNetRequest`, `webRequest`, `alarms`, `webNavigation`. The biggest
risk to your sanity isn't the platform — it's the zombie DevTools socket
convincing you nothing runs. Select the live socket and measure; don't assume.
