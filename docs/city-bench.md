# City bench

An automated, repeatable end-to-end benchmark of the destructible `/city`:
scripted headless players destroy the scene building by building while a
paired client+server capture records everything, then a report says whether
the server and every client stayed real-time and how efficiently the netcode
streamed it. It measures every symptom in
[the 2026-09-24 session analysis](mac-metal-session-analysis-2026-09-24.md)
and gates them against budgets, so it is the tool for keeping performance
real-time and for optimising the netcode.

## Run

```bash
scripts/perf/city-bench.sh                                   # full systematic run, 1 client (~6 min + ~1 min setup)
scripts/perf/city-bench.sh --scenario quick --clients 3     # ~2 min, 3 clients: netcode fan-out
scripts/perf/city-bench.sh --baseline target/city-bench/runs/<run>/report.json   # compare
scripts/perf/city-bench.sh --analyse target/city-bench/runs/<run>                # re-analyse only (no GPU)
```

Options: `--scenario NAME|PATH`, `--clients N`, `--buildings N` (cap),
`--intensity X` (scales shots, meteors and demolition rounds, not slot
times), `--seed N`, `--label NAME`, `--budgets FILE`, `--baseline FILE`,
`--no-build`. Exit status: 0 all budgets pass, 1 a budget failed, >1 the run
itself failed (the reason is printed and in `bench.log`). The environment
variables `HTTP_PORT`, `WT_PORT` and `CLIENT_PORT` move the server, its
WebTransport port and the client dev server off 4301/4302/3303, and
`CITY_BENCH_OUT` moves the output root (builds and runs) off
`target/city-bench`, so a second worktree can bench without sharing either.

What the wrapper does, in order:

1. Builds the release server (`--features native-destruction`) into
   `target/city-bench/cargo`, linking the PhysX package at
   `../PhysX/out/install/macos-cumetal/release`; builds the client wasm
   packages if missing.
2. Starts its own client dev server on `:3303` (proxying to `:4301`, with a
   private vite dependency cache).
3. Takes the machine-wide GPU lock (`scripts/perf/gpu-run.sh` of the main
   checkout), then `scripts/perf/city-bench/locked.sh` starts a fresh server
   (`127.0.0.1:4301`, WebTransport `:4302`, bundles into the run directory)
   and runs the driver. The server, the driver and its browsers are always
   torn down, and the lock released, when the run ends or fails.
4. Analyses the result outside the lock and writes `report.md` and
   `report.json`.

Everything generated goes to `target/city-bench/runs/<date>-<label>/`:
`report.md`, `report.json`, `run.json` (plan, phase times, sessions,
errors), `server.log`, `driver.log`, `server-stats.jsonl`,
`client-<i>-samples.jsonl`, `client-<i>-drawn.jsonl`,
`debug-reports/session-<run>-c<i>/` (the paired bundles) and
`analysis/c<i>/` (decoded tables, and the tape-analysis charts
`timeline.svg`, `render_clock.svg`, `frames.svg`, `bandwidth.svg`).

A fresh server per run is deliberate: `/city-reset` has been seen to kill the
process, and a second run on the rubble of the first measures something else.

## Scenarios

`client/e2e/city-bench/scenarios/*.json`. A scenario is a timed plan: each
step has a slot in wall seconds; a step runs until it is done or its slot
ends, and the next starts when the slot ends. A run therefore takes the same
wall time whatever the server does, and runs line up phase by phase.

| Scenario | What | Length |
|---|---|---|
| `systematic` | All 16 buildings (bond-graph components with ≥ 20 chunks, from `GET /city-buildings`) in ring order from the spawn. Per building: walk to a 10 m standoff (6 s), 3 cannonballs at seeded heights on the face (4 s), a player-fired meteor (2 s), a meteor at an exact roof point via `/city-meteor` (1 s), a demolition of the footing via `/city-demolish` (5 s; seeded straight drop or 50° wedge). The next walk is the previous collapse's settle. Then settle 6 s, drive a car through the rubble 25 s, idle 10 s | 334 s |
| `quick` | The same on the first 4 buildings, 15 s drive, 5 s idle | 123 s |

Step types: `idle`, `settle`, `walk` (`standoffM`), `cannon` (`shots`),
`meteorShot` (`shots`), `meteorAt` (`count`, `ground`), `demolish`
(`rounds`, `cutFraction`, `jitter`, `perTick`, `wedge`), `drive`
(`waypoints`). `buildings: {order: ring|nearest|id, minChunks, max}`.

Clients: client 0 plays. With `--clients N`, clients 1..N-1 are spectators
that walk to their own vantage point 25 m off each target building (spread
round it) and watch it, so each receives the destruction stream a bystander
would. Every client is headless Chromium on ANGLE/Metal, rendering on the
same GPU as the server, and records its own paired tape; the server keeps one
shared capture.

Robustness: every step has a deadline; the walker unsticks itself
(`client/e2e/mac-demo/nav.mjs`), the car resets itself when wedged; a step
that fails is recorded in `run.json` and the plan continues; the driver has a
watchdog (tape length + 240 s) and `locked.sh` a hard stop (30 min).

## Metrics

All times are on the unix wall clock (one machine): tape time maps through
the tape's `wallClockOriginMs`, server ticks carry `unix_us`. Every metric is
reported over the whole run, per coarse phase (intro, destroy, settle, drive,
idle-end), per building, per 5 s window, and the server tick also by
destruction level (active bodies; broken-bond fraction).

- **Server real-time** (`ticks.jsonl` of the capture): tick p50/p95/p99/max,
  % over 16.7 and 33 ms, sim-rate (simulated seconds per wall second) overall
  and worst 5 s, tick breakdown (dynamics / city / snapshot / player / …,
  mean, p95 and share), city encoder step/encode ms and bytes per awake
  body-tick (`city/stats.jsonl`), PhysX last step and GPU wait (the driver's
  1 Hz `/match-stats` samples), input frames per tick, destruction reached,
  r(tick, active bodies).
- **Client real-time** (tape frames): fps, frame and CPU p50/p95/p99, display
  period (median quiet frame, snapped to a refresh rate; headless Chromium
  runs rAF at 120 Hz here), % over 1.5x and 2x, hitches > 50/100 ms,
  CPU-bound frames > 33 ms, the worst hitches with phase and the server's
  worst tick within 150 ms, r(client fps, server ticks/s).
- **Netcode / streaming**:
  - bytes and packets per second per lane and per packet kind, share of
    bytes, peak second (tape);
  - sent vs received, lost, server drop outcomes, send→arrive latency per
    lane, tick-end→arrive, queue→send, the server's interest/budget decisions
    (`session_bundle.py` joins every taped packet to its send record);
  - snapshots per server tick, arrival gaps;
  - interpolation: render time's lead over the newest snapshot, % of frames
    extrapolating, render-clock backward steps (`meteors.ts` on the live
    client's recorded clock);
  - meteors: backward on-screen motion, arc→body and hold→body handover
    jumps, drawn below ground while the server sample is above (calls
    `placeMeteor`, the function `MeteorLayer` draws with);
  - rendered vs server truth: what the renderers drew (`drawnWorld()`, 10 Hz)
    against `world.bin` at the client's render time (reconstruction error)
    and at the latest tick (what the player sees vs where things are).
    Bodies drawn after the server stopped streaming them are counted as stale
    draws, separately;
  - received-snapshot quantisation error (`session_bundle.py`);
  - sync: structure repairs and full bootstraps after start, datagram and
    topology sequence gaps, repairs with no loss, city sends at the 10 kB
    ceiling, the client's ledger counters (hash mismatches, NACKs and resync
    requests sent upstream, pose jumps, clock rollbacks);
  - efficiency: city bytes per moving body-second and per record, repeat
    records (a pose restated unchanged: bytes that told the client nothing),
    snapshot bytes and unchanged snapshot bodies (`stream.ts`), the server's
    city selection (sent share of candidates, budget used).
- **Physics sanity**: bodies below y = -3 m (meteors/cannonballs in
  `world.bin`, city chunk bodies in the stream), "left the world" log lines,
  and the server's "went through the ground" (first below-ground tick) and
  "retired at the floor" lines (5 m under the lowest ground).
- **Build identity**: vibe-land commit, the server fingerprint, the PhysX SDK
  commit the server logs, the cuda-metal checkout head and the packaged
  `libcumetal.dylib` time, CuMetal warnings, machine, client renderer.

## Budgets

`scripts/perf/city-bench/budgets.json`: each budget is a metric path in
`report.json` (`clients.*.` means every client; the worst decides), an
operator and a threshold, with the reason. Initial values come from the
acceptance criteria of the session analysis' to-do list:

| Budget | Limit |
|---|---|
| Server tick p95 / p99 | < 16.7 / < 33.3 ms |
| Ticks over 16.7 ms | ≤ 5% |
| Sim-rate overall / worst 5 s | ≥ 0.98 / ≥ 0.9 |
| Client frame p95 | < 2 display periods |
| Client frames over 2 periods | ≤ 5% |
| Client hitches > 100 ms; CPU-bound > 33 ms | 0; 0 |
| Render-clock backward steps | 0 |
| Render lead over newest snapshot p95 | < 50 ms |
| Frames extrapolating | < 10% |
| Snapshots per server tick | ≥ 0.98 |
| Snapshot gap p99 | < 50 ms |
| Lost packets; server drops | 0; 0 |
| Send→arrive p99 | < 20 ms |
| Structure repairs without loss | 0 |
| Meteor arc→body / hold→body jump | < 1 m / < 2 m |
| Meteor backward frames; drawn below ground | 0; 0 |
| Body render error p99 (at render time) | < 0.5 m |
| Local player error p99 (now) | < 0.5 m |
| Match stats share of bytes | < 2% |
| Energy messages | ≤ 10/s |
| Bodies below -3 m | 0 |

Tune a limit in the file; set `"enabled": false` to keep a budget visible
but not gating. `display_period_ms` overrides the detected display period.

## Comparing runs

`--baseline <report.json>` records and prints deltas of the headline numbers
(server tick percentiles, sim-rate, GPU wait, destruction reached, and per
client frame p95, snapshots per tick, lead p95, extrapolating %, backward
steps, meteor backward frames, bandwidth, bytes per moving body-second,
latency p99, repairs, body error p99). Destruction is not bit-reproducible
(GPU rigid bodies), so compare runs of the same scenario and check the
destruction reached (`server.destruction`) before reading a delta as a
change: the per-level table (tick cost by active bodies) is the fairer
comparison when the damage differs.

## Files

| File | What |
|---|---|
| `scripts/perf/city-bench.sh` | The wrapper: build, dev server, GPU lock, analysis |
| `scripts/perf/city-bench/locked.sh` | The locked part: server and driver, always torn down |
| `scripts/perf/city-bench/report.py` | The analysis and the report |
| `scripts/perf/city-bench/stream.ts` | Streaming efficiency from a tape (repeats, moving bodies, snapshot presence) |
| `scripts/perf/city-bench/budgets.json` | Budgets |
| `client/e2e/city-bench/bench.mjs` | The driver (Playwright) |
| `client/e2e/city-bench/scenarios/` | Scenarios |
| `client/e2e/city-bench/vite.bench.config.ts` | The client config with a private dependency cache |

It reuses `client/e2e/mac-demo/nav.mjs` (walking, driving),
`scripts/perf/session_bundle.py` (the paired join) and
`scripts/perf/tape-analysis/` (`decode.ts`, `dumpstats.ts`, `meteors.ts`,
and `analyse.py` for charts). The client counts the NACKs and resync
requests it sends upstream (`CityClient.nacksSent`, `nackBodiesSent`,
`resyncRequestsSent`, in the e2e city snapshot), since upstream traffic is
not on the tape.

## Limits

- PhysX step and GPU wait come from 1 Hz samples of the last step, not every
  tick; the per-tick breakdown has `dynamics_ms` (98% of the tick) but not
  its GPU-wait share.
- `meteors.ts` calls the client's own `placeMeteor`
  (`client/src/vfx/meteorPlacement.ts`); `--legacy-meteors` approximates
  the pre-2026-09-24 layer for comparisons with old tapes.
- The render error depends on the client's recorded clock offset; the
  mapping was checked on bodies in flight (0.0–0.2 m while streamed).
- Headless Chromium frame pacing is not a display's vsync.
