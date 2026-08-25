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
