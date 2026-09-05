# Physical contact wrenches and mass scaling

**Held from deployment.** The public city remains on server source `66a7257`,
solver runtime `646a0f41`, with Direct GPU enabled and GPU contact ordering off.
The changes below are on `codex/simulation-frontier`; the numerical multilevel
reference is CPU-only and is not integrated into the game.

The investigation following the [six player reports](city-player-reports-2026-09-05.md)
found missing contact moments, incorrect mass scaling, and an asset/body frame
mismatch after fracture. Correcting them exposed a separate convergence problem:
on the 5,936-dynamic-node anchored building, the physical force residual is
**0.997 at 32 iterations and 0.641 after 2,048** in the current GPU path.
CPU results are similarly poor. Lower breakage from this candidate cannot be
claimed as improved fidelity or used to qualify a performance improvement.

## Implementation

- Accumulate physical force and moment in compensated double sums, then divide
  once by the solver node's actual mass and scalar inertia. Acceleration-mode
  input is converted with actual mass; a supplied free couple is always N m.
- Preserve physical mass/inertia in CPU and CUDA operators. Previously the
  operators substituted equalized values after inputs had already been divided
  by actual values, changing load balance. The low-level CUDA API retains an
  explicit legacy equalization argument; its default and the integrated solver
  use physical values. This C++ API change requires consumers to rebuild.
- Translate physical angular loads at the solver boundary. Its coupling uses
  `v + r cross w`, so the internal angular coordinate is the negative of the
  physical right-handed coordinate. A signed lever test caught the initially
  incorrect sign; it is corrected in the final native candidate.
- Carry a complete force/moment wrench through the additive C batch API and
  PhysX adapter. Recentered children transform world contact points back into
  the authored asset frame. Cached transforms serve snapshot ticks without
  PhysX calls.
- Aggregate city manifolds about a shared origin, preserving zero-resultant
  couples. Opposite actor sides receive opposite force and moment. Crushing
  keeps individual contact points because a wrench cannot recover its virial
  tensor or history.
- Audit CPU/GPU ordering on the same decoded input using both force and moment.
  The parallel-drain verifier now compares point and moment too. Diagnostics
  are disabled for performance measurements.

No force, impulse, velocity, fracture, bond or body budget was added. These are
physical corrections, not a promise of unchanged behavior relative to the old
model. Existing fidelity issues are recorded below rather than hidden by test
band or material changes.

## Analytical checks and native qualification

The old solver returned zero bending for opposing offset forces on both CPU
and GPU. The first moment prototype retained mass equalization and produced
an incorrect absolute result; an independently calculated section modulus
and different masses/inertias exposed it. Neither prototype was deployed.

The square-section fixture has area 9 m² and section modulus 4.5 m³. Opposing
10 N forces separated by 2 m produce 20 N m and **4.444444 Pa** bending stress.
CPU and GPU pass this expectation, cancellation, doubled load, equal moment
with different lever arms, translated asset, reversed order and aggregate
couple variants. The section gain is below the inherited gain ceiling.

A second fixture applies 10 N to a node centered at height 2 m with its joint
at height 1 m. Application heights 1, 2 and 3 m must produce bending stresses
0, 2.222222 and 4.444444 Pa. The initial sign produced 4.444445 Pa at height
1; the final CPU/GPU tests pass the signed expectations. Additional tests cover
compensated cancellation of +1e20, 18 and -1e20 N, unequal masses,
rotated/recentered children through ordinary and snapshot adapter ticks, and
CUDA accumulation of normal/friction couples about an offset origin.

The final native run passes **32/35 CTests**. The remaining failures are:

| Test | Final signed-moment result |
|---|---|
| `load_path` | Weak-material footing does not fail under the fixture load. |
| `reference_building_load_path` | Infill self-weight safety factor 0.7611, below the fixture's required 2. |
| `destruction_quality` | Extreme 40 t impact leaves fragmentation 0.515625; the fixture expects more complete destruction. |

The earlier unsigned prototype failed the same `destruction_quality` test at
its glancing-impact assertion. That is **not** the final failure reason. No
assertions, outcome bands or material limits were relaxed to obtain these results.

## City measurements are from the superseded prototype

`candidate-v1-artifacts.json` identifies the game binaries used before the final
angular-sign correction. Their results remain useful diagnostic evidence but
**do not qualify the final candidate**:

- Release integration: 176 passed, 27 ignored, zero failures.
- A 100-shot audit: 6,801,764 wrench comparisons, zero differences; 1,269 exact
  contact-sequence checks and 5,909,784 legacy-threshold checks, zero mismatches.
  It exercised 432 replays. The restore diagnostic's `moved` count means the
  mismatching pose was restored, not that the restore failed.
- Both ordering modes failed the old T2 outcome band: 114 broken bonds versus
  its minimum 126. Idle tests recorded zero broken bonds. The scenario never
  populated its required 3–6k-awake performance band.
- Three heavy trials per mode, in the 30–60k-contact band: median trial-mean
  ordering time 2.886 ms CPU versus 0.255 ms GPU; total contact pipeline
  8.290 versus 6.048 ms. Populations differed (about 33.7k versus 38.2k mean
  contacts), so these are not identical-state or full-tick speed claims.
- All six 60-second settling trials reached zero awake tail, but peak awake
  counts were only 111–138. That lighter response does not close the previous
  high-load settling concern. No trial reproduced the reports' 5–6k awake load.

The completed game build with the final sign is a compile check only; the
pre-sign city's integration and performance results must not be attached to it.
There is no eligible city artifact from this campaign.

## Corrected residual and next solver direction

The old graph metric fitted a multiplier against equal per-node gravity.
It could conceal a half-sized load response. The corrected metric compares
absolute physical reactions against each anchored node's `mass * gravity`,
without fitting. Its independent exact/half-force check returns 0/0.5 residual.
Free islands need rigid-acceleration accounting rather than static force balance.

| Iterations | GPU anchored-building force residual |
|---:|---:|
| 32 | 0.9970 |
| 128 | 0.9794 |
| 512 | 0.9210 |
| 2,048 | 0.6408 |

The broad 14-case run's relative GPU <= 2× CPU gate is insufficient: both can
be wrong. Earlier `point-wrench-native-qualification.log` also used the obsolete
fitted residual and is retained only as historical evidence. Existing GPU block
Jacobi did not solve the conditioning problem and failed the broader relative
gate. It remains off. Neither more iterations nor a tolerance change alone
establishes a real-time solution.

A CPU/double smoothed-aggregation reference supplies a promising direction:
rigid-motion coarse modes, symmetric block smoothing, exact Galerkin products,
and a residual against the unchanged physical operator. The initial anchored
prototype reached about 1.4e-9 force residual in 28 iterations. This is consistent
with using rigid modes and symmetric smoothing for multigrid-preconditioned CG;
see [hypre's solver documentation](https://hypre.readthedocs.io/en/latest/solvers-boomeramg.html).

The follow-up `demos/blast-stress-demo/tests/multilevel_reference.py` in the
solver repository explicitly separates free-fragment rigid acceleration from
internal load. It checks Newton/Euler acceleration, including orbital inertia,
against an independent calculation, and compares small-graph bond solutions
with a dense minimum-norm solve. Unequal masses, pure torque, free fall,
anchored loads, mixed anchored/free fracture components and coordinate
rotation/translation pass. A 40-node free rod takes 46 iterations; convergence
is not a universal 32-iteration guarantee.

On the exported building, with a stricter 1e-10 iterative tolerance:

| CPU reference fixture | Iterations | Physical force / moment residual |
|---|---:|---|
| Anchored building, gravity | 33 | 1.58e-11 / 1.88e-11 |
| Released building, varied forces and torques | 30 | 1.64e-11 / 2.03e-11 |
| Released building, gravity | 0 internal iterations | 8.26e-14 / 3.30e-18 |

These are numerical results, **not GPU speed measurements**. Setup, storage,
FP32/mixed precision, damage updates, warm starts, device execution and real
fracture outcomes still need implementation and qualification. Equilibrium
alone also does not certify constitutive response or the distribution of bond
stresses in a redundant structure.

## Evidence and remaining limits

The [campaign directory](../bench-results/simulation-frontier/contact-wrench/)
retains prototype failures, exact source/binary fingerprints, test output,
raw traces and reference scripts. Its qualification decision is explicitly
ineligible. Large traces are losslessly compressed; see its README for recovery.
Do not run those GPU harnesses against the live service or overwrite old results
with a new candidate under the same filenames.

Open fidelity issues include scalar/isotropic inertia, approximate aggregate
centers/inertias when graph reduction is enabled (city reduction is zero),
conflated transient-contact and persistent-gravity cache lifetimes, the bending
ceiling, excess-force release/clamping, contact filters, overlap correction and
complete replay state. The [fidelity contract](simulation-fidelity-contract.md)
remains open. The report-related rooted-fragment promotion gap is a separate
unfixed topology issue. None of these is solved by suppressing motion or damage.
