# Collapse costs (milestone 2)

What streaming a collapse costs each player under the per-player netcode
(wire 4). Each run is 4 clients on the lab's LTE link with a 1024 kbit/s
bucket (3x for 3 s), seed 1, server stage only.

Command: `scripts/netlab/collapse-cost.py <run> ...`. It reads a `netlab2
city --strategy per-player` run (its JSON strategy report) and the
capture's awake-body counts.

The owner's `keyframe_budget.py` was to drive this milestone. It has not
arrived, so this report computes the same quantities from per-player's
own accounting:
- keyframes per moving piece per second;
- bytes by distance;
- the mode mix;
- the sustained rate and the burst.

## Summary

| capture | peak / mean awake bodies | keyframes per moving body per second | mean kbit/s | busiest steady second, kbit/s | bytes per keyframe | delta records |
|---|---|---:|---:|---:|---:|---:|
| wedge | 313 / 84 | 9.77 | 141 | 2419 | 20.6 | 76% |
| sustained | 505 / 192 | 8.93 | 286 | 2325 | 20.6 | 77% |
| meteor-volley | 1717 / 636 | 4.33 | 467 | 2410 | 20.5 | 65% |
| city-100k (1,600 buildings) | 2631 / 1543 | 2.34 | 999 | 2648 | 22.1 | 60% |

- **Keyframes per moving body fall as the scene grows** (9.8 -> 2.3 per
  second). With the same budget, priority by penalty per byte spends it on
  the bodies whose error a player would notice, so a bigger collapse means
  fewer keyframes per body, not more bytes.
- **A keyframe costs 20-22 bytes** on every capture: acked-baseline deltas
  (60-77%) plus mode-aware prediction.
- **Where the bytes go depends on the view.** On the small captures most go
  to bodies 10-100 m away. On city-100k, 86% go to bodies past 100 m: the
  generated players look across a city of falling buildings.
- **Mode mix is broad:**
  - ballistic 26-33% of keyframes;
  - sliding 20-32%;
  - resting 18-23%, but only 11-15% of bytes, being the cheapest;
  - friction 22-26%.

## Budget (decision D9)

- **Mean rate per player:** 141-467 kbit/s on single-collapse scenes, 999
  kbit/s on the 1,600-building city.
- **Busiest second after the join:** 2.3-2.6 Mbit/s, inside the bucket's
  3 Mbit/s burst.
- **A recommended bucket:** 512 kbit/s sustained with a 1.5-3 Mbit/s
  burst for 3 s covers the single-collapse scenes, and city-scale
  bombardment needs about 1 Mbit/s sustained. In the rate-quality sweep
  per player degrades smoothly below that, and it beats shared v2 at every
  rate measured.
- **Production stays at its 2.5 Mbit/s ceiling** until the owner decides
  (D9).

## Per capture

### wedge: target/nds/cost/wedge

4 clients, lte, 48 s; peak awake bodies 313, mean 84; moving body-seconds 4038.

| per client | value |
|---|---:|
| keyframes per moving body per second | 9.77 |
| mean kbit/s | 141.1 |
| busiest 1 s, steady (kbit/s) | 2419 |
| bytes per keyframe | 20.6 |
| delta records | 76% |

| distance | keyframes | share of bytes | kbit/s per client |
|---|---:|---:|---:|
| <10 m | 2516 | 6% | 7.5 |
| 10-25 m | 12323 | 30% | 40.2 |
| 25-50 m | 14933 | 38% | 51.9 |
| 50-100 m | 3929 | 11% | 14.3 |
| >100 m | 5758 | 16% | 21.7 |

| mode | keyframes | bytes |
|---|---:|---:|
| ballistic | 26% | 28% |
| sliding | 26% | 28% |
| resting | 23% | 14% |
| friction | 25% | 30% |

### sustained: target/nds/cost/sustained

4 clients, lte, 68 s; peak awake bodies 505, mean 192; moving body-seconds 13023.

| per client | value |
|---|---:|
| keyframes per moving body per second | 8.93 |
| mean kbit/s | 285.9 |
| busiest 1 s, steady (kbit/s) | 2325 |
| bytes per keyframe | 20.6 |
| delta records | 77% |

| distance | keyframes | share of bytes | kbit/s per client |
|---|---:|---:|---:|
| <10 m | 981 | 1% | 2.1 |
| 10-25 m | 12556 | 10% | 28.2 |
| 25-50 m | 29744 | 25% | 71.7 |
| 50-100 m | 53248 | 46% | 130.6 |
| >100 m | 19816 | 18% | 50.3 |

| mode | keyframes | bytes |
|---|---:|---:|
| ballistic | 26% | 28% |
| sliding | 27% | 28% |
| resting | 22% | 14% |
| friction | 26% | 30% |

### meteor-volley: target/nds/cost/meteor-volley

4 clients, lte, 48 s; peak awake bodies 1717, mean 636; moving body-seconds 30697.

| per client | value |
|---|---:|
| keyframes per moving body per second | 4.33 |
| mean kbit/s | 467.4 |
| busiest 1 s, steady (kbit/s) | 2410 |
| bytes per keyframe | 20.5 |
| delta records | 65% |

| distance | keyframes | share of bytes | kbit/s per client |
|---|---:|---:|---:|
| <10 m | 6707 | 5% | 20.5 |
| 10-25 m | 14184 | 10% | 45.0 |
| 25-50 m | 27260 | 20% | 89.2 |
| 50-100 m | 58534 | 45% | 202.2 |
| >100 m | 26333 | 21% | 95.0 |

| mode | keyframes | bytes |
|---|---:|---:|
| ballistic | 33% | 36% |
| sliding | 20% | 22% |
| resting | 23% | 15% |
| friction | 23% | 27% |

### city-100k-v2: target/nds/cost/city-100k

4 clients, lte, 32 s; peak awake bodies 2631, mean 1543; moving body-seconds 49392.

| per client | value |
|---|---:|
| keyframes per moving body per second | 2.34 |
| mean kbit/s | 999.1 |
| busiest 1 s, steady (kbit/s) | 2648 |
| bytes per keyframe | 22.1 |
| delta records | 60% |

| distance | keyframes | share of bytes | kbit/s per client |
|---|---:|---:|---:|
| <10 m | 0 | 0% | 0.0 |
| 10-25 m | 1363 | 1% | 7.4 |
| 25-50 m | 3879 | 3% | 20.8 |
| 50-100 m | 11393 | 10% | 62.1 |
| >100 m | 98762 | 86% | 547.1 |

| mode | keyframes | bytes |
|---|---:|---:|
| ballistic | 29% | 31% |
| sliding | 32% | 34% |
| resting | 18% | 11% |
| friction | 22% | 24% |
