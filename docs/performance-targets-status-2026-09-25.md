# Performance targets: status (2026-09-25)

The goals: (1) server physics and destruction at 60 Hz minimum, 120 Hz
ideal, on CuMetal + PhysX GPU + the native stress solver; (2) netcode that
is fastest, least bandwidth and closest to server truth at 60 Hz, measured
with Netlab. This page is the current measured position against both, with
pointers to the evidence. Everything is measured on an M3 Max unless marked.

## 1. Server physics and destruction

"Production-like" means what a dedicated server sees: the headless clients
are capped at 30 fps (`CITY_BENCH_CLIENT_QUERY=maxFps=30`), so they do not
fight the server for the GPU the way an uncapped local browser does. Package:
cuda-metal a19f037 (resident cooperative grids at 2 blocks per core, now the
default as 99beab7) + PhysX b5b18ecb; vibe-land 3d96a192. Runs:
`target/prodlike/runs/*`. Stats from each run's server `ticks.jsonl`.

| run | sim rate | worst 5 s | tick p50 / p95 / p99 (ms) | > 16.7 ms | > 8.3 ms | max (ms) | destruction |
|---|---|---|---|---|---|---|---|
| systematic, 1 client, #1 | 0.995 | 0.94 | 6.79 / 11.76 / 22.38 | 2.2% | 21% | 90 | 89.5% of bonds |
| systematic, 1 client, #2 | 0.996 | 0.95 | 7.19 / 13.16 / 22.11 | 2.4% | 31% | 152 | 89.4% |
| quick, 3 clients, #1 | 0.987 | 0.87 | 7.09 / 13.96 / 28.90 | 3.2% | 34% | 72 | 20.9% |
| quick, 3 clients, #2 | 0.961 | 0.82 | 10.60 / 23.55 / 36.41 | 13.1% | 75% | 105 | 41.1% |

Against the first measurement of the day (docs/city-bench-baselines/
2026-09-24-systematic-1client.md: sim rate 0.97, worst 5 s 0.73, max 544 ms,
40 bodies through the ground):

- **60 Hz: met on average, not on every tick.** A whole-city destruction run
  keeps 99.5% of real time and 94-95% in its worst 5 s; about 2% of ticks
  still exceed 16.7 ms.
- **120 Hz: not met.** 21-31% of ticks exceed 8.3 ms and the p50 (~7 ms)
  leaves no headroom.
- **With uncapped local clients** (a browser on the same Mac, the user's
  play setup) the server yields the GPU: see the GPU-sharing follow-up in
  docs/meteor-impact-analysis-2026-09-24.md. `?maxFps=30` plus the DPR cap
  is the local-play mitigation (not default).

What the remaining cost is (docs/meteor-impact-analysis-2026-09-24.md,
docs/city-bench.md "Tick phases"): split ticks spend it in the PhysX
correction path and island repair (the stress solve is ~1 ms); the steady
~7 ms step with debris awake is serial GPU work (~390 dispatches at ~3.4 us)
plus ~10 host waits. Those levers are in the PhysX fork and are being worked
there. Resident grids at full GPU occupancy stalled under contention; 2
blocks per core had the best tail in an interleaved A/B
(`target/rescap2/runs`).

Changes that got here (all measured in their commits): pipeline preload and
GPU branch skip (cuda-metal 02bb9ca), the vehicle-wheel broad-phase fix
(PhysX 63a60440), correction-path and routeContacts work (PhysX b5b18ecb),
the resident-grid cap (cuda-metal 99beab7), the CCT reset crash
(vibe-land 1425a742, PhysX c4f528fc), and the client-side GPU findings.

## 2. Netcode

Netlab v2 replays frozen server truth through the production server stage,
a link model and the production client, and scores every rigid body the
client draws (docs/netlab-v2.md). The scoreboard, pre-work vs now on the
same truth, 4 bundles x 11 links, is in docs/netcode-tuning.md
("Netcode scoreboard (2026-09-24)") and docs/netcode-scoreboard-2026-09-24.md.
In short:

- **Closest to truth:** all-draws position error at render time p99 5-12x
  lower on fast links (systematic bundle 0.211 -> 0.025 m); wrong-body chunk
  draws on LTE 70,697 -> 529; clock back-steps and structure repairs -> 0;
  stale bodies and vehicles after leaving interest -66 to -95%.
- **Least bandwidth:** -4 to -12% bytes on fast links, -6 to -48% on
  rate-limited ones; snapshot overhead 60 -> 39 B; idle 54 -> 23 kbit/s
  (idle-cold players and vehicles); match stats ~33% -> ~1% of bytes.
- **Fastest:** constrained links no longer queue for seconds (rate
  adaptation: datagram p99 1.5-9 s -> 80-220 ms at 0.5-1 Mbit/s). The cost
  of drawing only what has arrived is latency: bodies 15-21 ms behind the
  server on loopback, the city ~10 ticks behind on LTE; options that cut it
  so far each added visible corrections (documented). City send cadence
  (60 Hz on fast links) is being measured next.

## Open items

- 120 Hz: the PhysX split-tick and steady-step levers (PhysX fork).
- Local play: whether to cap the client automatically when the server is on
  the same machine (the user's decision).
- Rest sleep (`VIBE_CITY_NATIVE_REST_SLEEP=1`) stays opt-in; its benefit in
  live play was small.
