// Vehicle input pacing: the client's half (server: VIBE_VEHICLE_INPUT_PACING,
// server/src/vehicle_input_pacing.rs). The server applies a driver's inputs
// one per tick from a queue and reports, in each snapshot, the queue's depth
// and the depth that absorbs the measured jitter of their arrival. The client
// runs its fixed-rate input clock slightly fast or slow to hold the queue at
// that target, as Overwatch does (Tim Ford, "Overwatch Gameplay Architecture
// and Netcode", GDC 2017), and resends every unacked input, so the server
// applies each once, in order. Chosen in simulation
// (netlab/vehicle/inputPipeline.ts).

/**
 * Seconds over which the input clock closes a queue-depth error. The client
 * sees the depth a round trip late, so the loop is stable only when this is
 * well above the round trip: the worst netem profile (poor-mobile) is
 * 300 ms plus jitter. One second, as simulated.
 */
export const INPUT_PACE_CLOSE_SEC = 1;

/**
 * Most the correction moves the input clock off the server's rate: the
 * driver's own car moves at the input clock's rate, and about 5% is the
 * Weber fraction for discriminating speeds (McKee, "A local mechanism for
 * differential velocity detection", Vision Research 1981). Owner's choice,
 * 2026-10-11. A larger queue error is backlog, which the server drops
 * (server/src/vehicle_input_pacing.rs `STALE_MARGIN_INPUTS`: this bound x
 * 60 Hz x INPUT_PACE_CLOSE_SEC).
 */
export const INPUT_PACE_MAX_DEVIATION = 0.05;

const SIM_HZ = 60;

/**
 * The input clock's rate (1 = real time) for the server's last report of the
 * driver's queue, or 1 without one: the server's simulation rate (`simRate`,
 * below 1 while it runs behind, its world in slow motion), corrected toward
 * the target depth within INPUT_PACE_MAX_DEVIATION.
 */
export function inputClockRate(queue: { depth: number; target: number } | null | undefined, simRate = 1): number {
  if (!queue) return 1;
  const correction = 1 + (queue.target - queue.depth) / (SIM_HZ * INPUT_PACE_CLOSE_SEC);
  const bounded = Math.min(1 + INPUT_PACE_MAX_DEVIATION, Math.max(1 - INPUT_PACE_MAX_DEVIATION, correction));
  return simRate * bounded;
}
