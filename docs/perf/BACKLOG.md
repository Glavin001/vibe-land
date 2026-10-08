# Performance backlog (high-fidelity profile)

Measured costs of the high-fidelity capabilities, collected while correctness
comes first. Nothing here is optimised yet. Optimisation starts once the
correctness suites (`docs/verification`, `docs/calibration`) pass on the
combined branch (`integration/high-fidelity`), and every change is gated by
them. Timing runs take the GPU lock (`scripts/perf/gpu-run.sh`). Correctness
runs share the GPU.

Fixed constraints, not levers:
- FP32.
- Stress cap 64; 16 for town qualification.
- `internalCorrectionLimit` 1.
- `PX_DESTRUCTION_ALLOW_UNCONVERGED=1`.
- No looser tolerance, no extra iterations, no double precision.

## Items

**1. Impact solve, per impact tick** (`VIBE_IMPACT_CAPACITY`, PhysX `feat/impact-capacity`)
- Cost: 0.4-1.3 s per impact tick in the first projected-gradient version, one block per island. Since 91d5b2aa2 it is ADMM with 6×6 per-chunk block preconditioning.
- At rest: zero extra.
- To measure: impact-tick step time against the runtime profile, for the truck, cannonball, meteor and small balls. Re-measure after the coupled impactor contact lands.
- 2026-10-07, after the convergence fix (122e83998: KKT projection for thin sections, per-residual rho rebalance) and with the evaluation budget raised from 4096 to 32768 steps so impact ticks converge:

  | First tick, sections off | Solves | Steps | Time | Longest dispatch |
  |---|---|---|---|---|
  | Truck | 23 | 4.7k | 4.8 s | 60 ms |
  | Corner | 39 | 9.8k | 7.6 s | 60 ms |
  | Cannonball | 38 | 11k | 10.5 s | 60 ms |
  | Meteor | 98 | 24.5k | 20 s | 60 ms |

  A house evaluation at rest converges in 36-42 steps (20-40 ms), or costs nothing with the carried yield state. Levers: fewer ramp levels and brittle cascades, cheaper J-steps, parallel islands. The 32768 budget is a correctness budget, not a performance target.

**2. Rotational stiffness convergence** (`VIBE_SECTION_ROTATION`, PhysX `feat/section-rotational-stiffness`)
- Cost: about 3× the iterations to the same force error on the two-storey veneer house (319 vs 114, native polynomial, from cold to 1e-3).
- Where the slow error sits: in the roof's soft near-mechanisms (rafters, ridge, gables). That is real physics.
- Tried, none reaching 114:
  - higher-degree Chebyshev: fewer iterations, about 630 operator passes;
  - rigid-group deflation and unsmoothed or smoothed aggregation: 150-200 iterations.
- Parallel-axis block-Jacobi diagonal: landed in 231644fb4.
- Parked work: PhysX `wip/matched-hierarchy`.
- At the cap, 82-100% of solves are unconverged at 16 iterations. Warm starts settle them over about 2 s.
- 2026-10-07, **Krylov carry** (PhysX `perf/rotation-convergence` a8660b4a8 + 045933819; `BLAST_STRESS_CARRY_KRYLOV`, on by default with rotational stiffness).
  - The settling was restarted PCG: each tick began a fresh PCG with a steepest-descent step, and 16 restarted iterations lose the Krylov space the soft modes need.
    - The CPU replay of the captured two-storey house predicted 25 ticks to settle restarted and 8 carried; the GPU measured 24 and 7.
    - Mailboxes and street signs never settled at all: 100% unconverged.
  - A warm solve now continues the previous solve's direction and gamma, under four conditions:
    - the operator is unchanged;
    - the load moved by at most the solve tolerance;
    - the previous solve did not converge;
    - the recurrence has run fewer than 6 iterations per chunk.
  - The converged answer and every stopping test are unchanged.
  - Unconverged ticks at rest, 300 ticks, high profile (unchanged vs carried):

    | Structure | Cap 16 | Cap 64 |
    |---|---|---|
    | Veneer house | 24 vs 7 | 1 vs 1 |
    | Veneer bungalow | 26 vs 8 | 2 vs 1 |

  - Vibe Town qualification at 16: 101 of 273 failing -> 0. Mean unconverged 23.8% -> 1.25%, worst 3.3% (cinema). Broken bonds are identical on every structure.
  - At 64, billboard-189: 19% -> 0.3%.
  - Oracle gate (verdicts at the cap, tick 120), largest stress error against the CPU oracle:
    - cinema: 5.6e-2 -> 1.8e-3;
    - library: 5.6e-2 -> 1.1e-3;
    - bus shelter: 1.8e-2 -> 1e-5.
    - Verdicts are identical.
  - Not changed: iterations to tolerance from cold. That is still the polynomial's 404 (residual) / 132 (force test) / 229 (1e-3 force error) on this capture of the house.
  - Next lever, CPU only so far (`rotbench.py`): strength-matched aggregate block-Jacobi (aggregates of 16 chunks, dense blocks, the same two-step polynomial). Cold, it halves these to 225 / 62 / 106. Each iteration costs more (two dense block solves). Not built on the GPU.
  - Paired perf suite (quick, 3 reps, both profiles; `--env BLAST_STRESS_CARRY_KRYLOV=0|1`, 20261007-234818 vs the next run): within noise in both profiles.
    - high SCORE 1.015; runtime 1.007 (carry forced on; it is off by default there).
    - town-idle p95 22.6 vs 24.2 ms.
    - The suite's idle window starts 20 ticks after a cold load, with 22 cars whose loads change. It never converges at 16 either way (30/30), so it cannot show converged structures being skipped at rest.
  - Lessons, with the tests that pin each down:
    - Carrying through changing loads (the parked fleet) set off the impact solve at rest. Test: `physx-bridge/tests/krylov_carry.rs`, a ball landing on the tip.
    - Carrying past convergence: the textbook portal frame drifted for 400 ticks until its solve diverged and broke a bond. Hence carry only from an unconverged solve, at most 6 iterations per chunk.
    - The correctness quick tier matches the baseline: high textbook 65 pass / 19 known gaps / 1 failing (redundancy-propped, pre-existing).

**3. High-fidelity scene configuration**
- Cost: +14.5 s. Vehicle lab, five monster trucks, shared GPU, 04:39 run:
  - native configure: 15.0 s against 0.5 s for runtime;
  - pack load and fleet preparation: 2.8 s against 1.9 s.
- The window covers:
  - per-bond sections from chunk geometry: 7,930 of 8,057 bonds, plus 857 per truck;
  - configureStress with the rotation rows;
  - the impact solve's buffers.
- The split needs timers.
- The in-process Welcome timeout was raised to 180 s (vibe-land 0de65c08, integration branch).
- Logs: `.claude/worktrees/hifi/target/native-video/vehicle-lab-20261007-043932.log` (high fidelity) and `-041150.log` (runtime).
- Under GPU and CPU contention, pack load alone took 97 s (`-040828.log`).

**4. Correction loop with chunk loads** (opt-in, PhysX `feat/chunk-loads-correction-loop`)
- Cost: about 2× on fracturing ticks. Worst tick 32 → 44 ms median; monster truck into a house 35 → 61 ms.
- The limit stays 1. Report a deeper loop only as a measured what-if.

**5. Contact crush and chunk crush**
- Measured: within run-to-run noise (1-2 ms) on impact steps with crushing on (vehicle lab, 2026-10-07).
- Re-measure with contact crush inside the impact solve.

**6. Runtime fracture ticks** (shipping profile, PhysX `perf/runtime-fracture-tick`, 2026-10-07)
- Where a correction tick goes (CuMetal commit/sync traces, perf suite + perf_bench, M3 Max):
  - lab house hits, 28-36 ms: GPU busy ~18 ms (stress solve at 64 iterations 4-5 ms a pass, twice; stress topology rebuild 2-4 ms; broadphase ~0.5 ms a pass); ~19-24 host waits; the rest GPU idle between them;
  - Vibe Town, 25-28 ms: GPU busy ~19 ms (topology rebuild ~3.9 ms each, often two a tick; split preparation ~2.5 ms a pass; broadphase ~1.1 ms a pass; stress ~1.4 ms a pass); ~26 host waits;
  - inside a rebuild, the motion modes (pointer jumping, closures, axis constraints) are ~2.7 of ~3.9 ms.
- Done: per-island residual reduction summed in the warp before its atomic (d361d7c51): 0.84 ms a solve on Apple GPUs (one float atomic per island, islands named by node), suite score 0.941 (-5.9% +-3.3%), town medians -0.7 to -0.9 ms.
- Done: the native sleep commit's five setters share one host wait (72be6dea3): sleepCommit 1.29 -> 0.76 ms on the ticks that commit sleep.
- Both replay perf_bench meteor (1,207 ticks) with identical per-tick broken bonds, iterations, convergence, contacts and clusters.
- Rejected: an early exit for the motion-mode pointer jumping. Its rounds past the longest tour already cost ~3 us each.
- Measured, not kept:
  - **CuMetal batch kick** (`CUMETAL_BATCH_KICK_DISPATCHES` 16 or 0): slower than the default 4.
  - **The component stress solve's critical path.** The phase probe does not compile under cumetalc, so the cost is read from the solve's GPU time against its iteration count:
    - lab: about 65 us per iteration plus 0.45 ms fixed (4.47 ms at 64 iterations);
    - town: about 27 us per iteration plus 0.73 ms fixed.
    - The largest components are about 1,000 nodes in the lab and about 1,400 in town, so the cost is not row-bound.
  - **512-thread stress blocks:** the solve is 12% faster in the lab and 6% faster in town, with identical per-tick verdicts and native lines over 1,877 ticks, but the suite score is 0.998 (no measurable gain). 1,024 threads fail the Metal pipeline gate.
  - A multi-threadgroup row split would gain less than that, so it is not pursued.
- Next levers:
  - the component stress solve's serial and barrier phases per iteration (thread-0 sections, reductions, motion projection), and its fixed setup;
  - the whole-scene union-find and sorts in every topology rebuild;
  - the second rebuild when the corrected pass fractures again;
  - the corrected pass's host handshakes in the PhysX core (about 20 waits at 0.2-0.5 ms of GPU idle each, plus 3-4 ms of host-only stages): about 3-7 ms, a deep Sc/Pxg pipeline change.

## The performance suite
Built: `scripts/perf/suite.sh` (`--quick`, `--compare`), described in
[SUITE.md](SUITE.md); the baseline is `scripts/perf/suite-baseline.json`.
Every optimisation step must lower its high-fidelity score (beyond the noise
band) and keep `scripts/verify/correctness.sh` green.
