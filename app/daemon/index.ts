// dogsh daemon — the terminal's real home. Owns the sessions (pty + headless
// mirror each), the WebSocket fan-out, and the handoff choreography. Faces
// (native window, tab overlays) and the native HOST (the Electron app's main
// process, which moves real windows around) are all just ws clients.
//
// Runs under Electron-as-Node (ELECTRON_RUN_AS_NODE=1) because node-pty in
// app/node_modules is built against Electron's ABI. No Electron APIs are
// used here — kill the app and the shells keep running; relaunch and every
// face reattaches to the live sessions via snapshot.
import { WebSocketServer, WebSocket } from 'ws';

import CONFIG from '../shared/config.js';
import { Session } from './session.js';
import { Arbiter, GHOST_GRACE_MS } from './arbiter.js';

const SMOKE = process.argv.includes('--smoke');
// DOGSH_PORT overrides the daemon port. The e2e suite uses this so a test
// daemon can NEVER be reached by the user's real extension (which retries
// the default port every 2s — during one test run it attached the user's
// live Chrome to the test session and typed escape codes at them).
const PORT = Number(process.env.DOGSH_PORT) || CONFIG.port;

// ---------------------------------------------------------------------------
// Clients. surface: 'native' | 'tab' are FACES (they render the terminal);
// 'native-host' is the Electron main process (it renders nothing — it moves,
// shows, hides, and barks real windows on the daemon's behalf).
// ---------------------------------------------------------------------------
interface Client {
  surface: DogshSurface;
  id: number;
  proto: number;
  caps: DogshCaps;
  meta: { href: string | null };
  ws: WebSocket;
  lagging?: boolean;
  laggingSince?: number;
}

const clients = new Map<WebSocket, Client>();
let nextClientId = 1;

function send(ws: WebSocket, msg: DogshDaemonMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastFaces(msg: DogshDaemonMsg): void {
  const raw = JSON.stringify(msg);
  for (const [ws, c] of clients) {
    if (c.surface !== 'native-host' && ws.readyState === ws.OPEN) ws.send(raw);
  }
}
function nativeHost(): Client | null {
  for (const c of clients.values()) if (c.surface === 'native-host') return c;
  return null;
}

// ---------------------------------------------------------------------------
// Ownership. The arbiter derives the owner from raw {visible,focused} levels
// (see arbiter.ts for the design and daemon/sim.ts for its executable
// contract). The daemon's job here is plumbing: feed signals in, broadcast
// derived owner-state out — on every change, and on a 2s re-assert tick.
// ---------------------------------------------------------------------------
const arbiter = new Arbiter({
  ownerChanged(prev, next) {
    // The terminal is now sized for whoever owns it...
    applyOwnerGrid();
    // ...and every client (faces AND host) re-renders from the new state.
    // prevOwner lets the involved faces choose a flight over an instant cut.
    broadcastOwnerState(prev);
  },
  bark() {
    const host = nativeHost();
    if (host) send(host.ws, { type: 'bark' });
  },
  scheduleGhostExpiry(faceKey) {
    // The owning face's socket dropped. If it was a bridge blip (MV3 killed
    // the extension service worker), the face reconnects within the grace
    // and adopts its row; if the tab really closed, this expiry fires and
    // rule 4 brings the terminal home.
    setTimeout(() => arbiter.expireGhost(faceKey), GHOST_GRACE_MS);
  },
});

function ownerStateMsg(prev?: DogshOwner): DogshDaemonMsg {
  return {
    type: 'owner-state',
    owner: arbiter.owner,
    gen: arbiter.generation,
    prevOwner: prev === undefined ? arbiter.owner : prev,
    doghouse: arbiter.doghouse,
    nativeBounds: arbiter.nativeBounds,
  };
}

function broadcastOwnerState(prev?: DogshOwner): void {
  const raw = JSON.stringify(ownerStateMsg(prev));
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

// ---------------------------------------------------------------------------
// Sessions. Up to MAX_SESSIONS real shells; exactly one is ACTIVE — the one
// every face displays (the terminal is one object with tabs, not N loose
// terminals; a tab switch on any face switches everywhere, like the terminal
// itself following you does). Non-active sessions keep running and keep
// mirroring; switching to one is a snapshot write, same as any attach.
// ---------------------------------------------------------------------------
const MAX_SESSIONS = 2;
const sessions = new Map<number, Session>();
let nextSessionId = 1;
let activeSessionId: number | null = null;

function sessionList(): DogshSessionListMsg {
  return {
    type: 'session-list',
    sessions: [...sessions.values()].map((s) => ({ id: s.id, title: s.title })),
    active: activeSessionId,
    max: MAX_SESSIONS,
  };
}
function broadcastSessionList(): void {
  broadcastFaces(sessionList());
}

function snapshotMsg(s: Session): DogshDaemonMsg {
  return {
    type: 'snapshot',
    sessionId: s.id,
    data: s.snapshot(),
    cols: s.cols,
    rows: s.rows,
  };
}

function createSession(): Session | null {
  if (sessions.size >= MAX_SESSIONS) return null;
  const id = nextSessionId++;
  const s = new Session({ id });
  sessions.set(id, s);
  s.onData((data) => {
    // Only the active session streams to faces (they render one buffer);
    // background sessions accumulate in their own mirror and are replayed
    // as a snapshot on switch.
    if (id === activeSessionId) streamToFaces({ type: 'data', sessionId: id, data });
  });
  s.onTitle(() => broadcastSessionList());
  s.onExit((exitCode) => {
    sessions.delete(id);
    broadcastFaces({ type: 'session-exit', sessionId: id, exitCode });
    if (sessions.size === 0) {
      // Last shell died. Exit rather than linger with nothing to serve:
      // under launchd (KeepAlive) a fresh daemon — fresh shell — comes up
      // and every face reconnects to it; in dev the host respawns us.
      setTimeout(() => process.exit(0), 300);
      return;
    }
    if (id === activeSessionId) {
      // The tab the user was looking at died; show the survivor.
      activateSession([...sessions.keys()][0]);
    } else {
      broadcastSessionList();
    }
  });
  return s;
}

function activeSession(): Session | null {
  return (activeSessionId != null && sessions.get(activeSessionId)) || null;
}

// Make a session the one every face displays: size it for the current owner
// first (it may have been created/parked under a different grid), then
// bring every face to its exact state with one snapshot.
function activateSession(id: number): void {
  const s = sessions.get(id);
  if (!s || id === activeSessionId) return;
  activeSessionId = id;
  applyOwnerGrid();
  broadcastSessionList();
  broadcastFaces(snapshotMsg(s));
}

// Session-scoped face messages carry sessionId; a message aimed at a session
// that is not the ACTIVE one is DROPPED, not misdelivered — it was sent by a
// face whose view of the world is stale (mid-switch, mid-reconnect), and the
// active session is the only one a user can be addressing.
function forActiveSession(msg: { sessionId?: number | null }): boolean {
  return msg.sessionId == null || msg.sessionId === activeSessionId;
}

// Durable clear (Cmd+K / context menu on any face): wipes scrollback in the
// active session's mirror — so future snapshots are clean — and on every
// attached face at once. The terminal is one object; "clear" can't mean
// "clear this face only".
function clearEverywhere(): void {
  const s = activeSession();
  if (!s) return;
  s.clear();
  broadcastFaces({ type: 'clear', sessionId: s.id });
}

// ---------------------------------------------------------------------------
// Dynamic grid: owner drives size. Exactly one face is visible at a time, so
// the active pty always matches the VISIBLE face's grid — no tmux-style
// smallest-common-client compromise. On handoff (or when the owning face
// updates its caps) the active session resizes and every face is told the
// new grid; faces that were hidden during the change resync via snapshot.
// ---------------------------------------------------------------------------
function ownerFace(): Client | null {
  if (arbiter.owner === 'native') {
    for (const c of clients.values()) if (c.surface === 'native') return c;
    return null;
  }
  for (const c of clients.values()) if (c.id === arbiter.owner) return c;
  return null;
}

function applyOwnerGrid(): void {
  const face = ownerFace();
  const s = activeSession();
  if (!face || !s) return; // owner face not attached (e.g. app quit) — keep the grid
  if (s.resize(face.caps.cols, face.caps.rows)) {
    broadcastFaces({ type: 'grid', sessionId: s.id, cols: s.cols, rows: s.rows });
  }
}

// ---------------------------------------------------------------------------
// Per-client backpressure. A `yes`/`cat bigfile` flood is megabytes per
// second; a face that can't drain (background-throttled tab, flaky socket)
// would otherwise buffer it all in daemon memory — and one bad face must
// never be able to bloat or stall the daemon that every OTHER face depends
// on. So high-volume 'data' frames stop flowing to a face whose socket
// backs up past the high-water mark; when it drains, ONE fresh snapshot
// from the mirror replaces everything it missed (cheaper than the backlog,
// and pixel-exact by construction). Small control frames (reveal/hide/
// grid/owner-state) always flow — they are what keeps handoffs honest.
// ---------------------------------------------------------------------------
const LAG_HIGH_WATER = 1.5 * 1024 * 1024; // stop streaming above this
const LAG_LOW_WATER = 128 * 1024; //         resync + resume below this
const LAG_ZOMBIE_MS = 20000; //              stuck this long -> cut the socket

function streamToFaces(msg: DogshDaemonMsg): void {
  const raw = JSON.stringify(msg);
  for (const [ws, c] of clients) {
    if (c.surface === 'native-host' || ws.readyState !== ws.OPEN) continue;
    if (c.lagging) continue;
    if (ws.bufferedAmount > LAG_HIGH_WATER) {
      c.lagging = true;
      c.laggingSince = Date.now();
      continue;
    }
    ws.send(raw);
  }
}

setInterval(() => {
  for (const [ws, c] of clients) {
    if (!c.lagging || ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount < LAG_LOW_WATER) {
      // Drained. One snapshot of the ACTIVE session brings this face to the
      // present; live streaming resumes right after (send order per socket
      // guarantees the snapshot lands first).
      c.lagging = false;
      c.laggingSince = 0;
      const s = activeSession();
      if (s) send(ws, snapshotMsg(s));
    } else if (Date.now() - (c.laggingSince || 0) > LAG_ZOMBIE_MS) {
      // Not draining at all: a dead peer behind a socket the TCP stack
      // hasn't given up on. Cut it — a live face will reconnect and get a
      // fresh snapshot; a dead one stops holding buffer memory.
      ws.terminate();
    }
  }
}, 250);

// The first session exists before the first client ever connects. (Creation
// cannot hit the MAX_SESSIONS cap here — the map is empty.)
activeSessionId = createSession()!.id;

// ---------------------------------------------------------------------------
// Server.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('listening', () => {
  console.log(`[dogshd] listening on ws://127.0.0.1:${PORT} (pid ${process.pid})`);
  if (SMOKE) runSmokeTest();
});
wss.on('error', (err: NodeJS.ErrnoException) => {
  if (err && err.code === 'EADDRINUSE') {
    if (SMOKE) {
      // A smoke run must test THIS daemon, not silently defer to another.
      console.error(`[smoke] FAIL: port ${PORT} already in use — stop the running daemon first`);
      process.exit(1);
    }
    // Another daemon already owns the port — we're redundant, not broken.
    console.log(`[dogshd] port ${PORT} already served; exiting`);
    process.exit(0);
  }
  console.error('[dogshd] server error:', err);
  process.exit(1);
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg: DogshClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(ws, msg);
  });
  ws.on('close', () => {
    const client = clients.get(ws);
    clients.delete(ws);
    if (!client) return;
    if (client.surface === 'native-host') arbiter.detachHost();
    else if (client.surface === 'tab') arbiter.detachTab(client.id);
    // 'native' faces are not in the ledger (the HOST speaks for the real
    // window); their disappearance is grid-relevant only.
  });
});

function handleMessage(ws: WebSocket, msg: DogshClientMsg): void {
  const client = clients.get(ws);
  switch (msg.type) {
    case 'hello': {
      const surface: DogshSurface =
        msg.surface === 'native' || msg.surface === 'native-host' ? msg.surface : 'tab';
      const c: Client = {
        surface,
        id: nextClientId++,
        proto: (msg.proto || 0) | 0,
        // Capabilities: what grid this face can render (feeds dynamic
        // resize), and whether it can reflow to arbitrary grids at all.
        caps: {
          cols: Number(msg.caps && msg.caps.cols) || CONFIG.cols,
          rows: Number(msg.caps && msg.caps.rows) || CONFIG.rows,
          canResize: !!(msg.caps && msg.caps.canResize),
        },
        meta: { href: msg.href || null },
        ws,
      };
      if (surface === 'native-host') {
        // One host at a time; a second hello means the app restarted and the
        // stale socket just hasn't closed yet.
        const old = nativeHost();
        if (old) clients.delete(old.ws);
        clients.set(ws, c);
        // Sync host-owned UI state so a relaunched app agrees with reality,
        // then enter the ledger (baseline levels; may re-derive ownership).
        send(ws, { type: 'doghouse-changed', on: arbiter.doghouse });
        send(ws, ownerStateMsg());
        arbiter.attachHost(msg.sig);
        break;
      }
      // Faces: register first (so any owner-state broadcast the attach
      // triggers reaches this socket too), then ack (identity + attachment),
      // then the tab strip, then the active session's snapshot, then live
      // data — ws.send is ordered per socket, so a face always knows WHO it
      // is and WHAT it's attached to before content or ownership news
      // arrives.
      clients.set(ws, c);
      send(ws, {
        type: 'hello-ack',
        clientId: c.id,
        sessionId: activeSessionId,
        ...arbiter.ownerState(),
        doghouse: arbiter.doghouse,
      });
      send(ws, sessionList());
      const s = activeSession();
      if (s) send(ws, snapshotMsg(s));
      if (surface === 'tab') {
        // Ledger entry. faceKey makes the face durable across bridge blips
        // (reconnect = same face, new socket); a keyless client gets a
        // per-socket key — each connection is its own face, no adoption.
        const faceKey =
          typeof msg.faceKey === 'string' && msg.faceKey ? msg.faceKey : `anon-${c.id}`;
        arbiter.attachTab(c.id, faceKey, msg.sig);
      }
      // 'native' faces are pure renderers; the HOST speaks for the window.
      // Stale-face detection: a face built against an older protocol still
      // "works" enough to look connected while missing fixes/UI — the classic
      // "rebuilt dist/ but never hit Reload at chrome://extensions". Warn
      // inside that client's terminal (client-local write; it is NOT in the
      // mirror, so other faces and future snapshots are unaffected).
      if (c.proto !== CONFIG.protocolVersion) {
        send(ws, { type: 'stale', expected: CONFIG.protocolVersion, got: c.proto });
        send(ws, {
          type: 'data',
          data:
            `\r\n\x1b[30;43m dogsh: this ${c.surface} face is outdated ` +
            `(v${c.proto || '?'}, daemon v${CONFIG.protocolVersion}). ` +
            (c.surface === 'tab'
              ? 'Reload the extension at chrome://extensions, then reload this page. '
              : 'Restart the dogsh app. ') +
            `\x1b[0m\r\n`,
        });
      }
      break;
    }
    case 'input': {
      const s = activeSession();
      if (s && forActiveSession(msg)) s.write(msg.data);
      break;
    }
    case 'clear':
      if (forActiveSession(msg)) clearEverywhere();
      break;
    case 'caps':
      // A face's renderable grid changed (window resized, zoom changed).
      // Recorded always; acted on only if that face currently owns the
      // terminal — hidden faces resync via snapshot when they're revealed.
      if (client && client.surface !== 'native-host' && msg.caps) {
        if (Number(msg.caps.cols)) client.caps.cols = Number(msg.caps.cols);
        if (Number(msg.caps.rows)) client.caps.rows = Number(msg.caps.rows);
        if (typeof msg.caps.canResize === 'boolean') client.caps.canResize = msg.caps.canResize;
        const face = ownerFace();
        if (face && face.id === client.id) applyOwnerGrid();
      }
      break;
    case 'session-create': {
      if (!client || client.surface === 'native-host') break;
      const s = createSession();
      if (!s) {
        broadcastSessionList(); // face asked past the cap; re-sync its strip
        break;
      }
      // A new tab focuses, like every terminal the user has ever used.
      activateSession(s.id);
      break;
    }
    case 'session-switch':
      if (!client || client.surface === 'native-host') break;
      activateSession(Number(msg.sessionId));
      break;
    case 'session-close': {
      if (!client || client.surface === 'native-host') break;
      const s = sessions.get(Number(msg.sessionId));
      // kill() fires the pty exit handler, which owns removal, activation
      // of the survivor, and the last-session daemon-exit path.
      if (s) s.kill();
      break;
    }
    case 'signal':
      // Raw visibility facts (v6). The arbiter derives ownership; nobody
      // claims anything.
      if (!client) break;
      if (client.surface === 'native-host') arbiter.signalHost(msg);
      else if (client.surface === 'tab') arbiter.signalTab(client.id, msg);
      break;
    case 'native-bounds':
      // Host reports where the real window sits — fly-in origin / fly-out
      // target for overlay flights.
      if (client && client.surface === 'native-host' && msg.bounds) {
        arbiter.nativeBounds = msg.bounds;
      }
      break;
    case 'measure':
      // Native renderer reports the pixel size of the fixed terminal grid;
      // the HOST owns the window, so forward for it to shrink-wrap.
      if (client && client.surface === 'native') {
        const host = nativeHost();
        if (host) send(host.ws, { type: 'set-content-size', w: msg.w, h: msg.h });
      }
      break;
    case 'doghouse':
      if (client && client.surface === 'native-host') {
        arbiter.setDoghouse(!!msg.on);
        // Echo back as the single source of truth; the host animates only on
        // this confirmation, never on its own optimistic state.
        send(ws, { type: 'doghouse-changed', on: arbiter.doghouse });
      }
      break;
    case 'debug':
      // Test-only control channel (e2e cannot synthesize OS-level app focus).
      if (process.env.DOGSH_DEBUG === '1' && msg.action === 'state') {
        send(ws, {
          type: 'debug-state',
          owner: arbiter.owner,
          gen: arbiter.generation,
          doghouse: arbiter.doghouse,
          barkCount: arbiter.barkCount,
          // The signal ledger the owner is derived from.
          ledger: arbiter.debugLedger(),
          sessions: [...sessions.values()].map((s) => ({
            id: s.id,
            title: s.title,
            cols: s.cols,
            rows: s.rows,
          })),
          activeSessionId,
          clients: [...clients.values()].map((c) => ({
            id: c.id,
            surface: c.surface,
            proto: c.proto,
            caps: c.caps,
            href: c.meta.href,
            lagging: !!c.lagging,
            buffered: c.ws.bufferedAmount,
          })),
          // Arbitration journal (bounded, oldest first): the sequence of
          // signals/grants that produced the current owner. `at` is daemon
          // wall-clock ms.
          journal: arbiter.journal,
        });
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Ownership re-assert. owner-state pushes can be lost across reconnect
// windows (face reattaches right as ownership changes). A periodic re-assert
// of the same derived state lets every client self-correct its DISPLAY —
// faces render from it, they never react to it with reports (that feedback
// loop was the old self-heal metronome). prevOwner === owner marks it as a
// re-assert, so nobody replays a flight.
// ---------------------------------------------------------------------------
setInterval(() => broadcastOwnerState(), 2000);

// ---------------------------------------------------------------------------
// Smoke mode: verifies (1) WS server up, (2) a real command runs in the real
// pty and its output round-trips through the headless mirror. Output-gated:
// prints SMOKE PASS only after observing expected bytes (never exit-code-only).
// ---------------------------------------------------------------------------
function runSmokeTest(): void {
  const MARKER = '__DOGSH_SMOKE_OK__';
  const s = activeSession();
  if (!s) {
    console.error('[smoke] FAIL: no active session');
    process.exit(1);
  }
  let sawMarker = false;
  const timeout = setTimeout(() => {
    console.error('[smoke] FAIL: marker not observed within 20s');
    process.exit(1);
  }, 20000);

  s.onData((data) => {
    if (s.id === activeSessionId) streamToFaces({ type: 'data', sessionId: s.id, data });
    if (sawMarker || !data.includes(MARKER)) return;
    sawMarker = true;
    // Confirm the mirror captured it too (snapshot path works).
    setTimeout(() => {
      clearTimeout(timeout);
      if (s.snapshot().includes(MARKER)) {
        console.log(`[smoke] PASS: pty roundtrip + mirror snapshot OK (ws://127.0.0.1:${PORT})`);
        process.exit(0);
      }
      console.error('[smoke] FAIL: marker seen on pty but missing from mirror snapshot');
      process.exit(1);
    }, 250);
  });

  setTimeout(() => s.write(`echo ${MARKER}\r`), 1200);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
