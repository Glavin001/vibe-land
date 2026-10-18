// Netlab v2 adapter for the pre-work client (e3fdf5cc, before 0eb6f3fd).
//
// That client has no meteorPlacement.ts: MeteorLayer.tsx placed each rock
// inline in its useFrame. This file is that placement rule, copied from
// e3fdf5cc client/src/vfx/MeteorLayer.tsx (the `for (const flight of
// flights)` loop) with the mesh work removed, in the shape the lab's client
// stage calls (`placeMeteorInFrame`). Installed into a pre-work worktree by
// install.sh beside it; never part of the production client.
//
//   - streamed: the body is in the snapshot map and not stale (newest sample
//     older than 250 ms while moving faster than 2 m/s): drawn at the runtime's
//     rendered state (MultiplayerGameRuntime.getRenderedDynamicBodyState's
//     non-interaction branch: the interpolated state, else the latest), with
//     the body's orientation; the flight's lastStreamedAtMs is set, as the
//     layer set it (meteorFlights forgets a flight by it).
//   - hold: streamed before, not now: where the rock was last drawn.
//   - arc: never streamed: the launch arc at the body render time.
//   - hidden: announced, not yet launched on the render clock.
import { meteorPositionAt, type MeteorFlight } from './meteorFlights';

const STALE_SAMPLE_MS = 250;

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

interface BodyState {
  position: V3;
  velocity: V3;
  quaternion: Q4;
}

interface ClientLike {
  dynamicBodies: Map<number, BodyState>;
  getDynamicBodyObservedAgeMs(id: number, localTimeUs?: number): number | null;
  getInterpolatedDynamicBodyState(id: number): BodyState | null;
}

const lastDrawn = new WeakMap<MeteorFlight, V3>();

export function placeMeteorInFrame(
  flight: MeteorFlight,
  client: ClientLike,
  options: { renderServerUs: number; lagMs: number; nowMs: number; tickUs?: number },
): { position: V3; quaternion: Q4 | null; source: 'arc' | 'body' | 'hold' | 'hidden' } {
  const { renderServerUs, nowMs } = options;
  const raw = client.dynamicBodies.get(flight.bodyId) ?? null;
  const sampleAgeMs = raw ? client.getDynamicBodyObservedAgeMs(flight.bodyId, nowMs * 1000) ?? 0 : 0;
  const rawSpeed = raw ? Math.hypot(raw.velocity[0], raw.velocity[1], raw.velocity[2]) : 0;
  const stale = raw !== null && sampleAgeMs > STALE_SAMPLE_MS && rawSpeed > 2;
  const streamed = raw && !stale ? client.getInterpolatedDynamicBodyState(flight.bodyId) ?? raw : null;
  const arcT = (renderServerUs - flight.serverLaunchTimeUs) / 1e6;
  if (streamed) {
    flight.lastStreamedAtMs = nowMs;
    const position: V3 = [streamed.position[0], streamed.position[1], streamed.position[2]];
    lastDrawn.set(flight, position);
    return { position, quaternion: [...streamed.quaternion] as Q4, source: 'body' };
  }
  if (flight.lastStreamedAtMs > 0) {
    const held = lastDrawn.get(flight) ?? [0, 0, 0];
    return { position: [held[0], held[1], held[2]], quaternion: null, source: 'hold' };
  }
  if (arcT < 0) {
    return { position: meteorPositionAt(flight, arcT, [0, 0, 0]), quaternion: null, source: 'hidden' };
  }
  const position = meteorPositionAt(flight, arcT, [0, 0, 0]);
  lastDrawn.set(flight, position);
  return { position, quaternion: null, source: 'arc' };
}
