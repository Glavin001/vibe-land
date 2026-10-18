# Multi-building scenes under the stress solver: the sim moved the number, not the codec

2026-08-17. Traces in `codec-results/blast-multi/`, recorded by
`record-city-trace` from PhysX GPU + the Blast CPU stress solver.

The D6-era question was "what does a city of collapsing buildings cost?" The
answer then was a **6.60 Mbps far-field floor** on 9 buildings / 55,063 bodies,
declared physical: set by how many bodies are colliding at once, insensitive to
precision, cadence and stride. This re-runs that question on the model we ship.

## The scenes

| scene | structures | chunks | bonds | broken | peak bodies | notes |
|---|---:|---:|---:|---:|---:|---|
| `city9-light` | 9 | 6,138 | 21,135 | 626 | 132 | 2 attacked, 8 shots |
| `city9-localized` | 9 | 6,138 | 21,135 | 4,016 | 897 | 3 attacked, 60 shots |
| `city25-wide` | 25 | 17,400 | 59,984 | 15,189 | 3,228 | all attacked, 150 shots |
| `c9-barrage` | 9 | 6,138 | 21,135 | 14,793 | 3,586 | 3 attacked, 600 shots over 60 s |

Recorder invariants held on all three: broken bonds equal the adapter's own
count, and the membership ledger matched `node_count` on every tick (0
mismatches) across 168 / 1,746 / 5,258 chunk migrations.

## Bandwidth, 0.5 cm masked contract

| scene | per-chunk | island stream | ratio | gates |
|---|---:|---:|---:|---|
| 9 bldg, light damage | 0.040 Mbps | **0.035 Mbps** | 1.12x | PASS |
| 9 bldg, localized | 0.435 Mbps | **0.362 Mbps** | 1.19x | PASS |
| 25 bldg, all attacked | 1.347 Mbps | **1.128 Mbps** | 1.19x | PASS |
| 1 bldg, fully demolished | 0.321 Mbps | **0.263 Mbps** | 1.22x | PASS |
| 9 bldg, 60 s barrage (70% of bonds broken) | 1.454 Mbps | **1.411 Mbps** | 1.03x | PASS |

The barrage row is the ratio's floor and shows the mechanism clearly: with 70%
of every bond broken, essentially nothing is left in a multi-chunk island, so
there is nothing to derive and island mode converges on the per-chunk path.

Island streaming also lands **tighter** every time (err p95 0.220 vs 0.323 cm on
the 25-building scene), because a root others are rebuilt from forgoes masking
slack.

## Finding 1: the island ratio does not grow with scene complexity

This was the hypothesis worth testing, and it did not hold: 1.12x - 1.22x across
a 17x range of chunk count and a 24x range of broken bonds. Complexity does not
help, because **the per-chunk path already pays nothing for stillness.** An
intact chunk is kinematic and a settled chunk is asleep; both cost one record
and then silence in either mode. The two paths only differ on chunks that are
*moving*, and a moving chunk is by definition one whose island has already been
broken up.

So the island win is bounded by the mean size of the islands that are actually
in motion, and in demolition content that number is small: the 25-building scene
peaks at 3,253 islands over 17,400 chunks, and most awake islands are a handful
of chunks. The 1.2x is real, free, and comes with better accuracy -- but it is
not where the order of magnitude is.

## Finding 2: the order of magnitude came from the simulation

The comparison that matters is against the D6 era, and it is not close:

| | bodies | avg rate |
|---|---:|---:|
| D6, 9 buildings collapsing (2026-08-17 doc) | 55,063 | 13.24 Mbps baseline / 6.60 floor |
| Blast, 25 buildings all attacked, per-chunk | 17,400 | **1.347 Mbps** |
| Blast, 25 buildings all attacked, island | 17,400 | **1.128 Mbps** |

About 3x of that is simply having 3x fewer bodies. The other ~3x is per body:
0.24 kbps/body on D6 content against 0.077 kbps/chunk here. That per-body factor
is the part the joints were costing us, and the earlier tracks doc had already
named the mechanism as a content-fidelity caveat rather than a codec property:

> the tower generator's all-dynamic-joints buildings sway and never sleep
> (59/55,063 rests in 5 s), inflating every delivery number

Under the stress solver a structure is **static until broken** -- one kinematic
body, zero pose traffic, no sway to encode -- and debris genuinely settles: at
tick 1200 of the 25-building scene, 1,404 of 3,246 bodies are awake, so **57% are
asleep and free.** The D6 scene got 59 rests out of 55,063.

The 6.60 Mbps floor was therefore never purely physical. It was physical *for
content that never stops moving*. Changing the simulation moved it by ~10x, and
the codec then took another 1.2x on top.

## Finding 3: localized destruction is cheap in absolute terms

Nine buildings with two of them shot up costs **0.035 Mbps** -- about 1.4% of
vibe-land's 2.5 Mbps per-client ceiling, for a scene a player would read as
"a building is coming down over there". Even the fully-demolished 25-building
city fits at 1.13 Mbps, inside that ceiling with room for the rest of the game.

## Videos

`viewer-videos/blast-multi-2026-08-17/` (Caddy root is `/root/workspace`):

- `compare-9buildings.mp4` -- truth vs island stream, 3 of 9 destroyed. The six
  untouched buildings are perfectly still in both panes, which is the model's
  whole claim rendered rather than asserted.
- `compare-25buildings.mp4` -- truth vs island stream, 17,400 chunks at
  1.13 Mbps. Indistinguishable.

`viewer-videos/blast-barrage-2026-08-17/` -- 60 s sustained barrage, the clearest
look at the model working:

- `compare-barrage-wide.mp4` -- three towers reduced to a rubble field, truth
  against island stream.
- `compare-barrage-topdown.mp4` -- overhead, where the three attacked structures
  and the six untouched ones are visible at once.

Two framing lessons, both fixed in the recorder: shots used to be fired from the
side OPPOSITE the camera, so every recording showed the intact back of the city;
and the default camera framed a 9-building grid so wide the destruction was a
few pixels. Shots now come from the camera's side and target the nearest row.

## What this says to do next

1. **Stop looking for the island win in demolition content.** It is a steady
   1.2x and that is the shape of it. The remaining structural lever is the
   coarse/far tier, where the bound is loose enough that big islands derive and
   the measured gain was 1.39x - 1.84x.
2. **Re-measure the far-field floor properly** with `debris-tracks` on
   `city25-wide`, against the 6.60 Mbps number. This doc compares single-stream
   totals, not per-viewer subscriptions, so it does not yet answer the floor
   question in the same units.
3. Content note for whoever tunes scenes: these use `high-rise-10f-local.json`
   with varied heights, so chunk counts per structure differ. Nothing here is
   normalised per structure.
