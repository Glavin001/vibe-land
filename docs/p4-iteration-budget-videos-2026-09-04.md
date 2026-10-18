# P4: iteration budget and limit scale, on video (2026-09-04)

The plan's P4 asks whether the stress solver should run 256 iterations with incremental
topology (so islands converge and the settled skip engages) instead of production's 32
iterations with whole-reset-on-topology. The standing cost at rest favours it (grid 2:
4.3 -> 1.35 ms). This note is the evidence for the part only the owner can decide: what
it does to the destruction look, and what it costs while things are actually falling.

## What was recorded

Same binary (vl4 `aca4932` + bss-2 `a6a6de22`), same scene and shots for every arm:
fractured-downtown, grid 1 (27 targets), 26 shots every 90 ticks over 45 s, production
shot profile, resim on, `scripts/physics-env.sh` for everything not listed.

| arm | iterations | topology | STRESS_LIMIT_SCALE |
|---|---|---|---|
| `prod-it32-s045` | 32 | whole reset | 0.45 (production) |
| `it256-s080` | 256 | incremental | 0.80 |
| `it256-s060` | 256 | incremental | 0.60 |
| `it256-s045` | 256 | incremental | 0.45 |

Videos (static vantage camera, 1080p, ground truth from the recorded trace):
`https://209.121.195.117:40617/viewer-videos/p4-budget-2026-09-04/<arm>-vantage.mp4`
(the `prod-it32-s045.mp4` without suffix is a roaming-tourist render that mostly
frames the sky; ignore it). `*-annotated.mp4` carry per-second awake / bonds / tick
numbers burned in.

## Numbers from the same recordings

| arm | bonds broken | peak awake | bodies at end | sim p50 / p95 (ms, all ticks) | islands skipped |
|---|---|---|---|---|---|
| prod-it32-s045 | 10,230 | 2,305 | 2,781 | 11.6 / 41.6 | 3% |
| it256-s080 | 18,690 | 4,553 | 4,962 | 23.8 / 138.0 | 3% |
| it256-s060 | 25,779 | 5,660 | 6,504 | 30.8 / 157.0 | 2% |
| it256-s045 | 33,957 | 7,454 | 9,096 | 43.1 / 227.6 | 2% |

At matched load (ticks with 500-1500 awake bodies), device solve p50: production 1.07 ms,
it256 arms 12-13 ms (few such ticks in the it256 arms, because they spend the run far
above 1,500 awake).

## What this says

- The converged solve carries more load into the bonds: even at limit scale 0.8 the
  256-iteration arm breaks 1.8x the bonds production does, and at 0.45 it breaks 3.3x.
  Matching production's amount of destruction would need a scale well above 0.8, which
  is a different look to sign off, not a free switch.
- Under destruction the settled skip does not engage either way (2-3% of islands), so
  the 256-iteration budget is paid nearly in full on every dirty island: the device
  solve is roughly an order of magnitude more expensive per tick while things move.
  The at-rest saving (~3 ms at grid 2) is real; the loaded cost is much larger.
- Single runs; the bond counts carry the usual +/-30% cascade drift. The ordering by
  scale is monotonic here, and the cost gap is far outside the drift.

Recommendation: keep production at 32 iterations + whole reset. The lever that still
looks worth pursuing on the device side is making the 32-iteration solve itself cheaper
(kernel efficiency, or the two-level AMG the plan defers), not raising the budget.

## Seen in the videos, unrelated to the budget

Clusters of chunks hang in mid-air above collapsed sections in every arm (visible from
~12 s on). They are frozen/sleeping bodies whose support went away; the production arm
shows the same. Worth its own look; it is not a solver-iteration effect.

## Regenerate

```
# record (each arm ~2 min, writes a 3.7 GB .towertrace)
. scripts/physics-env.sh; export VIBE_CITY_GRID=1
VIBE_CITY_SOLVER_ITERATIONS=256 BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=0 VIBE_CITY_STRESS_LIMIT_SCALE=0.6 \
  ./target/release/record-city-trace --scene destruction/assets/scenes/fractured-downtown.json \
  --grid 1 --hz 60 --seconds 45 --settle-ticks 30 --shots 26 --shot-interval-ticks 90 --targets 27 \
  --output /tmp/p4/it256-s060.towertrace --metrics-out /tmp/p4/it256-s060.csv
# render (destruction-codec `vantage` viewer kind, added 2026-09-04; tower-demo render; crop)
destruction-codec debris-tracks --trace T --out-dir D --splits PS2 --subscribes SS2 --render-viewer vantage --render-solo
tower-demo render --state D/truth-*.towerstate --output raw.mp4 && ffmpeg -i raw.mp4 -filter:v crop=1920:1080:0:0 out.mp4
scripts/annotate-video.py out.mp4 /tmp/p4/it256-s060.csv out-annotated.mp4 --label "it256 s0.60"
```
