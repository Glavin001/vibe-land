// Meteors in the air, as the server described them at launch.
//
// A meteor starts a few hundred metres out and up, and the body snapshot is
// relative to the viewer and quantised to +-82 m, so the rock cannot be
// streamed until the last half second of its fall. The launch packet carries
// the start, the launch velocity and the gravity it flies under, and the arc is
// exact -- a launched ball has no damping -- so this store can say where the
// rock is at any moment until it hits something. Once the streamed body
// appears, that wins: it is the thing that actually landed.
//
// Module-level like the dust shots: written by the runtime's packet handler,
// read by the layer that draws them, with nothing in between.

import { PKT_METEOR_LAUNCHED } from '../net/sharedConstants';

export interface MeteorLaunchedPacket {
  bodyId: number;
  shooterPlayerId: number;
  serverLaunchTimeUs: number;
  start: [number, number, number];
  velocity: [number, number, number];
  target: [number, number, number];
  radiusM: number;
  /** Magnitude, m/s^2, downward. */
  gravityMs2: number;
  /** Launch to the aimed point, unobstructed. */
  flightTimeS: number;
}

/** Rust: `server/src/meteor.rs`, `MeteorLaunchedPacket`. */
export const METEOR_LAUNCHED_PACKET_LEN = 1 + 4 + 4 + 8 + 12 + 12 + 12 + 4 + 4 + 4;

export function decodeMeteorLaunched(bytes: Uint8Array): MeteorLaunchedPacket | null {
  if (bytes.length < METEOR_LAUNCHED_PACKET_LEN || bytes[0] !== PKT_METEOR_LAUNCHED) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 1;
  const bodyId = view.getUint32(o, true); o += 4;
  const shooterPlayerId = view.getUint32(o, true); o += 4;
  const serverLaunchTimeUs = Number(view.getBigUint64(o, true)); o += 8;
  const vec = (): [number, number, number] => {
    const v: [number, number, number] = [
      view.getFloat32(o, true),
      view.getFloat32(o + 4, true),
      view.getFloat32(o + 8, true),
    ];
    o += 12;
    return v;
  };
  const start = vec();
  const velocity = vec();
  const target = vec();
  const radiusM = view.getFloat32(o, true); o += 4;
  const gravityMs2 = view.getFloat32(o, true); o += 4;
  const flightTimeS = view.getFloat32(o, true); o += 4;
  return {
    bodyId,
    shooterPlayerId,
    serverLaunchTimeUs,
    start,
    velocity,
    target,
    radiusM,
    gravityMs2,
    flightTimeS,
  };
}

export interface MeteorFlight extends MeteorLaunchedPacket {
  /** Launch instant on the local performance.now() clock, ms. */
  launchedAtLocalMs: number;
  /** For the rock's look, so two meteors in the air are not the same rock. */
  seed: number;
  /** When the streamed body was last seen, local ms; 0 if never. Set by the layer. */
  lastStreamedAtMs: number;
}

/**
 * A flight is forgotten this long after it should have landed, or after the
 * streamed body was last seen, whichever is later.
 */
const LANDED_LINGER_S = 6;
/** And this long after launch regardless, in case something went badly wrong. */
const MAX_AGE_S = 60;
const MAX_FLIGHTS = 8;

const flights: MeteorFlight[] = [];
let nextSeed = 1;

/**
 * Record a launch. `serverToLocalMs` maps a server microsecond stamp onto the
 * local clock; the runtime has the estimator that knows the offset.
 */
export function registerMeteorFlight(
  packet: MeteorLaunchedPacket,
  serverToLocalMs: (serverTimeUs: number) => number,
): MeteorFlight {
  // The body id is a ring on the server; a new launch through an id still in
  // this list is that rock's replacement, not a second rock.
  const existing = flights.findIndex((flight) => flight.bodyId === packet.bodyId);
  if (existing >= 0) flights.splice(existing, 1);
  const flight: MeteorFlight = {
    ...packet,
    launchedAtLocalMs: serverToLocalMs(packet.serverLaunchTimeUs),
    seed: nextSeed++,
    lastStreamedAtMs: 0,
  };
  flights.push(flight);
  if (flights.length > MAX_FLIGHTS) flights.shift();
  return flight;
}

/** Live flights, oldest first. Sweeps the ones nobody can still see. */
export function meteorFlights(nowMs: number): readonly MeteorFlight[] {
  for (let i = flights.length - 1; i >= 0; i -= 1) {
    const flight = flights[i];
    const age = (nowMs - flight.launchedAtLocalMs) / 1000;
    const landedAtMs = Math.max(
      flight.launchedAtLocalMs + flight.flightTimeS * 1000,
      flight.lastStreamedAtMs,
    );
    if (age > MAX_AGE_S || nowMs - landedAtMs > LANDED_LINGER_S * 1000) flights.splice(i, 1);
  }
  return flights;
}

export function isMeteorBody(bodyId: number): boolean {
  return flights.some((flight) => flight.bodyId === bodyId);
}

export function forgetMeteorFlight(bodyId: number): void {
  const index = flights.findIndex((flight) => flight.bodyId === bodyId);
  if (index >= 0) flights.splice(index, 1);
}

export function clearMeteorFlights(): void {
  flights.length = 0;
}

/**
 * Where the rock is `t` seconds after launch on the unobstructed arc, written
 * into `out`. Past the aimed point it is held there: with no streamed body to
 * say otherwise, the best guess is that it landed where it was aimed.
 */
export function meteorPositionAt(
  flight: MeteorFlight,
  t: number,
  out: [number, number, number],
): [number, number, number] {
  const clamped = Math.max(0, Math.min(t, flight.flightTimeS));
  out[0] = flight.start[0] + flight.velocity[0] * clamped;
  out[1] = flight.start[1] + flight.velocity[1] * clamped - 0.5 * flight.gravityMs2 * clamped * clamped;
  out[2] = flight.start[2] + flight.velocity[2] * clamped;
  return out;
}

/** Velocity at `t` on the arc; zero once it has (nominally) landed. */
export function meteorVelocityAt(
  flight: MeteorFlight,
  t: number,
  out: [number, number, number],
): [number, number, number] {
  if (t < 0 || t > flight.flightTimeS) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }
  out[0] = flight.velocity[0];
  out[1] = flight.velocity[1] - flight.gravityMs2 * t;
  out[2] = flight.velocity[2];
  return out;
}
