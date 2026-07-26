// Face lease (AEC): apply leaseRole from downlink enum only.
// Never signal from owner-state paint. TX gate after role change until trusted input.
export type FaceLeaseRole = 'sole' | 'mute' | 'monitor';

export function normalizeLeaseRole(
  role: unknown,
  fallback: { owner: unknown; myId: unknown; remote: boolean }
): FaceLeaseRole {
  if (role === 'sole' || role === 'mute' || role === 'monitor') return role;
  const sole = fallback.owner === fallback.myId;
  if (sole) return 'sole';
  return fallback.remote ? 'monitor' : 'mute';
}

export function mayInput(role: FaceLeaseRole): boolean {
  return role === 'sole';
}

export function mayShow(role: FaceLeaseRole): boolean {
  return role === 'sole' || role === 'monitor';
}

/** Post-downlink TX gate: suppress uplink after paint/role change. */
export function shouldGateTx(prev: FaceLeaseRole, next: FaceLeaseRole): boolean {
  return prev !== next;
}
