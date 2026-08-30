# Fractured-downtown perf suite: baseline and improvement validation

Scene: `fractured-downtown.json`, grid 2 — 4 structures, 86,966 chunks,
267,992 bonds. Harness: `scripts/perf/scene-suite.sh` at `45b6ba2`.

## Baseline

| scenario | ticks | cpu p50 | cpu p95 | cpu max | stress p50 | physx p50 | cb_drain p50 | peak awake | bonds broken |
|---|---|---|---|---|---|---|---|---|---|
| idle | 600 | 14.86 | 20.23 | 27.23 | 4.09 | 0.28 | 0.00 | 0 | 0 |
| bombard-short | 480 | 24.18 | 31.02 | 40.48 | 5.89 | 4.38 | 0.25 | 485 | 1,950 |
| bombard-slow | 1200 | 20.45 | 29.06 | 34.93 | 5.02 | 3.07 | 0.09 | 470 | 1,937 |
| bombard-med | 1200 | 24.99 | 35.45 | 49.79 | 5.89 | 4.54 | 0.26 | 939 | 4,162 |
| bombard-fast | 1200 | 25.59 | 38.56 | 52.66 | 5.73 | 4.76 | 0.25 | 1,195 | 5,495 |

**Idle costs 14.86 ms of CPU per tick with zero awake bodies**, 4.09 ms of it
stress solve. A city sitting still should be close to free, and this is the
largest single unexplained number in the table. Bombardment adds roughly 10 ms
on top, and the rate barely matters above `slow` — cost tracks how much is
awake, not how fast shots arrive.

## Improvement validation

Each optimisation A/B'd alone on `bombard-short`, 8 counterbalanced pairs,
A = ON. Full output in `perf-validation-2026-08-29.txt`.

| optimisation | verdict | effect |
|---|---|---|
| GPU bond-stress walk | **A faster, p=0.008 (8/8)** | `cpu_solve` 5.25 vs 15.38 ms — **2.9× faster**; whole-tick CPU 16.40 vs 26.49 ms (−38%) |
| CUDA graph update vs recapture | **A faster, p=0.008 (8/8)** | `gpu_solve` 0.61 vs 1.36 ms (−55%); `stress_solve` 5.90 vs 9.36 ms |
| parallel contact classify | **A faster, p=0.008 (8/8)** | `cb_drain` 0.246 vs 0.370 ms (−34%), but only 0.12 ms of a 24 ms tick |
| stable graph | **no call** | ≤1.4% on every metric, 3–5 wins of 8 |

Three of four are confirmed wins. **`stable graph` cannot be shown to help**:
with graph *update* already on it has almost nothing left to save, and it should
not be counted as a win until a scenario exists where it bites.

Two caveats worth keeping:

* The graph-update comparison **tripped the work check** — the arms destroyed
  19.2% different bond counts and saw 36.8% different contacts, far beyond the
  0.3% run-to-run drift this scenario normally shows. So recapture is not
  merely slower than update, it is taking a **different numeric path**. The
  work-normalized columns still say A faster, which is what the verdict rests
  on, but *update and recapture producing different simulations is a
  correctness question*, not a performance one, and it is unresolved.
* `parallel contact classify` is statistically solid and practically small.

## What made these numbers trustworthy

The first run of this harness reported a **false positive**: "B faster" at
p=0.008, 8 wins from 8, between two arms that were accidentally identical
(`BLAST_BOND_STRESS_GPU` defaults OFF, so an empty arm A compared the feature
against itself — `bs_gpu_runs` was 0 in both). The cause was run order: A always
ran first, so B inherited a warm GPU and page cache every pair. Pairs are now
counterbalanced, and the same null went to 6/8 at p=0.289.

Three rules came out of that and are enforced in the scripts:

1. **Run a null first.** Two identical arms must return "no call". Nothing the
   harness says is worth reading until it passes that.
2. **Never let an arm rely on a default.** State the ON value explicitly.
3. **Pick the scenario by work drift, not by load.** Drift grows with tick
   count — 5.7% at 20 s versus 0.3% at 8 s — so `bombard-short` is what arms are
   ranked on, and the longer rates are for reporting cost, not for ranking.
   A sign test on n pairs also cannot go below p = 2/2^n, so n=4 can never reach
   significance; 8 is the working default.

---

# Idle cost: identified, measured, reduced

## The baseline above was measured in the wrong configuration

The suite relied on library defaults while the server set its own; they had
drifted. Corrected (both now source `scripts/physics-env.sh`):

| scenario | old (wrong config) | production config |
|---|---|---|
| idle cpu p50 | 14.86 ms | **3.65 ms** |
| bombard-fast bonds broken | 5,495 | **24,212** |

Idle was overstated 4× (the suite ran the serial bond-stress walk over 268k
bonds, which production does not) and bombardment understated ~4× in damage
(without `STRESS_LIMIT_SCALE=0.45` the city is far tougher). Both directions of
error came from the same cause.

## Where idle actually went

```
TOTAL cpu_ms      3.645
  gravity         0.951   26.1%
  hw_in           0.926   25.4%    velocity walk-in
  hw_bond         0.203    5.6%
  hw_reset        0.195    5.3%
  physx_step      0.226    6.2%
islands 64,800, of which 63,450 settled (97.9%) · awake 0 · bonds broken 0
```

**Gravity and the walk-in are 51.5% of an idle tick**, both sweeping ~87,000
nodes every tick to recompute the same arithmetic for a city that is not
moving, while the solver retires 97.9% of islands as settled and never reads
the result.

## They are one problem, not two

`addNodeForce` is the only writer of `localVel`, so the walk-in can skip
whenever no force was applied — but gravity applies force to every node every
tick, so **the walk-in could never skip while gravity ran**. Fixing the walk-in
alone measured as nothing: `hw_in` went 1.075 → 0.937, and `gravity` moved the
same 13% despite being untouched by the change, which is what identified it as
machine noise rather than an effect.

The fix compares this tick's body snapshot against last tick's — 108 poses,
bit-exact — and when nothing moved and no contact landed, skips gravity
entirely. The solver's velocity array persists across ticks, so with both
passes sitting out it re-solves inputs it already had.

**The coupling is the whole trick, and getting it backwards cost 15×.** The
first version required two consecutive quiet ticks before the walk-in would
skip, on the reasoning that retaining last tick's velocities was a stale-input
hazard. Retaining them is the point: the first quiet tick still walked in and
wrote the zeros that skipped gravity had left behind, unloading every
structure, waking the settled islands, and turning a 3.7 ms idle tick into
**54 ms**.

## Result — 8 counterbalanced pairs

| scenario | metric | A (skip on) | B (off) | verdict |
|---|---|---|---|---|
| idle | `cpu_ms` | **3.326** | 4.056 | **A faster, −18%, p=0.008 (8/8)** |
| idle | `stress_solve` | **0.653** | 0.806 | **A faster, −19%, p=0.008 (8/8)** |
| bombard-short | every metric | — | — | no call — no regression under load |

Correctness: idle holds at 0 broken bonds, 0 awake, 108 bodies in both arms;
under bombardment the work check did not flag bonds, bodies or awake, so a 7.4%
bond difference seen in a single unpaired run was chaos, not behaviour.

Flags `BLAST_GRAVITY_QUIET_SKIP` and `BLAST_WALKIN_SKIP`, both default ON.

**Remaining idle cost** is ~3.3 ms, now led by `hw_bond` (0.2), `hw_reset`
(0.2) and PhysX's own step (0.23) — no single dominant term left. Note the
unpaired report above reads idle at 4.80 ms rather than 3.33: single runs swing
on this box, and the paired A/B is the number to trust.

## Follow-up: idle was not at its floor — 4.06 → 0.84 ms

Two more unconditional full-node passes, and one self-inflicted bug.

**The gravity skip was alternating.** `m_lastSnapshotApplied = !skipLoads`
flipped every tick: apply, skip, apply, skip. It looked like it worked and left
exactly half the benefit unclaimed. The distribution exposed it where the mean
could not — **50.0% of idle ticks were expensive and no physical quantity
correlated with which ones**: no contact, no wake, no pose change, no body
count change. A clean 50% split with no physical correlate is a state machine,
not a scene.

**`resetVelocities()` then became the largest term** (1.07 ms). It zeroes
`localVel` for every node every tick, but `addNodeForce` is the only writer, so
on a quiet tick it writes zeros over zeros.

| stage | idle cpu p50 |
|---|---|
| production baseline | 4.06 ms |
| gravity + walk-in skip (alternating) | 3.36 ms |
| alternation fixed | 2.20 ms |
| reset skip | **0.89 ms** |

Paired A/B, 8 counterbalanced pairs: `cpu_ms` **0.838 vs 3.206, p=0.008 (8/8)**;
`cpu_solve` 0.155 vs 1.268. Expensive-tick share 50% → 0%. Correctness: 30 s at
rest holds at 0 broken bonds, 0 awake, 0 overstressed.

What remains is ~1.4 ms of PhysX GPU wait (wall, not our CPU), 0.20 physx_step,
0.15 hw_bond, 0.10 stress_solve. No dominant term.

## Does the scene converge? Yes — in 15 ticks

30 s idle, unsettled islands per band:

| ticks | cpu_ms total | cpu p50 | unsettled islands |
|---|---|---|---|
| 0–15 | **1,494.4 ms** | 53.91 | 1,026 |
| 15–30 | 74.8 | 4.41 | 0 |
| 30–60 | 59.7 | 1.85 | 0 |
| 60–1799 | 2,102 | 0.79–0.84 | **0** |

The city converges completely within **15 ticks (0.25 s)** and stays converged
for the full 30 s. So idle cost is not unconverged solving.

But convergence is **not free at load**: the first 15 ticks burn **1.49 s of
CPU**, at 53.9 ms/tick against a 16.7 ms budget — a visible hitch of roughly a
quarter second whenever the scene loads. That is 65× the converged per-tick
cost, and it is the real target for baking a precomputed stress state into the
scene pack: the win is startup, not steady state.

## Current state — all optimisations on (56a72be)

| scenario | cpu p50 | cpu p95 | cpu max | stress p50 | physx p50 | peak awake | bonds broken | µs/awake body |
|---|---|---|---|---|---|---|---|---|
| idle | **0.36** | 0.71 | 4.44 | 0.05 | 0.13 | 0 | 0 | — |
| bombard-short | 28.23 | 36.85 | 57.75 | 12.21 | 6.61 | 1,872 | 7,732 | 20.82 |
| bombard-slow | 20.44 | 36.29 | 45.40 | 9.07 | 5.80 | 2,001 | 9,016 | 16.71 |
| bombard-med | 36.87 | 74.68 | 102.91 | 12.87 | 10.63 | 4,523 | 20,070 | 13.02 |
| bombard-fast | 45.77 | 77.94 | 93.31 | 14.35 | 11.37 | 5,873 | 24,429 | 12.67 |

Idle went 14.86 (wrong config) -> 4.06 (production baseline) -> **0.36-0.84**,
i.e. a still city now costs ~2% of the 16.7 ms frame budget instead of ~24%.

Caveat on the loaded rows: these are SINGLE runs. Against the equivalent
pre-optimisation report they look 25-35% better at comparable damage (24,429 vs
24,212 bonds broken), but the controlled 8-pair A/B of the quiet-skip under
bombardment returned NO CALL. So the loaded improvement is suggestive and not
established; only the idle result is statistically confirmed.

Under load the tick is still far over budget (36.9 ms p50 at bombard-med, 102.9
max against 16.7). The remaining cost is dominated by PhysX's own rigid-body
solve, which scales with awake bodies and is explicitly out of scope.

## Resolved: graph update vs recapture is NOT a different numeric path

An earlier A/B flagged the two arms destroying 19.2% different bond counts and
recorded it as an open correctness question -- recapture appearing to take a
different numeric path, not merely a slower one. It does not. Three independent
lines of evidence:

1. **Idle, which is bit-deterministic: the traces are BIT-IDENTICAL** between
   `BLAST_GPU_GRAPH_UPDATE=1` and `=0` over 15 s. Every pose, every topology
   change. Only `overstressed` and `islands_skip` differ, and those differ by
   more than that between two runs of the SAME arm.
2. **Short bombard (3 s, 3 shots), with a control pair.** Two runs of the same
   arm produced 1,760 and 1,781 broken bonds with different trace hashes, while
   the other arm produced 1,741 -- i.e. the cross-arm result sits INSIDE the
   same-arm spread.
3. **Eight runs per arm.** Within-arm spread 15.0%, between-arm median
   difference 5.8%, exact Mann-Whitney p=0.061. The scene's own noise is larger
   than the effect.

**Why it looked real.** The 19.2% was compared against a 0.3% drift baseline
measured under the OLD non-production config, where `STRESS_LIMIT_SCALE` left
the city roughly 4x tougher and damage 4x smaller. Under the production config
the same scenario drifts up to 15% by itself. The work check fired correctly;
the mistake was reading "work differs" as "numerics differ" against a
yardstick borrowed from a different configuration.

**Harness fix.** The work check compared against a fixed 2% threshold, which
under the production config flags essentially every loaded comparison. It now
compares the between-arm difference against the WITHIN-ARM drift observed in
the same run, and distinguishes "exceeds the scene's own noise" (suspect) from
"consistent with the scene's own noise" (reported, not alarming). A drift
baseline is only meaningful for the configuration it was measured in.

---

# The GPU CG solve's host-side wrapper

## What the tracing found, and what it refuted

The plan on file said the mid-enqueue `cudaStreamSynchronize` in
`refreshActiveLists` was "essentially all of hostSync". Measured, it is **5%**:

| host phase | ms/solve |
|---|---|
| `applyTopologyChange` | **2.20** |
| graph exec update | 0.73 |
| `refreshActiveLists` | 0.23 |
| **midSync** | **0.16** |
| `planSettledSkip` | 0.06 |
| *(wait for device)* | *4.86* |

Two corrections fell out of this:

1. **`gpu_host_blocked` is not wrapper overhead.** It is
   `cudaEventSynchronize(m_statusReady)` — the host waiting for the device to
   finish computing. Shrinking it means less device work or more overlap, not
   tighter host code. An earlier summary here called the whole 17.5 ms "host
   wrapper"; only the `gpu_host_work` half is reclaimable.
2. **`planSettledSkip` is 0.06 ms**, not a redundant full-node pass worth
   attacking. The plan listed it as item 3.

## Inside applyTopologyChange

| sub-step | ms/call |
|---|---|
| **uploads** | **2.20** |
| computeIslands | 0.55 |
| buildNodeBondCsr | 0.33 |
| groupBondsByIsland | 0.12 |
| memset | 0.03 |

Fifteen **blocking** `cudaMemcpy` out of pageable `std::vector`, which cannot
DMA — the driver bounces them chunk by chunk at ~0.9 GB/s.

## Two hypotheses, one discarded before being built

* **Pinned staging + async copies: only 17%.** Instrumenting the failure
  explained it: 5.30 MB per fracture tick, DMA enqueue 0.09 ms, host memcpy
  into the staging arena **1.52 ms**. It swapped the driver's hidden staging
  copy for an explicit one. *The copy, not the transfer, was the cost.*
* **Upload only the changed bytes: not viable.** 5.048 MB of the 5.31 MB is
  dirty every fracture tick, because `computeIslands` renumbers island ids
  wholesale. Measured before building it.

So the fix **deletes** the copy: the host arrays are backed by a pinned
allocator and the DMA reads the buffer the host already wrote.

| metric | before | after |
|---|---|---|
| upload | 2.609 | **0.073** ms/solve |
| staging memcpy | 1.524 | **0.000** |
| applyTopologyChange | 2.529 | **0.730** ms/solve |
| host plan total | 3.873 | **1.986** ms/solve |

Some cost moved into `midSync` (0.16 → 1.04): the DMA still takes time, it is
now overlapped rather than blocking.

## Two hazards handled

`cudaMemset` runs on the legacy default stream, which implicitly synchronises
every stream — it would have blocked on the very uploads made async. Now
`cudaMemsetAsync` on the solver stream. And resizing a pinned vector frees
memory a DMA may still be reading; every solve normally waits first, but the
no-op solve path returns early, so `applyTopologyChange` waits on an upload
event before touching the arrays.

`BLAST_TOPO_PINNED=0` reproduces the original faithfully — a blocking copy out
of a **pageable bounce buffer** — because the sources are pinned now, and an arm
that does not reproduce the old cost structure measures nothing.

## Verified: sync mode is the win; async was a regression

Two 16-pair counterbalanced A/Bs, `bombard-med`.

**Attempt 1 — pinned + async (rejected):**

| metric | A (async) | B (pageable) | verdict |
|---|---|---|---|
| `gpu_solve` | 10.531 | 9.648 | **B faster, 13/16, p=0.021** |
| `cpu_ms` | 44.452 | 44.413 | no call |

It made the *device* significantly slower. The 5.3 MB H2D rode alongside the CG
kernels and competed for memory bandwidth, where the blocking copies it replaced
had finished before the solve was enqueued. And the host time it saved never
became tick time, because **this phase is device-bound**: finishing the enqueue
1.9 ms earlier just makes the host wait 1.9 ms longer on
`cudaEventSynchronize`. Host work converted into host waiting.

**Attempt 2 — pinned + async + drained once before the solve (shipped):**

| metric | A (sync) | B (pageable) | verdict |
|---|---|---|---|
| `cpu_ms` | 44.331 | 45.263 | **A faster, 2/16, p=0.004** |
| `stress_solve` | 14.710 | 15.936 | **A faster, 3/16, p=0.021** |
| `stress_solve/awake` | 4.992 | 5.179 | **A faster, 3/16, p=0.021** |
| `gpu_solve` | 10.450 | 10.378 | no call, 8/16, p=1.000 |
| `cpu_solve` | 21.815 | 23.426 | +8.89%, 4/16, p=0.077 |

Whole-tick CPU down 2.33% at p=0.004, stress solve down 9.13%, and `gpu_solve`
exactly neutral — the regression is gone rather than hidden.

**Why the first sync attempt also failed.** Implemented with a blocking
`cudaMemcpy` it measured 1.99 ms, barely better than pageable, because a
blocking copy runs on the legacy default stream and implicitly synchronises
with every stream: each of the fifteen copies waited on whatever the GPU
already had queued. It was waiting, not transferring. Enqueuing all fifteen
async and draining **once** gives 0.91 ms, which is the real transfer.

**Cost ledger, host plan per solve:** 3.76 (pageable) → 2.43 (sync).

**The general lesson.** Three of the four things tried here moved cost rather
than removing it — into an explicit memcpy, into host waiting, into default-
stream stalls. Only the component-level trace distinguished those from the one
that actually removed work, and only the 16-pair A/B caught that the most
promising-looking version was a net regression.

## The spikes are device-side, not host-side

p99 ticks (n=46) against median ticks (n=2281), 4,560 ticks with the fix in:

| phase | spike | normal | delta | % of excess |
|---|---|---|---|---|
| `cpu_solve` | 67.44 | 15.88 | 51.56 | **78.9%** |
| — `gpu_solve` *(device)* | 43.75 | 7.68 | 36.07 | **55.2%** |
| — `gpu_host_blocked` *(waiting)* | 41.18 | 8.92 | 32.26 | 49.3% |
| — `gpu_host_work` *(reclaimable)* | 13.56 | 3.68 | 9.88 | 15.1% |
| `physx_step` | 15.99 | 9.66 | 6.32 | 9.7% |
| `frac_topo` | 2.52 | 1.03 | 1.49 | 2.3% |

Total tick excess 65.37 ms (p50 44.2 → p99 93.0, max 130.3).

**The spike is the device solve, and it is superlinear.** Awake bodies rise only
1.57x (2,452 → 3,839) while `gpu_solve` rises **5.7x** (7.68 → 43.75 ms). Host
work explains 15% of the excess; device time and waiting on it explain the rest.

So the remaining spike work is a different problem from the one just fixed: it
is device work, not host overhead, and no amount of faster enqueueing touches
it. The candidates, in the order the evidence supports:

1. **CG iteration count under load.** Cost that grows 5.7x for 1.57x the bodies
   is the signature of more iterations per island as well as more islands.
   `VIBE_CITY_SOLVER_ITERATIONS` is 32; whether spike ticks are hitting that cap
   is not yet instrumented at tick level and is the first thing to measure.
2. **Per-iteration kernel cost** at high active counts.
3. `hw_bond` also spikes 1.62 → 8.00 ms (9.8% of the excess), disproportionate
   to its 0.15 ms median.

None of these are addressed by the host-wrapper work, and claiming otherwise
would misread the data.

---

# The incremental topology path is not corrupt — the scene is tuned to an under-converged solver

`BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1` zeroes every warm-start impulse whenever a
bond breaks, so each fracture tick cold-starts the CG solve. It is on because
the incremental alternative "makes the city tear itself apart". Investigated:
that reading is wrong, and the truth matters more than the bug would have.

## Reproduction

Same 8 shots, then 25 s of quiet. Incremental breaks 6.8x more bonds
(24,186 vs 3,539) and keeps cascading long after the shots stop.

## The measurement that inverted the diagnosis

Convergence telemetry (`iters=` / `unconverged=` on the `[gpu-host]` line):

| path | bonds broken | iterations/solve | unconverged |
|---|---|---|---|
| whole-reset (**shipped**) | 3,476 | **32.0 — the cap** | **99.8–100%** |
| incremental | 27,759 | 30.3 → 21.7 | 85% → 35% |

**The shipped path never converges.** It hits the 32-iteration cap on
essentially every solve. An under-converged CG underestimates the stress field,
so fewer bonds reach their limit. The incremental path retains its warm start,
converges further, and therefore breaks more.

The hypothesis this replaced — that a stale warm start left the solve
unconverged — was exactly backwards.

## Destruction is currently a function of the iteration budget

Same whole-reset path, only the cap changed:

| path | iters | bonds broken | unconverged |
|---|---|---|---|
| whole-reset | 32 | 3,383 | 100% |
| whole-reset | 128 | 7,685 | 36% |
| whole-reset | 512 | 66,788 | 51% |
| incremental | 32 | 27,772 | 45% |
| incremental | 128 | 37,061 | 61% |
| incremental | 512 | **70,139** | 11% |
| incremental | 1024 | **65,728** | 3.7% |

**20x more destruction from the iteration budget alone**, with identical
materials, identical shots and identical geometry.

## The two paths agree at convergence

Well-converged, both land at ~66–70k broken bonds. The incremental path gets
there with ~168 iterations/solve and 3.7–11% unconverged; whole-reset is still
51% unconverged at 512. **So the incremental path is correct.** It is doing what
a warm start is supposed to do — reach the same answer sooner.

## What this actually means

1. **The incremental path is not a correctness bug.** It agrees with the
   reference at convergence.
2. **`VIBE_CITY_STRESS_LIMIT_SCALE=0.45` is calibrated against truncation.** The
   city holds together because the solver stops early, not because the material
   is strong enough to hold it.
3. **Effective material strength therefore varies with load.** How far the solve
   converges depends on how many islands are contending for the iteration
   budget, so the same wall takes different damage depending on what else is
   happening in the city. That is a physical inconsistency, and it is invisible
   until you measure convergence.
4. Enabling the incremental path buys the ~26% device-time slice and the spike
   tail, but it is a **recalibration, not a drop-in**: materials must be re-tuned
   against a converged solve to preserve the look.

## Also found

`VIBE_CITY_SOLVER_ITERATIONS=1024` with whole-reset **segfaults**. Not
investigated; filed here because a crash reachable from a config value is worth
knowing about.

## Next steps, in the order the evidence supports

1. Re-tune `STRESS_LIMIT_SCALE` against the incremental path at a fixed
   iteration budget, and compare the result on video — this is a perceptual
   call, not a metric one.
2. Then enable incremental by default: it is the same physics, converged
   sooner, and it removes the cold start that drives the spike tail.
3. Investigate the 1024-iteration segfault.

## The CPU solver cannot currently serve as the reference

Using NVIDIA's CPU stress solver as ground truth is the right instinct, and it
is the correct long-term reference. Measured today it cannot be:

| solver | scenario | bonds broken |
|---|---|---|
| CPU (`VIBE_CITY_GPU_STRESS=0`) | **at rest, no shots, 20 s** | **56,614** |
| GPU | at rest, no shots, 20 s | **0** |
| CPU | 8 shots, 32 iters | 34,539 |
| GPU | 8 shots, 32 iters | 3,465 |

**The CPU path destroys a city that nothing is touching.** This is known in
tree: `record_city_trace.rs` carries a hard guard refusing to run without the
`cuda-stress` feature, whose message is "its residual makes a city at rest
destroy itself".

So the 10x difference under load is the CPU **over**-destroying, not the GPU
under-destroying, and the earlier reading of "the GPU stops 35x past tolerance,
therefore it is inaccurate" cannot stand on its own: the arm that holds a city
up under gravity is the GPU one.

**The open question is whether the CPU solver here is unmodified NVIDIA code.**
If it has been modified in this fork, this is a regression we introduced and
fixing it hands us the reference we need. If it is stock, then NVIDIA's solver
genuinely cannot hold this scene at these materials and iteration counts, which
would say the scene configuration is out of range rather than the solver being
wrong. That diff is the next thing to do, and it gates the accuracy test.
