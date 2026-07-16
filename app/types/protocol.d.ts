// The face/host <-> daemon wire protocol (v6), typed once for every consumer:
// the daemon, the Electron host (main.ts), the native renderer (script-tag
// world), and the extension content script. Ambient on purpose — script-kind
// files (renderer.ts, island.ts) cannot use module imports, and types are
// erased anyway, so globals cost nothing.
//
// v6 is the level-based ownership protocol (see daemon/arbiter.ts):
//   facts in — clients report raw {visible, focused} signals, never claims;
//   state out — the daemon broadcasts derived owner-state, faces render it.
// Gone from the wire: focus/blur claims, reveal/hide commands, claim reasons.
//
// Fields on INCOMING messages are optional wherever the receiving code
// runtime-guards them: this is untrusted JSON off a socket, and the types
// describe what a well-behaved peer sends, not what parse can prove.

type DogshSurface = 'native' | 'tab' | 'native-host';

// 'native' or a tab client id.
type DogshOwner = 'native' | number;

interface DogshRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Raw visibility facts a client reports about itself. For tabs: page
// visibility + OS-level window focus (service-worker informed). For the
// host: window shown + window focused.
interface DogshSig {
  visible?: boolean;
  focused?: boolean;
}

// What grid a face can render; feeds owner-drives-size resizing.
interface DogshCaps {
  cols: number;
  rows: number;
  canResize: boolean;
}

interface DogshSessionInfo {
  id: number;
  title: string;
}

interface DogshSessionListMsg {
  type: 'session-list';
  sessions: DogshSessionInfo[];
  active: number | null;
  max: number;
}

// ---------------------------------------------------------------------------
// Client (face or host) -> daemon
// ---------------------------------------------------------------------------
type DogshClientMsg =
  | {
      type: 'hello';
      surface?: string;
      proto?: number;
      href?: string;
      caps?: Partial<DogshCaps>;
      // Durable face identity: random per-page key. The arbiter's ledger is
      // keyed by it, so a face that reconnects (MV3 bridge blip) is the SAME
      // face and keeps its place — including ownership.
      faceKey?: string;
      // Baseline levels at attach — a description of the present, never an
      // action (it cannot win an ownership recency contest).
      sig?: DogshSig;
    }
  | { type: 'input'; sessionId?: number | null; data: string }
  | { type: 'clear'; sessionId?: number | null }
  | { type: 'caps'; caps?: Partial<DogshCaps> }
  | { type: 'session-create' }
  | { type: 'session-switch'; sessionId?: number }
  | { type: 'session-close'; sessionId?: number }
  // Live signal report — event-backed by protocol: sent only from real
  // arrival/departure events (visibilitychange, window focus/blur, pageshow,
  // SW focus push, host window events), never from timers and never in
  // reaction to daemon broadcasts. The arbiter trusts live engaged reports
  // as "the user is here NOW".
  | { type: 'signal'; visible?: boolean; focused?: boolean }
  | { type: 'native-bounds'; bounds?: DogshRect } // native-host only
  | { type: 'measure'; w: number; h: number } //     native face only
  | { type: 'doghouse'; on?: boolean } //            native-host only
  | { type: 'debug'; action?: string };

// ---------------------------------------------------------------------------
// Daemon -> client. One union serves both audiences: faces and the host both
// render themselves from owner-state; the host additionally gets window
// choreography (bark, set-content-size, doghouse-changed).
// ---------------------------------------------------------------------------
type DogshDaemonMsg =
  | {
      type: 'hello-ack';
      clientId: number;
      sessionId: number | null;
      owner: DogshOwner;
      gen: number;
      doghouse?: boolean;
    }
  | DogshSessionListMsg
  | { type: 'snapshot'; sessionId: number; data: string; cols: number; rows: number }
  | { type: 'data'; sessionId?: number; data: string }
  | { type: 'grid'; sessionId: number; cols: number; rows: number }
  | { type: 'clear'; sessionId?: number }
  | { type: 'session-exit'; sessionId: number; exitCode: number }
  // The single source of display truth. Pushed to every client on each
  // ownership change (with prevOwner + nativeBounds so faces can decide
  // between a flight and an instant cut) and re-asserted on a 2s tick
  // (prevOwner === owner; a lost push costs one tick of latency, not a
  // stranded overlay).
  | {
      type: 'owner-state';
      owner: DogshOwner;
      gen: number;
      prevOwner?: DogshOwner;
      doghouse?: boolean;
      nativeBounds?: DogshRect | null;
    }
  | { type: 'stale'; expected: number; got: number }
  | { type: 'bark' }
  | { type: 'set-content-size'; w: number; h: number }
  | { type: 'doghouse-changed'; on: boolean }
  | { type: 'debug-state'; [k: string]: unknown };

// What the extension content script receives: daemon traffic plus the
// offscreen document's own connectivity signals.
type DogshBridgeMsg = DogshDaemonMsg | { type: 'bridge-up' } | { type: 'bridge-down' };
