# GPU stress observation checkpoint, 2026-09-05

This checkpoint removes unconditional impulse readback from the high-level CUDA
stress solver behind `BLAST_GPU_IMPULSE_READBACK=0`. The default remains eager.
It also adds opt-in fixed-order GPU reductions for strict audits, repairs a
scenario-harness replay omission, and preserves the current material, tolerance,
iteration and retirement settings. It does not complete the full-tick plan. The dependency checkpoint is
`cdf6c3ed` on `codex/simulation-frontier`.

## Implementation and ownership

A successful device solve makes the CPU impulse mirror stale. Device bond-stress
processing continues against resident impulses. CPU walks, convergence steadiness,
backend rebuilding, fallback and diagnostics explicitly refresh that mirror.
Pending swap-with-last operations are applied before a physical impulse read.
Deferred CPU strips refresh once before worker dispatch, avoiding concurrent
first-read mutations. A valid empty-graph GPU decline retires the empty mirror
and permits the existing CPU fallback; CUDA failures still propagate.

The bond impulse array now compacts on every removal, including its final two
slots. The previous condition left trailing elements behind. Host observation
cost and transfer bytes are included in the solver telemetry.

`BLAST_GPU_DETERMINISTIC_REDUCTIONS=1` writes exclusive scalar contributions and
reduces ascending island indices in fixed 1,024-element tiles. Separate tiles of
a large island run concurrently. Storage is proportional to nodes, bonds and
islands; topology changes refresh the index lists and graph parameters. The
existing gather operator (`BLAST_GPU_GATHER=1`) is required for the strict
end-to-end comparisons. The default padded atomic reduction remains available.
This audit path adds a reduction pass and topology metadata uploads; it is not
yet a qualified performance replacement.

The upload helper now uses `cudaPointerGetAttributes` to distinguish registered
host memory from pageable memory. The old probe deliberately generated and
cleared CUDA API errors on pageable pointers. CUDA 11+ supports querying ordinary
host pointers successfully; see [NVIDIA's API contract](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__UNIFIED.html).

## Bugs exposed by wider tests

`Rig::step`, shared by authored-structure scenarios, omitted `pre_step` and thus
never supplied a current replay snapshot. Its tests printed “requires a prior
capture” while continuing. It now captures before every physics step, matching
the production server and trace recorder. A quiet-structure regression requires
one current capture for each logical tick. This changes the harness to exercise
the intended simulation; it is not a claim of complete GPU replay coverage.

The bridge's POD-default test still expected 20 m/s² after the structural-realism
migration to 9.81. Its assertion now matches the implemented gravity contract;
no simulation gravity or material setting was changed.

## Verification

- The high-level eager/lazy audit uses 1,331 nodes and 3,630 bonds. It compares
  stress arrays, health, convergence and retirement exactly across 53 updates,
  three tail removals, two cuts that repartition a multi-tile island, GPU/CPU
  backend switches, complete shattering and a converged reset.
- Device, serial CPU and parallel CPU observers pass. Node-space, bond-space and
  optional Jacobi variants pass the eager/lazy comparisons. CUDA memcheck reports
  zero errors for the device, serial CPU and parallel CPU observer fixtures.
- The device-walk fixture avoids **4,218,656 reported device-to-host bytes** over
  its capped solves. This establishes removed transfer work, not a city speedup.
- The full current CTest run passes **26/29**. The failures are `load_path`,
  `reference_building_load_path` and `destruction_quality`, the same three named
  by the earlier baseline. They remain unresolved gates; no thresholds were
  relaxed to hide them.
- `gpu_stress_suite --grid 1 --iters 32 --compare` passes its existing equilibrium
  gate with both atomic and deterministic reductions. That gate allows up to
  twice the CPU residual; it does not prove exact CPU/GPU impulse agreement or
  resolve the known high-iteration column-scaling drift.
- In each ordinary/Direct GPU mode, all 21 bridge simulation tests pass. The
  additional POD-default failure is corrected and independently passes. The
  repaired rig suites pass 11 checks per mode; seven existing ignored probes
  remain ignored. Broader authored-structure qualification must be rerun with
  the repaired harness before deployment.

The original strict test failed at single-ULP differences; an unchanged
eager-versus-eager control reproduced that variation. The fixed-order reduction
makes those audits meaningful without loosening equality. An expanded scenario
then exposed the valid empty-graph fallback defect in the first lazy version;
that failure was fixed and the scenario rerun.

Raw results are in `bench-results/simulation-frontier/lazy-readback-validation/`.
The bridge logs retain the stale POD assertion failure alongside its correction
log, rather than claiming an uninterrupted green run.

## Performance and remaining work

Three paired, alternating eager/lazy demolition trials on grid 2 are being
measured from one fixed binary with the production 32-iteration, full-resimulation
settings. Deterministic reductions and Direct GPU are disabled in this comparison
so it isolates host impulse observation. Results belong in a subsequent update;
there is no whole-city speedup claim at this checkpoint.

Remaining work includes the at-rest and full scenario gates, benchmark analysis,
avoiding unnecessary host enumeration of changed bonds, and measuring observation
cost on converged/mostly sleeping scenes. Lazy convergence observations currently
read the whole live impulse array and may cost more than eager compact readback
in that regime. Body-to-node loads, contact ownership, complete replay and
commit-only streaming still need the wider GPU integration described in the
[city integration report](direct-gpu-city-integration-2026-09-05.md). The live city
has not been switched to these experimental options.
