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
