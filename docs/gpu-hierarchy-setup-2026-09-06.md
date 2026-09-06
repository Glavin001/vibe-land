# GPU hierarchy setup and current-topology experiments

Solver commit `555ed503` adds an optional CUDA backend for constructing exact
coarse matrices in the multilevel preconditioner. On the 5,936-node building,
the compact variant reduces warm native hierarchy setup from **145.6 to
108.1 ms anchored**, and **156.7 to 111.9 ms free**. These are approximately
26% and 29% reductions in setup time, including transfers and CPU conversions.
They are **not city tick improvements**. Setup remains much too expensive to
rebuild this way on every fracture.

The city still serves game `ed9c2ad`, solver `646a0f41`, binary SHA-256
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`.
Direct GPU, rooted-fragment wire fixes and existing sleep/freeze remain enabled.
No server/client deployment or physical setting changed in this increment.

## Why this work was needed

The previous [fracture sequence](gpu-rigid-projection-2026-09-06.md) showed that
the initial hierarchy becomes a poor preconditioner after a building splits.
Exact current GPU components and load projection work, but the split takes
326 iterations with the old hierarchy. Fresh reference hierarchies for its
two pieces take 38 and 33 iterations.

The CPU-only `hierarchy_refresh_reference.py` explores alternatives against the
same independent physical matrix, loads and original-order bond response.
With the **exact native initial hierarchy**, the split takes:

| Preconditioner | Iterations | Interpretation |
| --- | ---: | --- |
| Unchanged | 326 | Reproduces the previous slow split |
| Current Galerkin matrices and coarse pseudoinverse, old interpolation | 243 | Helps, but remains far slower than fresh component hierarchies |
| Fresh unsmoothed aggregation, four nodes per aggregate | 142 | Sparse interpolation is cheaper, but convergence remains poor |

All three converge to the independent physical answer with a diagnostic limit
of 600. That does not qualify any of them for production or change a runtime
iteration budget. The two earlier offline-Python hierarchy experiments are
archived separately: their original aggregation differs from the native one.
Their iteration counts must not be substituted for native results.

The retained interpolation has no exact representation of the new split's
rigid modes in the numerically refreshed coarse space: the native experiment's
coarse matrix has no near-zero eigenvalues, despite two free components.
This supports rebuilding interpolation from current connectivity. A proposed
coarse operator retaining every original bond coupling also shows substantial
fill: roughly 10.35 million coupling entries at 738 rows versus 224,532 entries
in the current coarse matrix. That layout is unattractive for bandwidth/memory.
CPU refresh setup timings include this diagnostic coupling calculation; they
are not optimized production setup benchmarks.

## Implementation

`GpuGalerkin` computes `R * (A * P)` in double precision using cuSPARSE, retaining
`A * P` on the GPU between the two products. It borrows the caller's context and
stream, retains matrix/work buffers across calls, validates CSR inputs, and
reports nonfinite results instead of sanitizing them. Stream completion guards
also protect host buffer lifetimes on exceptional returns.

`buildConnected` accepts an optional product backend. The CPU algorithm remains
the default. Aggregation, rigid-mode QR, smoothing, symmetrization, and coarse
inversion retain their existing equations. Physical loads and the fine physical
operator do not change. The native CPU fixture remains **byte-identical** after
the refactor.

Two additional waste reductions improve the hybrid path:

- Convert each level's matrices to scalar CSR once, sharing that representation
  between the CUDA callback and returned hierarchy.
- Reuse the compute workspace for the earlier memory-estimation scratch, whose
  lifetime ends before compute starts.

The implementation exposes the three cuSPARSE product algorithms for measured
comparison. The compact algorithm is the experimental default. Chunking only
changes how intermediate matrix products use scratch memory; every product is
evaluated. No bonds, physical interactions, forces, or velocities are limited.
The API sequence and algorithm characteristics follow the installed toolkit's
[NVIDIA cuSPARSE 12.8 documentation](https://docs.nvidia.com/cuda/archive/12.8.2/cusparse/index.html#cusparsespgemm).

This is a **hybrid, synchronous setup backend**. It uploads three matrices and
reads back one coarse matrix per level. Descriptors are recreated and library
setup runs on each product. It is not a fully resident hierarchy, does not
promise allocation-free library internals, and is not integrated with production
damage or rollback. Recorded allocation counts cover this class's explicit
device buffers; their capacities stop growing after the first repeated setup.

## Final measurements

RTX 4090, CUDA 12.8, 5,936 dynamic nodes and 18,627 original bonds. Warm setup
medians use repeats 4–7, zero based, of eight full builds in the same process.
All cold samples remain in the archive. No other GPU workload or build ran
during measurement. Hardware scheduling and CPU cache effects remain limits
of this single-machine comparison.

| Backend | Anchored setup | Free setup | Retained explicit GPU buffers |
| --- | ---: | ---: | ---: |
| CPU products | 145.607 ms | 156.676 ms | None for setup |
| GPU algorithm 1 | 102.153 ms | 106.769 ms | 1,709 MiB |
| GPU algorithm 2, compact | 108.145 ms | 111.862 ms | 343 MiB |
| GPU algorithm 3, chunk fraction 0.125 | 116.559 ms | 125.165 ms | 286 MiB |

Algorithm 2 trades a few milliseconds against algorithm 1 for about 80% less
retained memory. Algorithm 3 saves more memory after scratch sharing but takes
longer. The reported buffers include inputs, intermediates and workspace, but
exclude CUDA context/library-private allocations. One backend can reuse scratch
across sequential component builds; these are not mandatory per-building
resident allocations.

Context/library startup is separate: about 142–147 ms for the compact examples.
The first compact hierarchy build is another 164–178 ms. Neither startup cost
is hidden in a warm number or claimed as a per-tick saving.

In the final compact anchored sample, approximate remaining costs are:
input validation/conversion 25.5 ms; diagonal setup 2.9 ms; spectral bound
18.5 ms; aggregation/QR 5.8 ms; interpolation 12.6 ms; representation conversion
13.8 ms; coarse products including transfers 26.7 ms; final inverse 0.4 ms.
These phases identify the next resident-setup work; removing validation checks
is not the selected way to save that time.

## Validation and release status

- **60 ordinary full-building solve samples pass:** 52 using CUDA hierarchy
  products and eight CPU-product controls. They cover anchored/free structures,
  float/double preconditioners, zero loads, free pure gravity and extreme loads.
  Fine operators, vectors and reductions remain double precision.
- Every selected CUDA hierarchy comparison checks level matrices, inverse
  diagonals, interpolation/restriction, smoothing parameters and coarse inverse
  against the CPU builder. Final bond responses and force/moment residuals use
  the pre-existing independent physical oracle.
- Small independent scalar-column product checks cover rectangular matrices,
  empty rows/dimensions, exact cancellation, changing sizes, capacity reuse,
  extreme coefficients, invalid CSR/nonfinite inputs, overflowing products and
  recovery after rejected input, for all three algorithms.
- A deliberately incomplete one-iteration solve fails its physical checks.
- Both the small product suite and a full free-building GPU setup/solve pass
  Compute Sanitizer with **zero errors and zero leaked bytes**. Instrumented
  timings are excluded from performance comparisons.
- CPU native hierarchy tests pass; exported CPU hierarchy bytes match the
  pre-change fixture. The exact-native split experiment was rerun after the
  script gained a failing exit status for numerical failures.
- Exclusive tests required an idle city and restored its exact binary/settings
  after each window. The final fingerprint confirms Direct GPU remains enabled.

**The dynamic-fracture release gate remains open.** This increment accelerates
fresh static setup; it does not replace the old interpolation in the running
fracture sequence, resolve the split gate, or qualify held contact/physical
corrections. The remaining work is to build/update interpolation from current
components on the GPU, retain intermediate hierarchy data there, and qualify
that path through changing fractures, rollback, settling and streamed city
destruction before deploying it.

Evidence and reproduction commands are in
[`gpu-hierarchy-setup`](../bench-results/simulation-frontier/gpu-hierarchy-setup/summary.json).
Run `python3 bench-results/simulation-frontier/gpu-hierarchy-setup/verify-results.py`
to verify the archive. It explicitly reports that this is not a release pass.

## Current-component sequence follow-up

Solver `0ef769fa` now passes the numerical fracture sequence with fresh sparse
component hierarchies: 192/192 final samples pass and the split takes 36
iterations. This resolves the earlier standalone split convergence case.
Rebuild/upload overhead is still too high for deployment; production integration
is incomplete. See [component hierarchy evidence](component-hierarchy-2026-09-06.md)
for the controls, safety checks and complete cost breakdown.
