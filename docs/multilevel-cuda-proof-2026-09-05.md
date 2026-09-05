# Physical multilevel solve on CUDA

The multilevel method now runs on the RTX 4090 and passes comparisons against
the CPU reference. **This is a standalone numerical proof, not a deployed game
solver.** The public `/city` remains on its existing Direct GPU observation
build; its server binary is unchanged.

The [contact-wrench investigation](contact-wrench-fidelity-2026-09-05.md) found
severe under-convergence after correcting the physical equations: 0.997 force
residual at 32 iterations on the largest anchored building. The next solver
must remove that error while remaining fast enough for real destruction. An
under-solved result with fewer fractures cannot qualify as a performance gain.

## What was implemented

In the solver repository:

- `demos/blast-stress-demo/tests/export_multilevel.py` exports the exact physical
  operator, reference bond solution and a CPU-built multilevel hierarchy.
- `demos/blast-stress-demo/tests/multilevel_gpu_test.cu` runs preconditioned CG
  with persistent device buffers, CUDA graph iteration and device reductions.
  The host observes only scalar convergence state every eight iterations.
  Full solution readback is used after the solve for independent validation.
- The physical operator, outer vectors and reductions remain double precision.
  A flag selects double or float storage/arithmetic inside the preconditioner.
  The mixed path normalizes its input by a scalar and restores the scale on
  output. The original physical right-hand side is unchanged.
- The V-cycle's first matrix product at each level always multiplied zero.
  Its exact first update is evaluated directly, removing six launches and
  three unnecessary matrix reads across this three-level hierarchy.
- Free fragments use their known rigid-motion null space; they are not pinned
  or given artificial anchors. The updated physical operator is used even in
  the experiment that reuses the hierarchy from before anchor removal.
- The CPU reference's Newton/Euler comparison now uses an input-scaled
  roundoff allowance. Its old fixed absolute tolerance depended on units,
  accepting tiny-load errors while rejecting cancellation at huge scales.
  The failed assertion is retained. No material, damage or physical output
  band was changed to qualify the solver.

A separate comment correction removes an incorrect claim that grouping
separated components preserves finite-iteration CG results. Current partition
code checks connectivity; an exhausted connectivity-check budget forces a
full rebuild. Reusing a numerical preconditioner does not authorize stale
component labels or shared stopping tests. Runtime partition logic is unchanged.

## Measurements and correctness

The fixture is **one building with 5,936 dynamic stress nodes**, 18,627 bonds
when anchored and 18,564 after removing anchors. Those nodes are not 5,936
awake rigid bodies. This does not reproduce the player reports' destruction
population or a complete server tick.

Each final arm ran four identical-input solves in one process; the table uses
the median of the last three. Every solve passed the same physical force/moment
residual and CPU bond-solution checks. This measures warmed solving with an
already-built, already-uploaded hierarchy; it excludes CPU setup, upload,
contact handling, fracture, PhysX, rollback and streaming.

| Final fixture | Precision inside preconditioner | Iterations | Median warmed CUDA solve |
|---|---|---:|---:|
| Anchored, gravity | Double | 33 | 10.632 ms |
| Anchored, gravity | Float | 33 | **5.851 ms** |
| Free, varied forces/torques | Double | 30 | 10.589 ms |
| Free, varied forces/torques | Float | 30 | **6.214 ms** |
| Free, hierarchy retained from before anchor loss | Float | 53 | 10.864 ms |
| Free, all loads multiplied by 1e30 | Float | 30 | 6.215 ms |
| Free, all loads multiplied by 1e-30 | Float | 30 | 6.208 ms |

The mixed path's force/moment residuals are approximately 1.3e-11–2.1e-11.
All **28 final solves** pass. Reference bond relative errors are below 2e-11,
including the reused hierarchy; fresh-hierarchy errors are below 1e-12.
The low/high load tests use the same matrix and preserve homogeneous scaling.
Simultaneous extreme magnitude differences and near-threshold fracture
classification still require integration tests.
A deliberately incomplete one-iteration solve is rejected, with force residual
20.42. Hitting an iteration budget does not produce a passing result.

CUDA Compute Sanitizer reports **zero memory errors and zero leaked bytes**
on the final mixed-precision path with the large-load fixture. Its instrumented
417.8 ms timing is excluded from performance results.

The initial all-double implementation took about 11.8 ms anchored. Float
storage with double arithmetic was slower (about 14.0 ms), so that was not
accepted as an optimization. True float preconditioning reduced the earlier
implementation to about 6.3 ms; eliminating the zero-state work and adding
range normalization produced the final results above. Historical source
snapshots and failed experiments remain in the evidence directory.

Isolated CUDA-event phase graphs identify the preconditioner as the main cost;
these timings do not add up to a measured city tick. Nsight hardware counters
were unavailable (`ERR_NVGPUCTRPERM`), so no counter-derived bandwidth or
occupancy claim is made. Driver permissions/settings were not changed.

## Evidence and reproduction

[Evidence directory](../bench-results/simulation-frontier/multilevel-cuda/):
`summary.json`, final and historical logs, source/binary hashes, fixture
checksums, exact historical source archives and reproduction scripts.
The final exporter reproduced **all five tested fixtures byte-for-byte**.
Their roughly 70 MiB binary expansions are generated from the previously
committed graph rather than duplicated in Git.

From the solver checkout, build `multilevel_gpu_test` through the existing
`demos/blast-stress-demo` CMake configuration. Export a fixture with
`export_multilevel.py --graph GRAPH.json.gz --out FIXTURE.bin`, adding
`--release --loads random` for the free building. Use one BLAS thread, as
recorded in the reproduction script. Run the executable with
`FIXTURE.bin --float-preconditioner --solves 4` after stopping competing GPU
work through the deployment's ownership-aware, no-player wrapper.

All recorded GPU tests used exclusive GPU access. The wrapper restored the
exact previous city binary and environment, and the final identity/health check
confirmed restoration. `summarize.py` checks the retained evidence without GPU
access or a restart.

## Work required before game integration and rollout

1. Replace offline Python setup with a native hierarchy implementation and
   measure its construction/update cost. Current setup is not a per-tick path.
2. Batch real components and their rigid null spaces, including isolated nodes,
   small debris, anchored/free mixtures and changes during fracture. The CUDA
   proof handles one component; CPU tests cover additional split configurations.
3. Feed device force/moment data into the solve and return device bond results
   through the existing stress/fracture pipeline. Preserve physical load
   lifetimes and same-tick rollback/re-simulation ordering.
4. Update the physical operator and exact component membership immediately
   when topology changes. Reusing the old hierarchy after anchor loss preserved
   accuracy but increased iteration cost; it does not qualify general damaged
   hierarchy reuse or production rebuilding policy.
5. Validate the integration against native physical-quality failures, complete
   city/replay/settling tests and repeated heavy destruction at the reported
   5–6k-awake load, including full-tick and streaming costs. Broader scalar
   inertia, constitutive, contact and excess-force issues remain open.

The rooted-fragment promotion gap identified from the player reports remains
an independent outstanding topology fix. No force, impulse, velocity, fracture,
bond or body cap was added by this increment. No new game build was deployed.

The next [native setup increment](multilevel-native-setup-2026-09-05.md) replaces
Python hierarchy construction in the standalone harness, adds exact-zero and
free-fall checks, and measures the remaining construction cost. It is also held
from game deployment.
