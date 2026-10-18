// Where a meteor is drawn, from its launch arc and its streamed body.
//
// Pure: MeteorLayer calls it every frame, and the tape tools
// (scripts/perf/tape-analysis/replay-clock.ts) call the same function to judge
// a recorded session, so what is measured is what is drawn.
//
// The arc the launch packet describes is exact until the rock touches
// something: a launched ball has no damping, and stepped as the server steps
// it (meteorFlights.ts `meteorPositionAt`) the server's positions sit within
// 2 cm of it in flight. So the rock is drawn ON THE ARC, at the render
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

import { BODY_LEAD_CONFIG, BodyLeadTrack } from '../net/bodyLead';
import { MOVING_BODY_SPEED_MS, MOVING_BODY_STALE_TICKS } from '../net/bodyPresence';
import { sampleDynamicBodyTrack, type DynamicBodySample } from '../net/interpolation';
import { SERVER_TICK_US } from '../net/protocol';
import {
  meteorPositionAt,
  meteorVelocityAt,
  type MeteorFlight,
  type MeteorTrack,
} from './meteorFlights';

export { meteorFlightForgotten, newMeteorTrack, type MeteorTrack } from './meteorFlights';

/**
 * A streamed sample this far from the arc at its own time means contact. The
 * arc follows the server's integrator (meteorFlights.ts `METEOR_STEP_S`) on
 * the server's time scale (protocol.ts `SERVER_TICK_US`): in flight the body
 * sits 14 mm p50 / 20 mm max from it (2026-09-24 systematic run, 699
 * samples). The 1.5 m this was covered the old arc's 0.2-0.4 m error and its
 * clock drift (up to 2.4 m), and drew a rock that grazed something on the arc,
 * through it, until it was 1.5 m off.
 */
export const ON_ARC_TOLERANCE_M = 0.3;
/** Snapshots without a moving body before it counts as out of the stream. */
export const STALE_AFTER_TICKS = MOVING_BODY_STALE_TICKS;
/** Below this speed a body missing from the stream is resting, not gone. */
const MOVING_SPEED_MS = MOVING_BODY_SPEED_MS;
/** Longest the body is drawn past its newest snapshot. */
const MAX_BODY_EXTRAPOLATION_US = 250_000;
/**
 * How long a rock that never streamed is left at its aimed point once the
 * arc ends: one staleness window, the time a body that is in this client's
 * stream takes to show up in it.
 */
export const NEVER_STREAMED_LANDED_HOLD_US = STALE_AFTER_TICKS * SERVER_TICK_US;
/** The rock's tumble on the arc, rad/s (the studio rock's). */
export const ARC_TUMBLE_RADS = 0.45;
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
  /**
   * The lead a free-falling snapshot body is drawn at, us (the netcode
   * client's `getDynamicBodyLeadHorizonUs`; net/bodyLead.ts). The rock drawn
   * from its body after contact takes it while the body's last two samples
   * show free fall (a bounce); on the arc it is not used. 0 or absent: drawn
   * at the render time.
   */
  leadHorizonUs?: number;
}

export interface MeteorPlacement {
  source: MeteorSource;
  position: [number, number, number];
  velocity: [number, number, number];
  /**
   * The rock's orientation: from the body when drawn from it, the arc's
   * tumble on the arc; null when hidden.
   */
  quaternion: [number, number, number, number] | null;
  /** The arc at the render time (forensics). */
  arc: [number, number, number];
  /** How far past the render time it is drawn, us (the body lead; 0 on the arc). */
  leadUs?: number;
}

/** Each flight's body lead (net/bodyLead.ts), from its first draw from the body. */
const meteorLeads = new WeakMap<MeteorTrack, BodyLeadTrack>();

/**
 * The rock drawn from its body at server time `t`: interpolated, extrapolated
 * at most a quarter second past the newest snapshot and, past it, never lower
 * than it (a rock falling in the last snapshot is about to stop on whatever is
 * under it).
 */
function bodyAt(samples: readonly DynamicBodySample[], t: number): DynamicBodySample {
  const newest = samples[samples.length - 1];
  const target = Math.min(t, newest.serverTimeUs + MAX_BODY_EXTRAPOLATION_US);
  const body = sampleDynamicBodyTrack(samples, target)!;
  if (target > newest.serverTimeUs) {
    body.position = [body.position[0], Math.max(body.position[1], newest.position[1]), body.position[2]];
  }
  return body;
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
    // A rock that never streamed, past the end of its arc: it hit something
    // this client is not streamed (it landed out of the recipient's interest),
    // and where it went from there is unknown. Holding it at the aimed point
    // for the flight's linger drew it up to 157 m from the rock rolling away
    // (Netlab, heavy-quick3-v2 spectator). Past one staleness window it is not
    // drawn, like any body that left the stream; a body that does start
    // streaming is drawn from it (contact is then detected as usual).
    if (newest === null && r - (flight.serverLaunchTimeUs + flight.flightTimeS * 1e6) > NEVER_STREAMED_LANDED_HOLD_US) {
      return { source: 'hidden', position: arc, velocity: [0, 0, 0], quaternion: null, arc };
    }
    return done({ source: 'arc', position: arc, velocity: meteorVelocityAt(flight, arcT, [0, 0, 0]), quaternion: arcTumble(flight, arcT), arc });
  }

  if (newest && !stale) {
    // Before the first snapshot we hold, the rock was still on its arc.
    if (!track.drawnBody && r < samples[0].serverTimeUs) {
      return done({ source: 'arc', position: arc, velocity: meteorVelocityAt(flight, arcT, [0, 0, 0]), quaternion: arcTumble(flight, arcT), arc });
    }
    // Drawn from its body: at the render time, or past it by the body lead
    // while the body is in free fall. The lead starts at 0 on the first draw
    // from the body, where the arc handed over at the render time.
    let drawUs = r;
    let lead = meteorLeads.get(track);
    if (!lead && (input.leadHorizonUs ?? 0) > 0) {
      lead = new BodyLeadTrack();
      meteorLeads.set(track, lead);
    }
    if (lead) {
      drawUs = lead.advance(r, samples, input.leadHorizonUs ?? 0, BODY_LEAD_CONFIG, (t) => bodyAt(samples, t).position);
    }
    const body = bodyAt(samples, drawUs);
    const position: [number, number, number] = [...body.position];
    lead?.drawn(position);
    return done({ source: 'body', position, velocity: [...body.velocity], quaternion: [...body.quaternion], arc, leadUs: drawUs - r });
  }

  // Streamed once, gone now (out of the stream, or dropped by the netcode
  // client): not drawn. Holding it where it was last drawn put a rolling rock
  // tens of metres from where it really was.
  const last = track.lastPosition ?? arc;
  return { source: 'hidden', position: [...last], velocity: [0, 0, 0], quaternion: null, arc };
}


/**
 * The rock's orientation on its arc, `t` seconds after launch: a slow tumble
 * about an axis of its own, phased to pass through the launch orientation
 * (identity) at the planned landing.
 *
 * The server's ball does not spin in flight (its orientation at contact is
 * the launch orientation; measured on every flight of the systematic bundle),
 * and once it is streamed its orientation is integrated from that start
 * (netcodeClient `predictSphereQuaternion`). The tumble used to accumulate
 * from the rock's spawn, so the rock turned through an arbitrary angle in the
 * frame it handed over to its body. Phased to meet it, the handover is
 * continuous when contact comes at the planned landing, and off by the tumble
 * over the difference when it comes earlier (0.45 rad/s: 13 degrees for half a
 * second).
 */
export function arcTumble(flight: MeteorFlight, t: number): [number, number, number, number] {
  let ax = Math.sin(flight.seed * 12.9898);
  let ay = 0.6;
  let az = Math.cos(flight.seed * 78.233);
  const n = Math.hypot(ax, ay, az);
  ax /= n; ay /= n; az /= n;
  const half = (ARC_TUMBLE_RADS * (t - flight.flightTimeS)) / 2;
  const s = Math.sin(half);
  return [ax * s, ay * s, az * s, Math.cos(half)];
}

/** The tick the meteor layer judges staleness in: the server's, on its own time scale. */
export const METEOR_TICK_US = SERVER_TICK_US;

/** The streamed-body side of a meteor: the runtime (live), or the netcode client (replay, Netlab). */
export interface MeteorBodyFeed {
  /** The body's buffered snapshots, oldest first. */
  getDynamicBodySamples(id: number): readonly DynamicBodySample[];
  /** Server ticks of snapshots since the body was last in one. */
  getDynamicBodyTicksSinceSeen(id: number): number | null;
  /** The lead a free-falling body is drawn at, us (net/bodyLead.ts); absent: none. */
  getDynamicBodyLeadHorizonUs?(): number;
}

export interface MeteorFrame {
  /** The dynamic-body render time this frame, server us; null before a runtime exists. */
  renderServerUs: number | null;
  /** The dynamic-body interpolation delay, ms (the arc's local-clock fallback). */
  lagMs: number;
  nowMs: number;
  tickUs?: number;
}

/**
 * One meteor, one frame, exactly as MeteorLayer places it: at the frame's
 * dynamic-body render time (or, with nothing connected yet, on the local
 * clock), from the flight's arc and its streamed body. Netlab v2's client
 * stage calls this too, so what it scores is what the layer draws.
 */
export function placeMeteorInFrame(
  flight: MeteorFlight,
  feed: MeteorBodyFeed | null,
  frame: MeteorFrame,
): MeteorPlacement {
  // Without a runtime (nothing connected yet) the arc runs on the local clock.
  const renderUs = frame.renderServerUs
    ?? flight.serverLaunchTimeUs + (frame.nowMs - frame.lagMs - flight.launchedAtLocalMs) * 1000;
  return placeMeteor(flight, flight.track, {
    renderServerUs: renderUs,
    samples: feed?.getDynamicBodySamples(flight.bodyId) ?? [],
    ticksSinceSeen: feed?.getDynamicBodyTicksSinceSeen(flight.bodyId) ?? null,
    tickUs: frame.tickUs ?? METEOR_TICK_US,
    nowMs: frame.nowMs,
    leadHorizonUs: frame.renderServerUs === null ? 0 : feed?.getDynamicBodyLeadHorizonUs?.() ?? 0,
  });
}
