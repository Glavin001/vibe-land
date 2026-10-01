---
name: vehicle-qa
description: Reproduce a player's report about destructible vehicles (flicker, parts in two places, wheels falling off, cars breaking too easily or not at all) with automated tests before fixing it, and prove the fix with the same tests. Covers the live browser scenario runner, the GPU physics tests, tape replay frame by frame, and pixel flicker detection.
---

# Vehicle QA: reproduce, then fix

A report is not understood until a test reproduces it. Pick the fastest layer
that shows it, keep the slower ones as confirmation.

## 1. Live, real client and server: `client/e2e/vehicle-qa.mjs`

Drives /city in headless Chromium (Metal) against the fleet server
(`garage-vehicle-server` launch entry, port 4001) and the dev client (3003).
Steps: reset the city, join beside a fleet car, set the shot mode, aim, fire,
meteor, enter a car and steer it to a point. Records per rendered frame where
each car and every loose part is DRAWN (position and orientation, from the
instance matrices), and the server's view of each car after each step, plus a
screenshot per step and optionally a video.

```bash
cd client && node e2e/vehicle-qa.mjs --list
node e2e/vehicle-qa.mjs cannonball-wreck --video      # one run
node e2e/vehicle-qa-suite.mjs --repeat 4 cannonball-wreck   # live physics is not deterministic
```

Scenarios live in `client/e2e/vehicle-scenarios.mjs`; add the report as a new
one. Checks: `drawnFlicker` (position A->B->A), `spinFlicker` (orientation
A->B->A three or more times on one part: rocking, what a player calls
"phantom" / "two places at once"), `carFlicker`, `partsOff`, `wheelsOn`.
Reports land in `target/vehicle-qa/<scenario>/report.json` with the rocking
parts, where they were and the nearest ball.

Position checks alone miss the 2026-09-29 phantom: pieces rocked between two
orientations with steady positions. `drawnFlicker` follows each part's drawn
geometry centre, not its origin: parts are authored in the car's frame, so a
part spinning at PhysX's 100 rad/s limit swings its origin a metre where the
part itself barely moves.

**Server or renderer?** The report also has `receivedSpin`: the same rocking
count over what the client *received* (`vehicleRig` detached poses). Received
rocking equal to drawn rocking puts the fault in the server's physics; drawn
rocking with a quiet received stream puts it in the client.

**Rebuild the server.** The `garage-vehicle-server` launch entry runs
`--no-build`; after a bridge or server change, `cargo build --release -p
web-fps-server --features native-destruction --bin web-fps-server` (with the
PHYSX_ROOT/CARGO_TARGET_DIR below) before restarting it, or the live run tests
old code. `strings target/garage-vehicles/release/web-fps-server | grep <env>`
confirms a new switch is in.

## 2. Physics only, deterministic, seconds: GPU tests

`server/src/physx_runtime/vehicle_destruction_tests.rs`, run under the GPU
lock (stop the server first):

| test | reproduces |
|---|---|
| `garage_loose_pieces_do_not_flip_flop` | loose pieces rocking after the city cannonball (10.65 t, 60 m/s); `VIBE_SPIN_SHOTS`, `VIBE_SPIN_REST_TICKS`, `VIBE_SPIN_TRACE=<part> VIBE_SPIN_TRACE_FROM=<tick>` traces one piece's body tick by tick |
| `garage_car_drives_over_debris` | driving over concrete blocks (`VIBE_DEBRIS_HALF/DENSITY/SPEED`) |
| `garage_car_drives_through_wreck` | driving through a meteor-shattered car |
| `garage_car_crashes_into_car`, `garage_cars_in_one_scene_break_independently` | multi-car scenes |
| `vehicle_hulls_do_not_interpenetrate_at_rest` | authoring: hull overlap (no GPU) |
| `garage_vehicle_destruction_is_rigid_body_correct` | the correctness suite (`scripts/perf/garage-destruction-test.sh`); `VIBE_SUNK_TRACE=1` prints the deepest sunk hull per tick |
| `city_fleet_tests::city_cannonballed_buggy_pieces_do_not_rock`, `city_wreck_pieces_do_not_rock` | the car inside the real city stage (production arena, city world, city step), cannonballed or meteored; `VIBE_CITY_FLEET_VARIANT=n` another wreck, `VIBE_CITY_TRACE_PART=<part> VIBE_CITY_TRACE_FROM/TICKS` one piece's body tick by tick; reports rocking pieces, A-B-A jumps, rejected steps and step times |

The city matters: pieces wedge against buildings the garage does not have.
One wreck is one sample: judge a physics change over several variants (the
2026-09-30 depenetration fix was chosen over 5 variants x 2 cars).

```bash
scripts/perf/gpu-run.sh garage-destruction-test env VIBE_VEHICLE_BUILD_FIXTURES=$PWD/target/vehicle-build-fixtures.json \
  CUMETAL_CACHE_DIR=$PWD/target/cumetal-cache-vehicles VIBE_DESTRUCTION_MODELS=desert,derby,monster,circuit,buggy \
  cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server <test> -- --ignored --nocapture --test-threads=1
```
(with `PHYSX_ROOT=../PhysX/out/install/garage-multihull CARGO_TARGET_DIR=target/garage-vehicles`). Environment switches
are the A/B: run the same test with and without one and compare.

## 2b. Behaviour spec: the vehicle lab (`server/src/physx_runtime/vehicle_lab.rs`)

For "breaks too easily / not easily enough" reports. `scenarios()` is the
spec: ground (flat slab or the garage course) + obstacles (wall, kerb, loose
blocks) + a way of driving (park, straight, laps, into the first obstacle) +
events (the city cannonball), each with what must hold afterwards (`Intact`,
`KeepsWheels`, `Breaks`) and a one-line why. Add the player's report as a
scenario; do not edit expectations to make a run pass.

```bash
scripts/perf/gpu-run.sh lab env VIBE_VEHICLE_BUILD_FIXTURES=$PWD/target/vehicle-build-fixtures.json \
  CUMETAL_CACHE_DIR=$PWD/target/cumetal-cache-vehicles [VIBE_LAB_CARS=monster,buggy] [VIBE_LAB_SCENARIOS=wall,course-12] \
  [VIBE_LAB_REPORT_ONLY=1] cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server vehicle_lab -- --ignored --nocapture --test-threads=1
```

Per run: top/impact speed, bonds broken, parts off, wheels lost, the share of
ticks whose stress solve converged, peak deceleration (g) and peak Vehicle2
wheel load (x static corner weight). Per broken bond, an **audit**: its
tension/compression/shear the tick before as fractions of fatal, its
utilisation over the five ticks before, whether that solve converged, what
the car touched, its deceleration and wheel loads, classified
`unconverged` / `impact` / `wheel-load` / `unexplained`. A bond at 0% of fatal
the tick before, broken by an unconverged solve, is a spurious verdict, not a
weak part. Everything, tick by tick, lands in `target/vehicle-lab/report.json`.

### What the lab found (2026-10-01) and what changed

- **Spurious breaks were unconverged and diverged solves.** At 64 iterations a
  car's solve was cut off mid-transient: residual up to 2e5x tolerance, worse
  than its warm start. Causes, by what-if: chunks under 1 kg on stiff steel
  bonds (now merged, `client/src/vehicles/chunk-merge.mjs`) and a 1e6-4.5e7
  bond-stiffness spread (vehicle structures now use contact length and
  exponent 0.5 -- a measured concession, see the bridge's append_bonds).
- **Real breaks on rough ground were the rigid suspension limit.** The audit
  showed 1.5 MN constraint loads on the wheel chunk (PhysX's own corner
  constraint force agrees): Vehicle2 removes over-compression in one step.
  Garage builds now carry a compliant bump stop (PxNativeVehicle
  bumpStopStiffness, 10x spring) and springs sized for 30% sag.
- **Remaining rough-course damage** at 18+ m/s is body panels taking terrain
  contact in one step (contact loads in MN): the same rigid-contact class.

## 2c. Real-world grounding: `node scripts/vehicle-reality.mjs`

`client/src/vehicles/reality.mjs` holds each model's real class (mass, wheel
and tyre mass, top speed, acceleration), shared ranges (ride frequency, grip,
braking) and the joint materials against real materials. Anything outside its
range is a finding unless listed in `concessions` with its reason; the report
says how far out each value is. Tune inside the ranges; a value that must
leave one becomes a concession someone can weigh, not a magic number.

Part mass comes from `client/src/vehicles/dune/construction.mjs`: solid
volume x density, except parts modelled as the solid envelope of something
hollow or thin (tyres, castings, tanks, body skins), massed by wall or sheet
thickness. Rebuild fixtures after changing it
(`cd client && node scripts/verify-vehicle-builds.mjs ../.cache/vehicle-assets ../target/vehicle-build-fixtures.json`;
bump the recipe tag in prepare-asset.mjs so cached assets rebuild).

## 3. The player's own tape

A session tape (`debug-reports/session-*/client.vltape`) starts after the
join, so add the car assets first, then replay it in /cityreplay:

```bash
cd client && npx tsx scripts/tape-add-vehicle-assets.ts <in.vltape> public/<name>.vltape
node e2e/tape-frames.mjs <name>.vltape <fromMs> <toMs>      # consecutive frames, grass off
node e2e/frame-flicker.mjs ../target/tape-frames/<dir>        # pixels drawn A, B, A
npx tsx scripts/vehicle-tape-spin-flips.ts <tape>            # orientation flips in the stream
```
Look at the frames and the heat map yourself: that is what the player saw.

## Before claiming a fix

The same test must fail on the old behaviour and pass on the new one (an env
switch that restores the old behaviour makes this one command), and the
correctness suite must not regress.
