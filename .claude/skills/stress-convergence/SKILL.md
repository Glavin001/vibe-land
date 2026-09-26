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
