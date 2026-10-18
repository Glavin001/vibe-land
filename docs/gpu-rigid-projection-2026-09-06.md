# GPU components, rigid projection and fracture solve sequence

Solver commit `ae858be0` connects exact GPU component discovery and rigid-motion
projection to the resident physical operator and complete CUDA solve. Topology
updates no longer require CPU component assembly in this path. A full fracture
sequence now runs with the initial hierarchy and captured iteration graph kept
resident. **That hierarchy-reuse strategy fails the split convergence gate and
is not ready for deployment.**

The public city remains game `ed9c2ad` / solver `646a0f41`, binary
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`.
Direct GPU, the rooted-fragment wire fix, existing sleep/freeze, 32 solver
iterations, one replay pass and all previous physical settings remain enabled.
This increment does not deploy a server or frontend artifact.

## Implementation

`GpuRigidProjector` retains node coordinates/scaling, original bond endpoints,
component state and scratch on the supplied CUDA stream. A live-bond update:

1. Unions dynamic endpoints with monotone root links and compresses to the
   minimum active-node ordinal. Shared fixed supports do not merge otherwise
   disconnected dynamic components; live fixed endpoints mark anchoring.
2. Sorts nodes by their exact component and constructs component ranges.
3. Builds centered six-mode rigid Gram matrices and Cholesky factors for free
   bonded components. The small residual rotation/translation cross terms are
   retained rather than assumed to vanish.

The projector computes `Q Q^T` implicitly. Anchored components contribute zero;
isolated free nodes use exact identity. Splitting a load retains the whole input
as internal plus rigid motion. No physical load, contact, force, velocity or
fracture threshold is introduced. Nonfinite/invalid factorization is reported
as failure, never repaired by adding a physical anchor or clipping coefficients.
The asynchronous interface exposes device failure state; accepting consumers
must check it. The complete test solver checks it before accepting results.

The first projection kernel reduced every large component in one thread block.
That serialized too much work. The final version computes node contributions
in parallel and uses CUB ReduceByKey for six double-precision sums per component.
The installed CUDA 12.8 CUB documentation specifies run-to-run reduction
determinism on one GPU; this is not a claim of bitwise identity across GPU
architectures. Numerical comparisons use physical tolerances and independent
references, not fitted scale factors.

The preconditioner now applies the current rigid projector before/after its
numerical cycle. Its physical operator uses the current live-bond mask. A single
host membership upload feeds both GPU updates on the same stream. CUDA topology
and projection operations support graph capture with preallocated scratch.
The test's host right-hand-side upload can later be replaced with a device
producer; this increment does not integrate PhysX contact load production.

## Validation

- **36 topology states** across the building, a small mixed graph, and a rotated,
  translated irregular graph all pass exact component membership, CPU QR-based
  projection, load conservation, idempotence and current-operator nullspace
  checks. Isolation/restoration, zero inputs and scales of 1e30/1e-30 are covered.
- Stale component projection, stale bond membership and half-sized response
  negative controls are rejected. Invalid membership/source dimensions reject;
  completed-solve graphs leave outputs unchanged.
- **32 static solves pass**: 16 with the GPU projector and 16 reference-projector
  controls, covering anchored/free states and float/double preconditioners.
- The full eight-state sequence independently checks current physical matrices,
  projected inputs and original-order bond outputs. Its float and double runs
  each pass 14/16 samples and **fail both samples of the split frame** at 256
  iterations. These are open quality failures, not passing release tests.
- A diagnostic allowing up to 1,024 iterations passes all 16 sequence samples;
  the split actually takes **326 iterations**. Its ~69.5 ms float solve is too
  expensive. Raising the production limit is not the selected solution.
- A one-iteration negative sequence fails as intended, while its fully isolated
  frame has exact zero internal response and needs zero iterations.
- CUDA Compute Sanitizer reports **zero errors and zero leaked bytes** for the
  small transition suite and the integrated large free-building solve. Its
  instrumented ~417 ms solve is excluded from performance results.
- The independent fracture fixture reproduces byte for byte from final source.
  CPU reference solves build a fresh hierarchy for each distinct current
  topology. Identical restored topologies reuse the already-computed reference;
  the fully isolated result is analytic zero internal stress.

Every GPU run used the scoped exclusive wrapper after builds finished, with no
players connected. The exact city binary/settings were restored after success
and after the first unexpected sequence failure. The final CPU fixture
reproduction overlapped only the instrumentation run, not performance timing.

## Performance and what failed

On the 5,936-node / 18,627-bond building, membership plus GPU topology updates
measure **0.083–0.373 ms** in the final transition tests. The largest projection
relative error is **2.06e-14** against the independently rebuilt CPU basis.
The combined operator/bond-response/two-projection graph measures approximately
0.049–0.082 ms. These are primitive measurements, not full destruction ticks.
The transition log's `resident_bytes` covers the bond operator only, and its
`graph_captures` counts the application graph; projector scratch and its separate
topology graph are additional.

Static warm medians, last three of four solves, RTX 4090:

| State / preconditioner | Reference projector | GPU current-component projector |
| --- | ---: | ---: |
| Anchored / float | 6.001 ms | 7.489 ms |
| Free / float | 6.357 ms | 7.138 ms |
| Anchored / double | 10.755 ms | 12.277 ms |
| Free / double | 10.690 ms | 11.505 ms |

The free/float GPU-projector case fell from **15.146 ms** in the initial serial
implementation to **7.138 ms**. Anchored solves still pay unnecessary projection
launch/reduction overhead; the reference path can skip it because it knows the
static anchoring on the host. A changing GPU topology needs an equivalent
conditional fast path without trusting stale anchoring.

Using the initial hierarchy throughout the fracture sequence gives:

| State | Iterations | Result |
| --- | ---: | --- |
| Original / restored | 31 | Pass |
| Released | 54 | Pass |
| Split into two free components | 256 | Fail: physical residual ~2e-6 |
| Completely isolated | 0 | Pass, exact zero internal load |
| Partial damage | 157 | Pass, still expensive |
| Split, high-iteration diagnostic | 326 | Pass, ~69.5 ms float |

The independent fresh-component references take 38 and 33 iterations for the
two split pieces. This is evidence that unchanged hierarchy reuse is a poor
preconditioner after this cut. Exact GPU component tracking and projection do
not solve that numerical problem by themselves. No city speedup is claimed.

## Next required work

Refresh the numerical preconditioner from the **current** physical operator
without rebuilding all structural setup. Retaining interpolation while updating
Galerkin operators and the coarse solve is a candidate to test against the
retained split/partial-damage sequence. Its acceptance must include physical
residuals and bond response, not just fewer iterations. Keep the current failure
visible until that work closes it. Then address the anchored projection fast
path and integrate the qualified solver with production damage and same-tick
replay. Earlier physical-quality, settling and heavy streamed-city gates remain
required before deployment.

## Reproduction

Configure `demos/blast-stress-demo/build-gpu-activity` and build
`resident_rigid_projector_test` and `multilevel_gpu_test`. The transition test
accepts a BLSTPG01 input or creates its small mixed case by default. The
rotated irregular input is retained directly in the evidence directory.

Generate the sequence with one BLAS thread:

```bash
OPENBLAS_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1 python3 \
  demos/blast-stress-demo/tests/export_fracture_sequence.py \
  --input /tmp/physical-graph-final/building-anchored-component.input \
  --out /tmp/building-fracture-sequence.bin
```

The complete solve uses `--native-graph`, `--resident-operator`,
`--gpu-projector` and `--sequence`. Full commands, expected failures, source and
input hashes, initial/final logs and restoration evidence are under
`bench-results/simulation-frontier/gpu-rigid-projection/`. Its verifier checks
archived evidence without starting a GPU workload, and explicitly reports the
release gate as failed. The runner's expected exit 1 for that known failure
allows collection to continue; it does not qualify the candidate for release.
Run GPU commands only through the existing exclusive wrapper. Earlier input
reproduction is in `physical-graph-integration-2026-09-06.md`.

Commits remain local. No new push was attempted following the earlier automatic
approval rejection of private-source upload.

## Setup follow-up

[GPU hierarchy setup](gpu-hierarchy-setup-2026-09-06.md) records the next
experiment, solver `555ed503`. Retaining interpolation while refreshing current
matrices still takes 243 iterations on the exact-native split case; fresh
unsmoothed interpolation takes 142. The new CUDA coarse-product backend reduces
warm static setup by about 26–29%, with independent physical checks passing.
It does not close this document's dynamic split gate or change the city release.

## Current-component sequence follow-up

Solver `0ef769fa` now passes the numerical fracture sequence with fresh sparse
component hierarchies: 192/192 final samples pass and the split takes 36
iterations. This resolves the earlier standalone split convergence case.
Rebuild/upload overhead is still too high for deployment; production integration
is incomplete. See [component hierarchy evidence](component-hierarchy-2026-09-06.md)
for the controls, safety checks and complete cost breakdown.
