// dogsh daemon — the Session Host. Owns session mux (shell backends +
// persistence), the face WebSocket gateway, and the lease arbiter. Faces
// (native window, tab overlays) and the native HOST (Electron main) are
// thin WS clients — they never own shell lifetime.
//
// See ARCHITECTURE.md for the relocatable host / hot-potato model.
//
// Runs under Electron-as-Node (ELECTRON_RUN_AS_NODE=1) because node-pty in
// app/node_modules is built against Electron's ABI. No Electron APIs are
// used here — kill the app and the shells keep running; relaunch and every
// face reattaches to the live sessions via snapshot.
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';

import CONFIG from '../shared/config.js';
import { LeaseEngine, GHOST_GRACE_MS } from './lease-engine.js';
import { SessionMux, MAX_SESSIONS } from './session-mux.js';
import { handleRequest } from './serve.js';
import { flickerLog, FLICKER_LOG, startFlickerFlush } from './flicker-log.js';
import {
  createSignalCoalescer,
  leaseRoleFor,
  applyCaps,
  applySignal,
  applyInput,
  type FaceClient,
} from './face-gateway.js';
import type { SessionHostBundle } from './persist.js';

const SMOKE = process.argv.includes('--smoke');
const PORT = Number(process.env.DOGSH_PORT) || CONFIG.port;

const BIND = process.env.DOGSH_BIND || '127.0.0.1';
const TOKEN = process.env.DOGSH_TOKEN || '';
const TLS_CERT = process.env.DOGSH_TLS_CERT || '';
const TLS_KEY = process.env.DOGSH_TLS_KEY || '';

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
const BIND_IS_LOOPBACK = isLoopback(BIND) || BIND === 'localhost';
if (!BIND_IS_LOOPBACK && !TOKEN) {
  console.error(
    `[dogshd] refusing to bind ${BIND} without DOGSH_TOKEN — ` +
      'a non-loopback daemon without auth is an open shell on your network'
  );
  process.exit(1);
}

function tokenOk(presented: unknown): boolean {
  if (typeof presented !== 'string' || !TOKEN) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Face gateway clients
// ---------------------------------------------------------------------------
type Client = FaceClient;

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
function broadcastAll(msg: DogshDaemonMsg): void {
  const raw = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}
function nativeHost(): Client | null {
  for (const c of clients.values()) if (c.surface === 'native-host') return c;
  return null;
}

// ---------------------------------------------------------------------------
// Lease engine (input / display authority — instant, no grant-hold)
// ---------------------------------------------------------------------------
let lastBroadcastCause: DogshLeaseCause = 'attach';
const arbiter = new LeaseEngine({
  ownerChanged(prev, next) {
    lastBroadcastCause = arbiter.lastCause;
    flickerLog('GRANT', `${prev} -> ${next} cause=${arbiter.lastCause}`);
    if (arbiter.howl.maxGrantBurst >= 8) {
      flickerLog('howl', `maxGrantBurst=${arbiter.howl.maxGrantBurst} grants=${arbiter.howl.grants}`);
    }
    applyOwnerGrid();
    broadcastOwnerState(prev, arbiter.lastCause);
  },
  bark() {
    const host = nativeHost();
    if (host) send(host.ws, { type: 'bark' });
  },
  scheduleGhostExpiry(faceKey) {
    setTimeout(() => arbiter.expireGhost(faceKey), GHOST_GRACE_MS);
  },
  trace(ev, who, note) {
    flickerLog(ev, `${who ?? ''}${note ? ` ${note}` : ''}`.trim());
  },
});

startFlickerFlush(100);
flickerLog('daemon', `listening soon on ${BIND}:${PORT} log=${FLICKER_LOG}`);

function leaseRoleForClient(c: Client): DogshLeaseRole {
  return leaseRoleFor(arbiter, c);
}

function ownerStateMsg(
  c: Client,
  prev?: DogshOwner,
  cause: DogshLeaseCause = lastBroadcastCause
): DogshDaemonMsg {
  return {
    type: 'owner-state',
    owner: arbiter.owner,
    gen: arbiter.generation,
    prevOwner: prev === undefined ? arbiter.owner : prev,
    doghouse: arbiter.doghouse,
    nativeBounds: arbiter.nativeBounds,
    leaseRole: leaseRoleForClient(c),
    cause,
  };
}

function broadcastOwnerState(prev?: DogshOwner, cause: DogshLeaseCause = 'reassert'): void {
  lastBroadcastCause = cause;
  for (const [ws, c] of clients) {
    if (ws.readyState === ws.OPEN) send(ws, ownerStateMsg(c, prev, cause));
  }
}

// Uplink coalesce: last {v,f} per client within ~16ms, then one derive path.
const signalCoalesce = createSignalCoalescer();

// ---------------------------------------------------------------------------
// Session mux (shell backends + host fence / export-import)
// ---------------------------------------------------------------------------
const mux = new SessionMux({
  onSessionData(sessionId, data) {
    if (sessionId === mux.activeSessionId) {
      streamToFaces({ type: 'data', sessionId, data });
    }
  },
  onSessionTitle() {
    broadcastSessionList();
  },
  onSessionExit(sessionId, exitCode) {
    broadcastFaces({ type: 'session-exit', sessionId, exitCode });
    if (mux.sessions.size > 0) broadcastSessionList();
  },
  onActiveChanged() {
    applyOwnerGrid();
    broadcastSessionList();
    const s = mux.activeSession();
    if (s) broadcastFaces(snapshotMsg(s));
  },
  onFenced(redirectUrl) {
    broadcastAll({
      type: 'host-fenced',
      hostGeneration: mux.hostGeneration,
      redirectUrl,
    });
  },
});

function sessionList(): DogshSessionListMsg {
  return {
    type: 'session-list',
    sessions: [...mux.sessions.values()].map((s) => ({ id: s.id, title: s.title })),
    active: mux.activeSessionId,
    max: MAX_SESSIONS,
  };
}
function broadcastSessionList(): void {
  broadcastFaces(sessionList());
}

function snapshotMsg(s: { id: number; snapshot(): string; cols: number; rows: number }): DogshDaemonMsg {
  return {
    type: 'snapshot',
    sessionId: s.id,
    data: s.snapshot(),
    cols: s.cols,
    rows: s.rows,
  };
}

function forActiveSession(msg: { sessionId?: number | null }): boolean {
  return msg.sessionId == null || msg.sessionId === mux.activeSessionId;
}

function clearEverywhere(): void {
  const s = mux.activeSession();
  if (!s) return;
  s.clear();
  broadcastFaces({ type: 'clear', sessionId: s.id });
}

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
  const s = mux.activeSession();
  if (!face || !s) return;
  if (s.resize(face.caps.cols, face.caps.rows)) {
    broadcastFaces({ type: 'grid', sessionId: s.id, cols: s.cols, rows: s.rows });
    scheduleResizeSettle();
  }
}

let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleResizeSettle(): void {
  if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
  resizeSettleTimer = setTimeout(() => {
    resizeSettleTimer = null;
    const s = mux.activeSession();
    const owner = ownerFace();
    if (!s) return;
    const raw = JSON.stringify(snapshotMsg(s));
    for (const [ws, c] of clients) {
      if (c.surface === 'native-host' || ws.readyState !== ws.OPEN) continue;
      if (owner && c.id === owner.id) continue;
      ws.send(raw);
    }
  }, 300);
}

const LAG_HIGH_WATER = 1.5 * 1024 * 1024;
const LAG_LOW_WATER = 128 * 1024;
const LAG_ZOMBIE_MS = Number(process.env.DOGSH_LAG_ZOMBIE_MS) || 20000;

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
      c.lagging = false;
      c.laggingSince = 0;
      const s = mux.activeSession();
      if (s) send(ws, snapshotMsg(s));
    } else if (Date.now() - (c.laggingSince || 0) > LAG_ZOMBIE_MS) {
      ws.terminate();
    }
  }
}, 250);

mux.bootstrap({ smoke: SMOKE });

const SAVE_MS = Number(process.env.DOGSH_SAVE_MS) || 3000;
setInterval(() => mux.saveDirtySessions(), SAVE_MS);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server =
  TLS_CERT && TLS_KEY
    ? https.createServer(
        { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
        handleRequest
      )
    : http.createServer(handleRequest);
const wss = new WebSocketServer({ server });
server.on('listening', () => {
  const scheme = TLS_CERT && TLS_KEY ? 'wss' : 'ws';
  console.log(
    `[dogshd] listening on ${scheme}://${BIND}:${PORT} (pid ${process.pid}` +
      ` gen=${mux.hostGeneration}${mux.fenced ? ' FENCED' : ''})`
  );
  if (SMOKE) runSmokeTest();
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err && err.code === 'EADDRINUSE') {
    if (SMOKE) {
      console.error(`[smoke] FAIL: port ${PORT} already in use — stop the running daemon first`);
      process.exit(1);
    }
    console.log(`[dogshd] port ${PORT} already served; exiting`);
    process.exit(0);
  }
  console.error('[dogshd] server error:', err);
  process.exit(1);
});
server.listen(PORT, BIND);

const HEARTBEAT_MS = Number(process.env.DOGSH_HEARTBEAT_MS) || 10000;
type LiveWs = WebSocket & { isAlive?: boolean; remote?: boolean };
setInterval(() => {
  for (const ws of wss.clients as Set<LiveWs>) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket mid-close */
    }
  }
}, HEARTBEAT_MS);

wss.on('connection', (ws: LiveWs, req) => {
  ws.isAlive = true;
  ws.remote = !isLoopback(req.socket.remoteAddress);
  ws.on('pong', () => {
    ws.isAlive = true;
  });
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
  });
});

function hostAdminOk(ws: WebSocket): boolean {
  // Hot-potato admin: loopback only (same trust as debug channel).
  return !(ws as LiveWs).remote;
}

function handleMessage(ws: WebSocket, msg: DogshClientMsg): void {
  const client = clients.get(ws);
  const debugOk = msg.type === 'debug' && !(ws as LiveWs).remote;
  const hostAdmin =
    (msg.type === 'host-export' || msg.type === 'host-fence' || msg.type === 'host-import') &&
    hostAdminOk(ws);
  if (!client && msg.type !== 'hello' && !debugOk && !hostAdmin) return;

  switch (msg.type) {
    case 'hello': {
      const remote = !!(ws as LiveWs).remote;
      if (remote && !tokenOk(msg.token)) {
        console.log('[dogshd] remote hello rejected (bad token)');
        ws.close(4401, 'dogsh: bad or missing token');
        return;
      }
      const surface: DogshSurface = remote
        ? 'tab'
        : msg.surface === 'native' || msg.surface === 'native-host'
          ? msg.surface
          : 'tab';
      const c: Client = {
        surface,
        id: nextClientId++,
        proto: (msg.proto || 0) | 0,
        caps: {
          cols: Number(msg.caps && msg.caps.cols) || CONFIG.cols,
          rows: Number(msg.caps && msg.caps.rows) || CONFIG.rows,
          canResize: !!(msg.caps && msg.caps.canResize),
        },
        meta: { href: msg.href || null },
        ws,
        remote,
      };
      if (surface === 'native-host') {
        const old = nativeHost();
        if (old) clients.delete(old.ws);
        clients.set(ws, c);
        send(ws, { type: 'doghouse-changed', on: arbiter.doghouse });
        send(ws, ownerStateMsg(c, undefined, 'attach'));
        arbiter.attachHost(msg.sig);
        break;
      }
      clients.set(ws, c);
      send(ws, {
        type: 'hello-ack',
        clientId: c.id,
        sessionId: mux.activeSessionId,
        ...arbiter.ownerState(),
        doghouse: arbiter.doghouse,
        remote: c.remote,
        hostGeneration: mux.hostGeneration,
        fenced: mux.fenced,
        redirectUrl: mux.redirectUrl,
        leaseRole: leaseRoleForClient(c),
      });
      send(ws, sessionList());
      const s = mux.activeSession();
      if (s) send(ws, snapshotMsg(s));
      if (mux.fenced) {
        send(ws, {
          type: 'host-fenced',
          hostGeneration: mux.hostGeneration,
          redirectUrl: mux.redirectUrl,
        });
      }
      if (surface === 'tab') {
        const faceKey =
          typeof msg.faceKey === 'string' && msg.faceKey ? msg.faceKey : `anon-${c.id}`;
        arbiter.attachTab(c.id, faceKey, msg.sig, c.remote);
      }
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
      if (!client || client.surface === 'native-host') break;
      const raw = typeof msg.data === 'string' ? msg.data : '';
      applyInput(
        arbiter,
        mux,
        client,
        raw,
        forActiveSession(msg),
        (data) => {
          const s = mux.activeSession();
          if (s) s.write(data);
        },
        (dropped, shown, len) => {
          flickerLog(
            'input',
            `id=${client.id} ${client.surface}${client.remote ? '/remote' : ''}` +
              `${dropped ? ' DROPPED' : ''} len=${len} data=${shown}`
          );
        }
      );
      break;
    }
    case 'clear':
      if (mux.acceptsInput() && forActiveSession(msg)) clearEverywhere();
      break;
    case 'caps':
      if (client && client.surface !== 'native-host' && msg.caps) {
        applyCaps(client, msg.caps, (c) => {
          const face = ownerFace();
          if (face && face.id === c.id) applyOwnerGrid();
        });
      }
      break;
    case 'session-create': {
      if (!client || client.surface === 'native-host' || !mux.acceptsInput()) break;
      const s = mux.createSession();
      if (!s) {
        broadcastSessionList();
        break;
      }
      mux.activateSession(s.id);
      break;
    }
    case 'session-switch':
      if (!client || client.surface === 'native-host' || !mux.acceptsInput()) break;
      mux.activateSession(Number(msg.sessionId));
      break;
    case 'session-close': {
      if (!client || client.surface === 'native-host' || !mux.acceptsInput()) break;
      const s = mux.sessions.get(Number(msg.sessionId));
      if (s) s.kill();
      break;
    }
    case 'signal':
      if (!client) break;
      applySignal(arbiter, signalCoalesce, client, msg);
      break;
    case 'native-bounds':
      if (client && client.surface === 'native-host' && msg.bounds) {
        arbiter.nativeBounds = msg.bounds;
      }
      break;
    case 'measure':
      if (client && client.surface === 'native') {
        const host = nativeHost();
        if (host) send(host.ws, { type: 'set-content-size', w: msg.w, h: msg.h });
      }
      break;
    case 'doghouse':
      if (client && client.surface === 'native-host') {
        arbiter.setDoghouse(!!msg.on);
        send(ws, { type: 'doghouse-changed', on: arbiter.doghouse });
      }
      break;
    case 'trace':
      if (client) {
        const tag = typeof msg.tag === 'string' && msg.tag ? msg.tag : 'face';
        const detail =
          `id=${client.id} ${client.surface}${client.remote ? '/remote' : ''}` +
          (msg.detail ? ` ${msg.detail}` : '');
        flickerLog(tag, detail);
      }
      break;
    case 'host-export': {
      if (!hostAdminOk(ws)) break;
      const bundle = mux.exportBundle();
      send(ws, { type: 'host-bundle', bundle, hostGeneration: mux.hostGeneration });
      break;
    }
    case 'host-fence': {
      if (!hostAdminOk(ws)) break;
      mux.fence(typeof msg.redirectUrl === 'string' ? msg.redirectUrl : null);
      break;
    }
    case 'host-import': {
      if (!hostAdminOk(ws)) break;
      const bundle = msg.bundle as SessionHostBundle | undefined;
      const result = mux.importBundle(bundle as SessionHostBundle);
      if (!result.ok) {
        send(ws, { type: 'debug-state', error: result.error });
        break;
      }
      send(ws, {
        type: 'host-imported',
        hostGeneration: mux.hostGeneration,
        activeSessionId: mux.activeSessionId,
      });
      broadcastSessionList();
      const s = mux.activeSession();
      if (s) broadcastFaces(snapshotMsg(s));
      broadcastOwnerState(undefined, 'import');
      break;
    }
    case 'debug':
      if (process.env.DOGSH_DEBUG === '1' && msg.action === 'state' && !(ws as LiveWs).remote) {
        send(ws, {
          type: 'debug-state',
          owner: arbiter.owner,
          gen: arbiter.generation,
          doghouse: arbiter.doghouse,
          barkCount: arbiter.barkCount,
          hostGeneration: mux.hostGeneration,
          fenced: mux.fenced,
          redirectUrl: mux.redirectUrl,
          shellBackend: process.env.DOGSH_SHELL_BACKEND || 'pty',
          lastCause: arbiter.lastCause,
          howl: { ...arbiter.howl },
          ledger: arbiter.debugLedger(),
          rss: process.memoryUsage().rss,
          sessions: [...mux.sessions.values()].map((s) => ({
            id: s.id,
            kind: s.kind,
            title: s.title,
            cols: s.cols,
            rows: s.rows,
            flow: s.flow(),
          })),
          activeSessionId: mux.activeSessionId,
          clients: [...clients.values()].map((c) => ({
            id: c.id,
            surface: c.surface,
            proto: c.proto,
            caps: c.caps,
            href: c.meta.href,
            remote: c.remote,
            leaseRole: leaseRoleForClient(c),
            lagging: !!c.lagging,
            buffered: c.ws.bufferedAmount,
          })),
          journal: arbiter.journal,
        });
      }
      break;
  }
}

setInterval(() => broadcastOwnerState(undefined, 'reassert'), 2000);

function runSmokeTest(): void {
  const MARKER = '__DOGSH_SMOKE_OK__';
  const s = mux.activeSession();
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
    if (s.id === mux.activeSessionId) streamToFaces({ type: 'data', sessionId: s.id, data });
    if (sawMarker || !data.includes(MARKER)) return;
    sawMarker = true;
    // Wait until the headless mirror has the marker (parse is async), then
    // prove the hot-potato path preserves it.
    const tryPotato = (attempt: number): void => {
      if (!s.snapshot().includes(MARKER)) {
        if (attempt > 40) {
          clearTimeout(timeout);
          console.error('[smoke] FAIL: marker never landed in mirror');
          process.exit(1);
        }
        setTimeout(() => tryPotato(attempt + 1), 50);
        return;
      }
      const bundle = mux.exportBundle();
      const beforeGen = mux.hostGeneration;
      const imp = mux.importBundle(bundle);
      if (!imp.ok) {
        clearTimeout(timeout);
        console.error('[smoke] FAIL: host-import rejected:', imp.error);
        process.exit(1);
      }
      if (!(mux.hostGeneration > beforeGen)) {
        clearTimeout(timeout);
        console.error('[smoke] FAIL: hostGeneration did not advance on import');
        process.exit(1);
      }
      // restore() writes the mirror asynchronously — poll until the marker
      // reappears (same honesty as the pre-export wait).
      const waitRestored = (n: number): void => {
        const after = mux.activeSession();
        if (after && after.snapshot().includes(MARKER)) {
          clearTimeout(timeout);
          console.log(
            `[smoke] PASS: pty + mirror + host potato gen ${beforeGen}->${mux.hostGeneration}` +
              ` (ws://127.0.0.1:${PORT})`
          );
          process.exit(0);
        }
        if (n > 40) {
          clearTimeout(timeout);
          console.error('[smoke] FAIL: marker lost across host export/import');
          process.exit(1);
        }
        setTimeout(() => waitRestored(n + 1), 50);
      };
      waitRestored(0);
    };
    setTimeout(() => tryPotato(0), 50);
  });

  setTimeout(() => s.write(`echo ${MARKER}\r`), 1200);
}

process.on('SIGTERM', () => {
  mux.saveDirtySessions();
  process.exit(0);
});
process.on('SIGINT', () => {
  mux.saveDirtySessions();
  process.exit(0);
});
