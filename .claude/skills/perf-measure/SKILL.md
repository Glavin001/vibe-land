---
name: perf-measure
description: Measure server tick performance without fooling yourself. The bench.sh scenario matrix, the wall-time tree that decomposes at every level, the cost-driver regression that says WHY a phase is expensive, and the thirteen traps that have each produced a wrong conclusion in this project. Use when profiling the city step, comparing builds or scenes, investigating a slow tick, or before claiming any performance number.
---

# Measuring server performance

## The one command

```bash
scripts/perf/bench.sh --label base           # full matrix: idle + light + heavy
scripts/perf/bench.sh --label mychange       # record the other arm
scripts/perf/bench.sh --ab base mychange     # matched, refuses invalid compares
scripts/perf/bench.sh --show base            # re-print, no re-run
scripts/perf/bench.sh --label x --quick      # grid 1, ~2 min end to end
```

`bench.sh` is the entry point for anything you intend to QUOTE. It runs the
three load regimes, prints one hierarchical budget per scenario, and stamps
each set with git hash, binary inode+mtime, and the full BLAST_*/VIBE_* env,
into `bench-results/perf/<label>/`. `--label` is mandatory: an unlabelled run
cannot be compared later without guessing what it was.

### The procedure, in order

Every conclusion in this file was reached this way. Follow it rather than
improvising, because each step exists to stop a specific wrong answer.

1. **`bench.sh --label <name>`.** Never hand-run `record-city-trace`; the
   wrapper is what guarantees the env, the feature set, and the fingerprint.
2. **Read each scenario's CITY UNDER TEST block first, not its timings.** A
   per-phase table that does not say which structural regime it describes is
   an anecdote. If REGIME CHECK failed, the timings under it describe a
   different experiment than the name claims -- do not quote them.
3. **Read the COVERAGE line.** Below 99.9% exact means a phase is unnamed and
   any conclusion about that subtree is provisional.
4. **Read the `wall` column, not `raw`.** `wall` decomposes at every level;
   `raw` is thread time under a `[parallel]` node and legitimately exceeds its
   parent.
5. **Check `hit%` and `/hit` before calling a phase cheap.** `events` averages
   0.21 ms and is really a 1.33 ms spike on 16% of ticks.
6. **Read the cost-driver table at the end** (`drivers.py`, printed
   automatically). A mean says a phase is expensive; the driver says whether
   it is expensive for the WRONG REASON. A per-tick walk whose cost tracks
   TOTAL bodies is doing work for bodies that are frozen -- an algorithmic
   defect with a known fix, not a constant factor to shave. A low R2 means the
   model is missing that phase's real driver; find it before designing a fix.
7. **Only then compare.** `bench.sh --ab base <name>`, honouring `min_reps`.

### What a single run can and cannot resolve

Three IDENTICAL `saturated` runs ended at 53,437 / 62,488 / 60,597 broken
bonds -- a **14.5% spread**. The cascade is chaotic and GPU rigid-body
simulation is not bit-reproducible, so the arms genuinely simulate different
cities even with the binary, env and scene fixed.

So: `intact` and `onset` hold their work counters to a few percent and a 3-5%
timing delta there is real. On `demolition` / `saturated` / `aftermath`, **a
single-run delta under ~15% is indistinguishable from cascade drift** no matter
how clean the timing looks. Measure small wins on the tight scenarios, confirm
direction on the deep ones, and use n>=3 (`min_reps`, enforced by the A/B gate)
before quoting a deep-scenario number.

**Read the COVERAGE line before reading anything else.** Every tree ends with
`COVERAGE attributed N%`, split into exact residual and sampling error. Above
99.9% exact means the breakdown accounts for the tick. Below that it prints
`COVERAGE WARNING` naming the phase with the largest hole -- that is a missing
span, and any conclusion drawn from that subtree is provisional. As of
2026-09-01 `st_graph` carries a real ~1.5-1.9% hole; it is not yet named.

`--ab` REFUSES rather than reports when the arms broke bond counts more than
10% apart, because a per-phase delta across diverged physics is a different
workload, not a speedup. It also warns when both arms share a binary inode AND
an identical env, which means you are comparing a run against itself.

`scripts/perf/profile.sh` remains for one-off single-scenario work and
`--reuse` re-analysis. It sources the same physics-env.sh.

**The files, and which question each answers.** All under `scripts/perf/`:

| file | question it answers |
|---|---|
| `bench.sh` | run the matrix, fingerprinted and labelled |
| `scenarios.py` | which regimes exist, what each PROVES, and the assertions that prove the run reached it |
| `bench_report.py` | what city was simulated; is the A/B legitimate |
| `dist.py` | where did the wall time go (the tree) |
| `drivers.py` | WHY -- what variable drives each phase |

Scenarios are declarations, not shot counts. Add one in `scenarios.py` with a
`purpose`, a `proves`, and `asserts` that fail if the run misses the regime --
that gate caught the original scenario set claiming a 15-60% damage band it
could not reach, and caught a `settled` scenario asserting a resting state that
does not exist.

**The 18.6% damage ceiling.** A 2,000-shot / 200 s probe showed damage saturates
at 18.6% of bonds; the plateau arrives by ~450 shots and the next 1,550 add
0.9%. The 25-75% partly-demolished band -- which the convergence analysis calls
the hardest regime -- CANNOT be produced by shooting. Use the standalone
`gpu_stress_suite` for it. Do NOT raise `VIBE_CITY_SHOT_BLAST_RADIUS` or
`VIBE_CITY_SHOT_STRESS_IMPULSE` to force it; those are production physics
constants and moving them makes the suite describe a game nobody plays.

It prints a hierarchical budget where the shares add up, plus the worst
ticks fully decomposed. It refuses to run while the vl4 server is up,
because that server holds a CUDA context and tracing beside it inflated the
tail 60x. It sets the physics env to match run-vl4-server.sh, builds with
`cuda-stress,blast-core`, and excludes ring warm-up. None of that is
optional and none of it should have to be remembered.

**`max` does not decompose.** A parent's worst tick and a child's worst tick
are different ticks, so subtracting them describes no tick that ever ran.
Percentages in that table come from SUMS, which do decompose; the quantiles
beside them are shape. Columns marked `~` are sampled 1-in-16 or ring
-smoothed -- fine for a 1 Hz report, wrong per-tick, and never valid as a
per-unit denominator (`dist.py` raises rather than dividing by one).

Every wrong performance conclusion in this project came from a measurement
problem, not a reasoning problem. This is the procedure that avoids repeating
them.

Background and a full worked baseline: `docs/PERFORMANCE-ON-SMALL-GPUS.md`.

## Read the JSON, not the overlay

```bash
curl -sk https://<host>:<web_port>/match-stats/city-default | jq
```

**The in-game overlay hides fields.** `events_ms` and `filters_ms` are published
in the JSON but have no row in `client/src/city/CityStatsOverlay.tsx`. Reading
the overlay instead of the JSON produced a wrong root-cause hypothesis that
survived several rounds.

The fetch split is now published by default (F11). `physics_gpu_wait_ms` and
`physics_fetch_copy_ms` are populated on every tick: on the 1-in-16 sampled
ticks they are that tick's exact values, otherwise the recent-ring mean.
Before F11 they were hard 0.0 on unsampled ticks, so a 1 Hz debug report
essentially always showed `0.0` and PhysX looked opaque when it was only
unpublished — if you are reading an older report, that is why.

`VIBE_PHYSX_PROFILE_FETCH=1` still forces per-tick polling for traces that
need every tick exact, at the cost of a burned core (see trap 1).

The callback breakdown (`cb_extract_ms`, `cb_pair_load_ms`, `cb_queue_ms`,
`cb_wake_ms`) is also on by default since its timers moved to rdtsc
(~0.05 ms/tick). `VIBE_PHYSX_PROFILE_CALLBACK=0` turns it off. This is the
breakdown that matters most right now: measured 200 -> 5600 awake bodies,
GPU sim wall grew 3.3x while contact callbacks grew 24x (0.4 -> 9.6 ms).

## The six traps

**1. `VIBE_PHYSX_PROFILE_FETCH=1` busy-polls a core.**
`physx-bridge/src/physx_bridge.cc:874-887` spins on `fetchResults(false)`. The
comment says so: *"Polling burns a core, so it is opt-in and off by default."*
That spin competes with the Blast serial walks, so **measuring the split may
inflate the tick you are measuring.** Baseline both ways before trusting a
number.

**2. Some fields are parents of others.** `server/src/main.rs:261-300` documents
the nesting. `stress_solve_ms` **and** `tick_ffi_ms` are both parents of
`begin_ms`/`solve_ms`/`end_ms`/`readback_ms`/`events_ms`/`filters_ms`. Summing a
parent with its children double-counts. `step_ms` is a separate parent with a
different child set.

**3. Idle and loaded are different regimes.** The quiet-skip gate
(`physx-bridge/src/destruction.cc:1341-1357`) skips the whole membership diff
when topology has not changed. A sample taken while the city is settled is on
the *cheap path* and is a **lower bound**, not a worst case.

**4. Instantaneous vs windowed vs averaged.** `step_ms` is last-tick;
`timings.total_ms` is a rolling average; `window_step_ms` is a 60-sample window.
Comparing them directly is a category error — `city step 40.1 ms` next to
`tick avg 32.6 ms` is not a contradiction.

**5. Hand-driven runs are not comparable.** Two demolitions reach different
extents, so per-unit ratios drift. A 3060 at 10k bonds versus a 5060 Ti at 24k
bonds says nothing about the hardware. Use identical scripted input or do not
compare.

**6. `gl.render` on the client is CPU submission time, not GPU execution.** A
client can be entirely GPU-bound while `gl.render` reads 0.4 ms — the cost lands
in `off-frame`, which is just `frameTotalMs − cpuFrameMs`
(`client/src/city/renderStats.ts:95`).

## What actually drives the tick

Do not assume. On the one box measured so far:

| Cost | Driver |
| --- | --- |
| `physics_gpu_wait_ms` | GPU busy — **the CPU is blocked here, the GPU is not idle** |
| `physics_fetch_copy_ms` | result copy, scales with body count |
| `begin_ms` | serial injection walk, scales with **islands** |
| `solve_ms` | scales with **intact bonds** — falls as the city pulverises |
| `gpu_stress_solve_ms` | the only genuinely GPU-bound part of Blast, ~1 ms |

**The CUDA stress solve does not scale with island count.** It works on intact
bonds, so GPU cost peaks mid-demolition and *falls* as things break, while the
serial walks only grow. A linear extrapolation from a partial demolition
predicted 25 Hz where the box delivered 38.

## Deterministic benchmarking

`server/src/city_bench.rs` is the honest harness — *"fixed rays from fixed
points at fixed ticks. No browser, no network, no walking"*:

```bash
VIBE_CITY_SCENE=high-rise-10f-local.json VIBE_CITY_GRID=4 \
  cargo test -p web-fps-server --features destruction city_bench -- --nocapture --ignored
```

It is honest about what it cannot promise: GPU rigid-body simulation is **not
bit-reproducible** across runs (parallel reduction order varies), so measured
damage swings 10–15%. Phase timings are stable to <2% even when bond count moves
12%, and `us/body` normalises whatever scale a run produced. The gate catches
gross drift, not fine deltas.

**It is `#[cfg(test)]`, so it cannot run on a rented box.** That is the main gap
in this project's measurement story — every cross-hardware comparison so far has
been hand-driven and therefore caveated.

## Client-side frame profiling

```bash
E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
  npx playwright test --config e2e/playwright.config.ts city-frame-profile
```

Reports avg/p95 per phase at rest and under demolition. It asserts only
structural invariants — the phases account for the frame (`unattributedMs < 6`),
and the renderer is not the bottleneck. **Absolute budgets belong to the machine
running it**, not to the code, which is why the spec reports rather than gates
them.

## THE FIDELITY FLOOR (owner rule, 2026-08-27 — supersedes any perf idea)

**The stress solve is LOCKSTEP with the physics step, and must stay there.**
Resim's contract: contact event → simulate the tick → if that tick's solve
detects a fracture, REWIND and re-run the same tick with the fracture applied,
so the body breaks as if pre-fractured. Fracture detection must happen inside
the same tick as its contact — the rewind window IS the tick.

Resim-enabled quality is the floor; performance comes after, never instead. An
optimization is admissible ONLY if mathematically identical in simulation
outcome — same contacts, same solve inputs, same fracture timing, same rewind
semantics (equality up to the GPU's documented nondeterminism). This extends
the "no caps/clamps/truncation" rule to SCHEDULING:

- INADMISSIBLE: stress/fracture at reduced cadence (even dt-compensated),
  result-offset pipelining of anything the simulation consumes, catch-up
  steps that skip destruction bookkeeping, any tick-delay between a contact
  and its fracture detection.
- ADMISSIBLE: pipelining restricted to already-committed state (encode/
  publish of tick N−1's finalized snapshot during tick N's gpu_wait),
  cheaper onContact extraction, host-walk optimizations, anything provably
  outcome-identical.

## Three more traps, learned 2026-08-27

**7. A/B arms must simulate the same city.** Disabling contact reports
"saved ~6 ms" — but reports also feed stress injection, so the fast arm broke
21% fewer bonds and was simulating a smaller city. Bucket-matching cannot
rescue arms whose physics diverged. `scripts/perf/verdict.py` now REFUSES the
comparison (bond band, physics-env fingerprint, regime overlap) — use it via
`python3 -m scripts.perf.compare latest <labelA> <labelB> [-n 2]`; do not
hand-roll verdicts.

**8. Census/differential gates are differences, never absolutes.** The floater
census counts frozen and engine-asleep alike and legitimately includes
bond-held bodies; an absolute `=0` gate false-failed on the documented benign
tail of 2–4. Gate ON THE DELTA between arms.

**9. Do not rebuild during an experiment.** A cargo build mid-battery replaces
the trace binary between arms. Run dirs embed the short git hash and meta.json
carries the binary mtime, so this is now visible — check the run names match
before trusting a verdict.

**10. Build measurement binaries with `--features cuda-stress`, never
`--features destruction`.** `destruction` compiles the CUDA stress solver OUT
and falls back to the CPU CG solve, whose residual reads as real stress: an
untouched city breaks ~30,000 bonds in 90 s where the GPU path breaks 0. An
entire afternoon's bisect came back red on source that was green hours
earlier, purely from this. `record-city-trace` now REFUSES to start without
the feature, meta.json carries `cuda_stress`, and `verdict.py` refuses any arm
containing a CPU-solver run — but the flag is still yours to get right when
building by hand. The startup banner is the confirmation:
`[destruction] CUDA stress solver active`.

## The measurement stack (2026-08-27)

- Runs live in `bench-results/runs/<stamp>-<label>-<shortgit>/` with a
  fingerprinted meta.json (env, git, binary). `record-city-trace --label X`
  writes there; timings.jsonl carries per-tick wall phases + every generic
  span.
- New metrics are ONE `span_add(name, ms, kind)` call in the bridge (kind 0
  wall / 1 slot-summed / 2 count) — they appear in /match-stats (`spans`),
  traces, and debug reports automatically.
- `tick_unattributed_ms` (server) is the bracket-gap tripwire; the
  timing_consistency test asserts the bracket map in CI.
- The registry copy of match-stats carries `tick_ring` (last 300 ticks) for
  debug-report forensics; the client packet does not.
- `physics_contact_pairs` is ABSENT (not 0) under the GPU pipeline; pair
  activity = `spans.physics/gpu_found_lost_pairs` + contact high-waters.

## Two traps that produced wrong numbers on 2026-08-31

**11. A caller that RESTATES the physics env instead of sourcing it.**
`profile.sh` inlined its own copy and omitted `BLAST_BOND_STRESS_GPU` (so
`hw_bond` ran the serial CPU walk at 10.3 ms, 14.5x its real cost, and was
FLAT across load -- 25% fewer live bonds bought 4% less time) and
`BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY` (so the "idle" city broke 49,832 bonds
with nobody shooting). Both fixed by sourcing `physics-env.sh`. If you need a
knob, add it THERE.

**13. `pkill -x web-fps-server-vl4` silently does nothing.** `-x` matches the
process NAME, which the kernel truncates to 15 characters (`web-fps-server-`),
so an 18-char pattern can never match. `pgrep -x` fails the same way, so a
"did it stop?" check built on it reports success while the server is still up
holding the GPU. Use `kill $(pgrep -f '[w]eb-fps-server-vl4')` and verify with
`ps -eo pid,args | grep`.

**12. `run-vl4-server.sh` launches a HARDLINK, `web-fps-server-vl4`.** A
`cargo build` writes a new inode at `web-fps-server` and leaves the hardlink
pointing at the old one, so the running server can be hours stale. Observed as
a 2.3x `solve_ms` "regression" (4.1 -> 9.3 ms at matched damage) that was
entirely a stale deploy: the reports carried build 03:40:30 / git 41e8739 and
were missing six `BLAST_*` flags the afternoon build had. **Always check
`fingerprint.binary_mtime_unix` and `fingerprint.git` in a debug report before
comparing it to anything.** `stat -c %i` on both names tells you instantly
whether the hardlink is intact.

## Before claiming a number

1. Which sample — idle or loaded? Was the quiet-skip firing?
2. Was `VIBE_PHYSX_PROFILE_FETCH` on? Did it inflate the tick?
3. Are the fields you summed siblings, or is one a parent?
4. Is this instantaneous, windowed, or averaged?
5. If comparing two runs, was the input identical?
6. Do the parts add up to the whole? (`dynamics_ms + step_ms ≈ total_ms`)

If a claim rests on an assumption, write the assumption down next to it. A
conclusion whose assumption is later disproved should be **discarded, not
patched**.
