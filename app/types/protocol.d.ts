// The face/host <-> daemon wire protocol (v10), typed once for every consumer.
// Ambient on purpose — script-kind files cannot use module imports.
//
// v6: level-based lease (signals in, owner-state out).
// v7: dynamic grid. v8: remote faces. v9: relocatable Session Host.
// v10: leaseRole sole|mute|monitor + cause on owner-state (AEC / echo cancel).
//
// Fields on INCOMING messages are optional wherever the receiving code
// runtime-guards them.

type DogshSurface = 'native' | 'tab' | 'native-host';

// 'native' or a tab client id.
type DogshOwner = 'native' | number;

/** Face display/input role derived by the Session Host (v10). */
type DogshLeaseRole = 'sole' | 'mute' | 'monitor';

/** Why the lease moved or was re-asserted (AEC reference / post-mortem). */
type DogshLeaseCause =
  | 'signal'
  | 'input'
  | 'attach'
  | 'expire-ghost'
  | 'reassert'
  | 'import'
  | 'doghouse';

interface DogshRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DogshSig {
  visible?: boolean;
  focused?: boolean;
}

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

interface DogshSessionHostBundle {
  v: 1;
  hostGeneration: number;
  activeSessionId: number | null;
  sessions: Array<{
    id: number;
    state: {
      v: 1;
      savedAt: number;
      cols: number;
      rows: number;
      title: string;
      data: string;
    };
  }>;
  guestCheckpoints: Record<
    string,
    {
      v: 1;
      kind: 'guest';
      savedAt: number;
      cols: number;
      rows: number;
      title: string;
      mirror: string;
      payload: string;
    }
  >;
}

type DogshClientMsg =
  | {
      type: 'hello';
      surface?: string;
      proto?: number;
      href?: string;
      caps?: Partial<DogshCaps>;
      faceKey?: string;
      sig?: DogshSig;
      token?: string;
    }
  | { type: 'input'; sessionId?: number | null; data: string }
  | { type: 'clear'; sessionId?: number | null }
  | { type: 'caps'; caps?: Partial<DogshCaps> }
  | { type: 'session-create' }
  | { type: 'session-switch'; sessionId?: number }
  | { type: 'session-close'; sessionId?: number }
  | { type: 'signal'; visible?: boolean; focused?: boolean }
  | { type: 'native-bounds'; bounds?: DogshRect }
  | { type: 'measure'; w: number; h: number }
  | { type: 'doghouse'; on?: boolean }
  | { type: 'debug'; action?: string }
  | { type: 'trace'; tag?: string; detail?: string }
  | { type: 'host-export' }
  | { type: 'host-fence'; redirectUrl?: string }
  | { type: 'host-import'; bundle?: DogshSessionHostBundle };

type DogshDaemonMsg =
  | {
      type: 'hello-ack';
      clientId: number;
      sessionId: number | null;
      owner: DogshOwner;
      gen: number;
      doghouse?: boolean;
      remote?: boolean;
      hostGeneration?: number;
      redirectUrl?: string | null;
      fenced?: boolean;
      /** This face's display/input role (v10). */
      leaseRole?: DogshLeaseRole;
    }
  | DogshSessionListMsg
  | { type: 'snapshot'; sessionId: number; data: string; cols: number; rows: number }
  | { type: 'data'; sessionId?: number; data: string }
  | { type: 'grid'; sessionId: number; cols: number; rows: number }
  | { type: 'clear'; sessionId?: number }
  | { type: 'session-exit'; sessionId: number; exitCode: number }
  | {
      type: 'owner-state';
      owner: DogshOwner;
      gen: number;
      prevOwner?: DogshOwner;
      doghouse?: boolean;
      nativeBounds?: DogshRect | null;
      /** Per-recipient role — daemon sends per-socket (v10). */
      leaseRole?: DogshLeaseRole;
      /** Why this state was pushed (AEC reference). */
      cause?: DogshLeaseCause;
    }
  | { type: 'stale'; expected: number; got: number }
  | { type: 'bark' }
  | { type: 'set-content-size'; w: number; h: number }
  | { type: 'doghouse-changed'; on: boolean }
  | { type: 'debug-state'; [k: string]: unknown }
  | {
      type: 'host-bundle';
      bundle: DogshSessionHostBundle;
      hostGeneration: number;
    }
  | {
      type: 'host-fenced';
      hostGeneration: number;
      redirectUrl?: string | null;
    }
  | {
      type: 'host-imported';
      hostGeneration: number;
      activeSessionId: number | null;
    };

type DogshBridgeMsg = DogshDaemonMsg | { type: 'bridge-up' } | { type: 'bridge-down' };
