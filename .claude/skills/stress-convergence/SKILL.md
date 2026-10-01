---
name: stress-convergence
description: What to do when the native stress solve does not converge, a structure fractures under ordinary load, or you are tempted to switch to double precision, raise iterations or loosen tolerance. Non-convergence is almost always an authoring problem; check the authored graph first. Use for vehicles, buildings and any native destructible.
---

# When the stress solve will not converge, check the authoring first

A structure that is authored consistently converges in single precision.
The float (FP32) runtime is the product. Double precision (`BLAST_STRESS_GPU_FP64`) is
far slower and is only a diagnostic. Do not ship it as a fix, and do not "fix" a
failure by raising iterations or loosening tolerance. When a solve fails, is
rejected, or breaks bonds under loads that should be harmless, suspect the
authored data before the solver.

## First, confirm what actually ran

- **Runtime.** `DYLD_LIBRARY_PATH` placed in front of `scripts/perf/gpu-run.sh` is stripped by macOS SIP
  when `/bin/bash` starts, so the test silently loads the SDK's default runtime.
  Pass it inside the wrapper: `gpu-run.sh label env DYLD_LIBRARY_PATH=... cargo ...`.
- **Lock.** The GPU lock is held by whoever owns it, including the play server.
  A queued test prints nothing while it waits.

## The tools (structure qualification)

Measure, do not guess. In order:

1. **Lint** (no GPU): `cargo test -p web-fps-server --bin web-fps-server lint_city_structures`
   and `VIBE_VEHICLE_BUILD_FIXTURES=... lint_vehicle_builds` (`-- --ignored --nocapture`).
   `destruction/src/structure_lint.rs` runs the checklist below on the graph the
   stage gets: slivers, stiffness spread, mass contrast across a bond,
   unrealizable inertia, floating/disconnected parts, sole attachments rated in
   g of what hangs from them, bonds across moving rig joints. City buildings:
   spread ~40, mass ratio ~14. Fleet cars (2026-10-01): spread 1e6-4.5e7, ratio
   500+.
2. **Solve report** (GPU, PxDestructionScene v23): `World::native_set_stress_solve_report(passes)`
   then `native_stress_solve_report()` each step. Per component: why the solve
   stopped (converged / iteration cap / stagnated / degenerate / failed), the
   residual at iteration 0 and every power of two, and each chunk's share of
   what is left; per chunk, its stress input by source (prepared loads,
   constraints, contacts). `passes` bit 0 is the trial solve that decides what
   breaks (the corrected re-solve after a split would hide it).
   `server/src/structure_qualification.rs` `SolveTally` turns a run of reports
   into one verdict: converges / cut off at the cap (extra iterations
   extrapolated from the component's own history) / stalled (no iteration
   count helps) / diverged (ended >10x worse than it started -- its forces are
   garbage), plus the chunks holding the residual.
3. **Load cases**: `city_structures_qualify` (every city building at the city's
   cap, at rest and after a cannonball) and the vehicle lab
   (`physx_runtime/vehicle_lab.rs`: airborne, park, cruise, rough course, kerb,
   debris, walls, cannonball). Airborne vs park separates the structure from
   the loads injected on the ground.
4. **What-ifs before authoring changes**: `VIBE_TEST_MASS_FLOOR` (kg),
   `VIBE_TEST_BOND_WEIGHT=modulus|area|length|all`, `VIBE_BOND_CONTACT_LENGTH`,
   `VIBE_BOND_STIFFNESS_EXPONENT`, `VIBE_BOND_STIFFNESS_CLAMP`,
   `VIBE_GARAGE_STRESS_ITERATIONS/TOLERANCE`. A what-if that converges says which
   property to fix; it is not the fix. Use `${=cfg}` for multi-variable
   configs in zsh loops.
5. **Price every concession**: `VIBE_LAB_REPORT_NAME=` two runs (a converged
   reference at a high cap, the candidate) and
   `scripts/perf/compare-bond-loads.py ref.json cand.json` reports how far
   each load-bearing bond's stress moved.

Verify any "needs N more iterations" by running at that cap: the monster's
rough-course solves extrapolated to ~100 more at 64, then at 1024 stalled at
2.5x tolerance -- a floor, not a budget.

## Authoring checks, cheapest first

1. **Interface area distribution.** Tabulate the bond areas. The bridge floors stiffness at
   1e-4 m² (`append_bonds`: `max(area, 1e-4)`), while strength (`health`) uses the
   true area. So a sub-floor interface is made up to hundreds of times too stiff,
   draws load it cannot carry, and breaks or ill-conditions the system. On 2026-09-26, 7–8% of
   vehicle bonds were 1e-8 to 1e-5 m² slivers. Removing them let trophy and monster settle
   and drive with zero breaks (`docs/reports/vehicle-wheel-colliders-2026-09-26`).
2. **Measured area against real overlap.** Bond area comes from coplanar faces of the
   simplified collision hulls. Curved or angled contacts (tube nodes, panels on tubes)
   share almost no flat face even when the exact solids overlap by several cm³.
   Compare the area against the solid overlap volume (`overlapRemovedM3` in `model.bin` joints).
3. **Strength/area consistency.** Every weight the solver uses (stiffness, compliance,
   area) must come from the same quantity as the strength it is checked against.
4. **Contacts that are not attachments.** Bonds between parts that move relative to each other,
   incidental grazes, or rotating/stationary contacts (see `anchorRigJoints` and `mechanicalJoints`).
5. **Mass data.** Tiny or zero mass or inertia, an unrealizable tensor, a COM far from its
   chunk, or near-duplicate nodes.
6. **Connectivity.** Islands held by one tiny interface, or graphs that are almost disconnected.

Only after the authored graph is consistent is a solver change worth investigating.
Then prove it with a controlled A/B and an independent oracle
(see `debugging-discipline`), not with a precision or iteration increase.

## Related

- `diagnose-structure-failure`: reading the structural audit card.
- `city-physics-tuning`: material strength and load scales.
- `debugging-discipline`: A/B controls and proving a negative.
