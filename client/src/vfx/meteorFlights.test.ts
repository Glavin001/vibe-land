import { beforeEach, describe, expect, it } from 'vitest';

import { PKT_METEOR_LAUNCHED } from '../net/sharedConstants';
import {
  METEOR_LAUNCHED_PACKET_LEN,
  clearMeteorFlights,
  decodeMeteorLaunched,
  isMeteorBody,
  meteorFlights,
  meteorPositionAt,
  meteorVelocityAt,
  registerMeteorFlight,
  type MeteorLaunchedPacket,
} from './meteorFlights';

// Mirrors server/src/meteor.rs `encode_meteor_launched`.
function encode(packet: MeteorLaunchedPacket): Uint8Array {
  const out = new Uint8Array(METEOR_LAUNCHED_PACKET_LEN);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_METEOR_LAUNCHED);
  view.setUint32(o, packet.bodyId, true); o += 4;
  view.setUint32(o, packet.shooterPlayerId, true); o += 4;
  view.setBigUint64(o, BigInt(packet.serverLaunchTimeUs), true); o += 8;
  for (const v of [...packet.start, ...packet.velocity, ...packet.target]) {
    view.setFloat32(o, v, true); o += 4;
  }
  view.setFloat32(o, packet.radiusM, true); o += 4;
  view.setFloat32(o, packet.gravityMs2, true); o += 4;
  view.setFloat32(o, packet.flightTimeS, true); o += 4;
  return out;
}

const G = 9.81;

/** The server's plan: start, target, then velocity = (P - S)/T - g T / 2. */
function plan(start: [number, number, number], target: [number, number, number], T: number): MeteorLaunchedPacket {
  return {
    bodyId: 31,
    shooterPlayerId: 4,
    serverLaunchTimeUs: 5_000_000,
    start,
    velocity: [
      (target[0] - start[0]) / T,
      (target[1] - start[1]) / T + 0.5 * G * T,
      (target[2] - start[2]) / T,
    ],
    target,
    radiusM: 2,
    gravityMs2: G,
    flightTimeS: T,
  };
}

describe('meteorFlights', () => {
  beforeEach(() => clearMeteorFlights());

  it('decodes what the server encodes', () => {
    const packet = plan([200, 250, -100], [12, 3.5, -40], 2.6);
    const bytes = encode(packet);
    expect(bytes.length).toBe(65);
    const decoded = decodeMeteorLaunched(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded!.bodyId).toBe(31);
    expect(decoded!.shooterPlayerId).toBe(4);
    expect(decoded!.serverLaunchTimeUs).toBe(5_000_000);
    expect(decoded!.start).toEqual(packet.start);
    expect(decoded!.target).toEqual(packet.target);
    expect(decoded!.radiusM).toBe(2);
    expect(decoded!.gravityMs2).toBeCloseTo(G, 5);
    expect(decoded!.flightTimeS).toBeCloseTo(2.6, 5);
    for (let i = 0; i < 3; i += 1) expect(decoded!.velocity[i]).toBeCloseTo(packet.velocity[i], 3);
  });

  it('refuses a short or foreign packet', () => {
    expect(decodeMeteorLaunched(new Uint8Array([PKT_METEOR_LAUNCHED, 1, 2, 3]))).toBeNull();
    const other = encode(plan([0, 100, 0], [0, 0, 0], 1));
    other[0] = 119;
    expect(decodeMeteorLaunched(other)).toBeNull();
  });

  it('draws the arc through the aimed point and holds it there', () => {
    const target: [number, number, number] = [12, 3.5, -40];
    const flight = registerMeteorFlight(plan([300, 260, 80], target, 3.1), (us) => us / 1000);
    const at = meteorPositionAt(flight, 3.1, [0, 0, 0]);
    for (let i = 0; i < 3; i += 1) expect(at[i]).toBeCloseTo(target[i], 3);
    expect(meteorPositionAt(flight, 0, [0, 0, 0])).toEqual([300, 260, 80]);
    // Past the flight time it stays put, and stops moving.
    expect(meteorPositionAt(flight, 9, [0, 0, 0])).toEqual(at);
    expect(meteorVelocityAt(flight, 9, [0, 0, 0])).toEqual([0, 0, 0]);
    // Mid-flight it is descending.
    expect(meteorVelocityAt(flight, 3, [0, 0, 0])[1]).toBeLessThan(0);
  });

  it('maps the launch onto the local clock and forgets landed flights', () => {
    const flight = registerMeteorFlight(plan([0, 200, 0], [0, 0, 0], 2), (us) => us / 1000 + 1000);
    expect(flight.launchedAtLocalMs).toBe(6000);
    expect(isMeteorBody(31)).toBe(true);
    expect(meteorFlights(6000).length).toBe(1);
    expect(meteorFlights(6000 + 2000 + 5000).length).toBe(1);
    // A streamed body seen late keeps the flight alive past the linger.
    flight.lastStreamedAtMs = 6000 + 12_000;
    expect(meteorFlights(6000 + 15_000).length).toBe(1);
    expect(meteorFlights(6000 + 12_000 + 7000).length).toBe(0);
    expect(isMeteorBody(31)).toBe(false);
  });

  it('replaces a flight whose body id is reused', () => {
    registerMeteorFlight(plan([0, 200, 0], [0, 0, 0], 2), (us) => us / 1000);
    const again = registerMeteorFlight(plan([50, 200, 0], [1, 0, 0], 2), (us) => us / 1000);
    const live = meteorFlights(5000);
    expect(live.length).toBe(1);
    expect(live[0]).toBe(again);
  });
});
