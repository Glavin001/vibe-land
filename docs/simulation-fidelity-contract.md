# Simulation fidelity contract

Owner clarification, 2026-09-05: performance improvements must not suppress
physical interactions by limiting forces, impulses, velocities, fractures,
broken bonds or the number of resulting bodies. Apply this constraint to the
ordinary GPU path, Direct GPU path, stress solver, replay and streaming work.

A scenario assertion about localized facade damage is an expectation for its
specific authored structure, initial state and shot. It does not impose a
runtime damage budget. If the physical response requires a progressive or
complete collapse, the simulation must permit it. Investigate the model and
fixture expectation; do not force the output into a desired bond-count band.
Likewise, a retirement or performance guard cannot justify suppressing motion,
artificially weakening loads or freezing debris that should still move.

Material strength, geometry, friction and fracture energy determine the physical
response. Arbitrary computational ceilings are not substitutes for those laws.
Numerical regularization also requires validation: calling a limiter a stability
fix does not establish that it preserves fidelity. Distinguish floating-point
roundoff protection from changing a meaningful force or motion. Residual and
convergence errors must be measured, not hidden by clipping stresses.

Finite storage capacity is an engineering constraint, not permission to discard
interactions. Detect exhaustion explicitly and expand/retry where supported;
do not stream a result as complete after truncating contacts, fracture commands,
wake events or other required work. Preserve full same-tick fracture replay and
publish only committed state. Sleeping/freezing must retain correct support and
wake behavior rather than being used to meet a timing target.

## Initial audit of the current city

This is a partial audit, not a claim that all limits have been removed. No runtime
settings or deployment changed as part of recording this clarification.

| Mechanism | Observed current behavior | Required follow-up |
|---|---|---|
| Body-count cap | `VIBE_CITY_MAX_BODIES` is unset; city resolves to `maximum_bodies = 0` (unlimited). The old positive-value override still exists. | Do not use the override as a performance fallback; remove that escape path from future city configuration. |
| Per-actor bond-break cap | City sets `maximum_fractures_per_actor_per_tick = 0` (unlimited). | Preserve unlimited fracture output through topology changes and replay. |
| Rigid-body angular-speed limit | The live Direct GPU increment uses the SDK numeric range instead of the inherited 100 rad/s ceiling, including fracture children. | Focused momentum/fracture tests and complete release integration suites pass in both GPU modes; broader fidelity auditing remains open. |
| Bending/torsion gain ceiling | `BLAST_BEND_MAX_GAIN` is unset, selecting the existing default ceiling of 3 in the shared stress formula. | Correct and validate the discretization/load model rather than hiding excess stress under a gain ceiling. |
| Depenetration-speed limit | `VIBE_CITY_DEPEN_VELOCITY` is unset; the bridge supplies its existing 1 m/s overlap-correction limit. | Assess its effect on contact impulses and fracture. Do not assume that numerical correction is fidelity-neutral. |

Other inherited defaults, contact-report filters, overflow handling, force
injection, damping and freeze/wake behavior still require inspection. Existing
comments saying there are no velocity caps do not account for inherited engine
defaults and are insufficient evidence.

The Direct GPU qualification in
[the current checkpoint](direct-gpu-city-qualification-2026-09-05.md) establishes
specific observed behavior. It does not establish full compliance with this
contract. Future promotions must report remaining fidelity issues explicitly.

The [rotation-fidelity increment](rotation-fidelity-2026-09-05.md) also corrects
centrifugal load direction and speculative collision bounds. Its tests do not
close the remaining audit items.

The [Direct GPU observation increment](direct-gpu-observation-2026-09-05.md)
removes redundant scene-query scheduling only for exactly unchanged inactive
bodies; active updates are retained. It introduces no motion tolerance or damage budget.

The [GPU contact-ordering experiment](gpu-contact-order-2026-09-05.md) is held
from deployment. Exact-input contact audits passed, but repeated settling
controls showed unresolved behavior differences. The path is opt-in; no
retirement threshold, force, velocity or damage limit was changed to qualify it.

The [contact-wrench correction](contact-wrench-fidelity-2026-09-05.md) preserves
point-force moments, physical mass/inertia scaling and fracture-child contact
coordinates and the solver's signed angular convention. It is held from
rollout: analytical CPU/GPU tests pass, but the corrected physical residual
reveals severe large-graph under-convergence at the city's 32 iterations.
Pre-sign city trials are superseded and do not qualify the final candidate.
A CPU-only multilevel reference validates anchored and free-fragment equations;
its GPU implementation and production qualification remain outstanding.
Load lifetimes, scalar inertia, native quality failures and the other inherited
limits remain open.
