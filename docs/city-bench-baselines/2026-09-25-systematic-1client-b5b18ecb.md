# City bench: 20260925-001310-pkgb5b-systematic

Run `20260925-001310-pkgb5b-systematic` — scenario **systematic** (16 buildings, 1 client(s), intensity 1, seed 1); status **ok**; tape 337 s.
Build: vibe-land `1425a742` (server fingerprint `1425a742`), PhysX SDK `b5b18ecb2700abbf12e50749529ba3fe07db9344`, cuda-metal `80512aa` (libcumetal 2026-09-25T00:05:36), Apple M3 Max.

## Verdict: FAIL (5 of 27 budgets)

| status | id | observed | limit | where |
|---|---|---|---|---|
| pass | server.tick_p95 | 14.09 | < 16.7 |  |
| fail | server.tick_p99 | 36.72 | < 33.3 |  |
| pass | server.over_budget_pct | 2.98 | <= 5 |  |
| fail | server.sim_rate | 0.97 | >= 0.98 |  |
| fail | server.sim_rate_5s_min | 0.76 | >= 0.9 |  |
| pass | client.frame_p95 | 1.19 | < 2.0 | c0 |
| pass | client.over_2x_pct | 0.23 | <= 5 | c0 |
| fail | client.hitches_100ms | 4 | <= 0 | c0 |
| fail | client.cpu_hitch_33ms | 18 | <= 0 | c0 |
| pass | net.backward_steps | 0 | <= 0 | c0 |
| pass | net.lead_p95 | -4.80 | < 50 | c0 |
| pass | net.extrapolating_pct | 0.00 | < 10 | c0 |
| pass | net.snapshot_per_tick | 1.00 | >= 0.98 | c0 |
| pass | net.snapshot_gap_p99 | 39.90 | < 50 | c0 |
| pass | net.lost | 0 | <= 0 | c0 |
| pass | net.server_drops | 0 | <= 0 | c0 |
| pass | net.latency_p99 | 4.54 | < 20 | c0 |
| pass | net.repairs_without_loss | 0 | <= 0 | c0 |
| pass | net.meteor_arc_jump | 0.20 | < 0.5 | c0 |
| pass | net.meteor_hold_jump | 0 | < 2.0 | c0 |
| pass | net.meteor_backward | 0 | <= 0 | c0 |
| pass | net.meteor_below_ground | 0 | <= 0 | c0 |
| pass | net.body_render_error_p99 | 0.03 | < 0.5 | c0 |
| pass | net.self_error_p99 | 0.21 | < 0.5 | c0 |
| pass | net.match_stats_share | 0.69 | < 2 | c0 |
| pass | net.energy_rate | 1.40 | <= 10 | c0 |
| pass | physics.below_ground | 0 | <= 0 |  |

## Server real-time

- Tick p50/p95/p99/max: 6.93 / 14.09 / 36.72 / 269.86 ms; 2.98% over 16.7 ms, 1.09% over 33 ms, 12 over 100 ms (19653 ticks).
- Sim rate: 0.972 (worst 5 s window 0.760).
- Tick breakdown (mean ms, share): dynamics 7.80 (95.5%), city 0.31 (3.7%), snapshot 0.01 (0.2%), player_sim 0.03 (0.4%), unattributed 0.01 (0.1%)
- Per-tick physics phases (19653 ticks; engine profiler on 0 of them; GPU wait sampled on 1228): collecting them cost p50/p90/max 1.7/2.2/72.5 us per tick. Meteors launched: 27 (launch p50/max 0.064/0.097 ms); shots bracket p50/max 0.001/0.127 ms on ticks with shots.

Physics step by tick class (split: created bodies; break: broke bonds only), p50 / p90 (max for counts):

| class | ticks | total | dynamics | named_% | submit | overlap | fetch | gpu_wait | readback | corrections | promoted | bonds | contacts | iters | awake | pairs_found/lost |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| split | 287 | 23.60 / 67.28 | 22.95 / 66.82 | 100.0 | 0.01 | 0.00 | 22.93 / 66.79 | 21.82 | 0.01 | 1 / 1 | 3 / 205 | 6 / 720 | 7414 | 16 | 451 | 25/0 |
| break | 101 | 11.79 / 32.16 | 11.25 / 31.77 | 100.0 | 0.01 | 0.00 | 11.20 / 31.72 | 10.19 | 0.01 | 0 / 1 | 0 / 0 | 1 / 18 | 3743 | 16 | 469 | 10/4 |
| other | 19265 | 6.89 / 11.47 | 6.49 / 11.05 | 99.9 | 0.01 | 0.00 | 6.46 / 11.01 | 6.42 | 0.01 | 0 / 0 | 0 / 0 | 0 / 0 | 5112 | 16 | 571 | 1/1 |

- PhysX last step / GPU wait (1 Hz samples) p50/p95/max: 6.68/14.01/79.44 ms, 6.84/13.67/79.38 ms.
- City encoder: step p95 0.398 ms, encode p95 0.154 ms, 10555.0 B per awake body-tick, outbound drops 0.
- Destruction reached: 9250 of 10373 bonds broken (89.2%), 2470 chunk bodies, peak 1239 active bodies; r(tick, active bodies) = 0.12; bodies below -3 m: 0; 'left the world' log lines: 1; went through the ground (first tick logged): 0; retired at the floor: 0.

Tick cost against destruction level:

| by | bucket | ticks | tick_p50 | tick_p95 | tick_max | pct_over_16_7ms |
|---|---|---|---|---|---|---|
| active_bodies | 0-99 | 1960 | 4.65 | 8.19 | 80.46 | 1.30 |
| active_bodies | 100-499 | 6681 | 6.70 | 15.12 | 164.95 | 4.20 |
| active_bodies | 500-999 | 10374 | 7.27 | 14.13 | 269.86 | 2.40 |
| active_bodies | 1000+ | 638 | 7.86 | 15.48 | 215.39 | 4.40 |
| broken_bonds | 0-25% | 2276 | 5.08 | 14.18 | 164.95 | 3.20 |
| broken_bonds | 25-50% | 1926 | 7.36 | 16.87 | 132.30 | 5.20 |
| broken_bonds | 50-75% | 7441 | 6.67 | 11.16 | 269.86 | 2.60 |
| broken_bonds | 75-100% | 8010 | 7.48 | 14.36 | 215.39 | 2.80 |

## Clients at a glance

| client | role | fps | frame_p95 | pct_over_2x | snaps_per_tick | lead_p95 | pct_extrap | back_steps | kbps | lat_p99 | lost | repairs | body_err_p99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | player | 118.40 | 9.90 | 0.23 | 1.00 | -4.80 | 0.00 | 0 | 278.20 | 4.54 | 0 | 0 | 0.03 |

## Client 0 (player)

- Frames: 118.4 fps; frame p50/p95/p99 8.30/9.90/11.20 ms against a 8.33 ms display period (1.19x); 0.23% over 2x; CPU p50/p95 1.30/2.10 ms; hitches >100 ms: 4, CPU-bound >33 ms: 18; r(fps, server ticks/s) = 0.86.
- Client GPU time (EXT_disjoint_timer_query_webgl2; 39911 frames timed): longest pass p50/p95/max 1.19/3.73/376.99 ms, sum of passes p50/p95/max 4.54/12.63/1214.74 ms; frames over 2 periods by cause: {"cpu": 22, "wait": 41, "gpu": 27}; timer bookkeeping {"framesResolved": 39911, "disjoints": 0, "queriesDiscarded": 0, "framesExpired": 0, "queriesRefused": 0, "lagFramesMax": 3, "lagFramesMean": 0.08175690912279823, "framesTimedOnTape": 39911}.
- Snapshots: 58.3 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.70/39.90/272.70 ms; 13 gaps over 100 ms; less the server's own tick gap p99/max 3.22/67.06 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 -14.1/-4.8/-3.5 ms; 0.00% of frames extrapolating; render clock stepped back 0 times (0 ms); dyn delay p50 19.91 ms.
- Meteors: 27 drawn, 0 moved backwards (0 frames, max 0 m); arc→body jump (step less the body's own motion) p50/max 0.02/0.20 m (frame step 1.0/1.5 m; rocks first streamed after impact 0, max 0 m from their arc); hold→body max 0 m; drawn below ground 0 frames.
- Transport: 41894/41894 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.43/4.54/67.18 ms.
- Bandwidth: 278 kbps average, 1944 kbps peak second; match stats 0.69% of bytes; energy 1.4 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| city-chunks | 9628.80 | 17656 | 28.57 | 52.40 | 82.20 | 230.20 |
| snapshot | 1085.30 | 19653 | 3.22 | 58.30 | 9.30 | 6.00 |
| city-topology | 482.00 | 3256 | 1.43 | 9.70 | 4.10 | 9.50 |
| city-baseline | 404.80 | 163 | 1.20 | 0.50 | 3.50 | 12.00 |
| match-stats | 80.40 | 327 | 0.24 | 1.00 | 0.70 | 0.50 |
| city-topo-hash | 32.30 | 163 | 0.10 | 0.50 | 0.30 | 0.20 |
| energy | 2.40 | 486 | 0.01 | 1.40 | 0.00 | 0.00 |
| meteor-launched | 1.80 | 27 | 0.01 | 0.10 | 0.00 | 0.10 |
| city-bootstrap | 1.40 | 1 | 0.00 | 0.00 | 0.00 | 1.40 |
| roster | 1.10 | 164 | 0.00 | 0.50 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| welcome | 0.00 | 1 | 0.00 | 0.00 | 0.00 | 0.00 |

- Sync: 0 structure repairs (0.0 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 0; city sends at the 10 kB ceiling 22/9200; client counters {"bootstraps": 2, "hashChecks": 166, "resyncRequestsSent": 1, "presentedJumpsOver4m": 147, "drawnTeleports": 111, "correctionSnaps": 58, "settlesAfterSilence": 30}.
- Efficiency: 196.8 city bytes per moving body-second, 33.07 B/record, repeat records 0.04% (3.5 kB), snapshot 55 B mean, unchanged snapshot bodies 0.01%; server city selection {"candidates": 4832294, "sent": 291148, "sent_pct": 6.03, "not_newsworthy": 637885, "rest_stride": 3413799, "rest_unchanged": 480147, "ceiling": 0, "eval_cap": 0, "budget_used_pct": 8.74}.
- Rendered vs server truth (3000 samples; matched {"vehicles": 2566, "bodies": 1531}): vehicles_at_render_time_m p50/p99/max 0.001/0.002/0.024, local_now_m p50/p99/max 0.000/0.206/0.518, local_on_foot_now_m p50/p99/max 0.000/0.206/0.518, bodies_at_render_time_m p50/p99/max 0.004/0.034/0.127, bodies_now_m p50/p99/max 0.115/1.524/3.792, stale_body_draw_m p50/p99/max 0.005/0.007/0.007

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | gpu_ms | class | server_tick_max_ms_near |
|---|---|---|---|---|---|---|
| 198.39 | building-16:demolish | 220.80 | 1.40 | 1.76 | wait | 269.90 |
| 162.24 | building-17:demolish | 161.90 | 1.00 | 18.15 | wait | 235.10 |
| 182.49 | building-25:demolish | 142.60 | 1.20 | 2.37 | wait | 195.60 |
| 254.93 | building-20:demolish | 104.30 | 2.40 | 12.69 | wait | 215.40 |
| 93.15 | building-2:demolish | 65.00 | 61.50 | 17.48 | cpu | 61.80 |
| 292.24 | building-12:demolish | 61.10 | 46.20 | 9.40 | cpu | 44.30 |
| 292.52 | building-12:demolish | 57.00 | 42.70 | 9.42 | cpu | 55.70 |
| 200.64 | building-16:demolish | 56.60 | 42.90 | 9.22 | cpu | 52.80 |

## By phase

| window | dur_s | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| intro | 5.00 | 2.16 | 0.00 | 1.00 | 0 | 0 | 9.80 | 0.00 | 60.00 | -6.00 | 0.00 | 0 | 0.10 |
| destroy | 288.20 | 13.11 | 3.40 | 0.97 | 751 | 9237 | 9.90 | 0.20 | 58.10 | -4.80 | 0.00 | 0 | 33.90 |
| settle | 6.00 | 11.93 | 4.70 | 0.94 | 577 | 9250 | 10.50 | 0.30 | 56.70 | -5.10 | 0.00 | 0 | 24.90 |
| drive | 25.00 | 14.10 | 0.00 | 1.00 | 572 | 9250 | 9.80 | 0.00 | 60.00 | -4.10 | 0.00 | 0 | 17.40 |
| idle-end | 10.00 | 14.68 | 0.00 | 1.00 | 579 | 9250 | 9.90 | 0.30 | 60.00 | -4.60 | 0.00 | 0 | 15.80 |

Per building:

| window | dur_s | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| building-6 | 18.00 | 14.53 | 2.80 | 0.98 | 42 | 495 | 9.90 | 0.00 | 58.90 | -5.90 | 0.00 | 0 | 19.50 |
| building-0 | 18.00 | 18.91 | 6.00 | 0.94 | 455 | 2778 | 10.00 | 0.30 | 56.40 | -5.00 | 0.00 | 0 | 55.80 |
| building-7 | 18.00 | 18.96 | 6.20 | 0.97 | 448 | 4673 | 10.10 | 0.00 | 58.00 | -6.00 | 0.00 | 0 | 54.30 |
| building-1 | 18.00 | 12.68 | 2.00 | 0.99 | 225 | 5259 | 9.80 | 0.00 | 59.40 | -5.80 | 0.00 | 0 | 50.00 |
| building-2 | 18.00 | 24.69 | 7.90 | 0.93 | 396 | 5415 | 10.10 | 1.40 | 55.60 | -4.70 | 0.00 | 0 | 22.20 |
| building-5 | 18.00 | 9.18 | 0.60 | 1.00 | 366 | 5445 | 9.70 | 0.10 | 59.90 | -4.90 | 0.00 | 0 | 19.40 |
| building-10 | 18.00 | 8.90 | 1.20 | 0.99 | 453 | 5689 | 9.70 | 0.00 | 59.70 | -4.80 | 0.00 | 0 | 30.50 |
| building-11 | 18.00 | 13.16 | 3.10 | 0.97 | 722 | 6249 | 9.80 | 0.20 | 58.00 | -5.00 | 0.00 | 0 | 43.90 |
| building-17 | 18.00 | 11.42 | 2.60 | 0.96 | 778 | 6483 | 10.00 | 0.30 | 57.50 | -5.20 | 0.00 | 0 | 22.90 |
| building-25 | 18.00 | 8.96 | 0.90 | 0.99 | 664 | 6517 | 9.80 | 0.10 | 59.30 | -4.10 | 0.00 | 0 | 14.40 |
| building-16 | 18.00 | 15.22 | 4.40 | 0.96 | 810 | 7824 | 9.80 | 0.20 | 57.60 | -6.00 | 0.00 | 0 | 50.30 |
| building-22 | 18.00 | 11.44 | 2.60 | 0.98 | 662 | 8083 | 9.80 | 0.20 | 58.70 | -4.80 | 0.00 | 0 | 19.00 |
| building-21 | 18.00 | 15.47 | 4.40 | 0.96 | 631 | 8572 | 10.10 | 0.10 | 57.50 | -4.30 | 0.00 | 0 | 33.60 |
| building-20 | 18.00 | 19.46 | 5.60 | 0.94 | 1179 | 9203 | 9.90 | 0.40 | 56.20 | -5.70 | 0.00 | 0 | 47.20 |
| building-15 | 18.00 | 11.16 | 0.70 | 1.00 | 1234 | 9235 | 9.80 | 0.10 | 59.90 | -4.60 | 0.00 | 0 | 37.90 |
| building-12 | 18.00 | 13.34 | 4.00 | 0.95 | 751 | 9237 | 10.20 | 0.30 | 57.10 | -4.30 | 0.00 | 0 | 20.90 |

## Per 5 s

| window | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-5s | 2.16 | 0.00 | 1.00 | 0 | 0 | 9.80 | 0.00 | 60.00 | -6.00 | 0.00 | 0 | 0.40 |
| 5-10s | 2.11 | 0.00 | 1.00 | 0 | 0 | 10.00 | 0.20 | 60.00 | -6.10 | 0.00 | 0 | 0.10 |
| 10-15s | 8.01 | 2.00 | 1.00 | 90 | 436 | 9.90 | 0.00 | 59.80 | -4.90 | 0.00 | 0 | 11.60 |
| 15-20s | 22.40 | 7.80 | 0.94 | 114 | 495 | 9.80 | 0.00 | 56.20 | -6.30 | 0.00 | 0 | 46.20 |
| 20-25s | 14.09 | 0.70 | 1.00 | 38 | 495 | 9.80 | 0.00 | 60.00 | -5.30 | 0.00 | 0 | 14.60 |
| 25-30s | 7.87 | 0.00 | 1.00 | 3 | 496 | 9.80 | 0.00 | 60.00 | -4.50 | 0.00 | 0 | 1.00 |
| 30-35s | 9.99 | 2.40 | 0.98 | 8 | 964 | 10.00 | 0.30 | 59.00 | -5.40 | 0.00 | 0 | 9.20 |
| 35-40s | 45.22 | 21.20 | 0.80 | 547 | 2769 | 10.10 | 0.90 | 48.00 | -5.30 | 0.00 | 0 | 150.30 |
| 40-45s | 16.20 | 4.70 | 0.99 | 335 | 2908 | 10.00 | 0.00 | 59.80 | -7.80 | 0.00 | 0 | 98.70 |
| 45-50s | 10.04 | 0.00 | 1.00 | 235 | 2919 | 10.00 | 0.00 | 60.00 | -5.60 | 0.00 | 0 | 10.80 |
| 50-55s | 28.17 | 10.70 | 0.90 | 168 | 3089 | 10.70 | 0.00 | 54.20 | -5.30 | 0.00 | 0 | 17.50 |
| 55-60s | 23.25 | 10.50 | 0.96 | 431 | 4690 | 10.00 | 0.20 | 57.40 | -10.40 | 0.00 | 0 | 138.80 |
| 60-65s | 13.21 | 0.30 | 1.00 | 346 | 4694 | 9.80 | 0.00 | 60.00 | -7.10 | 0.00 | 0 | 30.60 |
| 65-70s | 11.03 | 3.00 | 0.99 | 316 | 5153 | 9.70 | 0.00 | 59.60 | -5.80 | 0.00 | 0 | 42.20 |
| 70-75s | 12.33 | 2.00 | 0.99 | 228 | 5258 | 9.80 | 0.00 | 59.40 | -5.30 | 0.00 | 0 | 55.10 |
| 75-80s | 8.77 | 0.00 | 1.00 | 223 | 5259 | 9.80 | 0.00 | 60.00 | -5.10 | 0.00 | 0 | 29.40 |
| 80-85s | 8.22 | 1.30 | 1.00 | 340 | 5290 | 9.70 | 0.00 | 59.80 | -4.40 | 0.00 | 0 | 13.00 |
| 85-90s | 9.49 | 3.10 | 0.97 | 345 | 5358 | 9.90 | 0.00 | 58.40 | -4.30 | 0.00 | 0 | 19.20 |
| 90-95s | 46.95 | 28.70 | 0.77 | 396 | 5415 | 18.80 | 5.70 | 46.00 | -12.50 | 0.00 | 0 | 37.80 |
| 95-100s | 8.38 | 0.30 | 1.00 | 217 | 5417 | 9.60 | 0.20 | 60.00 | -4.80 | 0.00 | 0 | 16.20 |
| 100-105s | 9.09 | 0.30 | 1.00 | 356 | 5419 | 9.70 | 0.20 | 60.00 | -4.80 | 0.00 | 0 | 17.60 |
| 105-110s | 9.95 | 1.30 | 0.99 | 374 | 5445 | 9.80 | 0.20 | 59.60 | -5.10 | 0.00 | 0 | 25.30 |
| 110-115s | 8.51 | 0.30 | 1.00 | 364 | 5445 | 9.70 | 0.00 | 59.80 | -4.90 | 0.00 | 0 | 12.90 |
| 115-120s | 8.26 | 0.00 | 1.00 | 297 | 5445 | 9.70 | 0.20 | 60.00 | -4.70 | 0.00 | 0 | 7.10 |
| 120-125s | 8.69 | 0.00 | 1.00 | 110 | 5445 | 9.70 | 0.00 | 60.00 | -4.90 | 0.00 | 0 | 16.20 |
| 125-130s | 14.80 | 4.40 | 0.98 | 462 | 5689 | 9.70 | 0.00 | 58.80 | -4.90 | 0.00 | 0 | 69.50 |
| 130-135s | 10.05 | 0.00 | 1.00 | 213 | 5689 | 9.70 | 0.20 | 60.00 | -5.70 | 0.00 | 0 | 33.30 |
| 135-140s | 8.77 | 0.30 | 1.00 | 437 | 5829 | 9.70 | 0.00 | 60.00 | -5.10 | 0.00 | 0 | 13.10 |
| 140-145s | 29.24 | 8.60 | 0.89 | 461 | 6242 | 11.50 | 0.50 | 53.40 | -3.10 | 0.00 | 0 | 32.70 |
| 145-150s | 15.20 | 2.70 | 0.99 | 660 | 6249 | 9.80 | 0.00 | 59.40 | -7.10 | 0.00 | 0 | 100.50 |
| 150-155s | 9.72 | 0.00 | 1.00 | 522 | 6249 | 9.80 | 0.00 | 60.00 | -4.90 | 0.00 | 0 | 15.90 |
| 155-160s | 11.45 | 2.70 | 1.00 | 692 | 6416 | 9.80 | 0.00 | 59.80 | -5.80 | 0.00 | 0 | 32.20 |
| 160-165s | 30.13 | 7.50 | 0.85 | 550 | 6478 | 12.70 | 1.10 | 51.00 | -5.30 | 0.00 | 0 | 18.40 |
| 165-170s | 8.62 | 0.00 | 1.00 | 673 | 6483 | 9.80 | 0.00 | 60.00 | -4.20 | 0.00 | 0 | 14.90 |
| 170-175s | 8.00 | 0.70 | 1.00 | 664 | 6485 | 9.70 | 0.00 | 60.00 | -4.00 | 0.00 | 0 | 9.60 |
| 175-180s | 8.30 | 1.00 | 1.00 | 687 | 6500 | 9.80 | 0.30 | 60.00 | -4.70 | 0.00 | 0 | 20.00 |
| 180-185s | 11.35 | 1.70 | 0.96 | 664 | 6517 | 9.80 | 0.20 | 57.60 | -4.20 | 0.00 | 0 | 16.90 |
| 185-190s | 9.62 | 0.00 | 1.00 | 516 | 6517 | 9.70 | 0.00 | 60.00 | -5.30 | 0.00 | 0 | 6.00 |
| 190-195s | 10.29 | 2.00 | 1.00 | 712 | 6706 | 9.70 | 0.30 | 60.00 | -6.10 | 0.00 | 0 | 19.40 |
| 195-200s | 18.47 | 5.70 | 0.94 | 956 | 7823 | 9.70 | 0.20 | 56.40 | -7.40 | 0.00 | 0 | 94.60 |
| 200-205s | 35.68 | 8.80 | 0.91 | 800 | 7824 | 11.80 | 0.30 | 54.80 | -5.30 | 0.00 | 0 | 69.30 |
| 205-210s | 9.46 | 1.30 | 0.99 | 778 | 7857 | 9.70 | 0.20 | 59.40 | -4.20 | 0.00 | 0 | 9.70 |
| 210-215s | 9.66 | 1.70 | 1.00 | 595 | 7934 | 9.70 | 0.00 | 60.20 | -5.80 | 0.00 | 0 | 19.30 |
| 215-220s | 23.83 | 6.40 | 0.93 | 665 | 8083 | 10.10 | 0.50 | 56.00 | -6.60 | 0.00 | 0 | 27.70 |
| 220-225s | 8.98 | 0.00 | 1.00 | 619 | 8083 | 9.80 | 0.20 | 60.00 | -4.40 | 0.00 | 0 | 16.90 |
| 225-230s | 9.27 | 2.30 | 0.99 | 672 | 8368 | 9.80 | 0.20 | 59.60 | -4.70 | 0.00 | 0 | 24.50 |
| 230-235s | 40.82 | 9.80 | 0.88 | 584 | 8420 | 13.50 | 0.20 | 53.00 | -3.60 | 0.00 | 0 | 28.90 |
| 235-240s | 15.97 | 4.80 | 0.97 | 613 | 8572 | 10.10 | 0.20 | 58.20 | -6.40 | 0.00 | 0 | 58.60 |
| 240-245s | 11.99 | 1.00 | 0.99 | 526 | 8572 | 9.90 | 0.00 | 59.20 | -5.20 | 0.00 | 0 | 10.50 |
| 245-250s | 12.26 | 2.30 | 1.00 | 590 | 8762 | 9.70 | 0.00 | 60.00 | -6.70 | 0.00 | 0 | 20.90 |
| 250-255s | 38.16 | 14.30 | 0.81 | 1027 | 9170 | 10.10 | 1.20 | 48.80 | -5.70 | 0.00 | 0 | 74.20 |
| 255-260s | 13.44 | 3.70 | 0.98 | 1151 | 9203 | 9.80 | 0.20 | 58.80 | -6.70 | 0.00 | 0 | 96.60 |
| 260-265s | 11.77 | 0.70 | 1.00 | 844 | 9203 | 9.90 | 0.00 | 60.00 | -4.90 | 0.00 | 0 | 12.80 |
| 265-270s | 7.82 | 0.00 | 1.00 | 754 | 9203 | 9.70 | 0.20 | 60.00 | -4.20 | 0.00 | 0 | 7.10 |
| 270-275s | 12.46 | 2.00 | 0.99 | 1234 | 9235 | 9.70 | 0.20 | 59.60 | -5.30 | 0.00 | 0 | 79.70 |
| 275-280s | 9.29 | 0.00 | 1.00 | 748 | 9235 | 9.70 | 0.20 | 60.00 | -4.40 | 0.00 | 0 | 29.60 |
| 280-285s | 8.59 | 0.30 | 1.00 | 859 | 9237 | 9.80 | 0.00 | 60.00 | -4.40 | 0.00 | 0 | 14.00 |
| 285-290s | 11.50 | 0.00 | 1.00 | 757 | 9237 | 9.70 | 0.20 | 60.00 | -4.00 | 0.00 | 0 | 27.50 |
| 290-295s | 43.71 | 23.70 | 0.76 | 887 | 9237 | 15.00 | 1.20 | 45.60 | -5.80 | 0.00 | 0 | 12.30 |
| 295-300s | 9.85 | 0.70 | 1.00 | 574 | 9250 | 9.80 | 0.00 | 60.00 | -4.90 | 0.00 | 0 | 23.40 |
| 300-305s | 9.07 | 0.00 | 1.00 | 571 | 9250 | 9.80 | 0.00 | 60.00 | -4.50 | 0.00 | 0 | 18.80 |
| 305-310s | 7.97 | 0.00 | 1.00 | 579 | 9250 | 9.80 | 0.00 | 60.00 | -3.80 | 0.00 | 0 | 22.50 |
| 310-315s | 11.54 | 0.00 | 1.00 | 571 | 9250 | 9.80 | 0.00 | 60.00 | -4.00 | 0.00 | 0 | 13.40 |
| 315-320s | 14.37 | 0.00 | 1.00 | 572 | 9250 | 9.90 | 0.00 | 60.00 | -4.10 | 0.00 | 0 | 12.50 |
| 320-325s | 14.62 | 0.00 | 1.00 | 572 | 9250 | 10.00 | 0.20 | 60.00 | -4.20 | 0.00 | 0 | 24.90 |
| 325-330s | 14.63 | 0.00 | 1.00 | 572 | 9250 | 9.80 | 0.20 | 60.00 | -4.60 | 0.00 | 0 | 14.60 |
| 330-335s | 14.67 | 0.00 | 1.00 | 579 | 9250 | 10.00 | 0.20 | 60.00 | -4.80 | 0.00 | 0 | 11.90 |
| 335-337s | 14.70 | 0.00 | 1.00 | 579 | 9250 | 9.90 | 0.00 | 60.00 | -4.20 | 0.00 | 0 | 22.70 |

## Against baseline `target/city-bench/runs/20260924-191044-pkg780-systematic/report.json`

| metric | baseline | current | delta | delta_pct |
|---|---|---|---|---|
| server.tick_p50_ms | 8.25 | 6.93 | -1.32 | -16.00 |
| server.tick_p95_ms | 15.29 | 14.09 | -1.20 | -7.80 |
| server.tick_p99_ms | 39.90 | 36.72 | -3.18 | -8.00 |
| server.tick_max_ms | 167.97 | 269.86 | 101.89 | 60.70 |
| server.pct_over_16_7ms | 3.69 | 2.98 | -0.71 | -19.20 |
| server.sim_rate | 0.97 | 0.97 | 0.01 | 0.50 |
| server.sim_rate_5s_min | 0.66 | 0.76 | 0.10 | 15.20 |
| server.dynamics_ms_mean | 9.19 | 7.80 | -1.39 | -15.10 |
| server.gpu_wait_p95_ms | 17.34 | 13.67 | -3.67 | -21.20 |
| server.broken_bond_pct | 88.30 | 89.20 | 0.90 | 1.00 |
| server.peak_active_bodies | 978 | 1239 | 261 | 26.70 |
| c0.frame_p95_ms | 9.30 | 9.90 | 0.60 | 6.50 |
| c0.pct_frames_over_2x | 0.17 | 0.23 | 0.06 | 35.30 |
| c0.hitches_over_100ms | 0 | 4 | 4 | – |
| c0.snapshots_per_tick | 1.00 | 1.00 | 0.00 | 0.00 |
| c0.lead_p95_ms | -6.50 | -4.80 | 1.70 | 26.20 |
| c0.pct_extrapolating | 0.00 | 0.00 | 0.00 | – |
| c0.backward_steps | 0 | 0 | 0 | – |
| c0.meteor_backward_frames | 0 | 0 | 0 | – |
| c0.kbps_avg | 252.80 | 278.20 | 25.40 | 10.00 |
| c0.city_B_per_moving_body_s | 224.40 | 196.80 | -27.60 | -12.30 |
| c0.latency_p99_ms | 4.13 | 4.54 | 0.40 | 9.70 |
| c0.structure_repairs | 0 | 0 | 0 | – |
| c0.body_render_err_p99_m | 0.03 | 0.03 | 0.00 | 3.00 |
| c0.stale_body_draws | 0 | 13 | 13 | – |
| c0.hitches_cpu_bound_33ms | 6 | 18 | 12 | 200.00 |
| c0.meteor_hold_jump_max_m | 0 | 0 | 0 | – |

Measured: everything above is read from the tapes, the server capture, /match-stats samples and the server log. PhysX step/GPU wait are 1 Hz samples of the last step, not every tick. Render error at render time depends on the client's recorded clock offset; 'now' error includes the intended interpolation delay.
