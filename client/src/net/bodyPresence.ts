// Whether a streamed dynamic body is still being streamed to this client.
//
// The server never says a body is gone. A retired cannonball or meteor is
// removed from its world, and a body outside the recipient's interest radius
// (`DYNAMIC_BODY_AOI_EXIT_RADIUS_M`) is left out of that recipient's
// snapshots; either way it simply stops appearing. What the client can go by
// is the snapshot builder's contract (server/src/snapshot_builder.rs):
//
// - a body in interest that is moving is "hot" and is in every snapshot the
//   byte budget allows;
// - a body in interest at rest is re-sent once per `COLD_REFRESH_TICKS`.
//
// So a body last seen moving too fast to have come to rest unseen is out of
// the stream once snapshots have gone `MOVING_BODY_STALE_TICKS` without it; a
// body last seen at rest (or slow) once a snapshot that should have carried
// its refresh arrived without it. A lost snapshot may have been that refresh,
// so a loss in the refresh window moves the verdict to the next refresh. The
// previous rule, 240 ticks for every body, drew retired and out-of-range
// cannonballs at their last pose for up to 4 s (Netlab v2, rec1: 60 of 759
// live renderer samples).
//
// Budget-starved bodies (a snapshot full before a far body's turn) break the
// contract too; they are retired here and come back with their next sample.
//
// A moving body that leaves the interest radius is known to be gone at once:
// the snapshot carries the recipient's position (the anchor its bodies are
// quantised against), and the builder drops a body beyond
// `DYNAMIC_BODY_AOI_EXIT_RADIUS_M` of it. So a fast body missing from a
// snapshot, whose last state carried on to that tick is outside the radius,
// is out of the stream from that snapshot. Waiting out the stale window drew
// it extrapolated for 15 more ticks, through whatever it hit: the two worst
// body render errors of the 2026-09-24 quick 3-client bench (1.75 m and
// 0.74 m, spectator c1) were cannonballs 80 m out, drawn 7 and 9 ticks past
// their last snapshot, after they had bounced.

import { DYNAMIC_BODY_AOI_EXIT_RADIUS_M, SIM_HZ } from './sharedConstants';

/** `COLD_DYNAMIC_REFRESH_TICKS` in snapshot_builder.rs (one second of ticks). */
export const COLD_REFRESH_TICKS = SIM_HZ;
/** A body faster than this (m/s) when last seen cannot come to rest in a tick or two. */
export const MOVING_BODY_SPEED_MS = 2;
/** Server ticks of snapshots without a moving body before it counts as out of the stream. */
export const MOVING_BODY_STALE_TICKS = 15;
/** Every body is dropped after this many ticks unseen, whatever the losses. */
export const MAX_UNSEEN_TICKS = 240;

type V3 = readonly [number, number, number];

type Presence = {
  lastSeen: number;
  fast: boolean;
  /** Position and velocity when last seen, when the caller knows them. */
  position: V3 | null;
  velocity: V3 | null;
  /** Earliest and latest tick its next cold refresh is due; null while it is in every snapshot. */
  refreshFrom: number | null;
  refreshBy: number;
};

export class BodyStreamPresence {
  private readonly bodies = new Map<number, Presence>();
  private lastTick: number | null = null;
  /** The newest snapshot tick known to be missing (between two received ones). */
  private lastLostTick = -Infinity;

  /**
   * The snapshot at `tick` carried body `id`, moving at `speedMs`; with its
   * position and velocity, a moving body that then leaves the recipient's
   * interest radius is retired as soon as a snapshot shows it gone.
   */
  seen(id: number, tick: number, speedMs: number, position: V3 | null = null, velocity: V3 | null = null): void {
    this.bodies.set(id, {
      lastSeen: tick,
      fast: speedMs > MOVING_BODY_SPEED_MS,
      position,
      velocity,
      refreshFrom: null,
      refreshBy: 0,
    });
  }

  /**
   * Once every body in the snapshot at `tick` has been `seen`: the ids that
   * are no longer streamed, which are forgotten here as well. `intervalTicks`
   * is the server's snapshot interval; `recipient`, the recipient position
   * the snapshot was built for (its anchor), when known.
   */
  endSnapshot(tick: number, intervalTicks: number, recipient: V3 | null = null): number[] {
    const interval = Math.max(1, Math.round(intervalTicks));
    if (this.lastTick !== null && tick - this.lastTick > interval) {
      this.lastLostTick = tick - interval;
    }
    this.lastTick = tick;
    const gone: number[] = [];
    for (const [id, body] of this.bodies) {
      if (body.lastSeen >= tick) continue;
      const unseen = tick - body.lastSeen;
      if (unseen > MAX_UNSEEN_TICKS) {
        gone.push(id);
      } else if (body.fast) {
        if (unseen > MOVING_BODY_STALE_TICKS || leftInterest(body, unseen, recipient)) gone.push(id);
      } else {
        if (body.refreshFrom === null) {
          // The first snapshot without it: the server last sent it no earlier
          // than when it was seen and no later than the previous snapshot tick.
          body.refreshFrom = body.lastSeen + COLD_REFRESH_TICKS;
          body.refreshBy = tick - interval + COLD_REFRESH_TICKS;
        }
        // The refresh goes out in the first snapshot at or after it is due,
        // and this is a snapshot at or after that.
        if (tick >= body.refreshBy) {
          if (this.lastLostTick >= body.refreshFrom) {
            // It may have been in a snapshot that was lost: wait for the next.
            body.refreshFrom += COLD_REFRESH_TICKS;
            body.refreshBy += COLD_REFRESH_TICKS;
          } else {
            gone.push(id);
          }
        }
      }
    }
    for (const id of gone) this.bodies.delete(id);
    return gone;
  }

  lastSeenTick(id: number): number | undefined {
    return this.bodies.get(id)?.lastSeen;
  }

  delete(id: number): void {
    this.bodies.delete(id);
  }

  clear(): void {
    this.bodies.clear();
    this.lastTick = null;
    this.lastLostTick = -Infinity;
  }
}

/**
 * Whether a body last seen moving has, carried on at its last velocity for
 * `unseenTicks`, left the interest radius around `recipient`: the snapshot
 * builder's exit test (`dynamic_body_within_aoi`, the exit radius for a body
 * it was sending).
 */
export function leftInterest(
  body: { position: V3 | null; velocity: V3 | null },
  unseenTicks: number,
  recipient: V3 | null,
): boolean {
  if (!recipient || !body.position || !body.velocity) return false;
  const t = unseenTicks / SIM_HZ;
  const dx = body.position[0] + body.velocity[0] * t - recipient[0];
  const dy = body.position[1] + body.velocity[1] * t - recipient[1];
  const dz = body.position[2] + body.velocity[2] * t - recipient[2];
  return dx * dx + dy * dy + dz * dz > DYNAMIC_BODY_AOI_EXIT_RADIUS_M * DYNAMIC_BODY_AOI_EXIT_RADIUS_M;
}
