# Fresh component hierarchies through the fracture sequence

Solver `0ef769fa` resolves the standalone numerical split failure from
[GPU rigid projection](gpu-rigid-projection-2026-09-06.md). Rebuilding each exact
current component's hierarchy reduces that split from **326 iterations to 36**.
All **192 rebuilt sequence samples pass** their independent physical checks.
The float split solve takes **8.381 ms** in the final three-run measurement.

This is not yet a faster complete fracture step. The same split spends about
**135.162 ms rebuilding** and **7.312 ms uploading/recapturing**, before its
solve. Even the old high-iteration diagnostic took only about 69.5 ms to solve
with the already-resident hierarchy. The new rebuild path must become much
cheaper before it is a performance improvement or a deployment candidate.

City remains game `ed9c2ad`, solver `646a0f41`, with Direct GPU, the rooted-fragment
wire fix and existing physical settings. No server/client deployment occurred.
The final binary hash is unchanged:
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`.

## What changed

`buildComponents` creates a fresh multilevel hierarchy for every exact bonded
component in the current physical graph, then combines them into one hierarchy:

- Each component keeps its own Jacobi smoothing parameter. In merged levels,
  that parameter is folded into its inverse diagonal, with composite omega 1.
- Components that finish coarsening early pass through deeper levels with
  identity interpolation and zero smoothing. This makes the combined cycle
  equivalent to independent component cycles despite different depths.
- Terminal inverses form a sparse block-diagonal matrix. There is no dense
  matrix whose width is the total width of every fragment's terminal problem.
- Isolated nodes have zero internal response; the current GPU rigid projector
  retains their full rigid-motion contribution. No physical rows or loads are
  dropped from the outer solver.
- A single connected structure whose rows already match the caller transfers
  matrix ownership directly, avoiding the component embedding copies. The
  sequence loader also moves hierarchy matrices into its solver fixture.

The CUDA test solver can now replace hierarchy buffers, use a sparse terminal
inverse and recapture its iteration graph. Its original physical bond coupling,
outer vectors and GPU current-component projector remain allocated across the
sequence. Bond membership changes preserve original bond output order, including
restoration from removed to live.

`--rebuild-hierarchy` selects this path in `multilevel_gpu_test`; optional
`--gpu-galerkin` uses the compact GPU coarse-product backend. Current physical
assembly, component orchestration, QR/aggregation and hierarchy composition are
still on the CPU. GPU topology discovery is independently used by the rigid
projector; it is not yet the source of the hierarchy builder's component list.
The whole path remains outside production stress-solver selection.

No forces, moments, velocities, contacts, bonds or fractures are clipped or
limited. Smoothing changes affect only the numerical preconditioner; the
physical operator and acceptance oracle remain unchanged. The original CPU
hierarchy still exports byte-identical fixture data.

## Validation

The sequence covers original anchored topology, support release, a two-piece
split, complete isolation, restoration, partial damage, release again and final
restoration. Each current physical matrix is independently compared before
hierarchy construction; final force/moment residuals and original-order bond
responses are checked against the independent fracture fixture.

- Three process runs for each of CPU/GPU coarse products and float/double
  preconditioners, two solves per state: **192/192 pass**. Physical operators,
  outer vectors and reductions remain double precision.
- The unchanged-hierarchy control still fails both split samples at its
  256-iteration validation limit. This confirms the experiment addresses the
  failing case; it does not hide it by raising the limit.
- A one-iteration negative control fails all nonzero internal-load states;
  the fully isolated state correctly succeeds with zero iterations.
- The complete eight-state rebuilt GPU sequence passes Compute Sanitizer with
  **zero errors and zero leaked bytes**, including destruction/replacement of
  hierarchy buffers and CUDA graphs between states. These instrumented timings
  are excluded from performance results.
- CPU component tests compare the combined cycle with separate native cycles
  for scattered row ordering, shared fixed supports, anchored/free fragments,
  isolated nodes and different hierarchy depths. Existing native tests pass.
- A 10,000-node fragmented test has a 60,000-row sparse terminal matrix with
  zero entries when fully isolated, and only 40 stored values with one remaining
  two-node bond. It avoids the potential 28.8 GB global dense inverse.
- The CPU composition tests also pass AddressSanitizer and UndefinedBehaviorSanitizer.

The fixture restores topology; it is not a complete PhysX rollback simulation.
Production force injection, fracture commands, body lifecycle, rollback and
settling still require integration and qualification with this solver.

## Final costs

RTX 4090 / CUDA 12.8. Medians below use three complete process runs of the GPU
coarse-product / float-preconditioner arm. Each frame has three rebuild/upload
samples and six solve samples. These columns have different sampling windows;
their medians are not an independently measured total tick time.

| State | Iterations | Solve | Host preparation + hybrid rebuild | Upload + graph recapture |
| --- | ---: | ---: | ---: | ---: |
| Original | 31 | 6.433 ms | 171.656 ms | 8.425 ms |
| Released | 30 | 7.031 ms | 155.654 ms | 8.349 ms |
| Two-piece split | 36 | 8.381 ms | 135.162 ms | 7.312 ms |
| Fully isolated | 0 | 0.010 ms | 11.094 ms | 1.148 ms |
| Restored | 31 | 6.434 ms | 160.834 ms | 7.190 ms |
| Partial: seven bonded components, one isolated node | 44 | 9.321 ms | 143.838 ms | 8.213 ms |
| Released again | 30 | 7.029 ms | 152.708 ms | 8.616 ms |
| Restored again | 31 | 6.429 ms | 145.541 ms | 8.276 ms |

Topology/RHS update is separately recorded, as are physical assembly and native
hierarchy setup within the preparation span. The fully isolated rebuild has
substantial host timing variation (other arms are around 1 ms); its lack of
internal solve work is exact, but its host wall-time result is not a floor.
CPU coarse products produce the same iteration counts and similar GPU solve
times; their split rebuild median is 158.806 ms. Double-preconditioner split
solve time is 13.408 ms. Neither variation changes release eligibility.

## Remaining work and report follow-up

The split's numerical convergence problem is resolved by fresh component
hierarchies. The performance problem now has direct evidence: host physical
assembly/validation, aggregate/basis construction, repeated representation
conversion, device uploads and graph recapture dominate. The next solver work
is a resident builder using current component data and retained storage, with
the same transition/physical checks. There is no performance case for deploying
the current hybrid rebuild on every fracture.

The gameplay reports also show expensive rollback. Source inspection confirms
that the live scene uses the custom SDK's Direct GPU **host-access** capability
and the adapter still invokes per-body CPU motion setters. The SDK queues these
commands into metadata uploads for the next simulate; this is **not evidence
of a separate GPU synchronization per setter**. More precise restore profiling
is needed before attributing the report's cost or selecting a batch rewrite.
Any replacement must preserve query/host mirrors, mass-frame velocity shifts,
sleep/wake state, pending forces and fracture-created body provenance.

Evidence, exact command lines, source/fixture hashes, controls and restored city
state are in
[`component-hierarchy`](../bench-results/simulation-frontier/component-hierarchy/summary.json).
Run `python3 bench-results/simulation-frontier/component-hierarchy/verify-results.py`.
The verifier explicitly distinguishes the passing numerical case from the
unqualified end-to-end performance and production integration.
