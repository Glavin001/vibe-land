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
| `decode.ts` | `header.json`, `frames.csv`, `packets.csv`, `snapshots.csv`, `chunks.csv`, `topology.json`, `events.json` | Flat tables of every frame and packet |
| `dumpstats.ts` | `match_stats.json` | Match-stats JSON packets with arrival times |
| `meteors.ts` | `meteor_frames.csv`, `meteor_raw.csv`, `render_clock.csv` | Replays the packets through `ReplayNetWorld` at their arrival times and, using the live client's recorded clock offset and interpolation delay, mirrors `MeteorLayer`'s arc/body/hold/hidden choice per frame |
| `below.ts` | stdout | Chunk bodies whose absolute-pose records are below y = -3 m |
| `analyse.py` | `summary.json`, `match_stats.csv`, `per_second.csv`, `timeline.svg`, `render_clock.svg`, `frames.svg`, `bandwidth.svg`, `scaling_tick_vs_bodies.svg`, `meteor_<body>_<s>s.svg` | All derived numbers and charts |
| `run-replay-perf.sh`, `replay-perf.mjs` | `replay_perf_<label>.json` | Server-less replay timing (GPU) |
| `replay_compare.py` | `replay_compare_<label>.json`, `replay_vs_live_<label>.svg` | Live frames vs replay frames |
| `replay-debug.mjs` | stdout | Loads `/cityreplay` offline and dumps status and console, for debugging the replay harness |

`meteors.ts` reconstructs the client's drawing from its logic as mirrored in
the script (250 ms stale rule, 0.75 s unstreamed linger, 3 s landed linger).
If `client/src/vfx/MeteorLayer.tsx` changes, update the mirror.

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
