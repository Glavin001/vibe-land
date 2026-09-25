# City bench: 20260925-001915-pkgb5b-fanout

Run `20260925-001915-pkgb5b-fanout` — scenario **quick** (4 buildings, 3 client(s), intensity 1, seed 1); status **ok**; tape 122 s.
Build: vibe-land `1425a742` (server fingerprint `1425a742`), PhysX SDK `b5b18ecb2700abbf12e50749529ba3fe07db9344`, cuda-metal `80512aa` (libcumetal 2026-09-25T00:05:36), Apple M3 Max.

## Verdict: FAIL (7 of 27 budgets)

| status | id | observed | limit | where |
|---|---|---|---|---|
| fail | server.tick_p95 | 18.03 | < 16.7 |  |
| fail | server.tick_p99 | 38.02 | < 33.3 |  |
| fail | server.over_budget_pct | 6.93 | <= 5 |  |
| fail | server.sim_rate | 0.96 | >= 0.98 |  |
| fail | server.sim_rate_5s_min | 0.64 | >= 0.9 |  |
| pass | client.frame_p95 | 1.18 | < 2.0 | c0 |
| pass | client.over_2x_pct | 0.47 | <= 5 | c0 |
| fail | client.hitches_100ms | 2 | <= 0 | c2 |
| fail | client.cpu_hitch_33ms | 2 | <= 0 | c0 |
| pass | net.backward_steps | 0 | <= 0 | c0 |
| pass | net.lead_p95 | -7.30 | < 50 | c0 |
| pass | net.extrapolating_pct | 0.01 | < 10 | c0 |
| pass | net.snapshot_per_tick | 1.00 | >= 0.98 | c0 |
| pass | net.snapshot_gap_p99 | 43.50 | < 50 | c1 |
| pass | net.lost | 0 | <= 0 | c0 |
| pass | net.server_drops | 0 | <= 0 | c0 |
| pass | net.latency_p99 | 4.34 | < 20 | c1 |
| pass | net.repairs_without_loss | 0 | <= 0 | c0 |
| pass | net.meteor_arc_jump | 0.02 | < 0.5 | c0 |
| pass | net.meteor_hold_jump | 0 | < 2.0 | c0 |
| pass | net.meteor_backward | 0 | <= 0 | c0 |
| pass | net.meteor_below_ground | 0 | <= 0 | c0 |
| pass | net.body_render_error_p99 | 0.04 | < 0.5 | c0 |
| pass | net.self_error_p99 | 0.43 | < 0.5 | c1 |
| pass | net.match_stats_share | 1.09 | < 2 | c1 |
| pass | net.energy_rate | 2.00 | <= 10 | c1 |
| pass | physics.below_ground | 0 | <= 0 |  |

## Server real-time

- Tick p50/p95/p99/max: 8.57 / 18.03 / 38.02 / 307.82 ms; 6.93% over 16.7 ms, 1.33% over 33 ms, 5 over 100 ms (6998 ticks).
- Sim rate: 0.956 (worst 5 s window 0.637).
- Tick breakdown (mean ms, share): dynamics 9.65 (97.3%), city 0.16 (1.6%), snapshot 0.02 (0.2%), player_sim 0.07 (0.7%), unattributed 0.01 (0.1%)
- Per-tick physics phases (6998 ticks; engine profiler on 0 of them; GPU wait sampled on 437): collecting them cost p50/p90/max 1.7/2.7/91.9 us per tick. Meteors launched: 5 (launch p50/max 0.075/0.085 ms); shots bracket p50/max 0.001/0.139 ms on ticks with shots.

Physics step by tick class (split: created bodies; break: broke bonds only), p50 / p90 (max for counts):

| class | ticks | total | dynamics | named_% | submit | overlap | fetch | gpu_wait | readback | corrections | promoted | bonds | contacts | iters | awake | pairs_found/lost |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| split | 94 | 39.52 / 81.69 | 39.19 / 81.45 | 100.0 | 0.01 | 0.00 | 39.16 / 81.41 | 31.56 | 0.01 | 1 / 1 | 3 / 117 | 5 / 757 | 3298 | 16 | 181 | 20/0 |
| break | 22 | 12.99 / 19.47 | 12.36 / 18.90 | 100.0 | 0.01 | 0.00 | 12.33 / 18.88 | 11.47 | 0.01 | 0 / 0 | 0 / 0 | 1 / 32 | 1683 | 16 | 182 | 8/6 |
| other | 6882 | 8.52 / 14.39 | 8.22 / 14.03 | 99.9 | 0.01 | 0.00 | 8.19 / 14.00 | 8.07 | 0.01 | 0 / 0 | 0 / 0 | 0 / 0 | 861 | 7 | 98 | 0/0 |

- PhysX last step / GPU wait (1 Hz samples) p50/p95/max: 8.41/28.87/82.44 ms, 8.62/22.14/51.90 ms.
- City encoder: step p95 0.178 ms, encode p95 0.140 ms, 26735.8 B per awake body-tick, outbound drops 0.
- Destruction reached: 3426 of 10373 bonds broken (33.0%), 855 chunk bodies, peak 435 active bodies; r(tick, active bodies) = 0.33; bodies below -3 m: 0; 'left the world' log lines: 0; went through the ground (first tick logged): 0; retired at the floor: 0.

Tick cost against destruction level:

| by | bucket | ticks | tick_p50 | tick_p95 | tick_max | pct_over_16_7ms |
|---|---|---|---|---|---|---|
| active_bodies | 0-99 | 3538 | 7.24 | 17.03 | 123.14 | 5.90 |
| active_bodies | 100-499 | 3460 | 9.37 | 21.50 | 307.82 | 8.00 |
| broken_bonds | 0-25% | 3770 | 9.73 | 17.96 | 123.14 | 7.70 |
| broken_bonds | 25-50% | 3228 | 7.66 | 18.05 | 307.82 | 6.00 |

## Clients at a glance

| client | role | fps | frame_p95 | pct_over_2x | snaps_per_tick | lead_p95 | pct_extrap | back_steps | kbps | lat_p99 | lost | repairs | body_err_p99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | player | 118.30 | 9.80 | 0.47 | 1.00 | -7.30 | 0.01 | 0 | 186.10 | 3.98 | 0 | 0 | 0.04 |
| 1 | spectator | 118.70 | 9.70 | 0.42 | 1.00 | -7.40 | 0.01 | 0 | 173.40 | 4.34 | 0 | 0 | 0.04 |
| 2 | spectator | 118.50 | 9.80 | 0.40 | 1.00 | -7.30 | 0.01 | 0 | 177.20 | 4.15 | 0 | 0 | 0.04 |

## Client 0 (player)

- Frames: 118.3 fps; frame p50/p95/p99 8.30/9.80/11.10 ms against a 8.33 ms display period (1.18x); 0.47% over 2x; CPU p50/p95 1.40/2.10 ms; hitches >100 ms: 1, CPU-bound >33 ms: 2; r(fps, server ticks/s) = 0.75.
- Client GPU time (EXT_disjoint_timer_query_webgl2; 14435 frames timed): longest pass p50/p95/max 1.85/4.54/225.06 ms, sum of passes p50/p95/max 6.06/21.77/1303.92 ms; frames over 2 periods by cause: {"cpu": 6, "wait": 20, "gpu": 42}; timer bookkeeping {"framesResolved": 14435, "disjoints": 0, "queriesDiscarded": 0, "framesExpired": 0, "queriesRefused": 0, "lagFramesMax": 3, "lagFramesMean": 0.1603048146865258, "framesTimedOnTape": 14435}.
- Snapshots: 57.4 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.70/43.00/304.80 ms; 6 gaps over 100 ms; less the server's own tick gap p99/max 3.37/55.45 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 -16.9/-7.3/-4.1 ms; 0.01% of frames extrapolating; render clock stepped back 0 times (0 ms); dyn delay p50 21.19 ms.
- Meteors: 5 drawn, 0 moved backwards (0 frames, max 0 m); arc→body jump (step less the body's own motion) p50/max 0.02/0.02 m (frame step 1.2/1.3 m; rocks first streamed after impact 0, max 0 m from their arc); hold→body max 0 m; drawn below ground 0 frames.
- Transport: 12267/12267 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.17/3.98/55.83 ms.
- Bandwidth: 186 kbps average, 1531 kbps peak second; match stats 1.01% of bytes; energy 1.3 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| city-chunks | 2034.20 | 4165 | 16.67 | 34.10 | 71.70 | 178.90 |
| snapshot | 624.60 | 6998 | 5.12 | 57.40 | 22.00 | 7.90 |
| city-topology | 79.30 | 650 | 0.65 | 5.30 | 2.80 | 10.50 |
| city-baseline | 55.10 | 58 | 0.45 | 0.50 | 1.90 | 5.90 |
| match-stats | 28.80 | 117 | 0.24 | 1.00 | 1.00 | 0.20 |
| city-topo-hash | 11.50 | 58 | 0.09 | 0.50 | 0.40 | 0.20 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.00 | 1.40 |
| roster | 1.00 | 59 | 0.01 | 0.50 | 0.00 | 0.00 |
| energy | 0.80 | 158 | 0.01 | 1.30 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |
| welcome | 0.00 | 1 | 0.00 | 0.00 | 0.00 | 0.00 |

- Sync: 0 structure repairs (0.0 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 0; city sends at the 10 kB ceiling 1/2381; client counters {"bootstraps": 2, "hashChecks": 62, "resyncRequestsSent": 1, "presentedJumpsOver4m": 29, "drawnTeleports": 38, "correctionSnaps": 1, "settlesAfterSilence": 8}.
- Efficiency: 275.9 city bytes per moving body-second, 32.50 B/record, repeat records 0.04% (0.8 kB), snapshot 89 B mean, unchanged snapshot bodies 0.00%; server city selection {"candidates": 433208, "sent": 62596, "sent_pct": 14.45, "not_newsworthy": 79354, "rest_stride": 254038, "rest_unchanged": 35699, "ceiling": 0, "eval_cap": 0, "budget_used_pct": 6.17}.
- Rendered vs server truth (1099 samples; matched {"vehicles": 1099, "players": 2081, "bodies": 415}): vehicles_at_render_time_m p50/p99/max 0.001/0.002/0.002, local_now_m p50/p99/max 0.001/0.160/0.410, local_on_foot_now_m p50/p99/max 0.001/0.157/0.410, remote_players_at_render_time_m p50/p99/max 0.001/0.050/0.074, bodies_at_render_time_m p50/p99/max 0.005/0.040/0.048, bodies_now_m p50/p99/max 0.178/1.748/1.999, local_driving_now_m p50/p99/max 0.067/0.160/0.185

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | gpu_ms | class | server_tick_max_ms_near |
|---|---|---|---|---|---|---|
| 68.12 | building-7:demolish | 213.00 | 1.50 | 4.30 | wait | 307.80 |
| 70.24 | building-7:demolish | 74.60 | 54.90 | 13.31 | cpu | 63.90 |
| 70.61 | building-7:demolish | 72.00 | 56.60 | 9.65 | cpu | 70.80 |

## Client 1 (spectator)

- Frames: 118.7 fps; frame p50/p95/p99 8.30/9.70/10.40 ms against a 8.33 ms display period (1.16x); 0.42% over 2x; CPU p50/p95 1.30/2.10 ms; hitches >100 ms: 1, CPU-bound >33 ms: 1; r(fps, server ticks/s) = 0.61.
- Client GPU time (EXT_disjoint_timer_query_webgl2; 14479 frames timed): longest pass p50/p95/max 1.75/4.37/1089.44 ms, sum of passes p50/p95/max 6.12/24.30/1704.03 ms; frames over 2 periods by cause: {"cpu": 4, "wait": 27, "gpu": 30}; timer bookkeeping {"framesResolved": 14479, "disjoints": 0, "queriesDiscarded": 0, "framesExpired": 0, "queriesRefused": 0, "lagFramesMax": 3, "lagFramesMean": 0.13674977553698459, "framesTimedOnTape": 14479}.
- Snapshots: 57.4 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.70/43.50/307.40 ms; 5 gaps over 100 ms; less the server's own tick gap p99/max 3.57/55.36 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 -17.1/-7.4/-4.1 ms; 0.01% of frames extrapolating; render clock stepped back 0 times (0 ms); dyn delay p50 21.54 ms.
- Meteors: 5 drawn, 0 moved backwards (0 frames, max 0 m); arc→body jump (step less the body's own motion) p50/max 0.01/0.02 m (frame step 1.1/1.2 m; rocks first streamed after impact 0, max 0 m from their arc); hold→body max 0 m; drawn below ground 0 frames.
- Transport: 12326/12326 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.25/4.34/56.15 ms.
- Bandwidth: 173 kbps average, 1501 kbps peak second; match stats 1.09% of bytes; energy 2.0 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| city-chunks | 1943.90 | 4144 | 15.93 | 34.00 | 73.50 | 176.30 |
| snapshot | 520.80 | 6998 | 4.27 | 57.40 | 19.70 | 6.50 |
| city-topology | 79.30 | 650 | 0.65 | 5.30 | 3.00 | 10.50 |
| city-baseline | 55.10 | 58 | 0.45 | 0.50 | 2.10 | 5.90 |
| match-stats | 28.80 | 117 | 0.24 | 1.00 | 1.10 | 0.20 |
| city-topo-hash | 11.50 | 58 | 0.09 | 0.50 | 0.40 | 0.20 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.10 | 1.40 |
| energy | 1.20 | 238 | 0.01 | 2.00 | 0.00 | 0.00 |
| roster | 1.00 | 59 | 0.01 | 0.50 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |
| welcome | 0.00 | 1 | 0.00 | 0.00 | 0.00 | 0.00 |

- Sync: 0 structure repairs (0.0 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 0; city sends at the 10 kB ceiling 1/2408; client counters {"bootstraps": 2, "hashChecks": 62, "resyncRequestsSent": 1, "presentedJumpsOver4m": 22, "drawnTeleports": 37, "correctionSnaps": 4, "settlesAfterSilence": 8}.
- Efficiency: 264.8 city bytes per moving body-second, 32.87 B/record, repeat records 0.04% (0.7 kB), snapshot 74 B mean, unchanged snapshot bodies 0.00%; server city selection {"candidates": 433208, "sent": 59149, "sent_pct": 13.65, "not_newsworthy": 83060, "rest_stride": 254038, "rest_unchanged": 35529, "ceiling": 0, "eval_cap": 0, "budget_used_pct": 5.86}.
- Rendered vs server truth (467 samples; matched {"players": 589, "vehicles": 436, "bodies": 125}): local_now_m p50/p99/max 0.000/0.428/0.491, local_on_foot_now_m p50/p99/max 0.000/0.428/0.491, remote_players_at_render_time_m p50/p99/max 0.002/0.801/8.408, vehicles_at_render_time_m p50/p99/max 0.001/0.005/0.006, bodies_at_render_time_m p50/p99/max 0.003/0.036/0.038, bodies_now_m p50/p99/max 0.115/1.821/2.027

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | gpu_ms | class | server_tick_max_ms_near |
|---|---|---|---|---|---|---|
| 68.12 | building-7:demolish | 214.80 | 1.50 | 4.75 | wait | 307.80 |
| 70.75 | building-7:demolish | 40.40 | 39.60 | 13.63 | cpu | 70.80 |

## Client 2 (spectator)

- Frames: 118.5 fps; frame p50/p95/p99 8.30/9.80/10.70 ms against a 8.33 ms display period (1.18x); 0.40% over 2x; CPU p50/p95 1.40/2.10 ms; hitches >100 ms: 2, CPU-bound >33 ms: 2; r(fps, server ticks/s) = 0.70.
- Client GPU time (EXT_disjoint_timer_query_webgl2; 14452 frames timed): longest pass p50/p95/max 1.89/4.56/247.38 ms, sum of passes p50/p95/max 6.22/24.45/690.96 ms; frames over 2 periods by cause: {"cpu": 5, "wait": 27, "gpu": 26}; timer bookkeeping {"framesResolved": 14452, "disjoints": 0, "queriesDiscarded": 0, "framesExpired": 0, "queriesRefused": 0, "lagFramesMax": 3, "lagFramesMean": 0.16537503459728758, "framesTimedOnTape": 14452}.
- Snapshots: 57.4 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.70/42.90/304.90 ms; 5 gaps over 100 ms; less the server's own tick gap p99/max 3.45/62.68 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 -16.9/-7.3/-4.1 ms; 0.01% of frames extrapolating; render clock stepped back 0 times (0 ms); dyn delay p50 21.22 ms.
- Meteors: 5 drawn, 0 moved backwards (0 frames, max 0 m); arc→body jump (step less the body's own motion) p50/max 0.01/0.02 m (frame step 1.2/1.4 m; rocks first streamed after impact 0, max 0 m from their arc); hold→body max 0 m; drawn below ground 0 frames.
- Transport: 12290/12290 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.26/4.15/62.79 ms.
- Bandwidth: 177 kbps average, 1508 kbps peak second; match stats 1.07% of bytes; energy 1.4 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| city-chunks | 1976.70 | 4177 | 16.20 | 34.20 | 73.20 | 177.10 |
| snapshot | 546.30 | 6998 | 4.48 | 57.40 | 20.20 | 6.80 |
| city-topology | 79.30 | 650 | 0.65 | 5.30 | 2.90 | 10.50 |
| city-baseline | 55.10 | 58 | 0.45 | 0.50 | 2.00 | 5.90 |
| match-stats | 28.80 | 117 | 0.24 | 1.00 | 1.10 | 0.20 |
| city-topo-hash | 11.50 | 58 | 0.09 | 0.50 | 0.40 | 0.20 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.10 | 1.40 |
| roster | 1.00 | 59 | 0.01 | 0.50 | 0.00 | 0.00 |
| energy | 0.80 | 169 | 0.01 | 1.40 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |
| welcome | 0.00 | 1 | 0.00 | 0.00 | 0.00 | 0.00 |

- Sync: 0 structure repairs (0.0 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 0; city sends at the 10 kB ceiling 1/2406; client counters {"bootstraps": 2, "hashChecks": 61, "resyncRequestsSent": 1, "presentedJumpsOver4m": 23, "drawnTeleports": 39, "correctionSnaps": 9, "settlesAfterSilence": 2}.
- Efficiency: 271.4 city bytes per moving body-second, 32.81 B/record, repeat records 0.04% (0.8 kB), snapshot 78 B mean, unchanged snapshot bodies 0.00%; server city selection {"candidates": 433208, "sent": 60251, "sent_pct": 13.91, "not_newsworthy": 79295, "rest_stride": 254038, "rest_unchanged": 35396, "ceiling": 0, "eval_cap": 0, "budget_used_pct": 5.97}.
- Rendered vs server truth (467 samples; matched {"vehicles": 437, "players": 590, "bodies": 192}): local_now_m p50/p99/max 0.001/0.250/0.546, local_on_foot_now_m p50/p99/max 0.001/0.250/0.546, vehicles_at_render_time_m p50/p99/max 0.001/0.004/0.005, remote_players_at_render_time_m p50/p99/max 0.002/5.813/15.466, bodies_at_render_time_m p50/p99/max 0.005/0.040/0.043, bodies_now_m p50/p99/max 0.183/2.161/2.248

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | gpu_ms | class | server_tick_max_ms_near |
|---|---|---|---|---|---|---|
| 68.12 | building-7:demolish | 216.30 | 1.50 | 4.19 | wait | 307.80 |
| 78.76 | building-1:cannon | 116.00 | 1.10 | 164.39 | gpu | 158.80 |
| 70.70 | building-7:demolish | 59.60 | 44.30 | 16.88 | cpu | 70.80 |
| 70.38 | building-7:demolish | 56.60 | 40.70 | 14.97 | cpu | 67.70 |

## By phase

| window | dur_s | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| intro | 5.00 | 4.76 | 0.00 | 1.00 | 0 | 0 | 9.70 | 0.00 | 60.00 | -7.20 | 0.20 | 0 | 0.10 |
| destroy | 88.00 | 22.34 | 9.80 | 0.94 | 173 | 3426 | 9.80 | 0.60 | 56.30 | -7.10 | 0.00 | 0 | 24.30 |
| settle | 6.00 | 8.61 | 0.00 | 1.00 | 87 | 3426 | 9.70 | 0.10 | 60.00 | -5.20 | 0.00 | 0 | 2.10 |
| drive | 15.00 | 8.21 | 0.00 | 1.00 | 87 | 3426 | 9.70 | 0.10 | 60.00 | -8.30 | 0.00 | 0 | 1.80 |
| idle-end | 5.00 | 6.99 | 0.00 | 1.00 | 1 | 3426 | 9.60 | 0.00 | 60.20 | -7.70 | 0.00 | 0 | 0.10 |

Per building:

| window | dur_s | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| building-6 | 22.00 | 19.47 | 13.00 | 0.95 | 241 | 1371 | 9.80 | 0.30 | 56.80 | -7.70 | 0.00 | 0 | 25.00 |
| building-0 | 22.00 | 16.78 | 5.40 | 0.98 | 177 | 1421 | 9.90 | 0.10 | 58.90 | -7.10 | 0.00 | 0 | 15.30 |
| building-7 | 22.00 | 32.54 | 16.90 | 0.85 | 418 | 3048 | 10.10 | 2.10 | 51.30 | -7.90 | 0.00 | 0 | 36.10 |
| building-1 | 22.00 | 16.31 | 4.70 | 0.97 | 173 | 3426 | 9.70 | 0.20 | 58.40 | -5.30 | 0.00 | 0 | 20.70 |

## Per 5 s

| window | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-5s | 4.76 | 0.00 | 1.00 | 0 | 0 | 9.70 | 0.00 | 60.00 | -7.20 | 0.30 | 0 | 0.40 |
| 5-10s | 7.44 | 0.30 | 1.00 | 0 | 0 | 9.80 | 0.50 | 60.00 | -7.00 | 0.00 | 0 | 0.10 |
| 10-15s | 12.96 | 3.40 | 0.98 | 35 | 225 | 9.80 | 0.00 | 58.80 | -7.20 | 0.00 | 0 | 6.40 |
| 15-20s | 18.42 | 20.10 | 0.98 | 39 | 423 | 9.60 | 0.00 | 58.80 | -9.00 | 0.00 | 0 | 17.50 |
| 20-25s | 49.38 | 35.70 | 0.80 | 229 | 1326 | 10.20 | 0.70 | 48.20 | -8.40 | 0.00 | 0 | 49.40 |
| 25-30s | 16.74 | 5.70 | 0.99 | 188 | 1379 | 9.90 | 0.00 | 59.60 | -9.40 | 0.00 | 0 | 53.70 |
| 30-35s | 16.51 | 4.70 | 0.99 | 179 | 1396 | 9.70 | 0.00 | 59.60 | -8.60 | 0.00 | 0 | 16.20 |
| 35-40s | 14.83 | 1.70 | 1.00 | 182 | 1411 | 9.70 | 0.00 | 60.00 | -7.60 | 0.00 | 0 | 14.70 |
| 40-45s | 13.73 | 0.70 | 1.00 | 155 | 1421 | 9.70 | 0.00 | 59.60 | -6.10 | 0.00 | 0 | 8.00 |
| 45-50s | 28.21 | 13.90 | 0.93 | 154 | 1421 | 11.00 | 0.50 | 56.20 | -6.40 | 0.00 | 0 | 14.00 |
| 50-55s | 14.51 | 0.00 | 1.00 | 85 | 1421 | 9.70 | 0.00 | 60.00 | -7.40 | 0.00 | 0 | 3.70 |
| 55-60s | 15.76 | 2.40 | 0.98 | 99 | 1527 | 9.80 | 0.00 | 59.00 | -8.30 | 0.00 | 0 | 6.80 |
| 60-65s | 29.22 | 16.40 | 0.87 | 91 | 1528 | 11.70 | 2.10 | 52.40 | -7.70 | 0.00 | 0 | 7.40 |
| 65-70s | 57.71 | 63.00 | 0.64 | 435 | 3021 | 10.00 | 1.30 | 38.40 | -19.00 | 0.00 | 0 | 131.10 |
| 70-75s | 45.74 | 8.10 | 0.87 | 318 | 3051 | 17.10 | 6.10 | 52.00 | -7.80 | 0.00 | 0 | 31.10 |
| 75-80s | 10.32 | 1.00 | 0.96 | 144 | 3275 | 9.60 | 0.30 | 57.60 | -4.50 | 0.00 | 0 | 10.60 |
| 80-85s | 11.30 | 1.30 | 1.00 | 151 | 3377 | 9.60 | 0.00 | 60.00 | -5.40 | 0.00 | 0 | 26.40 |
| 85-90s | 26.82 | 19.20 | 0.92 | 188 | 3426 | 9.80 | 0.30 | 55.20 | -4.70 | 0.00 | 0 | 20.90 |
| 90-95s | 9.46 | 0.00 | 1.00 | 166 | 3426 | 9.70 | 0.00 | 60.00 | -4.80 | 0.00 | 0 | 10.90 |
| 95-100s | 8.34 | 0.00 | 1.00 | 87 | 3426 | 9.70 | 0.20 | 60.00 | -8.50 | 0.00 | 0 | 1.40 |
| 100-105s | 8.29 | 0.00 | 1.00 | 86 | 3426 | 9.70 | 0.00 | 60.00 | -8.20 | 0.00 | 0 | 0.90 |
| 105-110s | 7.83 | 0.00 | 1.00 | 87 | 3426 | 9.70 | 0.20 | 60.00 | -8.50 | 0.00 | 0 | 0.60 |
| 110-115s | 8.04 | 0.00 | 1.00 | 1 | 3426 | 9.70 | 0.00 | 60.00 | -8.30 | 0.00 | 0 | 3.90 |
| 115-120s | 6.99 | 0.00 | 1.00 | 1 | 3426 | 9.60 | 0.00 | 60.00 | -7.50 | 0.00 | 0 | 0.10 |
| 120-122s | 6.82 | 0.00 | 1.01 | 1 | 3426 | 9.90 | 0.00 | 60.50 | -7.50 | 0.00 | 0 | 0.10 |

## Against baseline `target/city-bench/runs/20260924-192231-pkg780-fanout/report.json`

| metric | baseline | current | delta | delta_pct |
|---|---|---|---|---|
| server.tick_p50_ms | 10.17 | 8.57 | -1.60 | -15.70 |
| server.tick_p95_ms | 28.87 | 18.03 | -10.84 | -37.50 |
| server.tick_p99_ms | 43.03 | 38.02 | -5.01 | -11.60 |
| server.tick_max_ms | 135.84 | 307.82 | 171.98 | 126.60 |
| server.pct_over_16_7ms | 15.71 | 6.93 | -8.78 | -55.90 |
| server.sim_rate | 0.91 | 0.96 | 0.05 | 5.30 |
| server.sim_rate_5s_min | 0.49 | 0.64 | 0.14 | 29.20 |
| server.dynamics_ms_mean | 12.48 | 9.65 | -2.83 | -22.60 |
| server.gpu_wait_p95_ms | 29.09 | 22.14 | -6.95 | -23.90 |
| server.broken_bond_pct | 25.80 | 33.00 | 7.20 | 27.90 |
| server.peak_active_bodies | 275 | 435 | 160 | 58.20 |
| c0.frame_p95_ms | 9.30 | 9.80 | 0.50 | 5.40 |
| c0.pct_frames_over_2x | 0.40 | 0.47 | 0.07 | 17.50 |
| c0.hitches_over_100ms | 0 | 1 | 1 | – |
| c0.snapshots_per_tick | 1.00 | 1.00 | 0.00 | 0.00 |
| c0.lead_p95_ms | -5.70 | -7.30 | -1.60 | -28.10 |
| c0.pct_extrapolating | 0.00 | 0.01 | 0.01 | – |
| c0.backward_steps | 0 | 0 | 0 | – |
| c0.meteor_backward_frames | 0 | 0 | 0 | – |
| c0.kbps_avg | 179.90 | 186.10 | 6.20 | 3.40 |
| c0.city_B_per_moving_body_s | 255.40 | 275.90 | 20.50 | 8.00 |
| c0.latency_p99_ms | 4.11 | 3.98 | -0.12 | -3.00 |
| c0.structure_repairs | 0 | 0 | 0 | – |
| c0.body_render_err_p99_m | 0.04 | 0.04 | -0.00 | -4.80 |
| c0.stale_body_draws | 11 | 0 | -11 | -100.00 |
| c0.hitches_cpu_bound_33ms | 3 | 2 | -1 | -33.30 |
| c0.meteor_hold_jump_max_m | 0 | 0 | 0 | – |
| c1.frame_p95_ms | 9.20 | 9.70 | 0.50 | 5.40 |
| c1.pct_frames_over_2x | 0.18 | 0.42 | 0.24 | 133.30 |
| c1.hitches_over_100ms | 0 | 1 | 1 | – |
| c1.snapshots_per_tick | 1.00 | 1.00 | 0.00 | 0.00 |
| c1.lead_p95_ms | -5.60 | -7.40 | -1.80 | -32.10 |
| c1.pct_extrapolating | 0.00 | 0.01 | 0.01 | – |
| c1.backward_steps | 0 | 0 | 0 | – |
| c1.meteor_backward_frames | 0 | 0 | 0 | – |
| c1.kbps_avg | 168.30 | 173.40 | 5.10 | 3.00 |
| c1.city_B_per_moving_body_s | 244.20 | 264.80 | 20.60 | 8.40 |
| c1.latency_p99_ms | 4.23 | 4.34 | 0.12 | 2.70 |
| c1.structure_repairs | 0 | 0 | 0 | – |
| c1.body_render_err_p99_m | 0.03 | 0.04 | 0.00 | 9.10 |
| c1.stale_body_draws | 0 | 0 | 0 | – |
| c1.hitches_cpu_bound_33ms | 3 | 1 | -2 | -66.70 |
| c1.meteor_hold_jump_max_m | 0 | 0 | 0 | – |
| c2.frame_p95_ms | 9.20 | 9.80 | 0.60 | 6.50 |
| c2.pct_frames_over_2x | 0.31 | 0.40 | 0.09 | 29.00 |
| c2.hitches_over_100ms | 0 | 2 | 2 | – |
| c2.snapshots_per_tick | 1.00 | 1.00 | 0.00 | 0.00 |
| c2.lead_p95_ms | -5.70 | -7.30 | -1.60 | -28.10 |
| c2.pct_extrapolating | 0.01 | 0.01 | 0.00 | 0.00 |
| c2.backward_steps | 0 | 0 | 0 | – |
| c2.meteor_backward_frames | 0 | 0 | 0 | – |
| c2.kbps_avg | 170.80 | 177.20 | 6.40 | 3.70 |
| c2.city_B_per_moving_body_s | 248.00 | 271.40 | 23.40 | 9.40 |
| c2.latency_p99_ms | 4.71 | 4.15 | -0.56 | -11.90 |
| c2.structure_repairs | 0 | 0 | 0 | – |
| c2.body_render_err_p99_m | 0.04 | 0.04 | 0.00 | 8.10 |
| c2.stale_body_draws | 6 | 0 | -6 | -100.00 |
| c2.hitches_cpu_bound_33ms | 5 | 2 | -3 | -60.00 |
| c2.meteor_hold_jump_max_m | 0 | 0 | 0 | – |

Measured: everything above is read from the tapes, the server capture, /match-stats samples and the server log. PhysX step/GPU wait are 1 Hz samples of the last step, not every tick. Render error at render time depends on the client's recorded clock offset; 'now' error includes the intended interpolation delay.
