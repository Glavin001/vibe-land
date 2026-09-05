# Rotation fidelity and Direct GPU contact bounds, 2026-09-05

This increment follows the owner's no-clipping requirement. It corrects motion
and centrifugal stress; it does not introduce a force, speed or fracture budget.
City rollout and performance qualification are separate from the focused proofs
below. The broader simulation-frontier goal remains open.

## Changes

- The game bridge and Blast adapter now request PhysX's largest supported angular
  speed range, `1e16` rad/s, instead of inheriting its 100 rad/s default. Adapter
  creation covers fracture children; crush debris receives the same setting.
  This removes the practical 100 rad/s trajectory ceiling. It does not make
  floating-point arithmetic or the SDK's supported numerical range unlimited.
- Centrifugal stress now receives the outward inertial acceleration
  `-omega × (omega × r)`. The former inward acceleration produced compression
  where a spinning bar needs tensile bond forces to maintain its rotation.
  This input is shared by the CPU and CUDA stress solves. The Rapier regression
  previously encoded the incorrect compression expectation; its material now
  distinguishes correct tensile failure from that sign error.
- The experimental PhysX patch computes rotational search inflation from local
  geometry relative to the body's center of mass. Extents alone missed the
  orbital motion of offset shapes. CPU world bounds are also stale in Direct GPU
  mode; combining them with observed GPU positions produced an expanding halo.
  The new calculation requires no world-bounds readback or publication.
- Rotational search inflation uses `min(|omega|*dt, 2)*R`. Every shape point is
  inside radius `R` about the center of mass, so any rotation can displace it by
  at most `2*R`. The arc-length estimate remains tighter for small rotations.
  This is a geometric envelope, not a cap on motion, impulses or contacts.
  It retains the existing velocity-prediction assumptions of speculative CCD;
  it is not a proof of exact continuous collision detection under arbitrary
  acceleration. Speculative CCD stays enabled.
- The SDK builder explicitly selects the `_64` artifact names consumed by the
  adapters. Without `PX_OUTPUT_ARCH`, a reconfiguration wrote unsuffixed archives
  while old suffixed archives passed the previous existence check. The manifest
  now lists only the required consumer artifacts, including PVDRuntime.

The radius calculation still executes in PhysX's CPU speculative-contact task.
Moving it and the remaining contact/load assembly to the GPU remains work to do.
This increment does not claim a measured city speedup.

## Focused evidence

The new native `velocity_fidelity_test` tests a two-mass rotor at 50 and ±500
rad/s, analytically checks `tension = m*omega^2*r/area`, distinguishes strong and
weak tensile materials, restores through a real fracture, checks total momentum,
and verifies continued spin of the children. It explicitly checks which stress
backend executes. Geometry, collision detection, and solver iteration settings
are identical across the CPU, ordinary GPU and Direct GPU arms.

The game bridge test applies opposed off-center impulses to a unit cube. Their
net linear impulse is zero, and their torque gives the known target angular
speed. Subsequent expectations explicitly account for the existing damping.

Observed diagnosis:

| Candidate | Observation |
|---|---|
| Before the changes | Requested 500 rad/s becomes exactly 100 in all three physics modes. |
| Speed ceiling removed | Motion reaches 500, but the solver reports 137,500 Pa compression instead of tension. |
| Stress sign corrected | The weak bond breaks. GPU children then acquire spurious motion with speculative CCD; disabling CCD only in a diagnostic fixture removes that anomaly. |
| Initial SDK rebuild attempt | Still linked stale `_64` archives; this run did not exercise the intended SDK correction. |
| Geometric envelope using CPU world bounds, correct artifacts | CPU and ordinary GPU pass; Direct GPU still fails because those world bounds are stale. |
| Geometric envelope using local geometry | All three physics modes pass with speculative CCD enabled, including both spin directions. |

The focused native campaign passed 6/6 CTest cases: rotation in three modes,
Direct GPU checkpoint, GPU sleeping/wake activity, and Direct GPU contact drain.
The selected Rust solver suites passed 38 tests (2 centrifugal wiring, 4 free
island loads, 32 solver tests). The standalone Rust command requires
`--features rapier,scenarios`; using only `rapier` encountered an existing
`scene_pack`/optional-serde feature configuration error.

An independent geometry audit sampled 74,880 rotated box corners, including
unequal extents and offset centers. The new envelope had zero violations within
roundoff; the old extents-only radius failed 11,434 samples. This supports the
geometric derivation, not a claim that every engine collision case was tested.

Evidence is under
[`bench-results/simulation-frontier/velocity-fidelity`](../bench-results/simulation-frontier/velocity-fidelity).
Diagnostic logs describe successive candidates; only the final sources and
current SDK manifest define the candidate for city qualification. Raw timings
from these tiny fixtures are not city performance measurements.

## Remaining qualification

The rebuilt city candidate needs its complete release integration suites,
city scenarios, replay audits and deployment/browser verification. Its initial
focused success does not certify the city's full fidelity or performance.
The inherited bending/torsion gain ceiling, depenetration behavior and other
items in [the fidelity contract](simulation-fidelity-contract.md) remain open.
