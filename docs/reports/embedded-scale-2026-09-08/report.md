# Embedded Vibe-land destruction: scale screen

One run per size; durations: **600 steps / 10 simulated seconds**, fixed timestep 1/60 s. Wave counts per run: **3**. Simultaneous waves start at tick 30, then every 150 ticks; each building gets one 18,000 kg, radius 0.5 m round at 40 m/s per wave. The normal game sphere damping applies. Direct GPU API **off**, native sleep **on**, correction limit **one**, stress passes **at most two**.

The timer begins before projectile insertion and ends with accepted game events/status/snapshots ready. It includes first-step native setup and runtime allocations. Asset/world creation is reported separately. Rendering, network encoding, test audits and report generation are excluded. These are short isolated simulation/integration screens, **not** whole-game or endurance qualification.

| Buildings | Chunks | Bonds | Rounds | Mean ms | Peak ms | Peak on a fracture tick, ms | >16.67 ms steps |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 4 | 1,776 | 3,584 | 12 | 11.136 | 40.234 | 29.611 | 12 / 600 |
| 64 | 28,416 | 57,344 | 192 | 24.208 | 70.608 | 61.939 | 425 / 600 |
| 256 | 113,664 | 229,376 | 768 | 94.641 | 186.782 | 186.782 | 565 / 600 |

## 4 buildings: the actual worst step

Tick **0**: **40.234 ms**, 0 projectiles present, 0 fragment bodies (0 awake), 4 total destruction clusters, 0 native normal-contact count, 0 cumulative broken bonds, 0 correction(s).

| Operation | Owner | Time on this peak, ms | Share |
|---|---|---:|---:|
| 📥 Commands / preparation | CPU → PhysX | 0.000160 | 0.00% |
| ⚙️ Native physics + destruction + correction | CPU tasks + CUDA | 39.967635 | 99.34% |
| 📤 Accepted events / game snapshots | CPU + GPU observations | 0.265766 | 0.66% |
| 👁️ Staged status / snapshot access | CPU | 0.000111 | 0.00% |

Initialization: **527.3 ms** separately. Final unique broken bonds: **1,034**. Misses over 8 ms: **565 / 600**.

[All samples and summary](four-buildings.json.gz) · [Recorded command tape](four-buildings-commands.json)

## 64 buildings: the actual worst step

Tick **0**: **70.608 ms**, 0 projectiles present, 0 fragment bodies (0 awake), 64 total destruction clusters, 0 native normal-contact count, 0 cumulative broken bonds, 0 correction(s).

| Operation | Owner | Time on this peak, ms | Share |
|---|---|---:|---:|
| 📥 Commands / preparation | CPU → PhysX | 0.000170 | 0.00% |
| ⚙️ Native physics + destruction + correction | CPU tasks + CUDA | 69.373717 | 98.25% |
| 📤 Accepted events / game snapshots | CPU + GPU observations | 1.234124 | 1.75% |
| 👁️ Staged status / snapshot access | CPU | 0.000090 | 0.00% |

Initialization: **538.0 ms** separately. Final unique broken bonds: **19,021**. Misses over 8 ms: **565 / 600**.

[All samples and summary](64-buildings.json.gz) · [Recorded command tape](64-buildings-commands.json)

## 256 buildings: the actual worst step

Tick **139**: **186.782 ms**, 256 projectiles present, 16,587 fragment bodies (13,747 awake), 16,843 total destruction clusters, 400,481 native normal-contact count, 72,407 cumulative broken bonds, 1 correction(s).

| Operation | Owner | Time on this peak, ms | Share |
|---|---|---:|---:|
| 📥 Commands / preparation | CPU → PhysX | 0.000441 | 0.00% |
| ⚙️ Native physics + destruction + correction | CPU tasks + CUDA | 169.699817 | 90.85% |
| 📤 Accepted events / game snapshots | CPU + GPU observations | 17.081810 | 9.15% |
| 👁️ Staged status / snapshot access | CPU | 0.000070 | 0.00% |

Initialization: **628.6 ms** separately. Final unique broken bonds: **78,046**. Misses over 8 ms: **565 / 600**.

[All samples and summary](256-buildings.json.gz) · [Recorded command tape](256-buildings-commands.json)

## Interpretation and limits

- ❌ These results do not pass the 8 ms or every-step 60 Hz target.
- 🔎 Native advance includes both CPU tasks and GPU execution/waits. This coarse boundary does not establish a compute, bandwidth or synchronization bottleneck inside it.
- 📤 Game observation cost includes accepted topology/event processing. Eliminating it entirely would still leave the large native peak far above the deadline.
- 🛡️ All measured rows are retained. The per-peak tables are disjoint and sum to that peak; independent phase maxima are not added together.
- ⚖️ The 17.96 m city spacing, game sphere damping and input tape differ from standalone native and historical external-adapter captures. No matched speedup or superiority is claimed.
- ✅ Each run checks pre-impact stability, finite observed positions, unique committed bond events, event/state count agreement, correction/stress-pass limits and final shape ownership. These checks do not establish projectile clearance, full physical parity or endurance.
