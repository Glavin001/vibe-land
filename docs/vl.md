# `scripts/vl`: autonomous reproduction, debugging and performance

`vl` is one entry point an agent can drive end to end, with no human in the
loop. Every command that needs a server launches its own: vite, the server and
a headless player, on private ports (4311 / 4312 / 3313), with the server under
the GPU lock (`scripts/perf/gpu-run.sh`). It writes a run directory and exits
non-zero on failure.

Run it with `uv`; the shebang does this, and numpy is declared inline.

## What every server records (no flags)

The flight recorder is on by default; `VIBE_FLIGHT_RECORDER=0` turns it off.
It costs about 1 µs a tick.

- **Tick records.** The last 600 ticks, each a full `TickTiming` record:
  brackets, PhysX phases, stage counts, and zones when
  `VIBE_PHYSX_PROFILE=1`. Read them with `GET /match-stats/:id/ticks`.
- **Spike dumps.** A tick over `VIBE_SPIKE_DUMP_MS` (33) writes
  `debug-reports/spike-*` with ±120 ticks.
- **Invariants.** Velocity explosions, escaped bodies, rejected or missed
  frames and stage error bits write `debug-reports/anomaly-*`.
- **Repro bundles.** Every report, spike and anomaly dump carries `repro/`
  (format in `docs/repro-bundle.md`):
  - the city events since the server started;
  - the last minute's inputs and poses;
  - the recent ticks;
  - the server's settings.

## Performance

| Command | Answers |
|---|---|
| `vl perf scenario <name> [--reps 3] [--env K=V] [--gpu-trace]` | Runs `scenarios/perf/<name>.json`. Records every tick, then explains and diffs each step. With repetitions it writes `summary.json`. |
| `vl perf explain <ticks/dir>` | For each spike: the phases that grew against its neighbours, and the counts and events that grew with them. Also: what a steady tick is made of, a cost model per phase, and where the over-budget time goes. |
| `vl perf diff A B` | What changed between two runs or steps (medians). |
| `vl perf compare runA runB` | B − A per metric, as a 95% Welch interval over repetitions. Marks only differences whose interval excludes zero and that are at least 5% and 0.3 units. Warns when the two arms ran in different physics regimes. |
| `vl perf gpu <run>` | Real GPU time on Metal. With `--gpu-trace`: GPU busy per tick against the CPU's wait, command buffers per tick, kernels. With `--env CUMETAL_TRACE_GPU=1`: exact per-kernel duration and grid. |
| `vl perf suite [--reps N]` | `scenarios/perf/suite.json`: runs the scenarios, checks budgets, appends to `bench-results/history.jsonl`. |
| `vl perf history <scenario>` | The trend, commit by commit. |
| `vl perf record --out D` / `vl perf spikes` | Pull a live server's ring; list the spike dumps. |

Rules learned on the way:
- **Never trust one run.** One fleet run's aftermath took 46 stress iterations
  a tick and the next took 9. Use `--reps 3` and `compare`.
- **The profiler changes the timing.** Explain with `VIBE_PHYSX_PROFILE=1`,
  and quote numbers from unprofiled runs.
- **On Metal, `cuda.*` zones are host time.** Use `vl perf gpu` for GPU time.
- **A run without the stage is not a measurement.** If the server rejects the
  destruction configuration, the city runs with no destruction and every tick
  is cheap. A scenario fails when no tick carries a stage record, and quotes
  the server's error. Set `"expect": {"stage_live": false}` to run without it.

## Reproduction

| Command | Does |
|---|---|
| `vl triage [debug-reports]` | Groups every dump by symptom and prints the `vl repro` command for each group. |
| `vl repro <dump> [--reps 3]` | Builds a scenario from the bundle and runs it N times, then prints the reproduction rate. The scenario has three parts:<br>• the recording's settings;<br>• the city events since the last reset, at their tick offsets;<br>• the broken expectation (the anomaly's kind, no tick over the spike threshold near where it fell, or the report's client symptoms). |
| `vl repro <dump> --emit-test NAME` | Writes `scenarios/repro/NAME.json`, a test that fails while the bug reproduces: `vl perf scenario scenarios/repro/NAME.json --reps 3`. |

The physics is not bit-reproducible, so a reproduction is a rate and a fix
must move the rate. Player inputs are recorded but not yet replayed: the
reproduction drives the world, not the player's camera.

## The loop, end to end

```
vl triage                                # what is broken, largest first
vl repro <dump> --reps 3                 # does it reproduce, how often
vl perf explain <run>/rep-0              # why: phases, counts, events
vl perf gpu <run> (--gpu-trace)          # which GPU work, on Metal
# ... change the code or setting ...
vl perf scenario scenarios/repro/X.json --reps 3   # the test passes now
vl perf compare <before> <after>         # by how much, and is it real
vl perf suite                            # nothing else regressed
```

Worked examples (2026-10-03, Metal):

**The destructible fleet's +12 ms idle tick.** The steps were:
1. `compare` pinned it at +11.9 ms (interval 11.9–12.0).
2. `vl perf gpu` showed 11 ms of real GPU work.
3. The exact per-kernel trace named one 128-thread kernel,
   `validateChunkCommands`, at 5.9 ms. It was O(clusters × chunks).
4. Fixed in PhysX. The idle tick went from 13.3 to 5.4 ms, and over-budget
   meteor ticks from 43% to 20%.

**Lost steps under the reject policy.** The steps were:
1. The `stage_error` anomaly dumped itself.
2. `vl repro` reproduced it 2 of 2.
3. `--emit-test` wrote the test.
4. With `PX_DESTRUCTION_ALLOW_UNCONVERGED=1` the test passes.
