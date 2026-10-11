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
