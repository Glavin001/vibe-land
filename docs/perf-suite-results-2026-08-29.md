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
