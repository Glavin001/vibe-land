# Rate-quality: shared-v2 vs per-player, 2026-10-10

## Setup

- **Truth:** three fresh captures on this tree, from `scripts/netlab/record-truth.py`
  with `scenarios/netcode/*.json`:
  - wedge: 2,881 ticks, up to 313 bodies;
  - meteor-volley: 2,897 ticks, up to 1,717 bodies;
  - sustained: 4,075 ticks, up to 505 bodies.
- **Clients:** 4 per run (generated cameras), lab LTE link, seed 1.
- **Budget:** a 1024 kbit/s bucket (3x burst for 3 s), under the per-link
  controller.
- **Sweep:** each strategy's own quality knob from 0.5 to 8 px:
  - `city.error_budget_px` for shared-v2;
  - `pp.tolerance_px` for per-player.
- **Commands:** `scripts/netlab/rate-quality.py run --budgets 1024
  --qualities 0.5,1,2,4,8`.
- **Scoring:** the perceptual model is uncalibrated. Q saturates at 0 in
  heavy scenes, so the penalty per client-minute is the number to compare.

## Reading

- **Shared-v2 is one operating point.** Its error budget moves its rate by
  only 1-8%: its bytes are policy-bound, not error-bound. September's tuning
  found the same, where the latency tail was a policy gate, not bandwidth.
- **Per-player traces a curve,** from 64 to 638 kbit/s.
- **At equal bytes, per-player's penalty is:**
  - 35-45% lower on wedge (~155 kbit/s);
  - 5x lower on meteor-volley (~500 kbit/s; debris p99 2.3 m vs 16 m);
  - 20-30% *higher* on sustained (~290 kbit/s).
- **Measured cause of the sustained loss:** per-player keyframes are absolute
  (about 29 B) against v2's 11 B baseline deltas, and sustained has the
  longest settle tail. Acked-baseline deltas (the spec's Phase B) are the next
  lever.

## Results

| capture | strategy | budget kbit/s (-q px) | sent kbit/s | busiest 1 s | Q mean | penalty/min | debris p99 m | pops/min | screen err/min | gates |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| meteor-volley | per-player | 1024-q0.5 | 632.3 | 2528 | 0.0 | 1983.7 | 2.263 | 248.7 | 101.2 | pass |
| meteor-volley | per-player | 1024-q1 | 568.2 | 2555 | 0.0 | 1652.4 | 2.274 | 192.0 | 82.3 | pass |
| meteor-volley | per-player | 1024-q2 | 512.8 | 2538 | 0.0 | 1580.3 | 1.940 | 161.5 | 84.5 | pass |
| meteor-volley | per-player | 1024-q4 | 422.8 | 2546 | 0.0 | 2297.6 | 1.287 | 226.0 | 167.7 | pass |
| meteor-volley | per-player | 1024-q8 | 305.0 | 2450 | 0.0 | 5039.6 | 0.765 | 529.1 | 908.4 | pass |
| meteor-volley | shared-v2 | 1024-q0.5 | 505.0 | 2996 | 0.0 | 8628.7 | 16.258 | 1467.8 | 783.8 | pass |
| meteor-volley | shared-v2 | 1024-q1 | 499.6 | 2996 | 0.0 | 8279.3 | 16.326 | 1402.2 | 767.8 | pass |
| meteor-volley | shared-v2 | 1024-q2 | 496.1 | 2996 | 0.0 | 8455.6 | 15.915 | 1440.3 | 771.3 | pass |
| meteor-volley | shared-v2 | 1024-q4 | 493.7 | 2996 | 0.0 | 8946.9 | 16.389 | 1518.3 | 826.7 | pass |
| meteor-volley | shared-v2 | 1024-q8 | 492.2 | 2996 | 0.0 | 8641.0 | 16.136 | 1441.1 | 829.7 | pass |
| sustained | per-player | 1024-q0.5 | 637.7 | 2638 | 0.0 | 209.5 | 0.044 | 37.3 | 13.0 | pass |
| sustained | per-player | 1024-q1 | 467.4 | 2560 | 0.0 | 295.0 | 0.080 | 49.9 | 19.4 | pass |
| sustained | per-player | 1024-q2 | 299.4 | 2493 | 0.0 | 521.3 | 0.146 | 73.3 | 27.0 | pass |
| sustained | per-player | 1024-q4 | 165.4 | 1806 | 0.0 | 701.4 | 0.284 | 78.9 | 38.0 | pass |
| sustained | per-player | 1024-q8 | 88.8 | 1104 | 0.0 | 1700.5 | 0.595 | 194.8 | 233.5 | pass |
| sustained | shared-v2 | 1024-q0.5 | 304.9 | 2110 | 0.0 | 381.2 | 0.199 | 50.6 | 43.1 | pass |
| sustained | shared-v2 | 1024-q1 | 290.2 | 1961 | 0.0 | 406.1 | 0.206 | 51.3 | 43.7 | pass |
| sustained | shared-v2 | 1024-q2 | 283.3 | 1925 | 0.0 | 420.6 | 0.210 | 52.2 | 47.3 | pass |
| sustained | shared-v2 | 1024-q4 | 280.4 | 1907 | 0.0 | 438.8 | 0.222 | 49.1 | 51.9 | pass |
| sustained | shared-v2 | 1024-q8 | 279.2 | 1902 | 0.0 | 502.4 | 0.233 | 58.8 | 62.1 | pass |
| wedge | per-player | 1024-q0.5 | 348.0 | 2634 | 25.1 | 71.6 | 0.046 | 8.7 | 14.7 | pass |
| wedge | per-player | 1024-q1 | 259.4 | 2572 | 25.1 | 91.0 | 0.115 | 10.6 | 15.9 | pass |
| wedge | per-player | 1024-q2 | 173.5 | 2557 | 23.8 | 97.4 | 0.132 | 13.1 | 12.2 | pass |
| wedge | per-player | 1024-q4 | 111.4 | 2508 | 19.9 | 141.6 | 0.259 | 13.4 | 18.4 | pass |
| wedge | per-player | 1024-q8 | 63.9 | 1536 | 22.6 | 447.0 | 0.495 | 55.0 | 104.9 | pass |
| wedge | shared-v2 | 1024-q0.5 | 161.9 | 2113 | 23.7 | 156.9 | 0.142 | 11.6 | 53.3 | pass |
| wedge | shared-v2 | 1024-q1 | 155.9 | 2062 | 19.4 | 155.3 | 0.147 | 11.6 | 53.1 | pass |
| wedge | shared-v2 | 1024-q2 | 152.9 | 2029 | 16.9 | 176.6 | 0.161 | 13.1 | 56.2 | pass |
| wedge | shared-v2 | 1024-q4 | 151.3 | 2005 | 14.4 | 188.7 | 0.185 | 11.9 | 58.1 | pass |
| wedge | shared-v2 | 1024-q8 | 150.3 | 1988 | 16.2 | 196.9 | 0.194 | 11.6 | 65.9 | pass |

Penalty at equal bytes (log-rate interpolation over each strategy's points; lower is better):

| capture | at kbit/s | shared-v2 penalty | per-player penalty |
|---|---:|---:|---:|
| meteor-volley | 492 | 8641.0 | 1710.8 |
| meteor-volley | 494 | 8641.0 | 1700.7 |
| meteor-volley | 496 | 8455.6 | 1684.7 |
| meteor-volley | 500 | 8279.3 | 1662.1 |
| meteor-volley | 505 | 8279.3 | 1628.0 |
| sustained | 279 | 502.4 | 539.9 |
| sustained | 280 | 438.8 | 538.7 |
| sustained | 283 | 420.6 | 535.9 |
| sustained | 290 | 406.1 | 529.5 |
| sustained | 299 | 390.3 | 521.3 |
| sustained | 305 | 381.2 | 509.2 |
| wedge | 150 | 196.9 | 109.9 |
| wedge | 151 | 188.7 | 109.3 |
| wedge | 153 | 176.6 | 108.3 |
| wedge | 156 | 155.3 | 106.6 |
| wedge | 162 | 155.3 | 103.3 |
