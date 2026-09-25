---
name: city-bench-fidelity
description: Keep the /city benches faithful to what the server actually runs, and debug physics by controlled A/B rather than by hypothesis. Use before trusting any number out of city_bench.rs, and before proposing a physics fix.
---

# Trusting a /city measurement

A bench that does not match production measures its own configuration. This is
not hypothetical: three separate divergences were found in one session, and
**each one moved the numbers materially**, so conclusions drawn before the fix
were wrong each time.

## The rule

**Anything production decides, the bench calls rather than restates.**

Every hardcoded constant is a value that silently drifts when production
changes. Syncing constants harder does not help; removing the opportunity does.

`city_bench.rs` builds its world the way the server does:

```rust
let mut arena = crate::movement::PhysicsArena::new(
    MoveConfig::default(), PhysicsBackendKind::PhysxGpu)?;
crate::demo_world::seed_world_for_match(&mut arena, CITY_MATCH_PREFIX)?;
let player = arena.spawn_player(1);
let world = arena.physx_world_mut().unwrap();
```

Use the **arena facade**, not `PhysxPhysicsArena` directly -- the facade is what
`main.rs` holds, so it matches the layer production runs.

`assert_matches_production()` fails if the gravity handed to `city.step` drifts
from the gravity the PhysX world integrates with. Extend it whenever a new
value could diverge; it is far cheaper than noticing.

## A fourth: pile size determines island structure

The bench pile (~300-400 bodies) may fragment into several PhysX contact islands
where production (2,500-9,500 bodies) is one giant island. Since PhysX sleeps
islands ATOMICALLY, island structure is the entire mechanism for anything about
settling -- so a settling result from the bench does not transfer.

Demonstrated: `a_settled_pile_stays_settled` PASSED with freeze disabled, while
the live server with freeze disabled sat at 2,268 awake bodies, flat, for 12
seconds of idle. Same configuration, opposite conclusions. Verify island
structure before trusting any settling result from a small pile.

## The three that were actually found

Recorded because each looked harmless and none was.

**Gravity.** The bench hardcoded `[0, -9.81, 0]` and stayed there when the world
was raised to 20 m/s^2, so it fed the stress solver Earth gravity inside a
2x-gravity scene -- a combination production never runs. Max residual moved
0.164 -> 0.681 m/s, across the sleep threshold, reversing a conclusion.

**GPU capacities.** `World::new(WorldConfig::default())` skips five capacity
overrides `PhysxPhysicsArena::new` reads from the environment (rigid contacts,
rigid patches, heap, found/lost pairs, collision stack). These surface as
*dropped contacts*, not errors -- invisible, and fatal to a contact-related
investigation.

**Terrain.** The arena builds the scene but **not** its contents. Production
instantiates a heightfield from a world document; the bench stood the city on a
flat box. Contact generation differs in triangle edges and per-triangle normals.
Going through `seed_world_for_match` fixed it -- and skipping it entirely, which
happened mid-refactor, left no ground at all and the whole city in free fall at
p50 315 m/s.

Re-measure after every fidelity change. One of these made things *worse* before
better, and only measuring caught it.

## Debugging physics: A/B, never hypothesis

Three hypotheses were tried and all three were wrong -- sleep threshold, solver
iterations, residual velocity floor. What worked was elimination.

**Change one variable.** Two at once produced an unattributable collapse
(18,260 bonds at rest) that cost a full cycle to untangle.

**Build the isolated instrument first.** `physx-bridge/tests/stack_settling.rs`
settles plain boxes with no destruction involved, which exonerated stacking,
pile depth, body count, gravity and solver iterations in one measurement --
10,416 boxes to exactly 0.0000 m/s. Ruling a mechanism *out* is what makes the
remaining difference attributable rather than merely correlated.

**Reproduce the bug before fixing it.** A passing test proves nothing about a
fix. `stack_settling.rs` passes and is *not* a reproduction; it is an
exoneration. The reproduction is `demolished_tower_comes_to_rest` with
`VIBE_CITY_FREEZE=1`, which fails, and a fix is proven when it goes green with
freeze still on.

**Measure the distribution, not the max.** `max_body_speed` is dominated by a
few outliers still in flight and completely hides the reported bug. The jitter
lives in the bulk: p50, p90, p99 and the fraction inside a jitter band. Reading
only the max cost several wrong turns, because 6-20 m/s outliers during collapse
look nothing like 0.03 m/s creep at rest.

**Check the number against the threshold it is supposed to cross.** PhysX sleeps
on `0.5*v^2` against `sleepThreshold`; 0.05 means `v < 0.316 m/s`. Every
jittering body measured 0.033 m/s -- 90x under. That single comparison would
have killed the sleep-threshold and solver-iteration theories immediately.

## Running the reproduction

```bash
VIBE_CITY_FREEZE=1 VIBE_CITY_SCENE=fractured-downtown.json VIBE_CITY_GRID=1 \
VIBE_CITY_VARIED_HEIGHTS=0 VIBE_CITY_STRESS_LIMIT_SCALE=0.6 \
VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_CITY_SHOT_BLAST_RADIUS=0.4 \
VIBE_CITY_SHOT_STRESS_IMPULSE=6.0e6 VIBE_WORLD_FRICTION=0.75 \
VIBE_WORLD_RESTITUTION=0.02 BLAST_ROOT=/path/to/blast-stress-solver/blast \
cargo test --release -p web-fps-server --features blast-core,cuda-stress \
  demolished_tower_comes_to_rest -- --ignored --nocapture
```

Pass the same env the live server runs, or you are back to measuring your own
configuration. See [city-physics-tuning] for what each knob does.

## On a Mac

`city_bench.rs` compiles only with `--features destruction` (Blast), so none
of it builds on a Mac, its native-path tests included, and the reproduction
command above is Linux-only. The Mac's controlled harnesses are `perf_bench`
(`server/src/perf_bench.rs`, `--features native-destruction`) and the bridge
tests. The rule is the same.

- **`perf_bench` already calls production.** Each scene is
  `PhysicsArena::new(.., PhysxGpu)`, `seed_world_for_match(..,
  CITY_MATCH_PREFIX)` and `CityRuntime::native(60, world)`, stepped as
  `city.pre_step`, `step_vehicles_and_dynamics`, `city.step`, the server's
  order. Keep new scenarios going through those calls. How to build and run
  it is in [perf-measure](../perf-measure/SKILL.md#perf_bench).
- **Production on the Mac is `play-server.sh`'s environment**:
  `VIBE_PHYSICS_BACKEND=physx_gpu` and code defaults for everything else.
  `scripts/physics-env.sh` (the vl4 box's grid 2, stress scale 0.45, 2 GB GPU
  heap and raised capacities, freeze on) is sourced by neither
  `play-server.sh` nor `city-bench.sh`, `perf_bench` or the rest soak. A Mac
  measurement that sources it describes the Linux box's city, not the one
  played here. Read the running server's env back with
  `ps -E -ww -o command= -p <pid> | tr ' ' '\n' | grep -E 'VIBE_|CUMETAL_'`.
- **Settling, A/B.** The Mac analogue of the reproduction is `perf_bench`'s
  `rubble_sleep` scenario, which attacks every building and then watches the
  city settle. Run it with `VIBE_PERF_TRACE_DIR` set in both arms and compare
  the per-body rest-pose CSVs with
  `scripts/perf/rubble-sleep/rest_compare.py A.csv B.csv`. Change one knob
  per arm (`VIBE_CITY_NATIVE_REST_SLEEP`, `VIBE_PHYSX_STABILIZATION`, ...; see
  [run-locally](../run-locally/SKILL.md#opt-in-knobs)).
  `physx-bridge/tests/rubble_rest.rs` replays three neighbourhoods cut out of
  bench captures and runs on Metal (ignored; `-- --ignored --test-threads=1`
  under the GPU lock).
- **The island trap applies unchanged.** The bench pile and the live city
  differ in island structure on Metal as on CUDA.
- **Two more ways a Mac run measures its own configuration**: a browser
  rendering on the same GPU (the server yields to it), and a first run on a
  new PhysX package (first-use costs; pipeline compiles too, for a package
  without a pipeline archive). Hold the GPU lock, close the browser, and warm
  up once before timing.
