// Where a meteor is drawn, from its launch arc and its streamed body.
//
// Pure: MeteorLayer calls it every frame, and the tape tools
// (scripts/perf/tape-analysis/replay-clock.ts) call the same function to judge
// a recorded session, so what is measured is what is drawn.
//
// The arc the launch packet describes is exact until the rock touches
// something: a launched ball has no damping, and the server's positions sit
// 0.1-0.4 m from it in flight. So the rock is drawn ON THE ARC, at the render
// time, until a streamed snapshot shows it has left the arc (it hit something)
// -- not from the first streamed snapshot. That removes the handover jump: a
// body with one snapshot cannot be interpolated, and drawing it at that
// snapshot's time while the arc was drawn at the render time put the jump at
// lead x speed (7.8 m median, 24 m worst, on the 2026-09-24 session). After
// contact the body is the truth: interpolated between its snapshots at the
// render time, extrapolated past the newest for at most a quarter second --
// never below the newest snapshot, which is where a falling rock meets the
// ground it is about to stop on.
//
// A body the stream stops carrying while it moves has left the streaming
// range (or been retired); from then on the rock is not drawn at all -- the
// netcode client drops the body by the same rule (net/bodyPresence.ts), and a
// rock held where it was last seen stood tens of metres from the rolling truth
// (43 m p99 in Netlab v2, rec1). That is judged in server ticks (snapshots
// that arrived without it), not against the estimated server clock: while the
// server is stalled nothing arrives, and a rock is not stale because the
// server is slow.

import { MOVING_BODY_SPEED_MS, MOVING_BODY_STALE_TICKS } from '../net/bodyPresence';
import { sampleDynamicBodyTrack, type DynamicBodySample } from '../net/interpolation';
import {
  meteorPositionAt,
  meteorVelocityAt,
  type MeteorFlight,
  type MeteorTrack,
} from './meteorFlights';

export { meteorFlightForgotten, newMeteorTrack, type MeteorTrack } from './meteorFlights';

/** A streamed sample this far from the arc at its own time means contact. */
export const ON_ARC_TOLERANCE_M = 1.5;
/** Snapshots without a moving body before it counts as out of the stream. */
export const STALE_AFTER_TICKS = MOVING_BODY_STALE_TICKS;
/** Below this speed a body missing from the stream is resting, not gone. */
const MOVING_SPEED_MS = MOVING_BODY_SPEED_MS;
/** Longest the body is drawn past its newest snapshot. */
const MAX_BODY_EXTRAPOLATION_US = 250_000;
/** 'hold' (held where last drawn) is no longer produced; tools still read it in older tapes. */
export type MeteorSource = 'arc' | 'body' | 'hold' | 'hidden';

export interface MeteorPlacementInput {
  /** The dynamic-body render time, server us. */
  renderServerUs: number;
  /** The body's buffered snapshots, oldest first; empty if never streamed. */
  samples: readonly DynamicBodySample[];
  /** Server ticks of snapshots since the body was last in one; null if unknown. */
  ticksSinceSeen: number | null;
  tickUs: number;
  nowMs: number;
}

export interface MeteorPlacement {
  source: MeteorSource;
  position: [number, number, number];
  velocity: [number, number, number];
  /** The body's orientation when drawn from the body; null on the arc or held. */
  quaternion: [number, number, number, number] | null;
  /** The arc at the render time (forensics). */
  arc: [number, number, number];
}

export function placeMeteor(
  flight: MeteorFlight,
  track: MeteorTrack,
  input: MeteorPlacementInput,
): MeteorPlacement {
  const { renderServerUs: r, samples } = input;
  const arcT = (r - flight.serverLaunchTimeUs) / 1e6;
  const arc = meteorPositionAt(flight, arcT, [0, 0, 0]);

  // Contact: the first snapshot that is off the arc at its own time, or past
  // the arc's end (it landed where it was aimed).
  const scratch: [number, number, number] = [0, 0, 0];
  for (const s of samples) {
    if (s.serverTimeUs <= track.checkedUs) continue;
    track.checkedUs = s.serverTimeUs;
    track.lastSampleUs = Math.max(track.lastSampleUs, s.serverTimeUs);
    if (track.contactUs !== null) continue;
    const t = (s.serverTimeUs - flight.serverLaunchTimeUs) / 1e6;
    const onArc = meteorPositionAt(flight, t, scratch);
    const off = Math.hypot(s.position[0] - onArc[0], s.position[1] - onArc[1], s.position[2] - onArc[2]);
    if (off > ON_ARC_TOLERANCE_M || t >= flight.flightTimeS) track.contactUs = s.serverTimeUs;
  }

  const newest = samples.length > 0 ? samples[samples.length - 1] : null;
  const newestSpeed = newest ? Math.hypot(newest.velocity[0], newest.velocity[1], newest.velocity[2]) : 0;
  const stale = newest !== null
    && input.ticksSinceSeen !== null
    && input.ticksSinceSeen > STALE_AFTER_TICKS
    && newestSpeed > MOVING_SPEED_MS;

  const done = (placement: MeteorPlacement): MeteorPlacement => {
    if (placement.source !== 'hidden') track.lastPosition = [...placement.position];
    if (placement.source === 'body') {
      track.drawnBody = true;
      track.lastBodyUs = r;
    }
    return placement;
  };

  // Still on the arc (or never streamed): the arc is exact until contact.
  if (track.contactUs === null && !track.drawnBody) {
    if (arcT < 0) {
      return { source: 'hidden', position: arc, velocity: [0, 0, 0], quaternion: null, arc };
    }
    return done({ source: 'arc', position: arc, velocity: meteorVelocityAt(flight, arcT, [0, 0, 0]), quaternion: null, arc });
  }

  if (newest && !stale) {
    // Before the first snapshot we hold, the rock was still on its arc.
    if (!track.drawnBody && r < samples[0].serverTimeUs) {
      return done({ source: 'arc', position: arc, velocity: meteorVelocityAt(flight, arcT, [0, 0, 0]), quaternion: null, arc });
    }
    const target = Math.min(r, newest.serverTimeUs + MAX_BODY_EXTRAPOLATION_US);
    const body = sampleDynamicBodyTrack(samples, target)!;
    const position: [number, number, number] = [...body.position];
    if (target > newest.serverTimeUs) {
      // Past the newest snapshot: never lower than it. A rock falling in the
      // last snapshot is about to stop on whatever is under it.
      position[1] = Math.max(position[1], newest.position[1]);
    }
    return done({ source: 'body', position, velocity: [...body.velocity], quaternion: [...body.quaternion], arc });
  }

  // Streamed once, gone now (out of the stream, or dropped by the netcode
  // client): not drawn. Holding it where it was last drawn put a rolling rock
  // tens of metres from where it really was.
  const last = track.lastPosition ?? arc;
  return { source: 'hidden', position: [...last], velocity: [0, 0, 0], quaternion: null, arc };
}

