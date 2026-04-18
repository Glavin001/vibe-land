export type ShotTraceKind = 'miss' | 'world' | 'body' | 'head';

export type LocalShotTrace = {
  id: number;
  shooterId: number | null;
  origin: [number, number, number];
  end: [number, number, number];
  kind: ShotTraceKind;
  expiresAtMs: number;
};

export type RemoteShotHit = {
  distance: number;
  kind: 'body' | 'head';
};

export function pickShotTraceIntercept(
  sceneDistance: number | null,
  remoteHits: RemoteShotHit[],
  maxDistance: number,
): { distance: number; kind: ShotTraceKind } {
  const closestRemote = remoteHits.reduce<RemoteShotHit | null>((closest, hit) => {
    if (!closest || hit.distance < closest.distance) return hit;
    return closest;
  }, null);

  if (closestRemote && (sceneDistance == null || closestRemote.distance < sceneDistance)) {
    return {
      distance: closestRemote.distance,
      kind: closestRemote.kind,
    };
  }

  if (sceneDistance != null) {
    return {
      distance: sceneDistance,
      kind: 'world',
    };
  }

  return {
    distance: maxDistance,
    kind: 'miss',
  };
}

export function shotTraceColor(kind: ShotTraceKind): number {
  switch (kind) {
    case 'head':
      return 0xff4b4b;
    case 'body':
      return 0xff9a5c;
    case 'world':
      return 0xffefb0;
    case 'miss':
    default:
      return 0x9df6ff;
  }
}

export function isShotTraceActive(trace: LocalShotTrace | null, nowMs: number): boolean {
  return Boolean(trace && trace.expiresAtMs > nowMs);
}

export function pruneExpiredTraces(traces: LocalShotTrace[], nowMs: number): void {
  let write = 0;
  for (let read = 0; read < traces.length; read += 1) {
    const trace = traces[read];
    if (trace.expiresAtMs > nowMs) {
      if (write !== read) {
        traces[write] = trace;
      }
      write += 1;
    }
  }
  traces.length = write;
}
