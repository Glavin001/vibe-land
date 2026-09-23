# Server physics cost on Mac/Metal (2026-09-23)

What a server tick costs on an M3 Max running PhysX GPU through CuMetal:
how it was measured, what changed, and what is still over budget.

## Measuring

- `server/src/perf_bench.rs` (ignored test, `--features native-destruction`)
  builds the production city arena and steps it the way `MatchState::tick`
  does, with fixed inputs at fixed ticks. Each scenario prints one `PERF` JSON
  line and its worst ticks as `SPIKE` lines.
  - Scenarios: `city_idle`, `city_walking`, `city_boxes_100` (settling, then
    asleep), `city_balls_100_rolling`, `fracture_cold`/`fracture_warm` (six
    cannonballs), `debris_idle`, `debris_awake` (a ball rolled into the rubble
    every 10 ticks), `demolition`.
  - `VIBE_PERF_SCENARIOS=a,b` runs a subset.
  - `VIBE_PERF_PACE=1` holds ticks to 60 Hz. Use it for idle and walking;
    see below.
  - `VIBE_PHYSX_PROFILE=1` adds the engine's own zones, with call counts, to
    each `SPIKE` line.
- `physx-bridge/tests/step_cost.rs`: rigid-only step cost by scene state
  (asleep, settling, rolling, walking among 100 boxes).
- `client/e2e/perf-e2e.mjs`: the real server and client with scripted play.
  It collects every server tick from `/match-stats` and the client frame rate,
  and refuses a software renderer (Chromium runs with `--use-angle=metal`).

Destruction runs are not deterministic run to run (broken bonds differ
between identical builds), and a busy desktop moves every number. Compare
builds with interleaved A/B runs.

## Idle and walking are latency, not compute

Stepped back to back, the idle city costs 0.66 ms and walking 1.1 ms. At the
server's real 60 Hz pace the same ticks cost about 1.8 ms and 2.6-3.0 ms: the
GPU clocks down in the 15 ms between ticks, and each tick holds two host syncs
(the broadphase readback and the destruction stage's idle check). An idle tick
does about 0.1-0.2 ms of GPU work in 12 command buffers. Thread QoS makes no
difference; busy-waiting the CPU through the gap recovers only a quarter.

## Changes and effect (unpaced medians unless stated)

| Scene | Before | After |
|---|---|---|
| Idle city | 0.98 ms | 0.66 ms (1.8 paced) |
| Walking | - | 1.1 ms (2.6-3.0 paced) |
| 100 boxes asleep | 0.98 ms | 0.67 ms |
| 100 balls rolling | 4.4 ms | 2.3-2.8 ms |
| Rubble, all asleep | 9.5 ms | 0.8 ms (4.2 while fragments settle) |
| Rubble, 100-370 bodies awake | - | 5-7 ms, p99 7-9 ms |
| Fracture p99 / max | ~70 / 114 ms | 21-30 / 28-45 ms |
| Demolition max | 94 ms | 26-41 ms |
| First fracture (cold pipelines) | 1278 ms | 44 ms |

"After" is a range where the desktop load moved the numbers between runs.

The changes, by repository (all uncommitted):

- **PhysX fork.**
  - Pre-solve island storage could index past the node registry once the two
    grew apart. That aborted the scene about 850 ticks into a pile of rolling
    bodies, and plausibly caused fragments falling through the floor. The same
    overflow is silent on CUDA; this is fixed on all platforms.
  - Motion-mode construction runs as ordinary launches.
  - A cache skips the principal-frame solve when a root's inertia is unchanged.
  - The force-threshold mask race is fixed.
  - The fine-level stress hierarchy construction is split into launches, but
    opt-in only (`BLAST_STRESS_SEPARATE_CONSTRUCT=1`). It takes 1-3 ms off
    spike p99 and adds 0.7 ms to every awake-debris tick.
  - Details: PhysX `docs/CUMETAL_COMPATIBILITY.md`.
- **CuMetal.**
  - Heap allocation is the default under raw device addresses (one residency
    declaration per heap).
  - Per-launch scratch slots are recycled.
  - 8-bit radix passes take a 32-bit sort from 96 dispatches to 12.
  - The launch path is 12% cheaper on the host (cached settings and pipeline
    facts, no registration copies on graph replay).
  - Details: cuda-metal `docs/known-gaps/runtime.md`.

## Still over budget: destruction spikes

A fracture tick runs the destruction stage twice (trial, then correction). By
the engine's zones:
- About 2 ms of host submission per pass.
- 3-5 ms waiting on stress and topology GPU work per pass.
- 1.5-3 ms of synchronous connectivity readback per pass.
- 3-10 ms of corrected collision solve and 3-4 ms of correction acceptance,
  once per tick.

About 4-6% of the ticks in a six-shot bombardment exceed 16.7 ms. Sustained
awake rubble and walking stay inside the budget.

Levers not yet taken, largest first:

1. Replay captured CUDA graphs as Metal indirect command buffers in CuMetal.
   Submission is per node today, which is the ~2 ms per pass and much of every
   awake tick.
2. Make the connectivity readback asynchronous, or device-owned while sleeping
   is enabled.
3. Choose the split hierarchy construction only on ticks the host expects to
   fracture, keeping its spike gain without the awake cost.
4. Skip the idle check's sync when the island manager reports every cluster
   body asleep. That is about a third of an idle tick, but it changes a
   deliberate verify-then-publish design in the destruction stage.
