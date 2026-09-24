# City bench: 20260924-084654-netcode-clock-quick-3c-r2

Run `20260924-084654-netcode-clock-quick-3c-r2` — scenario **quick** (4 buildings, 3 client(s), intensity 1, seed 1); status **ok**; tape 122 s.
Build: vibe-land `e3fdf5cc-dirty` (server fingerprint `e3fdf5cc-dirty`), PhysX SDK `25b694ee1a15108d7805bfe34873a151b96598fe`, cuda-metal `26251a2` (libcumetal 2026-09-24T03:10:54), Apple M3 Max.

## Verdict: FAIL (13 of 27 budgets)

| status | id | observed | limit | where |
|---|---|---|---|---|
| fail | server.tick_p95 | 18.13 | < 16.7 |  |
| fail | server.tick_p99 | 44.83 | < 33.3 |  |
| fail | server.over_budget_pct | 6.31 | <= 5 |  |
| fail | server.sim_rate | 0.95 | >= 0.98 |  |
| fail | server.sim_rate_5s_min | 0.72 | >= 0.9 |  |
| pass | client.frame_p95 | 1.12 | < 2.0 | c0 |
| pass | client.over_2x_pct | 0.60 | <= 5 | c0 |
| pass | client.hitches_100ms | 0 | <= 0 | c0 |
| fail | client.cpu_hitch_33ms | 6 | <= 0 | c2 |
| pass | net.backward_steps | 0 | <= 0 | c0 |
| pass | net.lead_p95 | -5.20 | < 50 | c1 |
| pass | net.extrapolating_pct | 0.01 | < 10 | c1 |
| pass | net.snapshot_per_tick | 1.00 | >= 0.98 | c0 |
| pass | net.snapshot_gap_p99 | 47.20 | < 50 | c0 |
| pass | net.lost | 0 | <= 0 | c0 |
| pass | net.server_drops | 0 | <= 0 | c0 |
| pass | net.latency_p99 | 4.15 | < 20 | c2 |
| fail | net.repairs_without_loss | 4 | <= 0 | c2 |
| fail | net.meteor_arc_jump | 1.40 | < 1.0 | c2 |
| pass | net.meteor_hold_jump | 0 | < 2.0 | c0 |
| pass | net.meteor_backward | 0 | <= 0 | c0 |
| pass | net.meteor_below_ground | 0 | <= 0 | c0 |
| fail | net.body_render_error_p99 | 0.67 | < 0.5 | c1 |
| fail | net.self_error_p99 | 0.52 | < 0.5 | c0 |
| fail | net.match_stats_share | 41.91 | < 2 | c1 |
| fail | net.energy_rate | 56.80 | <= 10 | c0 |
| fail | physics.below_ground | 10 | <= 0 |  |

## Server real-time

- Tick p50/p95/p99/max: 10.23 / 18.13 / 44.83 / 572.03 ms; 6.31% over 16.7 ms, 2.34% over 33 ms, 3 over 100 ms (6927 ticks).
- Sim rate: 0.946 (worst 5 s window 0.720).
- Tick breakdown (mean ms, share): dynamics 10.90 (97.5%), city 0.16 (1.4%), snapshot 0.02 (0.2%), player_sim 0.07 (0.7%), unattributed 0.02 (0.2%)
- PhysX last step / GPU wait (1 Hz samples) p50/p95/max: 9.81/23.44/67.42 ms, 10.85/17.88/23.40 ms.
- City encoder: step p95 0.197 ms, encode p95 0.116 ms, 23568.1 B per awake body-tick, outbound drops 0.
- Destruction reached: 2158 of 10373 bonds broken (20.8%), 588 chunk bodies, peak 289 active bodies; r(tick, active bodies) = 0.29; bodies below -3 m: 10; 'left the world' log lines: 3.

Tick cost against destruction level:

| by | bucket | ticks | tick_p50 | tick_p95 | tick_max | pct_over_16_7ms |
|---|---|---|---|---|---|---|
| active_bodies | 0-99 | 2973 | 8.08 | 15.65 | 572.03 | 3.10 |
| active_bodies | 100-499 | 3954 | 11.60 | 27.43 | 128.67 | 8.70 |
| broken_bonds | 0-25% | 6927 | 10.23 | 18.13 | 572.03 | 6.30 |

## Clients at a glance

| client | role | fps | frame_p95 | pct_over_2x | snaps_per_tick | lead_p95 | pct_extrap | back_steps | kbps | lat_p99 | lost | repairs | body_err_p99 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | player | 118.50 | 9.30 | 0.60 | 1.00 | -5.30 | 0.00 | 0 | 319.90 | 3.96 | 0 | 1 | 0.26 |
| 1 | spectator | 119.20 | 9.30 | 0.24 | 1.00 | -5.20 | 0.01 | 0 | 289.10 | 3.49 | 0 | 0 | 0.67 |
| 2 | spectator | 118.60 | 9.30 | 0.39 | 1.00 | -5.20 | 0.01 | 0 | 300.60 | 4.15 | 0 | 4 | 0.40 |

## Client 0 (player)

- Frames: 118.5 fps; frame p50/p95/p99 8.30/9.30/12.70 ms against a 8.33 ms display period (1.12x); 0.60% over 2x; CPU p50/p95 1.40/2.10 ms; hitches >100 ms: 0, CPU-bound >33 ms: 3; r(fps, server ticks/s) = 0.61.
- Snapshots: 56.8 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.70/47.20/585.80 ms; 3 gaps over 100 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 -16.6/-5.3/-3.2 ms; 0.00% of frames extrapolating; render clock stepped back 0 times (0 ms); dyn delay p50 20.88 ms.
- Meteors: 5 drawn, 0 moved backwards (0 frames, max 0 m); arc→body jump p50/max 0.5/1.1 m; hold→body max 0 m; drawn below ground 0 frames.
- Transport: 18348/18348 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.27/3.96/67.58 ms.
- Bandwidth: 320 kbps average, 1510 kbps peak second; match stats 37.88% of bytes; energy 56.8 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| city-chunks | 1873.50 | 3518 | 15.36 | 28.80 | 38.40 | 160.20 |
| match-stats | 1847.80 | 115 | 15.15 | 0.90 | 37.90 | 16.20 |
| snapshot | 780.80 | 6931 | 6.40 | 56.80 | 16.00 | 9.50 |
| city-baseline | 262.40 | 115 | 2.15 | 0.90 | 5.40 | 4.80 |
| city-topology | 62.00 | 615 | 0.51 | 5.00 | 1.30 | 8.10 |
| energy | 34.70 | 6932 | 0.28 | 56.80 | 0.70 | 0.30 |
| city-topo-hash | 11.50 | 58 | 0.09 | 0.50 | 0.20 | 0.20 |
| city-structure-repair | 2.00 | 1 | 0.02 | 0.00 | 0.00 | 2.00 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.00 | 1.40 |
| roster | 1.00 | 59 | 0.01 | 0.50 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |

- Sync: 1 structure repairs (2.0 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 1; city sends at the 10 kB ceiling 0/2681; client counters {"bootstraps": 2, "structureRepairs": 1, "hashChecks": 61, "resyncRequestsSent": 2, "presentedJumpsOver4m": 18, "drawnTeleports": 24, "correctionSnaps": 10, "settleRejects": 1}.
- Efficiency: 299.2 city bytes per moving body-second, 31.21 B/record, repeat records 0.00% (0.0 kB), snapshot 113 B mean, unchanged snapshot bodies 0.00%; server city selection {"candidates": 457624, "sent": 60035, "sent_pct": 13.12, "not_newsworthy": 78061, "rest_stride": 283872, "rest_unchanged": 34587, "ceiling": 0, "eval_cap": 0, "budget_used_pct": 5.97}.
- Rendered vs server truth (1190 samples; matched {"vehicles": 1190, "players": 2260, "bodies": 591}): vehicles_at_render_time_m p50/p99/max 0.001/0.016/0.031, local_now_m p50/p99/max 0.000/0.517/0.570, remote_players_at_render_time_m p50/p99/max 0.001/0.028/0.307, bodies_at_render_time_m p50/p99/max 0.008/0.255/0.479, bodies_now_m p50/p99/max 0.190/2.951/6.308, stale_body_draw_m p50/p99/max 81.067/244.157/259.007

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | cpu_bound | server_tick_max_ms_near |
|---|---|---|---|---|---|
| 69.80 | building-7:demolish | 77.80 | 57.00 | True | 76.10 |
| 89.81 | building-1:demolish | 38.50 | 29.00 | True | 48.60 |
| 65.21 | building-7:meteorAt | 36.30 | 35.10 | True | 49.50 |

## Client 1 (spectator)

- Frames: 119.2 fps; frame p50/p95/p99 8.30/9.30/11.60 ms against a 8.33 ms display period (1.12x); 0.24% over 2x; CPU p50/p95 1.40/2.00 ms; hitches >100 ms: 0, CPU-bound >33 ms: 1; r(fps, server ticks/s) = 0.70.
- Snapshots: 56.8 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.70/45.60/585.60 ms; 3 gaps over 100 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 -16.1/-5.2/-3.2 ms; 0.01% of frames extrapolating; render clock stepped back 0 times (0 ms); dyn delay p50 20.94 ms.
- Meteors: 5 drawn, 0 moved backwards (0 frames, max 0 m); arc→body jump p50/max 0.5/0.6 m; hold→body max 0 m; drawn below ground 0 frames.
- Transport: 17948/17948 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.28/3.49/45.26 ms.
- Bandwidth: 289 kbps average, 1460 kbps peak second; match stats 41.91% of bytes; energy 56.8 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| match-stats | 1847.80 | 115 | 15.15 | 0.90 | 41.90 | 16.20 |
| city-chunks | 1565.20 | 3119 | 12.83 | 25.60 | 35.50 | 155.50 |
| snapshot | 622.50 | 6931 | 5.10 | 56.80 | 14.10 | 7.30 |
| city-baseline | 262.40 | 115 | 2.15 | 0.90 | 6.00 | 4.80 |
| city-topology | 62.00 | 615 | 0.51 | 5.00 | 1.40 | 8.10 |
| energy | 34.70 | 6932 | 0.28 | 56.80 | 0.80 | 0.30 |
| city-topo-hash | 11.50 | 58 | 0.09 | 0.50 | 0.30 | 0.20 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.00 | 1.40 |
| roster | 1.00 | 59 | 0.01 | 0.50 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |
| welcome | 0.00 | 1 | 0.00 | 0.00 | 0.00 | 0.00 |

- Sync: 0 structure repairs (0.0 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 0; city sends at the 10 kB ceiling 0/2447; client counters {"bootstraps": 2, "hashChecks": 62, "resyncRequestsSent": 1, "presentedJumpsOver4m": 24, "drawnTeleports": 27, "correctionSnaps": 11}.
- Efficiency: 254.3 city bytes per moving body-second, 31.27 B/record, repeat records 0.00% (0.0 kB), snapshot 90 B mean, unchanged snapshot bodies 0.00%; server city selection {"candidates": 457624, "sent": 50056, "sent_pct": 10.94, "not_newsworthy": 92491, "rest_stride": 283872, "rest_unchanged": 30380, "ceiling": 0, "eval_cap": 0, "budget_used_pct": 4.98}.
- Rendered vs server truth (483 samples; matched {"players": 459, "vehicles": 457, "bodies": 141}): local_now_m p50/p99/max 0.000/0.460/3.315, remote_players_at_render_time_m p50/p99/max 0.001/0.801/0.802, vehicles_at_render_time_m p50/p99/max 0.001/0.014/0.022, bodies_at_render_time_m p50/p99/max 0.009/0.673/1.829, bodies_now_m p50/p99/max 0.141/2.375/5.337, stale_body_draw_m p50/p99/max 37.616/216.781/227.424

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | cpu_bound | server_tick_max_ms_near |
|---|---|---|---|---|---|
| 64.85 | building-7:meteorAt | 35.50 | 24.60 | True | 50.50 |

## Client 2 (spectator)

- Frames: 118.6 fps; frame p50/p95/p99 8.30/9.30/12.10 ms against a 8.33 ms display period (1.12x); 0.39% over 2x; CPU p50/p95 1.40/2.10 ms; hitches >100 ms: 0, CPU-bound >33 ms: 6; r(fps, server ticks/s) = 0.73.
- Snapshots: 56.8 Hz, 1.000 per server tick; arrival gaps p50/p99/max 16.70/47.20/585.60 ms; 3 gaps over 100 ms.
- Interpolation: render lead over newest snapshot p50/p95/p99 -16.8/-5.2/-3.1 ms; 0.01% of frames extrapolating; render clock stepped back 0 times (0 ms); dyn delay p50 20.85 ms.
- Meteors: 5 drawn, 0 moved backwards (0 frames, max 0 m); arc→body jump p50/max 0.5/1.4 m; hold→body max 0 m; drawn below ground 0 frames.
- Transport: 18050/18050 taped packets joined to sends; lost 0, server drops 0; send→arrive p50/p99/max 0.27/4.15/58.28 ms.
- Bandwidth: 301 kbps average, 1500 kbps peak second; match stats 40.31% of bytes; energy 56.8 msg/s.

| kind | kB | packets | kB_per_s | packets_per_s | pct_of_bytes | peak_kB_s |
|---|---|---|---|---|---|---|
| match-stats | 1847.80 | 115 | 15.15 | 0.90 | 40.30 | 16.20 |
| city-chunks | 1681.50 | 3217 | 13.78 | 26.40 | 36.70 | 159.50 |
| snapshot | 659.10 | 6931 | 5.40 | 56.80 | 14.40 | 8.40 |
| city-baseline | 262.40 | 115 | 2.15 | 0.90 | 5.70 | 4.80 |
| city-topology | 62.00 | 615 | 0.51 | 5.00 | 1.40 | 8.10 |
| energy | 34.70 | 6932 | 0.28 | 56.80 | 0.80 | 0.30 |
| city-structure-repair | 21.40 | 4 | 0.18 | 0.00 | 0.50 | 7.50 |
| city-topo-hash | 11.50 | 58 | 0.09 | 0.50 | 0.30 | 0.20 |
| city-bootstrap | 1.40 | 1 | 0.01 | 0.00 | 0.00 | 1.40 |
| roster | 1.00 | 59 | 0.01 | 0.50 | 0.00 | 0.00 |
| body-meta | 0.40 | 1 | 0.00 | 0.00 | 0.00 | 0.40 |
| meteor-launched | 0.30 | 5 | 0.00 | 0.00 | 0.00 | 0.10 |

- Sync: 4 structure repairs (21.4 kB), 0 full bootstraps after start, datagram gaps 0, topology gaps 0 → repairs without loss: 4; city sends at the 10 kB ceiling 0/2455; client counters {"bootstraps": 2, "structureRepairs": 4, "hashChecks": 61, "resyncRequestsSent": 5, "presentedJumpsOver4m": 40, "drawnTeleports": 31, "correctionSnaps": 19, "implausibleJumps": 2, "settleRejects": 4}.
- Efficiency: 272.3 city bytes per moving body-second, 31.21 B/record, repeat records 0.00% (0.0 kB), snapshot 95 B mean, unchanged snapshot bodies 0.00%; server city selection {"candidates": 457624, "sent": 53867, "sent_pct": 11.77, "not_newsworthy": 85980, "rest_stride": 283872, "rest_unchanged": 32184, "ceiling": 0, "eval_cap": 0, "budget_used_pct": 5.36}.
- Rendered vs server truth (483 samples; matched {"vehicles": 462, "players": 459, "bodies": 248}): local_now_m p50/p99/max 0.000/0.399/0.786, vehicles_at_render_time_m p50/p99/max 0.002/0.013/0.023, remote_players_at_render_time_m p50/p99/max 0.001/0.801/0.803, bodies_at_render_time_m p50/p99/max 0.010/0.401/0.437, bodies_now_m p50/p99/max 0.193/2.220/5.456, stale_body_draw_m p50/p99/max 82.715/239.643/250.093

Worst hitches:

| t_s | phase | frame_ms | cpu_ms | cpu_bound | server_tick_max_ms_near |
|---|---|---|---|---|---|
| 69.97 | building-7:demolish | 53.10 | 44.70 | True | 68.90 |
| 89.72 | building-1:demolish | 53.00 | 37.20 | True | 48.60 |
| 64.71 | building-7:meteorAt | 45.50 | 30.30 | True | 62.50 |
| 64.49 | building-7:meteorAt | 42.30 | 33.00 | True | 62.50 |
| 69.65 | building-7:demolish | 42.10 | 27.60 | True | 76.10 |
| 46.41 | building-0:demolish | 35.30 | 31.80 | True | 35.00 |

## By phase

| window | dur_s | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| intro | 5.00 | 4.47 | 0.00 | 1.00 | 0 | 0 | 9.30 | 0.00 | 60.00 | -4.40 | 0.00 | 0 | 0.10 |
| destroy | 88.00 | 25.05 | 8.90 | 0.93 | 111 | 2156 | 9.30 | 0.80 | 55.60 | -7.00 | 0.00 | 0 | 24.30 |
| settle | 6.10 | 10.17 | 0.00 | 0.99 | 4 | 2156 | 9.20 | 0.00 | 60.00 | -3.80 | 0.00 | 0 | 2.20 |
| drive | 15.30 | 10.36 | 0.10 | 1.00 | 83 | 2158 | 9.20 | 0.20 | 60.00 | -3.80 | 0.00 | 0 | 2.60 |
| idle-end | 5.00 | 9.51 | 0.00 | 1.00 | 83 | 2158 | 9.20 | 0.00 | 60.00 | -4.70 | 0.00 | 0 | 2.90 |

Per building:

| window | dur_s | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| building-6 | 22.00 | 20.90 | 10.30 | 0.91 | 242 | 1318 | 9.20 | 0.10 | 54.90 | -5.80 | 0.00 | 0 | 31.70 |
| building-0 | 22.00 | 18.60 | 8.60 | 0.95 | 149 | 1454 | 9.20 | 0.00 | 57.30 | -7.90 | 0.00 | 0 | 26.00 |
| building-7 | 22.00 | 38.69 | 11.60 | 0.88 | 270 | 1646 | 13.10 | 3.10 | 52.70 | -7.60 | 0.00 | 0 | 12.50 |
| building-1 | 22.00 | 19.24 | 5.50 | 0.96 | 111 | 2156 | 9.30 | 0.10 | 57.40 | -7.40 | 0.00 | 0 | 26.90 |

## Per 5 s

| window | server_tick_p95 | server_pct_over_16_7 | sim_rate | active_bodies | broken_bonds | c0_frame_p95 | c0_pct_frames_over_2x | c0_snapshots_per_s | c0_lead_p95 | c0_pct_extrapolating | c0_backward_steps | c0_city_kB_s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0-5s | 4.47 | 0.00 | 1.00 | 0 | 0 | 9.30 | 0.00 | 60.00 | -4.40 | 0.00 | 0 | 0.40 |
| 5-10s | 5.17 | 0.00 | 1.00 | 0 | 0 | 9.20 | 0.50 | 60.00 | -4.50 | 0.00 | 0 | 0.10 |
| 10-15s | 18.47 | 6.80 | 0.84 | 45 | 293 | 9.10 | 0.00 | 50.20 | -3.50 | 0.00 | 0 | 6.30 |
| 15-20s | 20.01 | 14.40 | 0.97 | 68 | 430 | 9.20 | 0.00 | 58.20 | -11.20 | 0.00 | 0 | 37.30 |
| 20-25s | 50.33 | 23.40 | 0.83 | 249 | 1315 | 9.20 | 0.00 | 49.40 | -11.00 | 0.00 | 0 | 52.60 |
| 25-30s | 16.90 | 6.10 | 0.98 | 222 | 1439 | 9.20 | 0.00 | 59.00 | -10.30 | 0.00 | 0 | 84.00 |
| 30-35s | 17.63 | 8.70 | 1.00 | 192 | 1442 | 9.30 | 0.00 | 59.80 | -7.10 | 0.00 | 0 | 15.30 |
| 35-40s | 17.20 | 7.40 | 0.99 | 206 | 1445 | 9.20 | 0.00 | 59.60 | -9.90 | 0.00 | 0 | 24.50 |
| 40-45s | 15.89 | 2.00 | 1.00 | 146 | 1445 | 9.20 | 0.00 | 60.00 | -5.80 | 0.00 | 0 | 18.90 |
| 45-50s | 38.75 | 17.50 | 0.82 | 196 | 1454 | 9.20 | 0.00 | 49.20 | -7.60 | 0.00 | 0 | 17.40 |
| 50-55s | 16.24 | 4.90 | 0.96 | 146 | 1454 | 9.30 | 0.30 | 57.40 | -8.30 | 0.00 | 0 | 5.00 |
| 55-60s | 13.88 | 1.00 | 0.99 | 162 | 1544 | 9.20 | 0.00 | 59.40 | -5.00 | 0.00 | 0 | 7.10 |
| 60-65s | 49.87 | 12.00 | 0.83 | 208 | 1544 | 17.30 | 6.70 | 49.80 | -7.60 | 0.00 | 0 | 7.00 |
| 65-70s | 49.52 | 34.30 | 0.72 | 254 | 1646 | 17.20 | 6.20 | 43.20 | -7.80 | 0.00 | 0 | 26.50 |
| 70-75s | 16.42 | 4.80 | 0.97 | 236 | 1646 | 9.30 | 1.20 | 58.20 | -7.90 | 0.00 | 0 | 19.80 |
| 75-80s | 12.52 | 1.00 | 0.99 | 180 | 1820 | 9.20 | 0.00 | 59.60 | -5.70 | 0.00 | 0 | 9.30 |
| 80-85s | 16.09 | 3.70 | 0.98 | 266 | 2135 | 9.20 | 0.20 | 58.80 | -5.80 | 0.00 | 0 | 53.20 |
| 85-90s | 36.89 | 20.80 | 0.83 | 283 | 2156 | 10.50 | 0.30 | 50.00 | -9.50 | 0.00 | 0 | 26.80 |
| 90-95s | 15.01 | 1.00 | 1.00 | 96 | 2156 | 9.20 | 0.00 | 60.40 | -5.90 | 0.00 | 0 | 18.30 |
| 95-100s | 9.76 | 0.00 | 0.99 | 4 | 2156 | 9.20 | 0.00 | 60.00 | -3.50 | 0.00 | 0 | 0.30 |
| 100-105s | 10.56 | 0.30 | 1.00 | 4 | 2158 | 9.20 | 0.30 | 60.00 | -3.20 | 0.00 | 0 | 3.20 |
| 105-110s | 9.67 | 0.00 | 1.00 | 83 | 2158 | 9.20 | 0.00 | 60.00 | -3.90 | 0.00 | 0 | 1.80 |
| 110-115s | 10.63 | 0.00 | 1.00 | 83 | 2158 | 9.20 | 0.20 | 60.00 | -4.40 | 0.00 | 0 | 3.40 |
| 115-120s | 9.04 | 0.00 | 1.00 | 83 | 2158 | 9.20 | 0.00 | 60.00 | -4.70 | 0.00 | 0 | 2.90 |
| 120-122s | 8.86 | 0.00 | 1.00 | 83 | 2158 | 9.10 | 0.00 | 59.80 | -2.90 | 0.00 | 0 | 2.80 |

## Against baseline `/Users/glavin/Development/vibe-land/target/city-bench/runs/20260924-081934-fanout-quick/report.json`

| metric | baseline | current | delta | delta_pct |
|---|---|---|---|---|
| server.tick_p50_ms | 11.44 | 10.23 | -1.21 | -10.60 |
| server.tick_p95_ms | 27.51 | 18.13 | -9.38 | -34.10 |
| server.tick_p99_ms | 52.51 | 44.83 | -7.68 | -14.60 |
| server.tick_max_ms | 621.76 | 572.03 | -49.73 | -8.00 |
| server.pct_over_16_7ms | 13.96 | 6.31 | -7.65 | -54.80 |
| server.sim_rate | 0.91 | 0.95 | 0.04 | 4.20 |
| server.sim_rate_5s_min | 0.56 | 0.72 | 0.16 | 27.90 |
| server.dynamics_ms_mean | 12.24 | 10.90 | -1.34 | -11.00 |
| server.gpu_wait_p95_ms | 27.55 | 17.88 | -9.67 | -35.10 |
| server.broken_bond_pct | 35.10 | 20.80 | -14.30 | -40.70 |
| server.peak_active_bodies | 652 | 289 | -363 | -55.70 |
| c0.frame_p95_ms | 9.30 | 9.30 | 0.00 | 0.00 |
| c0.pct_frames_over_2x | 0.37 | 0.60 | 0.23 | 62.20 |
| c0.hitches_over_100ms | 1 | 0 | -1 | -100.00 |
| c0.snapshots_per_tick | 1.00 | 1.00 | 0.00 | 0.00 |
| c0.lead_p95_ms | 116.70 | -5.30 | -122.00 | -104.50 |
| c0.pct_extrapolating | 75.21 | 0.00 | -75.21 | -100.00 |
| c0.backward_steps | 270 | 0 | -270 | -100.00 |
| c0.meteor_backward_frames | 449 | 0 | -449 | -100.00 |
| c0.kbps_avg | 372.80 | 319.90 | -52.90 | -14.20 |
| c0.city_B_per_moving_body_s | 261.60 | 299.20 | 37.60 | 14.40 |
| c0.latency_p99_ms | 4.67 | 3.96 | -0.72 | -15.40 |
| c0.structure_repairs | 6 | 1 | -5 | -83.30 |
| c0.body_render_err_p99_m | 0.74 | 0.26 | -0.48 | -65.40 |
| c0.stale_body_draws | 333 | 298 | -35 | -10.50 |
| c0.hitches_cpu_bound_33ms | 5 | 3 | -2 | -40.00 |
| c0.meteor_hold_jump_max_m | 33.90 | 0 | -33.90 | -100.00 |
| c1.frame_p95_ms | 9.20 | 9.30 | 0.10 | 1.10 |
| c1.pct_frames_over_2x | 0.30 | 0.24 | -0.06 | -20.00 |
| c1.hitches_over_100ms | 14 | 0 | -14 | -100.00 |
| c1.snapshots_per_tick | 1.00 | 1.00 | 0.00 | 0.00 |
| c1.lead_p95_ms | 119.90 | -5.20 | -125.10 | -104.30 |
| c1.pct_extrapolating | 75.36 | 0.01 | -75.35 | -100.00 |
| c1.backward_steps | 283 | 0 | -283 | -100.00 |
| c1.meteor_backward_frames | 357 | 0 | -357 | -100.00 |
| c1.kbps_avg | 339.10 | 289.10 | -50.00 | -14.70 |
| c1.city_B_per_moving_body_s | 231.80 | 254.30 | 22.50 | 9.70 |
| c1.latency_p99_ms | 177.66 | 3.49 | -174.17 | -98.00 |
| c1.structure_repairs | 4 | 0 | -4 | -100.00 |
| c1.body_render_err_p99_m | 6.20 | 0.67 | -5.53 | -89.20 |
| c1.stale_body_draws | 180 | 148 | -32 | -17.80 |
| c1.hitches_cpu_bound_33ms | 16 | 1 | -15 | -93.80 |
| c1.meteor_hold_jump_max_m | 1.10 | 0 | -1.10 | -100.00 |
| c2.frame_p95_ms | 9.30 | 9.30 | 0.00 | 0.00 |
| c2.pct_frames_over_2x | 0.34 | 0.39 | 0.05 | 14.70 |
| c2.hitches_over_100ms | 10 | 0 | -10 | -100.00 |
| c2.snapshots_per_tick | 1.00 | 1.00 | 0.00 | 0.00 |
| c2.lead_p95_ms | 115.80 | -5.20 | -121.00 | -104.50 |
| c2.pct_extrapolating | 74.47 | 0.01 | -74.46 | -100.00 |
| c2.backward_steps | 269 | 0 | -269 | -100.00 |
| c2.meteor_backward_frames | 440 | 0 | -440 | -100.00 |
| c2.kbps_avg | 347.50 | 300.60 | -46.90 | -13.50 |
| c2.city_B_per_moving_body_s | 242.60 | 272.30 | 29.70 | 12.20 |
| c2.latency_p99_ms | 61.57 | 4.15 | -57.42 | -93.30 |
| c2.structure_repairs | 6 | 4 | -2 | -33.30 |
| c2.body_render_err_p99_m | 1.60 | 0.40 | -1.20 | -75.00 |
| c2.stale_body_draws | 128 | 112 | -16 | -12.50 |
| c2.hitches_cpu_bound_33ms | 14 | 6 | -8 | -57.10 |
| c2.meteor_hold_jump_max_m | 0 | 0 | 0 | – |

## Notes

- destruction reached differs from the baseline (35.1% vs 20.8% of bonds): compare the per-level tables, not only totals

Measured: everything above is read from the tapes, the server capture, /match-stats samples and the server log. PhysX step/GPU wait are 1 Hz samples of the last step, not every tick. Render error at render time depends on the client's recorded clock offset; 'now' error includes the intended interpolation delay.
