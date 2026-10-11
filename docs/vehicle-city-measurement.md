# Measuring vehicles in /city

How we measure driving in the destructible city, multiplayer included. This
complements [vehicle-netcode-quality.md](vehicle-netcode-quality.md), whose
deterministic replay, scenario contracts and limits (`contracts.ts`) it reuses.
That plan replays a pinned garage drive; this one records drives in the city,
where the car meets buildings, debris, other cars and players.

## What a vehicle needs measured, and why it differs from a player or debris

A car is driven by a person: the driver's own car is predicted from their
inputs and must answer them at once, while matching what the server will
simulate. Everyone else sees it as a remote body. So every measurement is per
role, and the roles want different things.

| Role | What matters | Measured as |
|---|---|---|
| Driver | Answers the stick now; never drifts from what the server will do; corrections rare and small | Drawn pose vs the server's state at the tick it is drawn at (the prediction's tick); corrections (count, size, hard/min); input-to-drawn latency; pops |
| Observer | Where the car really is, smoothly, little delay | Drawn pose vs the server's state at the observer's car-clock tick; pops; delay |
| Both, near contact | The car meets the world when the server's car did | The same errors split into the 30 ticks after an impact (a tick whose horizontal deceleration the tyres cannot give, `mu g`, Coulomb) and the rest |
| Server input pipeline | Applies the driver's inputs in order, one per tick | Ticks the input queue was empty (last input repeated), inputs collapsed out of a backlog, queue depth |
| Cost | Bytes per car per viewer | Snapshot, rig and per-player car stream bytes |

Error sources a vehicle has that a player capsule does not, each needing its own
evidence: tyre slip and suspension (the client's proxy is not Vehicle2), impacts
with standing structures, with debris, with other cars and with players,
damage (lost wheels, broken drivetrain), airborne flight and landings, and the
input pipeline (the server applies one input per tick; a starved or collapsed
queue applies a different input than the driver predicted).

## Methods

1. **Live, closed loop** (`client/e2e/vehicle-measure.mjs`). Two headless
   players on the real stack: one drives a course by scripted inputs, one
   watches. The server (`VIBE_VEHICLE_TAPE=1`) records the driven car per tick:
   the input it applied and the car's state after the step
   (`/city-vehicle-tape`). That record is the truth, exact per tick: no
   polling. Optional in-process impairment of both directions
   (`--impair lte`, `client/netlab/netemProfiles.json`). Courses: `street`
   (weaving down the main street) and `wall` (into the shops on both sides).
   Reports per role, plus the server's input counters
   (`network.vehicle_input_starved`, `vehicle_inputs_collapsed`).
2. **Deterministic replay of a recorded drive**
   (`client/scripts/qualify-vehicle-city.mts`). The live run's tape, replayed
   through the shipping predictor and interpolator under every receive
   schedule of `netlab/vehicle/schedule.ts`, scored by the qualification
   evaluator. `--world flat|city` chooses the collision world the predictor
   sweeps, so one drive measures a change with everything else fixed. It
   applies inputs as the server applied them (a perfect pipeline), isolating
   prediction and collision error from input-pipeline error.
3. **Unit tests with analytic truth** for each mechanism (predictor wheels,
   colliders, the stream's car predictor), as elsewhere in the repo.
4. **Visual review**: `client/e2e/vehicle-qa.mjs` scenarios with `--video`.

Physics is not deterministic across runs, so live A/B compares distributions
over seeds, and the replay is the paired comparison.

## Traps found while building this

- An observer standing in the road is a player the car can hit: the server
  stops a car on a player, the client's prediction (which knows no players)
  drives on. The scripts keep the observer on the sidewalk.
- The tape repeats input sequence numbers when the server's queue runs dry; the
  replay renumbers each tick's applied input (perfect pipeline), or the
  evaluator rejects the drive as out of order.

## First results (2026-10-11, Vibe Town, car 13, loopback and in-process LTE)

**The driver, live.** The observer draws the car within about 1 cm at p95. The
driver does far worse, and mostly because of the server's input pipeline, not
the prediction model:

| Wall course | Driver p95 / max | Hard corrections a min | Queue empty a min | Inputs collapsed a min |
|---|---|---|---|---|
| clean | 0.31-0.38 m / 1.2-1.4 m | 100-200 | 585-686 | 300-336 |
| LTE | 0.47-0.96 m / 1.3-6.0 m | 174-415 | 1,021-1,493 | 840-1,243 |

The server applies one input per tick and repeats the last when its queue is
empty, or collapses a backlog of 4 or more to the newest. Headless browsers
send in uneven bursts, and LTE adds jitter, so the queue swings between empty
and backlog. Every such tick applies an input the driver's prediction did not.
This is the largest source of driver error measured.

**Static city colliders for the prediction** (`vehicles/cityColliders.ts`).
Built and measured; **opt-in** (`?cityColliders=1`), because in Vibe Town they
do not help:

- Live A/B (wall, LTE, 3 seeds each) showed no improvement, and worse
  maxima.
- Replay of the same drives found two causes.
  1. *Wheel spheres.* The proxy's wheels are spheres of tyre radius, about
     0.25 m wider than the tyre. They stopped the car wherever the server's car
     scraped past a kerb, a wall or bumps in terrain. Vehicle2's wheels act
     only through the suspension. Fixed in `moveVehicle`: a wheel never stops
     the car sideways. On the pinned garage qualification this improved 50 of
     576 metrics (long-haul hard corrections 137 to 56 a minute, worst
     correction 2.35 to 0.41 m). It worsened 3 (the turn-blackout worst
     orientation, 34.0 by 0.08 degrees). Pass count unchanged.
  2. *Breakthroughs.* The real car drives through roadside obstacles that
     break: on the street drive, 24 chunks of a shelter, a sign and a tree.
     The prediction stops at them until the fracture reaches the client, a
     round trip after it was needed. No client can know in advance whether a
     wall will hold.
- After the wheel fix, replays of the same drives give typical error equal to
  flat ground (street p95 0.247 vs 0.249 m; wall 0.125 vs 0.129 m). The street
  drive's worst error is worse (1.75 vs 0.83 m), from the breakthroughs.

The tape now records each step's released chunks (`released`), and the replay
drops a chunk's collider when a snapshot from its release tick reaches the
client. So the next recorded drives give a fair A/B with fractures.

## Vehicle input pacing (opt-in, `VIBE_VEHICLE_INPUT_PACING=1`)

The fix for the largest error above: a jitter buffer whose depth the client
steers, as Overwatch paces its command buffer (Tim Ford, "Overwatch Gameplay
Architecture and Netcode", GDC 2017).

- **Server** (`server/src/vehicle_input_pacing.rs`):
  - A driver's inputs are queued in sequence order against the last one
    applied. A packet overtaken by a later one still lands in its place.
  - The queue is never collapsed.
  - Each input's lateness (arrival tick minus sequence) is measured. The
    server reports a target depth: the spread of lateness from its least to
    its 95th percentile over the last 120 inputs.
  - Each snapshot to a driver carries depth and target (section tag 0xE8
    after the removals; 3 bytes). Absent otherwise, so other snapshots are
    byte for byte unchanged.
- **Client** (`client/src/runtime/inputPacing.ts`):
  - The fixed-rate input clock runs at `1 + (target - depth) / 60` over a
    1 s time constant, well above the worst round trip.
  - It resends every unacked input, up to what one QUIC datagram carries
    (`INPUT_BUNDLE_MAX_FRAMES`, 115).
  - Without a report, nothing changes.
- **Counter:** `vehicle_inputs_skipped` (gaps in the applied sequence)
  compares both pipelines. `vehicle_inputs_collapsed` counts the shipping
  collapse only.

The pipeline was chosen by simulation (`client/netlab/vehicle/inputPipeline.ts`,
the real `FixedInputBundler`, the server's queue rules, links from
`netemProfiles.json`). These are mispredicted ticks a minute and input delay
in ticks (production to application, p50/p95), as means over 3 seeds × 10 min:

| Link | Display | Shipping | Paced |
|---|---|---|---|
| loopback | 60 Hz vsync | 0.2, 0.9/1.4 | 0.2, 2.3/2.9 |
| loopback | 60 Hz, 2% 80 ms hitches | 341, 1.0/1.8 | 0.2, 4.4/5.7 |
| loopback | headless (25±15 ms, 3% 150 ms) | 618, 1.3/2.5 | 55, 6.2/10.4 |
| wifi-bad | 60 Hz vsync | 238, 3.9/4.4 | 0.5, 6.0/6.8 |
| lte | 60 Hz vsync | 1,533, 6.3/7.5 | 0.9, 10.0/11.0 |
| lte | 60 Hz hitches | 1,762, 6.3/7.7 | 1.7, 11.1/12.9 |
| lte | headless | 2,371, 6.4/8.3 | 57, 12.9/18.0 |
| poor-mobile | 60 Hz vsync | 1,764, 9.7/11.1 | 1.3, 13.9/14.7 |

The simulation's headless loopback shipping figure (618 a minute) matches the
live clean wall course (585-686 starved plus 300-336 collapsed, counted
differently), which calibrates it.

**The cost.** Pacing adds about 1.4-4 ticks of input delay. That is the
queue holding the jitter. The driver's own car is predicted locally, so
steering responds the same. The delay shows in when the server, and
everyone else, sees the input.

**Not yet measured live** (the GPU was reserved for another session). Next:
`vehicle-measure.mjs` on the wall and street courses, clean and LTE, pacing
on vs off, reading `skippedPerMin` and `starvedPerMin`.

Tests:
- `vehicle_input_pacing::tests`;
- `a_driven_cars_burst_of_inputs_is_applied_in_order_not_collapsed`, which
  reproduces the shipping collapse;
- `netlab/vehicle/inputPipeline.test.ts`, whose shipping case asserts the
  bug and whose paced case gates the fix.
