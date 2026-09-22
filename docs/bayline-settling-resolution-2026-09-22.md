# Bayline settling: cause and fix — 2026-09-22

Resolves the settle failures in the [handoff](bayline-handoff-2026-09-22.md)
and corrects the [morning diagnosis](bayline-settling-zombie-bodies-2026-09-22.md).
SDK change: `physx-2` branch `claude/settle-dead-fragments`, commit `05645289`,
qualification in `physx-2/qualification/fragment-depenetration-20260922/`.

## Cause (measured)

Inside the SDK, per step, for a stuck fence rail (2.7 kg): island node active
and in the solver's body list, `PxgBodySim` sane and equal to the CPU mirror,
solver record at the expected slot with gravity applied at pre-integration,
integration output equal to input (Δp ≈ 1e-6 m, Δv ≈ 3e-5 m/s). Its contacts:
the static ground below (one end 7 cm inside it, impulses 7–17 N·s/step) and a
52 kg piece 10 cm inside it from above (impulses up to 27 N·s/step), itself
under a heavier slab. Lifting the rail 1 m makes it free-fall at *g* and land
normally. So: fast meteor debris (~70 m/s, 1.2 m/step) tunnels the 18 cm deck,
lands buried, and with PhysX's unbounded depenetration clamp the opposing
push-out biases (metres per second each) plus eight PGS iterations across a
2.7 : 52 : ~200 kg stack settle into a fixed point. Heavier neighbours do a
period-2 cycle (7 cm teleport per step) and keep the whole island awake.

Ruled out by measurement: CPU/island activity desync (seven fragments stranded
"activating" for <20 steps at impact, then fine), stale GPU slots, phantom
kinematic velocities, stabilization as the cause, TGS (dissolves stacks but
changes the impulses the stage reads as load: porch cannonball 1,616 → 6,834
breaks), iteration count (16 happens to work, 32 sticks again), a whole-body
depenetration cap (settles, but halves the projectile's trial impulse against
the anchored remnant: cannonball bounces off, 242 breaks instead of 1,799).

Fixture bug found on the way: `run.py` hard-coded
`VIBE_CITY_NATIVE_DEPEN_VELOCITY=0` into the child environment, so earlier cap
experiments (including, possibly, the ones behind "depenetration cap alone
does not let a pile sleep") never applied a cap. It now passes the env through.

## Fix

SDK: `PxDestructionStressDesc::fragmentMaxDepenetrationVelocity` (v18; 0 =
inherit). Free fragments get the clamp at creation on the GPU; supported
remnants keep the parent's unbounded clamp. A pair uses the tighter clamp, so
debris push-out is bounded while projectile-versus-structure trial impulses —
which decide fracture — are unchanged.

App: bridge accepts v18 and passes `VIBE_CITY_NATIVE_FRAGMENT_DEPEN_VELOCITY`
(default 0, unchanged behaviour); `VIBE_PHYSX_STABILIZATION=0` and
`VIBE_PHYSX_SOLVER=tgs` knobs (defaults unchanged); harness gains `sleepAudit`,
`wakeProbeTick` (negative speed = lift probe), `TOWN_KIT_DIAGNOSTIC_BINARY`,
and records the SDK path's revision and dirty state.

Qualified setting: **stabilization off + fragment cap 0.5 m/s**, 8/2 contact
iterations, correction limit 1.

| Case | Production (stab on, uncapped) | Stab off + fragment cap 0.5 |
| --- | --- | --- |
| Deployed bungalow, cannonball | 1,799 breaks, **147 awake at 90 s**, 4.5 ms/tick | 732 breaks, asleep 4.8 s after impact, 0.50 ms/tick |
| Deployed bungalow, meteor | 1,381, asleep 4.1 s | 1,382, asleep 3.8 s |
| Deployed porch house, cannonball | 1,616, asleep 4.3 s | 1,616, asleep 2.6 s |
| Deployed porch house, meteor | 809, asleep 6.2 s | 809, asleep 3.4 s |
| v2 bungalow, cannonball | 1,113, **149 awake** | 1,117, asleep 14 s |
| v2 bungalow, meteor | 1,938, **451 awake** | 1,992, asleep 47 s (stress solve still iterating at 90 s) |
| v2 porch, cannonball | 1,362, asleep 12 s | 1,044, asleep 11 s |
| v2 porch, meteor | 3,232, **823 awake** | 3,204, asleep 34 s |

All eight: intact gate passed, zero escaped bodies, zero awake at 90 s. The
bungalow-cannonball break difference is siding torn along the full length of
both side walls (and floor bonds) while the ball flew through the interior —
push-out artefact, not the ball hitting those walls; front breach and far-wall
exit are the same (trial breaks 474 vs 486). With stabilization left on plus
the cap, two of three failing cases pass and one keeps a 22 kg roof piece in a
freeze/thaw slide cycle.

Evidence: `structures/town-kit/out/reviews/house-cannonball/f-frag05-*`
(qualified set), `q-depen05-*` (whole-body cap), `ab-*` (sweeps),
`sdkaudit*`/`sdktrace*` (SDK audits), and the SDK's `evidence.json`.

## Not claimed / open

- The stress solver keeps 16 iterations/tick running on a fully asleep damaged
  remnant for up to a minute (5 ms/tick per house); the v2 bungalow meteor
  fails the gate on that flag alone. Separate engine cost, untouched.
- No 36-building or continuous-play measurement yet; that precedes deployment.
- Meteors still rebound off the deployed roof; `residential-v2` (which
  penetrates) is now qualifiable on settling but has not been promoted.
- Debris still tunnels thin decks; the cap bounds what happens afterwards.
