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
