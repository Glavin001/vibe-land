# Native hierarchy construction and physical zero-load checks

The multilevel solver now has a native C++ hierarchy builder, replacing the
Python/SciPy setup dependency in the standalone CUDA test. **It is not integrated
into the game and no new city build was deployed.** The city remains on the
Direct GPU build used for the six [player reports](city-player-reports-2026-09-05.md).
A repeat inventory found no reports newer than 18:54:01 UTC, and re-running the
report analysis reproduced the committed summary exactly.

## Implementation and scope

`NvBlastExtStressGpuMultilevel.{h,cpp}` builds a six-degree-of-freedom block
hierarchy from a physical matrix and its rigid-motion basis, using standard C++.
It constructs connected aggregates, twice-reorthogonalized local QR factors,
smoothed interpolation, transposed restriction and exact Galerkin products.
Only exact zero coefficients are omitted. The grouping size of eight nodes
and the coarse-solve threshold control numerical organization; every physical
node, bond and contributing coefficient remains represented.

The builder rejects disconnected input, asymmetric operators, nonfinite basis
entries and incorrect free rigid modes. Callers must supply each current exact
component independently. Small components go directly to a dense solve. For
free components, the coarse inverse projects out the six supplied rigid modes;
it adds no physical anchors. The CUDA test still uses the unchanged physical
matrix, original loads, physical weights and reference bond solution.

Smoothing uses an upper bound derived from the entrywise absolute value of the
symmetrically whitened operator. A positive test vector bounds its spectral
radius; twelve iterations tighten that bound and a 5% numerical margin remains.
The selected weight is `4/(3*bound)`, inside the symmetric Jacobi stability
interval `0 < omega < 2/lambda_max`. The positivity floor belongs only to this
setup test vector; it does not touch physical forces or solver outputs.

An initial implementation used `1/bound`. It passed accuracy checks but took
48 iterations / 7.72 ms anchored and 44 / 9.09 ms free. That choice was rejected
for repeated solving cost. Its source and logs are retained. The final weight
restored the solve times below without changing physical acceptance thresholds.

## Measurements

Same RTX 4090 and 5,936-dynamic-node building as the
[earlier CUDA proof](multilevel-cuda-proof-2026-09-05.md), not 5,936 awake rigid
bodies. Each arm ran four identical-input solves in one process. Times are the
median of the final three; setup and upload are excluded from warmed solve time.

| Fixture / hierarchy | Preconditioner | Iterations | Warmed CUDA solve |
|---|---|---:|---:|
| Anchored / offline Python | Float | 33 | 5.86 ms |
| Anchored / native | Float | 34 | 5.89 ms |
| Anchored / native | Double | 34 | 10.67 ms |
| Free, varied loads / offline Python | Float | 30 | 6.23 ms |
| Free, varied loads / native | Float | 31 | 6.31 ms |
| Free, varied loads / native | Double | 31 | 10.66 ms |
| Free, all loads times 1e30 / native | Float | 31 | 6.30 ms |
| Free, all loads times 1e-30 / native | Float | 31 | 6.31 ms |
| Free fall / native | Float | 23 | 4.73 ms |
| Exactly zero load, free or anchored / native | Float | 0 | about 0.01 ms |

The native builder takes approximately **202–209 ms per building** in these
runs, including input checks, starting from an already assembled matrix/basis.
It does not include graph/operator assembly, CUDA context initialization,
upload or graph capture. Offline export includes different work, so its timing
is not an equivalent setup comparison. This increment removes a Python runtime
dependency; it does **not** establish a warmed solve speedup over the previous
prototype. Rebuilding this hierarchy on every fracture would be too expensive.

All **44 final non-instrumented CUDA solves** passed. Loaded-case physical
force/moment residuals remain around 1e-11. One deliberately incomplete
one-iteration solve was rejected. The native test covers free and anchored
chains with 1, 2, 29, 30, 64 and 256 nodes, checking independent Galerkin products,
coarse inverse identities, symmetry and the six-mode nullity. It also rejects
invalid input and spurious loads. AddressSanitizer and UndefinedBehaviorSanitizer
passed. CUDA Compute Sanitizer passed free-fall and exact-zero cases with zero
memory errors and zero leaked bytes; those instrumented timings are excluded.

## Free fall exposed an invalid diagnostic

The old CUDA harness divided bond error by a reference bond norm, with a tiny
constant substituted when that reference was exactly zero. Free fall therefore
reported a meaningless relative error near 3e137. The solver's physical force
residual was about 8.26e-14 of the original gravity load. The failed result and
its exact source are preserved.

The harness now measures bond-force and bond-couple error in N and N m, deriving
conversion factors from direct same-axis coupling entries and node weights.
Both bond endpoints must agree on the conversion. These errors are normalized
by the original physical input norm. Nonzero reference solutions retain the
existing relative bond check as an additional requirement; zero references
report relative error as JSON null. Exactly zero input requires exactly zero
physical error, with no artificial denominator floor.

The numerical solver and free-fall right-hand side were not changed to make
this case pass. In particular, its tiny projected residual is still solved,
which explains the 23 iterations. Exactly zero right-hand sides skip unused
preconditioner work and copying an uninitialized search direction. Negative
controls reject nonzero force under zero input, a spurious 1e-3 force or couple
under unit input, and nonfinite results. No force, impulse, velocity or fracture
was clipped, dropped or capped.

## Remaining work before deployment

The builder currently consumes a prepared matrix/basis for one component.
Production integration still needs native/device physical operator assembly,
batched component solves, exact fracture-time membership and rigid modes,
measured hierarchy reuse/update policy, persistent device input/output and
same-tick fracture rollback/re-simulation. The 202–209 ms setup must be removed
from the tick path or replaced by a demonstrably correct update strategy.

The existing physical-quality failures and contact-ordering qualification hold
remain open. The missing rooted-fragment promotion is also still an independent
wire-topology defect to reproduce and fix. These numerical tests do not replace
city tests at the reports' 5–6k-awake load, near-threshold fracture comparisons,
settling checks or full-tick/streaming measurements.

## Reproduction and deployment evidence

[Evidence directory](../bench-results/simulation-frontier/multilevel-native/)
contains all final commands/logs, both earlier source snapshots, final source
and binary hashes, fixture checksums, sanitizer results and a summary verifier.
The final exporter reproduced all seven fixture binaries and both rigid-basis
sidecars byte-for-byte in a separate scratch directory.

From the game checkout, `python3
bench-results/simulation-frontier/multilevel-native/summarize.py` checks retained
results without touching services or the GPU. `reproduce-fixtures.py --out DIR`
regenerates inputs using CPU only. The machine-local `run-final.py` requires
exclusive GPU ownership established by its caller; it does not stop the city.

All GPU runs used the existing ownership-aware, no-player exclusive wrapper.
The final restoration check found PID 4027114 healthy with the unchanged binary
SHA-256 `51efeb841976fe88eb5f52b1a2d84e4227ee2612d784463f82138315073a2f79`,
Direct GPU enabled, contact ordering at its existing default, 32 solver
iterations, one configured replay pass and the existing scene/settings. This
is artifact/health verification, not a new browser or visual qualification.
