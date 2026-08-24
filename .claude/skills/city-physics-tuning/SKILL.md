---
name: city-physics-tuning
description: Tune /city destruction physics — gravity, material strength, ductility, shot footprint, contact response — and diagnose a city that self-destructs, feels weightless, or takes no damage. Use before changing any stress limit, blast radius, damping or gravity value.
---

# Tuning /city destruction

Every knob here is an environment variable, so tuning is a **restart, not a
rebuild**. Change one at a time: several of these interact, and a two-variable
change has already produced an unattributable collapse.

## Measure, don't eyeball

The gate that matters is **the city must not destroy itself**. Run it before and
after any change:

```
server/src/city_bench.rs::a_city_at_rest_does_not_destroy_itself_on_the_core_path
```

Or headlessly (see `city-stack-run`): connect, idle ~10 s, read
`brokenBonds` and `chunksAwake`. Both should be **0**.

This exists because every aggregate counter is *satisfied* by a collapse. Bonds
break, bodies appear, topology flows -- so "did destruction happen" assertions
all pass while the building falls over on its own.

## The knobs

| variable | default | what it actually controls |
|---|---|---|
| `VIBE_WORLD_GRAVITY` | 20.0 | world gravity, m/s^2 |
| `VIBE_WORLD_FRICTION` | 0.75 | contact friction (concrete ~0.6-0.8) |
| `VIBE_WORLD_RESTITUTION` | 0.02 | rebound; concrete barely bounces |
| `VIBE_CITY_STRESS_LIMIT_SCALE` | 0.6 | scales elastic **and** fatal together |
| `VIBE_CITY_SOLVER_ITERATIONS` | 8 | 8 is CPU-era; 32 is safe and better |
| `VIBE_CITY_SHOT_BLAST_RADIUS` | 0.4 | damage **width** -- sharpness |
| `VIBE_CITY_SHOT_STRESS_IMPULSE` | 4.0e5 | damage **depth** -- bite |
| `VIBE_CITY_DEBRIS_LINEAR_DAMPING` | 0.0 | air drag; leave at 0 |

## Traps, each of which has cost real time

**Blast radius and impulse are independent, and impulse is per-node.** The
impulse is applied to each node in range scaled by falloff -- it is *not*
distributed across the sphere. Shrinking the radius therefore does **not**
concentrate load. Cutting both together (2.5 -> 0.4 m and 1.2e7 -> 4.0e5) put
every hit below the elastic limit and destroyed nothing at all. Shrink the
radius for sharpness; adjust the impulse separately for bite.

**`STRESS_LIMIT_SCALE` moves elastic and fatal together**, so it changes how
close the city is to failing but never its character. Dropping 0.6 -> 0.5 broke
18,260 bonds at rest and demolished the city before anyone connected. Any
recommendation of 0.5 in older comments predates the gravity change and is stale.

**Gravity is 20 m/s^2 everywhere**, matched to the player (Source's
`sv_gravity 800` = 20.32). The city therefore carries ~2x the load its pack was
authored for, so every strength number written before that is suspect.

**Damping is not collision energy loss.** Damping is air drag on a body moving
through empty space; a 10-tonne slab does not feel it. Energy should be lost
*on impact*, which is `VIBE_WORLD_RESTITUTION` and `VIBE_WORLD_FRICTION`.

**CUDA is a correctness fix, not just performance.** With the `cuda-stress`
feature, spontaneous at-rest breaks went 40 -> 0 at identical settings: the CPU
solver's 8-iteration residual was being reported as real stress.

## How the damage model works

Per tick, per bond:

```
if stress > elastic:
    multiplier = (stress - elastic) / (fatal - elastic)
    damage     = bond_health * multiplier
```

- Below elastic: **zero** damage, forever. Not reduced -- none.
- Above elastic: exponential decay of health. A bond 1% into the gap takes ~460
  ticks (~8 s) to fail; one at fatal breaks in a single tick.
- **`fatal - elastic` is the ductility dial.** Wide gap = visible sagging then
  failure. Narrow gap = shatters instantly.

The shipped packs already author this. `fractured-downtown` has five materials:
foundation and skeleton at 10x ductile, brittle infill at 1.2x and most numerous.
Flattening that table (putting every bond on material 0) does not just rescale
strength -- it erases the skeleton/facade distinction that makes a collapse look
like a building rather than dissolving cubes.

## Diagnosing by symptom

**City self-destructs at rest.** Strength too low for the load. Raise
`STRESS_LIMIT_SCALE`. Verify the material table is not flattened -- check the
solver receives all the pack's materials, not one.

**Shots do no damage.** Impulse below the elastic limit. Raise
`SHOT_STRESS_IMPULSE`; leave the radius alone, since widening it is what makes
hits mushy.

**Debris flies and spins like polystyrene.** Not mass -- chunks are already
10 tonnes median at 2400 kg/m^3. `destruction.cc` pushes with
`addForce(..., eVELOCITY_CHANGE)`, which is *mass-independent*, so a 681-tonne
slab gets the same velocity as a 10 kg shard. The fix is a real impulse capped
at a maximum delta-v: `dv = min(J/mass, v_max)`.

**Damage is local; knocking out supports never propagates.** Working stress sits
far below the elastic limit (skeleton elastic ~28.8 MPa vs a few MPa of real
column load), so redistributed load never reaches the threshold. Progressive
collapse needs elastic lowered **on its own**, keeping fatal -- which is not what
`STRESS_LIMIT_SCALE` does. Elastic must stay above at-rest stress or the city
eats itself slowly.

## Performance

Check `gpu_stress_solve_ms` before optimising the solver -- it is typically
~2.4 ms and rarely the bottleneck. Cost is dominated by **awake body count**:
`physics_fetch_ms` (PhysX GPU wall time; `physics_simulate_ms` is near zero
because dispatch is async) and blast `begin_ms`. Watch `freeze_flips` against
`unfreeze_flips`: near-equal counts in the tens of thousands mean freeze is
thrashing rather than settling, and halving awake bodies is worth several ms.

`solver_islands_skipped: 0` is **expected** on the CUDA path -- the GPU solves
the whole graph as one system, so the settled-island skip is a CPU-path
optimisation you trade away for the fast solve. Not a bug.

`backstop_releases` should be **0**; non-zero means freeze's normal release path
failed and a safety net caught it.
