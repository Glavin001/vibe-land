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

const SIM_HZ = 60;

/**
 * The input clock's rate (1 = real time) for the server's last report of the
 * driver's queue, or 1 without one. Never negative: a client cannot take back
 * inputs it has made.
 */
export function inputClockRate(queue: { depth: number; target: number } | null | undefined): number {
  if (!queue) return 1;
  return Math.max(0, 1 + (queue.target - queue.depth) / (SIM_HZ * INPUT_PACE_CLOSE_SEC));
}
