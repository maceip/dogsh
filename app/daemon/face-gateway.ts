// Face gateway: hello / signal / input / caps — AEC uplink path.
// Daemon index owns listen/smoke/wiring; this module owns face message policy.
import type { WebSocket } from 'ws';
import type { LeaseEngine } from './lease-engine.js';
import { UPLINK_POLICY } from './lease-engine.js';
import type { SessionMux } from './session-mux.js';

export interface FaceClient {
  surface: DogshSurface;
  id: number;
  proto: number;
  caps: DogshCaps;
  meta: { href: string | null };
  ws: WebSocket;
  remote: boolean;
  lagging?: boolean;
  laggingSince?: number;
}

export type LiveWs = WebSocket & { isAlive?: boolean; remote?: boolean };

export function leaseRoleFor(
  lease: LeaseEngine,
  c: Pick<FaceClient, 'surface' | 'id' | 'remote'>
): DogshLeaseRole {
  return lease.leaseRoleFor({ surface: c.surface, clientId: c.id, remote: c.remote });
}

const SIGNAL_COALESCE_MS = UPLINK_POLICY.reportFocus.coalesceMs;

type Pending = {
  visible: boolean;
  focused: boolean;
  timer: ReturnType<typeof setTimeout>;
};

/** Coalesce last {v,f} per key within ~16ms; grants stay immediate after apply. */
export function createSignalCoalescer(): {
  push(
    key: number | 'native',
    sig: { visible?: boolean; focused?: boolean },
    apply: (s: { visible: boolean; focused: boolean }) => void
  ): void;
} {
  const pending = new Map<number | 'native', Pending>();
  return {
    push(key, sig, apply) {
      const visible = !!sig.visible;
      const focused = !!sig.focused;
      const prev = pending.get(key);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        const p = pending.get(key);
        pending.delete(key);
        if (p) apply({ visible: p.visible, focused: p.focused });
      }, SIGNAL_COALESCE_MS);
      pending.set(key, { visible, focused, timer });
    },
  };
}

export function isOwnerClient(lease: LeaseEngine, client: FaceClient): boolean {
  if (!UPLINK_POLICY.write.ownerOnly) return true;
  return (
    (client.surface === 'native' && lease.owner === 'native') ||
    (client.surface === 'tab' && lease.owner === client.id)
  );
}

export function applyCaps(
  client: FaceClient,
  caps: Partial<DogshCaps>,
  onOwnerCaps: (c: FaceClient) => void
): void {
  if (Number(caps.cols)) client.caps.cols = Number(caps.cols);
  if (Number(caps.rows)) client.caps.rows = Number(caps.rows);
  if (typeof caps.canResize === 'boolean') client.caps.canResize = caps.canResize;
  onOwnerCaps(client);
}

export function applySignal(
  lease: LeaseEngine,
  coalesce: ReturnType<typeof createSignalCoalescer>,
  client: FaceClient,
  msg: { visible?: boolean; focused?: boolean }
): void {
  if (client.surface === 'native-host') {
    coalesce.push('native', msg, (s) => lease.signalHost(s));
  } else if (client.surface === 'tab') {
    const id = client.id;
    coalesce.push(id, msg, (s) => lease.signalTab(id, s));
  }
}

export function applyInput(
  lease: LeaseEngine,
  mux: SessionMux,
  client: FaceClient,
  data: string,
  forActive: boolean,
  write: (data: string) => void,
  log?: (dropped: boolean, shown: string, len: number) => void
): void {
  if (!mux.acceptsInput()) return;
  const owner = isOwnerClient(lease, client);
  if (forActive && owner) write(data);
  const shown = JSON.stringify(data.length > 40 ? data.slice(0, 40) + '…' : data);
  log?.(!owner, shown, data.length);
  if (owner) {
    if (client.surface === 'native') lease.noteInput('native');
    else if (client.surface === 'tab') lease.noteInput(client.id);
  }
}
