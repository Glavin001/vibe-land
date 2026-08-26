---
name: perf-measure
description: Measure server tick performance without fooling yourself — which endpoint to read, which fields nest inside which, and the six traps that have each produced a wrong conclusion in this project. Use when profiling the city step, comparing hardware or scenes, investigating a slow tick, or before claiming any performance number.
---

# Measuring server performance

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

Turn on the fetch split before any perf run:

```
-e VIBE_PHYSX_PROFILE_FETCH=1
```

Without it, `physics_fetch_ms` is one opaque number and the split between
*waiting on the GPU* and *copying results back* is invisible.

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
