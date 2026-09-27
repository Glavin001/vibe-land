# Garage vehicle destruction correctness — 2026-09-26

`scripts/perf/garage-destruction-test.sh` runs
`garage_vehicle_destruction_is_rigid_body_correct`
(`server/src/physx_runtime/vehicle_destruction_tests.rs`) on the GPU, on the
garage's own path (`PhysxPhysicsArena` + `enable_vehicle_destruction`, the same
wheel posing, ball launch and `/debug` readback the range uses). Float SDK,
unconverged stress steps published (convergence is out of scope here).

Checked every tick: bond groups = rigid bodies (no intact bond across bodies, no
body holding unconnected groups); body mass and COM = sum of its parts; parts
rigid within their body; loose bodies have gravity, fall at g in free flight,
never drift at constant velocity, end on the ground or the car; loose kinetic
energy <= the ball's; detached parts streamed (arena and every rig-packet page)
= parts off the car; Vehicle2 wheel mask = wheels on the car; shots break bonds
near the ball and the target.

Buggy, all scenarios pass (`report-buggy.json`): rest 4 s and a 86 m drive loop
over the garage course break nothing; 3000 kg / 20 m/s shots break 2-5 bonds,
first within 0.3-1.0 m of the ball; the rear-right tyre and a headlight detach.
With `VIBE_NATIVE_FRAGMENT_GRAVITY=0` (the weightless-debris bug) the suite fails:
"loose body does not fall at g (a_y 0.00 over 279 airborne ticks)", "drifts at
constant velocity" (`report-buggy-without-fragment-gravity.json`).

## Found and fixed by these tests

- Fragments inherited the Vehicle2 carrier's disabled gravity on the GPU
  (PhysX `fragmentGravity`, 29e80f33); the bridge's CPU addForce workaround was
  a no-op with device destruction contact inputs.
- Detached parts beyond 36 were never streamed (drawn on the car while flying).
- Debug readback: the stress verdict's `broken` is per step, not persistent
  (now from fracture events); hull rest poses are re-framed from the authored
  vertices (rest rotation now reported; the overlay drew hulls misframed).
- Authoring (recipe `vehicle-physics-interface-11`, joints `vehicle-joints-2`):
  seats joined at upholstery strength (2 kN) tore off on every impact; lamp and
  mirror housings were solid steel (12.1 kg lamps); the headlamp bracket grazed
  the nose panel 3 mm above it (2.9e-5 m²).
- Range aim: the eye line to a far wheel passes through the car; "Fire at part"
  now finds a clear line.

## Known, not fixed

- Stress never converges in float (rejected on ~every step); verdicts are
  published anyway.
- Balls faster than ~24 m/s pass through thin parts between 60 Hz ticks (the
  stage forbids sweep CCD; speculative CCD delivers no fracture load).
- A loose wheel keeps a rest-pose mass frame with posed hulls (COM error bounded
  by the suspension travel).
- Mass authoring elsewhere uses solid steel volumes (buggy 2.49 t; the engine
  crankcase is a 385 kg block welded to the frame and survives any shot).
