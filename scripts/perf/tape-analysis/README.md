# Tape analysis

Offline analysis of a client city tape (RECORD TAPE): decodes every packet
and frame with the client's own decoders, reconstructs what the client drew
for each meteor, and writes tables, a `summary.json` and SVG charts. Used for
[the 2026-09-24 Mac/Metal session analysis](../../../docs/mac-metal-session-analysis-2026-09-24.md).

Everything except the replay is CPU-only and needs no server.

## Inputs

- A client tape with per-frame clock data (v2 or later): `debug-reports/tape-*/city.vltape`,
  or `client.vltape` inside a paired `debug-reports/session-<id>/` bundle.
- Optional: the server log for the same run (for tick-rate health lines and
  "left the world" escape lines). ANSI colour codes are stripped.
- Replay only: a built client and the city manifest named by the tape
  header's `manifestHash`.

## Run

The TypeScript scripts import from `client/src` by relative path, so run them
with the client's `tsx` from `client/`. Outputs go to `target/tape-analysis/`
(gitignored).

```bash
TAPE=../debug-reports/tape-1790237324-city-default/city.vltape
OUT=../target/tape-analysis
cd client
npx tsx ../scripts/perf/tape-analysis/decode.ts    $TAPE $OUT                  # frames, packets, snapshots, chunks, topology, events
npx tsx ../scripts/perf/tape-analysis/dumpstats.ts $TAPE $OUT/match_stats.json # server match stats (kind 124)
npx tsx ../scripts/perf/tape-analysis/meteors.ts   $TAPE $OUT                  # per-frame meteor reconstruction + render clock
npx tsx ../scripts/perf/tape-analysis/below.ts     $TAPE                       # prints bodies streamed below y = -3 m
cd ..
python3 scripts/perf/tape-analysis/analyse.py target/tape-analysis target/mac-server-play.log
# optional: choose which meteors get a chart (default: three with most backward motion)
python3 scripts/perf/tape-analysis/analyse.py target/tape-analysis target/mac-server-play.log --meteors 30@59.57,31@63.33,25@73.13
```

`analyse.py` and `replay_compare.py` use only the Python standard library;
charts come from `svgplot.py` (no matplotlib).

| Script | Writes | What |
|---|---|---|
| `decode.ts` | `header.json`, `frames.csv`, `packets.csv`, `snapshots.csv`, `chunks.csv`, `topology.json`, `events.json` | Flat tables of every frame and packet. `frames.csv` has `gpu_ms` (the frame's timer-query passes summed) and `gpu_max_pass_ms` on tapes since 2026-09-24, empty where the frame has none; `header.json` `gpuTimer` says whether the browser could time the GPU at all |
| `dumpstats.ts` | `match_stats.json` | Match-stats packets (JSON from older servers, the compact frame of `shared/match-stats-frame.json` from current ones) with arrival times |
| `meteors.ts` | `meteor_frames.csv`, `meteor_raw.csv`, `render_clock.csv` | Replays the packets through `ReplayNetWorld` at their arrival times and, using the live client's recorded clock offset and interpolation delay, runs `MeteorLayer`'s placement (`placeMeteor`) per frame. `--legacy-meteors` mirrors the pre-2026-09-24 layer instead, for tapes recorded by that client |
| `replay-clock.ts` | `render_clock.csv`, `meteor_frames.csv`, `player_clock.csv`, `replay_summary.json` | Judges the client code in this tree against a tape: the packets go through the current `NetcodeClient` at their arrival times and the render clocks, delays and meteor placement are the code's own, not the recording's. `--wasm <pkg dir>` runs the WASM clock estimator (what the live client runs; the TypeScript copy is kept identical); `--legacy-meteors` for an older tree. The summary has render-clock backward steps, extrapolating share and lead percentiles, playout rate per 5 s, the own avatar's stutter, and meteor backward motion, handovers and below-ground frames |
| `below.ts` | stdout | Chunk bodies whose absolute-pose records are below y = -3 m |
| `analyse.py` | `summary.json`, `match_stats.csv`, `per_second.csv`, `timeline.svg`, `render_clock.svg`, `frames.svg`, `bandwidth.svg`, `scaling_tick_vs_bodies.svg`, `meteor_<body>_<s>s.svg` | All derived numbers and charts |
| `run-replay-perf.sh`, `replay-perf.mjs` | `replay_perf_<label>.json` | Server-less replay timing (GPU) |
| `replay_compare.py` | `replay_compare_<label>.json`, `replay_vs_live_<label>.svg` | Live frames vs replay frames |
| `replay-debug.mjs` | stdout | Loads `/cityreplay` offline and dumps status and console, for debugging the replay harness |
| `meteor_impacts.py` | `impacts.csv`, `events.csv`, `impact_ticks.csv`, `aligned.csv`, `meteor_summary.json`, `server_timeline.svg`, `split_excess_vs_promos.svg`, `aligned_other_ticks.svg`, `client_frames_vs_server.svg` | Paired session bundles only. Finds each meteor's first contact: the first tick whose velocity change is not gravity alone. Groups impacts less than 60 ticks apart. Per impact it measures: bonds broken and new bodies (from the log and the tape's topology); awake bodies; tick cost, split into ticks that create bodies, ticks that only break bonds, and the rest; recovery (the trailing 30-tick mean under 16.7 ms for 60 ticks); sim rate; and the client's frames, snapshot gaps and bytes. Used for [the meteor impact analysis](../../../docs/meteor-impact-analysis-2026-09-24.md). On captures with per-tick phases (`timing_version` 2, see `scripts/perf/tick_phases.py`) the split and break ticks come from the server's own stage counts, `impact_ticks.csv` gains the PhysX and stage phase columns, the summary a `capture.phases` block by tick class, and the client windows split long frames into cpu / gpu / wait |
| `cannon_vs_meteor.py` | `cannon_vs_meteor.json`, `cannon_vs_meteor.svg` | Tick cost from the 300-tick `tick_ring` in a debug report's `server.json`, with new bodies per tick from a decoded 20 s tape beside the report. Compares cannonball and meteor windows from one server run |
| `meteor-bench.sh` | `<out>/<arm>.log`, `<out>/<arm>/*.csv` | Uses the GPU. Runs perf_bench's `meteor` scenario (the 2026-09-24 session's first two meteors, replayed from their logged start and velocity) and `fracture_warm` under the machine-wide GPU lock. Arms: `timing`; `zones` (`VIBE_PHYSX_PROFILE=1`); `commits` (`CUMETAL_TRACE_COMMITS=1`); `small` (a 1 m rock); `nocorrect` (`VIBE_CITY_NATIVE_CORRECTION_LIMIT=0`) |

To analyse meteor impacts in a paired session bundle (CPU only), first decode
the bundle's `client.vltape` into `$OUT` with `decode.ts`, `dumpstats.ts` and
`meteors.ts`. Then:

```bash
python3 scripts/perf/tape-analysis/meteor_impacts.py \
  debug-reports/session-20260924-213925-ondf3t $OUT <server log> target/meteor-analysis/out
python3 scripts/perf/tape-analysis/cannon_vs_meteor.py <server log> target/meteor-analysis/out \
  "cannonballs=debug-reports/report-1790285739-city-default-tick6420:target/meteor-analysis/tape-1790285739" \
  "first meteor=debug-reports/report-1790285874-city-default-tick14280:target/meteor-analysis/tape-1790285874"
```

`meteors.ts` and `replay-clock.ts` call the layer's own placement
(`client/src/vfx/meteorPlacement.ts`), so they follow `MeteorLayer` without a
mirror to update. Their `--legacy-meteors` mode is a frozen mirror of the
layer before 2026-09-24.

Before/after for a clock or interpolation change, on one tape:

```bash
# the old tree's wasm, built and saved before the change
npx tsx ../scripts/perf/tape-analysis/replay-clock.ts $TAPE $OUT/before --wasm <old pkg> --legacy-meteors
npx tsx ../scripts/perf/tape-analysis/replay-clock.ts $TAPE $OUT/after --wasm src/wasm/pkg
```

## Replay (uses the GPU)

Plays the tape through `/cityreplay` in headless Chromium (ANGLE/Metal) at
1x following the recorded camera, with no game server, and records each
frame's rAF delta, CPU, GPU timer and awake chunks. Nothing listens on a
port: Playwright request routing serves the built client, tape and manifest.

1. Build the client into the replay directory (the wasm packages must
   already be built, e.g. by `npm run build:wasm`):
   `cd client && npx vite build --outDir ../target/tape-analysis/replay-dist`
2. Get the manifest: `GET /city-manifest/<manifestHash>` from a server
   running the same city (`client/e2e/tape-replay/record.mjs` saves it as
   `manifest-<hash>.bin`). Any saved manifest with the same hash works.
3. Stop every game server and run under the GPU lock:

```bash
scripts/perf/gpu-run.sh tape-replay-perf \
  scripts/perf/tape-analysis/run-replay-perf.sh \
  debug-reports/tape-1790237324-city-default/city.vltape \
  target/tape-replay/run1/manifest-391bacd0d2033bc213bfe72b81bf3136692aaac73c22413870515afa15cc6723.bin \
  headless            # label; then optional width height dpr headless(1/0), default 1512 945 2 1
python3 scripts/perf/tape-analysis/replay_compare.py target/tape-analysis \
  target/tape-analysis/replay_perf_headless.json headless
```

The script prints whether a `web-fps-server` was running; a replay that
shares the GPU with a server is not a server-less baseline. A warm-up pass
(3 s) precedes the measured pass. Headless frame pacing is not a display's
vsync: compare shares of long frames and per-second shape, not only means.
