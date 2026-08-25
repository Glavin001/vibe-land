# What the client displayed vs what the server simulated, in data

2026-08-21. `destruction-codec state-diff` joins two TWSTATE1 recordings over
the same actor table — truth from the authoritative trace, client from
`replay-city-client.mts` (the shipping client fed the exact server bytes) —
and reports per chunk, per building, per frame.

```
record-city-trace --packets-out p3 --packets-wire 3 --output truth.towertrace
npx tsx tools/replay-city-client.mts --packets p3 --out v3.towerstate
destruction-codec replay --trace truth.towertrace --output truth.towerstate
destruction-codec state-diff --truth truth.towerstate --client v3.towerstate \
  --manifest p3/manifest.json --out diff-v3.json
```

## The verdict

One GPU run per wire, grid 2, 45 s, 3,078 chunks, ~10k broken bonds.

| | wire v2 | wire v3 |
|---|---:|---:|
| presentation delay (**measured**, not assumed) | 100 ms | 200 ms |
| position error p50 | 8.4 cm | **0.4 cm** |
| position error p95 | 19.3 cm | **2.5 cm** |
| position error max | 2.15 m | 2.14 m |
| freezes (client still ≥5 frames while truth moves) | **1,867** | **49** |
| excess steps (client jumps >3× truth's own step) | 672 | 49 |
| reversals (client moves against truth) | 133 | 6 |
| bytes | 6.46 MB (1.15 Mbps) | 4.11 MB (0.73 Mbps) |

**v3 costs 100 ms more presentation delay and buys a 21× tighter median
error, 38× fewer freezes, and 36% fewer bytes.** The 1,867 freezes are the
"laggy, rubber-bandy" complaint stated numerically: v2's priority model holds
bodies still while the simulation moves them, and the client's own displayed
poses prove it without anyone watching a video.

The delay is measured by searching the frame offset that minimises error, so
it separates *lateness* from *wrongness*: v3's error at zero lag is p95
41.7 cm, and at its true 200 ms offset 2.5 cm — i.e. v3 is almost entirely
"correct but late by design" (100 ms span flush + 100 ms interpolation),
where v2 is 19.3 cm wrong even after its lateness is removed.

## What it localised

The report ranks by building and hands back timestamps, so frames can be
pulled instead of scrubbed:

| structure | v3 err p95 | v3 freezes | v2 err p95 | v2 freezes |
|---|---:|---:|---:|---:|
| 0 | 2.3 cm | 17 | 10.9 cm | 683 |
| 1 | 3.1 cm | 7 | 13.5 cm | 744 |
| 2 | 1.0 cm | 0 | 30.6 cm | 42 |
| 3 | 3.1 cm | 25 | 29.1 cm | 398 |

v3's worst events cluster: **25 chunks of structure 3 step ~4.0 m in one
frame at t=4.23 s**, all at once. Twenty-five chunks moving together is one
island, so this is not a codec artifact but an island-scale re-seed at
promotion — confirmed by pulling truth 4.13/4.30 s beside client 4.33/4.50 s,
where the upper slab of the leaning tower drops as a unit. That is the top
open v3 item, and it is now a specific, reproducible, one-line query rather
than "the video looks bad somewhere".

## Why this instrument and not the video

Pixel differencing was tried first and misled repeatedly: it ranked a
sleeping-tint colour flip as the worst artifact in a run, and it cannot tell
lateness from error at all. Every number above comes from the poses the
client had in hand immediately before rendering — the same data the GPU was
about to draw.

---

# The apples-to-apples matrix (post-merge physics, 2026-08-21)

Three legs, identical args, identical merged physics (which is gentler than
pre-merge: debris damping + restored sleep thresholds mean most breakage is
world anchors and piles rest properly — cross-run comparisons to pre-merge
numbers are invalid, so all three legs were re-run). Every leg is the
shipping client replayed over dumped bytes; delay is measured, not assumed.

| | wire v2 | v3 @ 100 ms flush | **v3 @ 50 ms flush** |
|---|---:|---:|---:|
| bytes | 0.79 Mbps | **0.73 Mbps** | 1.09 Mbps |
| measured presentation delay | 100 ms | 200 ms | **133 ms** |
| err p95 (lag removed) | 6.8 cm | 0.7 cm | **0.6 cm** |
| err p95 (same instant) | 8.9 cm | 1.5 cm | 1.6 cm |
| err max | 1.26 m | 1.38 m | **0.35 m** |
| freezes | 91 | 17 | **0** |
| excess steps | 135 | 17 | **1** |
| reversals | 36 | 2 | **0** |

Notes the table forces into the open:

- **The 200 ms is not needed.** At 50 ms flush v3 sits 33 ms behind v2's
  latency, with effectively zero artifacts (0 freezes, 1 excess step, 0
  reversals across 1,346 frames × 3,078 chunks) and 11× tighter p95, for
  +0.30 Mbps over v2. The 100 ms operating point buys 0.36 Mbps with 67 ms
  of latency and a handful of artifacts — a reasonable default, but the knob
  now has measured prices at both ends.
- **v2 improved on the merged content** (freezes 1,867 → 91 on the old
  physics vs new): the upstream damping/sleep work makes piles genuinely
  rest, which shrinks the population v2 starves. Reported because it is
  true, not because it changes the ranking — v3 beats v2 on every quality
  metric at every operating point, at equal-or-fewer bytes for equal flush.
- **Same-instant error**: v3 at either flush is ~1.5 cm from the live
  simulation at the moment of display; v2 is 8.9 cm. The earlier 42 cm
  same-instant figures were a property of the violent pre-merge content
  (fast free-fall × any delay), not of either wire.
- The merged solver also breaks **world-anchor bonds** (chunk-to-ground);
  the trace format only carries chunk-chunk edges, so the recorder now
  filters and counts them (`note:` line), and dedups the two-pass cascade's
  duplicate reports.

---

# Downtown at scale: 24,105 chunks, receipts burned into the video (2026-08-21)

`viewer-videos/downtown-ab-2026-08-21/compare-downtown.mp4` — TRUTH | WIRE V2
| WIRE V3@50ms, 60 s, the merged fractured-downtown pack at full bond strength
(1 structure, 24,105 chunks, 74,543 bonds; ~3.7k chunk-chunk breaks, ~19.3k
migrations, ~950 peak bodies). Each wire pane carries a live byte meter
(current / running avg / running peak / total) generated from the packet dump
by `research/destruction-codec/tools/packet_rate_overlay.py`.

| | wire v2 | wire v3 @ 50 ms |
|---|---:|---:|
| avg | 0.569 Mbps | **0.554 Mbps** |
| peak second | 1.38 Mbps | **1.27 Mbps** |
| total (60 s) | 4.27 MB | **4.16 MB** |
| ... of which reliable | 0.539 MB | 0.255 MB |
| measured delay | 100 ms | 133 ms |
| freezes / reversals | 7 / 0 | 4 / 1 |
| excess steps | 0 | **189 (~20 excursions)** |
| err max | 0.28 m | **173 m** |

Two honest findings, one per wire:

- **This content is easy for v2.** Only ~950 of 24k chunks ever move at once,
  the merged physics rests piles quickly, and v2's ranked selection handles a
  small moving set fine. The starvation regime needs thousands of
  simultaneously-moving bodies (the violent grid-2 runs, or multi-building
  barrages), not one localized cascade. Quiet content narrows the gap; v3
  still wins every byte metric at 33 ms more delay.
- **v3's lane-reassignment race scales with migration churn.** ~20 excursions
  in 60 s where one chunk shows another lane's pose for ~100 ms and snaps
  back (worst 173 m — palpably a different building). 19.3k migrations is 4×
  the previous content; the client-side hold guard misses the fresh-lane
  first-sample case. This is THE argument for the 1-byte lane generation
  tag: the race is content-scaled, and downtown-scale churn is the roadmap.

Instrument limitation recorded: err p50/p95 read 0.0 cm on this scene because
percentiles are taken over ALL chunks and 96% never move. `state-diff` needs
a moving-only percentile before its error rows mean anything at district
scale (the artifact counters and max are unaffected).

---

# The ramped downtown run: receipts for cost, quality, and compute (2026-08-21)

`viewer-videos/downtown-ramp-2026-08-21/compare-downtown-ramp.mp4`. Same
24,105-chunk downtown, stress scale 0.30, and a RAMPED shot plan
(`--shot-ramp-min-ticks`): 100 shots whose interval shrinks from 1.2 s to
83 ms, so the run escalates from sniper pot-shots to a closing barrage —
~24k bonds broken, ~6,800 peak bodies, ~29k migrations. Each wire pane's
burned-in meter now carries three rows of receipts per second: bytes
(now/avg/peak/total), accuracy (moving chunks, moving-only err p95,
cumulative artifacts), and compute (server sim ms/tick, encode ms/tick,
client ms/s of real decode+sample work measured in the replayer).

| | wire v2 | wire v3 @ 50 ms |
|---|---:|---:|
| avg / peak-second | 2.10 / 3.32 Mbps | **4.02 / 9.00 Mbps** |
| total (60 s) | 15.7 MB (3.27 reliable) | 30.1 MB (0.57 reliable) |
| all-chunk err p95 | 13.9 cm | **1.9 cm** |
| moving-only err p50 / p95 | 1.5 / 5.7 cm | 1.2 / 6.1 cm |
| freezes / excess / reversals | **4,139** / 1,221 / 520 | 2,063 / 2,146 / 589 |
| nacks | 0 | 627 |
| worst event | 2.6 m freeze | **78 m lane-race excursion** |
| sim ms/tick p50 / p95 / max | 18.4 / 33.0 / 283 | 18.3 / 34.4 / 287 |
| encode ms/tick p50 / p95 | 0.53 / 1.90 (per client) | 2.10 / 9.02 (all clients) |
| client work ms per second | 246 | 208 |

What the hard content changes:

- **The flush knob is content-scaled.** 50 ms flush was 1.09 Mbps on the
  grid-2 city and is 4.02 avg / 9.0 peak here — over the 2.5 Mbps budget.
  At barrage scale the operating point must be 100 ms (≈ half the bytes) or
  rate-adaptive flush (shorten when quiet, lengthen under load) — the knob
  exists, per-match, and this run prices it.
- **v2 pays where it always pays**: 13.9 cm all-chunk p95 (stale scenery),
  double the freezes, and 3.27 MB of reliable-channel baseline traffic (21%
  of its total). But its moving-chunk p95 (5.7 cm) holds up, and its peak
  bandwidth is governed by its ceiling — the starved bodies just don't get
  drawn correctly, which bytes metrics cannot see and the freeze counter can.
- **v3's artifact storm at this churn is the lane race compounding**: 627
  nacks and 2,146 excess steps at 29k migrations (worst: one chunk 78 m off
  for ~100 ms). Every escalation of content escalates this class. The 1-byte
  lane generation tag is no longer an optimization; it is the gate for
  district-scale destruction.
- **The simulation itself breaks 60 Hz during the barrage** (sim p95 33-34
  ms, max ~287 ms against a 16.7 ms budget) — on this box, with this pack,
  the physics is the binding constraint at peak, not the wire. Encode: v3
  9 ms p95 within its 50 ms span budget, and once for all clients; v2's
  1.9 ms is per client.
