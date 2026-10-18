# City bench: 20260924-081934-fanout-quick

Run `20260924-081934-fanout-quick` — scenario **quick** (4 buildings, 3 client(s), intensity 1, seed 1); status **ok**; tape 122 s.
Build: vibe-land `1a35ecf8-dirty` (server fingerprint `1a35ecf8-dirty`), PhysX SDK `25b694ee1a15108d7805bfe34873a151b96598fe`, cuda-metal `26251a2` (libcumetal 2026-09-24T03:10:54), Apple M3 Max.

## Verdict: FAIL (22 of 27 budgets)

| status | id | observed | limit | where |
|---|---|---|---|---|
| fail | server.tick_p95 | 27.51 | < 16.7 |  |
| fail | server.tick_p99 | 52.51 | < 33.3 |  |
| fail | server.over_budget_pct | 13.96 | <= 5 |  |
| fail | server.sim_rate | 0.91 | >= 0.98 |  |
| fail | server.sim_rate_5s_min | 0.56 | >= 0.9 |  |
| pass | client.frame_p95 | 1.12 | < 2.0 | c0 |
| pass | client.over_2x_pct | 0.37 | <= 5 | c0 |
| fail | client.hitches_100ms | 14 | <= 0 | c1 |
| fail | client.cpu_hitch_33ms | 16 | <= 0 | c1 |
| fail | net.backward_steps | 283 | <= 0 | c1 |
| fail | net.lead_p95 | 119.90 | < 50 | c1 |
| fail | net.extrapolating_pct | 75.36 | < 10 | c1 |
| pass | net.snapshot_per_tick | 1.00 | >= 0.98 | c0 |
| fail | net.snapshot_gap_p99 | 58.20 | < 50 | c2 |
| pass | net.lost | 0 | <= 0 | c0 |
| pass | net.server_drops | 0 | <= 0 | c0 |
| fail | net.latency_p99 | 177.66 | < 20 | c1 |
| fail | net.repairs_without_loss | 6 | <= 0 | c0 |
| fail | net.meteor_arc_jump | 24.50 | < 1.0 | c1 |
| fail | net.meteor_hold_jump | 33.90 | < 2.0 | c0 |
| fail | net.meteor_backward | 449 | <= 0 | c0 |
| fail | net.meteor_below_ground | 152 | <= 0 | c2 |
| fail | net.body_render_error_p99 | 6.20 | < 0.5 | c1 |
| fail | net.self_error_p99 | 0.89 | < 0.5 | c1 |
| fail | net.match_stats_share | 34.40 | < 2 | c1 |
| fail | net.energy_rate | 54.50 | <= 10 | c0 |
| fail | physics.below_ground | 12 | <= 0 |  |

## Server real-time

- Tick p50/p95/p99/max: 11.44 / 27.51 / 52.51 / 621.76 ms; 13.96% over 16.7 ms, 3.70% over 33 ms, 10 over 100 ms (6648 ticks).
- Sim rate: 0.908 (worst 5 s window 0.563).
- Tick breakdown (mean ms, share): dynamics 12.24 (97.5%), city 0.19 (1.5%), snapshot 0.02 (0.2%), player_sim 0.08 (0.6%), unattributed 0.02 (0.2%)
- PhysX last step / GPU wait (1 Hz samples) p50/p95/max: 11.09/34.45/113.46 ms, 11.83/27.55/39.00 ms.
- City encoder: step p95 0.261 ms, encode p95 0.151 ms, 32134.3 B per awake body-tick, outbound drops 0.
- Destruction reached: 3645 of 10373 bonds broken (35.1%), 977 chunk bodies, peak 652 active bodies; r(tick, active bodies) = 0.30; bodies below -3 m: 12; 'left the world' log lines: 5.

Tick cost against destruction level:

| by | bucket | ticks | tick_p50 | tick_p95 | tick_max | pct_over_16_7ms |
|---|---|---|---|---|---|---|
| active_bodies | 0-99 | 3674 | 8.22 | 20.84 | 621.76 | 9.10 |
| active_bodies | 100-499 | 2827 | 12.90 | 30.00 | 129.91 | 18.40 |
| active_bodies | 500-999 | 147 | 16.21 | 86.11 | 203.01 | 49.70 |
| broken_bonds | 0-25% | 3638 | 12.51 | 27.39 | 621.76 | 18.70 |
| broken_bonds | 25-50% | 3010 | 9.72 | 27.62 | 203.01 | 8.30 |

## Clients at a glance

| client | role | fps | frame_p95 | pct_over_2x | snaps_per_tick | lead_p95 | pct_extrap | back_steps | kbps | lat_p99 | lost | repairs | body_err_p99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | player | 118.40 | 9.30 | 0.37 | 1.00 | 116.70 | 75.21 | 270 | 372.80 | 4.67 | 0 | 6 | 0.74 |
| 1 | spectator | 116.20 | 9.20 | 0.30 | 1.00 | 119.90 | 75.36 | 283 | 339.10 | 177.66 | 0 | 4 | 6.20 |
| 2 | spectator | 117.10 | 9.30 | 0.34 | 1.00 | 115.80 | 74.47 | 269 | 347.50 | 61.57 | 0 | 6 | 1.60 |

## Client 0 (player)

- Frames: 118.4 fps; frame p50/p95/p99 8.30/9.30/12.40 ms against a 8.33 ms display period (1.12x); 0.37% over 2x; CPU p50/p95 1.60/2.50 ms; hitches >100 ms: 1, CPU-bound >33 ms: 5; r(fps, server ticks/s) = 0.61.
- Snapshots: 54.5 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.80/54.70/633.00 ms; 11 gaps over 100 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 4.6/116.7/165.3 ms; 75.21% of frames extrapolating; render clock stepped back 270 times (-5440 ms); dyn delay p50 5.00 ms.
- Meteors: 5 drawn, 5 moved backwards (449 frames, max 33.9 m); arc→body jump p50/max 0.8/1.5 m; hold→body max 33.9 m; drawn below ground 145 frames.
- Transport: 18255/18255 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.32/4.67/56.24 ms.
- Bandwidth: 373 kbps average, 2291 kbps peak second; match stats 31.29% of bytes; energy 54.5 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| city-chunks | 2743.80 | 3821 | 22.49 | 31.30 | 48.30 | 256.10 |
| match-stats | 1778.80 | 111 | 14.58 | 0.90 | 31.30 | 16.20 |
| snapshot | 717.90 | 6648 | 5.88 | 54.50 | 12.60 | 9.00 |
| city-baseline | 249.80 | 111 | 2.05 | 0.90 | 4.40 | 11.00 |
| city-topology | 101.40 | 794 | 0.83 | 6.50 | 1.80 | 15.00 |
| city-structure-repair | 46.50 | 6 | 0.38 | 0.00 | 0.80 | 12.80 |
| energy | 33.20 | 6649 | 0.27 | 54.50 | 0.60 | 0.30 |
| city-topo-hash | 10.90 | 55 | 0.09 | 0.50 | 0.20 | 0.20 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.00 | 1.40 |
| roster | 1.00 | 56 | 0.01 | 0.50 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |

- Sync: 6 structure repairs (46.5 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 6; city sends at the 10 kB ceiling 29/2263; client counters {"bootstraps": 2, "structureRepairs": 6, "hashChecks": 62, "resyncRequestsSent": 7, "presentedJumpsOver4m": 207, "drawnTeleports": 74, "correctionSnaps": 68, "implausibleJumps": 4, "settleRejects": 10}.
- Efficiency: 261.6 city bytes per moving body-second, 30.89 B/record, repeat records 0.00% (0.0 kB), snapshot 108 B mean, unchanged snapshot bodies 0.05%; server city selection {"candidates": 438696, "sent": 88825, "sent_pct": 20.25, "not_newsworthy": 103817, "rest_stride": 214688, "rest_unchanged": 25584, "ceiling": 378, "eval_cap": 0, "budget_used_pct": 9.74}.
- Rendered vs server truth (1187 samples; matched {"vehicles": 1187, "players": 2253, "bodies": 599}): vehicles_at_render_time_m p50/p99/max 0.001/0.008/0.023, local_now_m p50/p99/max 0.004/0.437/0.990, remote_players_at_render_time_m p50/p99/max 0.003/0.627/4.892, bodies_at_render_time_m p50/p99/max 0.009/0.736/4.411, bodies_now_m p50/p99/max 0.090/4.127/10.549, stale_body_draw_m p50/p99/max 86.947/244.859/267.510

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | cpu_bound | server_tick_max_ms_near |
|---|---|---|---|---|---|
| 71.00 | building-7:demolish | 104.60 | 103.50 | True | 86.50 |
| 71.68 | building-1:walk | 69.90 | 52.00 | True | 86.10 |
| 90.24 | building-1:demolish | 37.80 | 28.30 | True | 63.30 |
| 90.03 | building-1:demolish | 36.00 | 27.30 | True | 63.30 |
| 5.05 | building-6:walk | 35.10 | 32.80 | True | 4.30 |

## Client 1 (spectator)

- Frames: 116.2 fps; frame p50/p95/p99 8.30/9.20/10.80 ms against a 8.33 ms display period (1.10x); 0.30% over 2x; CPU p50/p95 1.50/2.40 ms; hitches >100 ms: 14, CPU-bound >33 ms: 16; r(fps, server ticks/s) = 0.06.
- Snapshots: 54.5 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.80/57.50/607.00 ms; 20 gaps over 100 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 4.6/119.9/169.1 ms; 75.36% of frames extrapolating; render clock stepped back 283 times (-5910 ms); dyn delay p50 5.00 ms.
- Meteors: 5 drawn, 4 moved backwards (357 frames, max 33.5 m); arc→body jump p50/max 1.3/24.5 m; hold→body max 1.1 m; drawn below ground 88 frames.
- Transport: 18013/18013 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.21/177.66/589.66 ms.
- Bandwidth: 339 kbps average, 2266 kbps peak second; match stats 34.40% of bytes; energy 54.5 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| city-chunks | 2395.60 | 3581 | 19.64 | 29.40 | 46.30 | 253.90 |
| match-stats | 1778.80 | 111 | 14.58 | 0.90 | 34.40 | 16.20 |
| snapshot | 567.40 | 6648 | 4.65 | 54.50 | 11.00 | 7.20 |
| city-baseline | 249.80 | 111 | 2.05 | 0.90 | 4.80 | 11.00 |
| city-topology | 101.40 | 794 | 0.83 | 6.50 | 2.00 | 15.00 |
| energy | 33.20 | 6649 | 0.27 | 54.50 | 0.60 | 0.40 |
| city-structure-repair | 30.20 | 4 | 0.25 | 0.00 | 0.60 | 12.80 |
| city-topo-hash | 10.90 | 55 | 0.09 | 0.50 | 0.20 | 0.20 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.00 | 1.40 |
| roster | 1.00 | 56 | 0.01 | 0.50 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |

- Sync: 4 structure repairs (30.2 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 4; city sends at the 10 kB ceiling 22/2266; client counters {"bootstraps": 2, "structureRepairs": 4, "hashChecks": 61, "resyncRequestsSent": 5, "presentedJumpsOver4m": 224, "drawnTeleports": 78, "correctionSnaps": 64, "implausibleJumps": 6, "settleRejects": 6}.
- Efficiency: 231.8 city bytes per moving body-second, 30.96 B/record, repeat records 0.00% (0.0 kB), snapshot 85 B mean, unchanged snapshot bodies 0.11%; server city selection {"candidates": 438696, "sent": 77382, "sent_pct": 17.64, "not_newsworthy": 118537, "rest_stride": 214688, "rest_unchanged": 23772, "ceiling": 158, "eval_cap": 0, "budget_used_pct": 8.49}.
- Rendered vs server truth (476 samples; matched {"players": 453, "vehicles": 451, "bodies": 129}): local_now_m p50/p99/max 0.029/0.885/2.507, remote_players_at_render_time_m p50/p99/max 0.005/1.041/5.632, vehicles_at_render_time_m p50/p99/max 0.001/0.017/0.051, bodies_at_render_time_m p50/p99/max 0.008/6.203/9.775, bodies_now_m p50/p99/max 0.068/6.235/9.660, stale_body_draw_m p50/p99/max 41.247/205.091/215.056

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | cpu_bound | server_tick_max_ms_near |
|---|---|---|---|---|---|
| 7.31 | building-6:walk | 535.90 | 534.20 | True | 5.80 |
| 14.80 | building-6:cannon | 374.80 | 369.50 | True | 22.70 |
| 30.78 | building-0:walk | 370.20 | 365.80 | True | 13.00 |
| 6.60 | building-6:walk | 298.10 | 219.00 | True | 5.10 |
| 47.68 | building-0:demolish | 295.70 | 2.20 | False | 20.90 |
| 5.24 | building-6:walk | 225.00 | 222.70 | True | 4.50 |
| 14.28 | building-6:cannon | 164.20 | 148.40 | True | 23.60 |
| 23.85 | building-6:demolish | 158.10 | 157.10 | True | 37.60 |

## Client 2 (spectator)

- Frames: 117.1 fps; frame p50/p95/p99 8.30/9.30/10.90 ms against a 8.33 ms display period (1.12x); 0.34% over 2x; CPU p50/p95 1.60/2.30 ms; hitches >100 ms: 10, CPU-bound >33 ms: 14; r(fps, server ticks/s) = 0.29.
- Snapshots: 54.5 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.80/58.20/632.80 ms; 18 gaps over 100 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 4.5/115.8/165.4 ms; 74.47% of frames extrapolating; render clock stepped back 269 times (-5959 ms); dyn delay p50 5.00 ms.
- Meteors: 5 drawn, 5 moved backwards (440 frames, max 33.7 m); arc→body jump p50/max 3.7/22.0 m; hold→body max 0 m; drawn below ground 152 frames.
- Transport: 18066/18066 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.30/61.57/520.13 ms.
- Bandwidth: 348 kbps average, 2269 kbps peak second; match stats 33.57% of bytes; energy 54.5 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| city-chunks | 2501.20 | 3632 | 20.50 | 29.80 | 47.20 | 254.20 |
| match-stats | 1778.80 | 111 | 14.58 | 0.90 | 33.60 | 16.20 |
| snapshot | 591.90 | 6648 | 4.85 | 54.50 | 11.20 | 7.90 |
| city-baseline | 249.80 | 111 | 2.05 | 0.90 | 4.70 | 11.00 |
| city-topology | 101.40 | 794 | 0.83 | 6.50 | 1.90 | 15.00 |
| energy | 33.20 | 6649 | 0.27 | 54.50 | 0.60 | 0.30 |
| city-structure-repair | 28.70 | 6 | 0.24 | 0.00 | 0.50 | 7.80 |
| city-topo-hash | 10.90 | 55 | 0.09 | 0.50 | 0.20 | 0.20 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.00 | 1.40 |
| roster | 1.00 | 56 | 0.01 | 0.50 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |

- Sync: 6 structure repairs (28.7 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 6; city sends at the 10 kB ceiling 25/2264; client counters {"bootstraps": 2, "structureRepairs": 6, "hashChecks": 59, "resyncRequestsSent": 7, "presentedJumpsOver4m": 160, "drawnTeleports": 82, "correctionSnaps": 64, "settleRejects": 6}.
- Efficiency: 242.6 city bytes per moving body-second, 30.93 B/record, repeat records 0.00% (0.0 kB), snapshot 89 B mean, unchanged snapshot bodies 0.05%; server city selection {"candidates": 438696, "sent": 80867, "sent_pct": 18.43, "not_newsworthy": 108227, "rest_stride": 214688, "rest_unchanged": 24381, "ceiling": 318, "eval_cap": 0, "budget_used_pct": 8.87}.
- Rendered vs server truth (480 samples; matched {"vehicles": 445, "players": 457, "bodies": 251}): local_now_m p50/p99/max 0.003/0.303/0.816, vehicles_at_render_time_m p50/p99/max 0.002/12.601/19.932, remote_players_at_render_time_m p50/p99/max 0.004/38.327/44.787, bodies_at_render_time_m p50/p99/max 0.010/1.605/14.198, bodies_now_m p50/p99/max 0.082/3.483/10.098, stale_body_draw_m p50/p99/max 94.886/241.576/259.794

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | cpu_bound | server_tick_max_ms_near |
|---|---|---|---|---|---|
| 13.85 | building-6:cannon | 394.20 | 389.90 | True | 25.40 |
| 5.85 | building-6:walk | 346.50 | 343.40 | True | 4.90 |
| 21.16 | building-6:meteorAt | 156.60 | 156.00 | True | 29.80 |
| 13.46 | building-6:cannon | 150.50 | 145.70 | True | 30.40 |
| 6.49 | building-6:walk | 138.00 | 135.70 | True | 4.70 |
| 20.16 | building-6:meteorAt | 134.60 | 133.50 | True | 36.30 |
| 13.31 | building-6:cannon | 133.10 | 132.00 | True | 621.80 |
| 21.30 | building-6:meteorAt | 126.50 | 1.90 | False | 38.70 |

## By phase

| window | dur_s | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| intro | 5.00 | 4.80 | 0.00 | 1.00 | 0 | 0 | 9.20 | 0.00 | 60.00 | 10.90 | 84.00 | 0 | 0.10 |
| destroy | 88.00 | 33.94 | 20.10 | 0.87 | 84 | 3645 | 9.40 | 0.50 | 52.40 | 129.70 | 77.50 | 270 | 34.80 |
| settle | 6.00 | 12.45 | 0.00 | 1.00 | 9 | 3645 | 9.20 | 0.00 | 60.00 | 9.60 | 69.90 | 0 | 4.50 |
| drive | 15.00 | 13.27 | 0.30 | 1.00 | 83 | 3645 | 9.20 | 0.20 | 60.00 | 10.50 | 72.40 | 0 | 4.10 |
| idle-end | 5.00 | 8.64 | 0.00 | 1.00 | 6 | 3645 | 9.20 | 0.00 | 60.00 | 5.20 | 54.70 | 0 | 0.40 |

Per building:

| window | dur_s | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| building-6 | 22.00 | 33.00 | 33.10 | 0.83 | 272 | 1362 | 9.20 | 0.20 | 50.10 | 138.40 | 89.30 | 91 | 26.00 |
| building-0 | 22.00 | 20.86 | 11.30 | 0.94 | 187 | 1470 | 9.40 | 0.20 | 56.30 | 74.60 | 69.10 | 28 | 35.80 |
| building-7 | 22.00 | 41.19 | 22.40 | 0.83 | 652 | 3151 | 10.30 | 0.50 | 50.00 | 138.10 | 73.80 | 82 | 41.70 |
| building-1 | 22.00 | 33.96 | 14.90 | 0.89 | 84 | 3645 | 9.50 | 1.10 | 53.20 | 128.20 | 77.70 | 69 | 35.70 |

## Per 5 s

| window | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-5s | 4.80 | 0.00 | 1.00 | 0 | 0 | 9.20 | 0.00 | 60.00 | 10.90 | 84.00 | 0 | 0.40 |
| 5-10s | 5.20 | 0.00 | 1.00 | 0 | 0 | 9.30 | 0.50 | 60.00 | 9.70 | 80.00 | 1 | 0.10 |
| 10-15s | 15.88 | 3.90 | 0.85 | 19 | 177 | 9.20 | 0.00 | 50.80 | 392.50 | 79.70 | 3 | 2.10 |
| 15-20s | 27.09 | 55.60 | 0.86 | 58 | 382 | 9.20 | 0.00 | 51.80 | 65.70 | 94.90 | 4 | 16.90 |
| 20-25s | 49.95 | 78.40 | 0.62 | 111 | 472 | 9.40 | 0.20 | 37.00 | 150.30 | 99.50 | 83 | 39.00 |
| 25-30s | 36.76 | 40.10 | 0.86 | 256 | 1410 | 9.60 | 0.30 | 51.40 | 74.10 | 91.70 | 3 | 103.20 |
| 30-35s | 13.66 | 1.30 | 1.00 | 232 | 1424 | 9.20 | 0.00 | 59.80 | 11.90 | 55.70 | 0 | 31.00 |
| 35-40s | 16.71 | 5.00 | 1.00 | 159 | 1425 | 9.20 | 0.00 | 59.80 | 12.10 | 65.80 | 0 | 31.00 |
| 40-45s | 19.05 | 12.80 | 0.99 | 157 | 1425 | 9.20 | 0.00 | 59.40 | 15.10 | 64.00 | 0 | 14.80 |
| 45-50s | 41.93 | 21.00 | 0.83 | 263 | 1470 | 11.30 | 0.50 | 49.60 | 146.40 | 80.10 | 25 | 40.20 |
| 50-55s | 18.67 | 10.10 | 0.99 | 170 | 1470 | 9.20 | 0.00 | 59.60 | 13.20 | 64.70 | 0 | 11.20 |
| 55-60s | 18.60 | 7.70 | 1.00 | 15 | 1519 | 9.10 | 0.00 | 59.80 | 12.90 | 60.00 | 0 | 3.50 |
| 60-65s | 37.37 | 23.00 | 0.85 | 87 | 1519 | 9.50 | 1.70 | 51.20 | 134.30 | 71.40 | 17 | 7.90 |
| 65-70s | 71.51 | 63.90 | 0.56 | 652 | 3151 | 10.80 | 0.00 | 33.80 | 165.70 | 97.80 | 57 | 142.60 |
| 70-75s | 59.31 | 16.40 | 0.73 | 480 | 3159 | 16.70 | 5.10 | 43.80 | 139.60 | 76.10 | 17 | 64.80 |
| 75-80s | 28.54 | 18.00 | 0.93 | 200 | 3353 | 9.30 | 0.00 | 55.60 | 66.50 | 77.70 | 4 | 20.10 |
| 80-85s | 21.85 | 10.40 | 0.93 | 230 | 3575 | 9.30 | 0.30 | 56.00 | 57.60 | 83.90 | 4 | 39.90 |
| 85-90s | 42.91 | 23.40 | 0.80 | 266 | 3645 | 9.60 | 0.20 | 47.80 | 150.50 | 79.30 | 47 | 22.00 |
| 90-95s | 17.63 | 7.90 | 0.97 | 69 | 3645 | 9.20 | 0.30 | 58.20 | 27.20 | 72.60 | 5 | 24.80 |
| 95-100s | 11.98 | 0.00 | 1.00 | 8 | 3645 | 9.20 | 0.00 | 60.20 | 9.60 | 68.30 | 0 | 2.50 |
| 100-105s | 12.94 | 0.00 | 1.00 | 7 | 3645 | 9.20 | 0.20 | 60.00 | 10.70 | 70.60 | 0 | 5.30 |
| 105-110s | 10.40 | 0.00 | 1.00 | 85 | 3645 | 9.20 | 0.20 | 59.80 | 10.70 | 74.20 | 0 | 4.10 |
| 110-115s | 14.46 | 1.00 | 1.00 | 6 | 3645 | 9.20 | 0.20 | 60.20 | 10.20 | 70.60 | 0 | 3.30 |
| 115-120s | 8.44 | 0.00 | 1.00 | 6 | 3645 | 9.20 | 0.00 | 59.80 | 5.00 | 53.40 | 0 | 0.10 |
| 120-122s | 8.34 | 0.00 | 1.00 | 6 | 3645 | 9.20 | 0.00 | 60.40 | 5.00 | 51.70 | 0 | 0.10 |

Measured: everything above is read from the tapes, the server capture, /match-stats samples and the server log. PhysX step/GPU wait are 1 Hz samples of the last step, not every tick. Render error at render time depends on the client's recorded clock offset; 'now' error includes the intended interpolation delay.
