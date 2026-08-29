# How deterministic is the destruction sim, and how should we measure it?

Measured 2026-08-29 on the shared Vast box, `record-city-trace`, grid 1 and 2.

## Determinism: what is and is not reproducible

The sim is **not** bitwise reproducible, and the source is **PhysX GPU contact
generation**, upstream of everything we wrote.

Controls run, each a pair of identical invocations. Every one still diverged:

| configuration | diverges? |
|---|---|
| default (GPU stress walk + GPU CG + parallel classify + adaptive aim) | yes |
| `BLAST_BOND_STRESS_GPU=0` (GPU walk off) | yes |
| `VIBE_PHYSX_CONTACT_CLASSIFY=0` (parallel classify off) | yes |
| `VIBE_CITY_GPU_STRESS=0` (CPU CG solver) | yes |
| `VIBE_CITY_STRESS_WORKERS=1` (single stress worker) | yes |
| `VIBE_TRACE_ADAPTIVE_AIM=0` (fixed shot plan) | yes |
| `VIBE_PHYSX_CPU_THREADS=1` | yes |
| **`--shots 0` (no damage)** | **no — bit-identical** |

So: our GPU stress solver, our parallel classify, our worker threading, the
harness's target selection, and PhysX's CPU dispatcher width are all cleared.
The residual is PhysX's own GPU narrowphase/broadphase, which uses atomics whose
completion order is not fixed. The scene runs `eENABLE_GPU_DYNAMICS` +
`PxBroadPhaseType::eGPU` and does not set `eENABLE_ENHANCED_DETERMINISM` (which
is a CPU-pipeline flag and does not cover GPU dynamics anyway).

Two earlier diagnoses were **wrong** and are corrected here:

* *"The float `atomicAdd` at `NvBlastExtStressGpu.cu:842` is the root cause."*
  It is a real order-dependence, but it is not the cause of run-to-run
  divergence: the CPU CG solver diverges identically.
* *"Adaptive aim amplifies divergence."* It **reduces** it. Adaptive aim drives
  the city to rubble, and total rubble is an absorbing state that both runs
  reach (final bonds 837 vs 832). The fixed plan leaves structures partly
  standing, and a partly-standing structure is where divergence compounds
  (final bonds 4640 vs 3613).

## How big is the divergence, and when

The first divergence is always `contacts_q` — a contact **count**, with poses
and topology still bit-identical. It then either dies out or compounds.

| scenario | bodies | bonds | outcome |
|---|---|---|---|
| grid 1, 6 s | 0.0% | 0.0% | 3 of 4 runs bit-identical end to end |
| grid 2, 25 s, fixed aim | 24.5% | 22.1% | chaotic, does not reconverge |
| grid 2, 25 s, adaptive aim | 8.2% | 8.1% | converges (everything is rubble) |

**Short runs are effectively deterministic; long heavy runs are chaotic.** This
is the single most important fact for the test harness, and it explains why
loaded A/B comparisons kept disagreeing: two identical 25 s runs differ in live
bonds by more than most optimisations move the mean.

## Consequences for automated testing

1. **Correctness gate — short, bit-exact.** `--grid 1 --seconds 6` with a fixed
   aim is reproducible often enough to diff the `.towertrace` directly. Treat a
   mismatch as a signal to re-run once, not as an immediate failure (~25% of
   6 s runs diverge harmlessly in `contacts_q` only).
2. **Performance gate — never compare raw means of long runs.** Compare cost per
   unit work (µs per awake body, ns per bond), bucketed by load, or compare only
   runs whose work counters match.
3. Bitwise determinism at scale would require CPU dynamics, which changes the
   thing being measured. Not worth it.

## Measuring compute on a shared box

Hardware counters are unavailable in this container:

* `perf_event_paranoid = 4` — CPU PMU denied.
* `ncu` is installed (2025.1.1.0) but returns `ERR_NVGPUCTRPERM` — GPU counters
  denied by the host driver setting. Unblocking needs
  `NVreg_RestrictProfilingToAdminUsers=0` on the **host**; that is the single
  biggest measurement upgrade available and it is a config change, not code.

What works, in order of preference:

1. **Work counters** (kernel launches, CG iterations, bytes moved, graph updates
   vs recaptures, `bs_gpu_skipped`/`runs`). Given identical work these are
   bit-identical, so they resolve changes far below timing noise.
2. **`CLOCK_PROCESS_CPUTIME_ID`** — now recorded per tick as the `cpu_ms` column.
   It only advances while our threads are on-CPU, so a co-tenant burning cores
   cannot inflate it. It sums across threads, which is what we want: the metric
   is compute consumed, not latency.
3. **Wall clock** — reserve for the one question it alone answers: do we hit
   60 Hz.

Measured benefit, on three runs with **bit-identical traces** (so the work is
provably the same):

| metric | run totals (ms) | spread |
|---|---|---|
| `cpu_ms` (process CPU) | 924.0 / 917.8 / 895.5 | **3.1%** |
| `physx_step` (wall) | 527.9 / 513.6 / 501.5 | 5.1% |
| `stress_solve` (wall) | 252.3 / 279.7 / 261.7 | 10.4% |
| `cpu_solve` (wall) | 222.1 / 250.1 / 232.2 | 11.9% |

Identical work, and the wall-clock spans still disagree by up to 12% while
process CPU time holds to 3%. Any optimisation smaller than ~12% is invisible to
the wall-clock columns on this box and visible to `cpu_ms`.
