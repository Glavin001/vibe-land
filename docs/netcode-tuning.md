# Netcode tuning: the /city server-to-client stream (2026-09-24)

This round tuned what the server sends a /city client. The goal: fewer
bytes, the same or lower latency, and client-drawn state closer to the
server's truth, at 60 Hz. Every number was measured with
[Netlab v2](netlab-v2.md), which replays frozen server truth through the
production encoders, a seeded link model and the production client. Claims
are marked **measured** (read from a lab or live run) or **inferred** (a
conclusion from those numbers).

## Recommendation

**Server** (`destruction/src/encoder.rs`). These are now the defaults of
`EncoderConfig::validated`, the config the live server builds.

| Setting | Before | Now | Why |
|---|---|---|---|
| `ballistic_requires_free_fall` | (always ballistic when no contacts) | on | 98% of records were sent ballistic, including debris lying on the ground |
| `model_client_extrapolation` | (judge against the last-sent pose) | on | the client extrapolates for 133 ms and then holds; that held pose is what it draws |
| `baseline_interval_ticks` | 60 (1 s) | 120 (2 s) | halves baseline bytes, and allows the longer lag below |
| `baseline_reference_lag_ticks` | 0 | 110 | deltas keep the previous generation until the new baseline can have arrived |
| `baseline_skips_quiescent` | off | on | resting rubble never gets delta records, so its baseline entries bought nothing |
| `world_gravity_y` | – | from the physics world | free fall is measured against it |

**Client, one line** (`client/src/city/presentation.ts`,
`presentationConfig60Hz`): extrapolation gravity changes from −20 to
**−9.81 m/s²**. The world has fallen at 9.81 since the physics went back to
Earth gravity (`physx-bridge` `world_gravity_magnitude`). This line was
left at 20. It is the only client change, and the encoder models the same
value (`CLIENT_EXTRAPOLATION_GRAVITY_Y`). A test on each side reads the
other's value.

**Result** (measured, lab). Production (the clean 2c84b393 tree: server and
client) against all of the above, rebased on 2c84b393, on 3 bundles × 6
links, with `lab.recorded_repairs=0`:

- **Bytes:** netcode bytes (snapshot + city) fall 7–16% on every cell.
- **Resting debris:** 0.198 → 0.019 m at p50.
- **Settling debris:** about 0.20 → 0.03–0.07 m.
- **All city bodies not yet settled:** mean error down 27–69%.
- **On-screen area perceptibly wrong:** down 36–97%.
- **Latency** (sent to drawn): unchanged, within seed noise.
- **Snapshot classes** (cannonballs, vehicles, players): unchanged.
- **Cost:** on the light rec1 bundle, landing debris (fast, in contact) is
  1–5 cm worse at p50. City moving bodies never drawn at all trend up
  10–20% on LTE (within seed noise). See [Risks](#risks-and-limits).

**Later round** ([City latency and topology delivery](#city-latency-and-topology-delivery)):
`topology_datagram_copies` 2 (topology copied onto the datagram lane) and
a reliable-stream signal in the rate controller, both on; an adaptive
playout delay, built and off.

**Scoreboard** ([Netcode scoreboard (2026-09-24)](#netcode-scoreboard-2026-09-24)):
the pre-work netcode against HEAD on four bundles and eleven links, then the
changes it pointed at: a compact self state and explicit removals, then late
snapshots applied per entity and idle players and vehicles sent cold, then
[the city stream at 60 Hz with a 5-tick playout delay](#city-send-cadence-and-playout-delay).

**Not changed then, stated as trade-offs:** the per-send byte ceiling and the
city send rate were the two large levers left (the send rate has since gone
to 60 Hz: [City send cadence and playout delay](#city-send-cadence-and-playout-delay)); see
[the Pareto front](#pareto-front). A lower ceiling is the only knob that
fixes the saturated 0.5–1 Mbit/s links, and it costs error on fast links. The
fix there is per-link rate adaptation, now implemented: see
[Rate adaptation](#rate-adaptation).

## Bundles

| Name | What | Client it was recorded with | Calibration |
|---|---|---|---|
| `heavy-quick3-v2` c0, c1 | city-bench `quick`, 3 clients, 122 s: 4 buildings shot, meteored and demolished, then a drive. c0 plays; c1 spectates 25 m from each target | 91c814bb (current) | **PASS**: 100% of lab packets byte-identical to the live send log; clock offset vs live p99 96 µs (c0), 95 µs (c1). **This is the calibration reference for the current client.** |
| `rec1` | the original light 75 s capture: 1 player, cannonballs, a meteor, a demolition, a drive | b0502db9 (old) | PASS with the b0502db9 client (`--client-root`); still passes with this round's lab binary |
| `heavy-quick3` c0 ("h1c0") | same scenario as v2, recorded earlier | b0502db9 (old) | bytes 100% identical; clock-convergence window FAILS (775 µs vs 200 µs: seam S8 under server stalls). Used only for relative comparisons |

Paths: `target/netlab-v2/bundles/<name>/`, each with a README. The heavy
bundles never reach the city byte ceiling at production settings (19 sends
clipped in 122 s, live) or the snapshot budget. Truncation is priced on the
rate-limited profiles (`poor-mobile` 1 Mbit/s, `bw-capped` 0.5 Mbit/s).
There the heavy stream saturates the link at its peaks.

## How it was measured

- **Lab:** `netlab2 matrix` with the recorded server pace, link seed 1
  (replicates with seeds 2–4 below), and links `loopback`, `lan`, `cable`,
  `lte`, `poor-mobile`, `bw-capped` (`netlab2 profiles`). Scored by the lab's
  production client stage.
- **Bytes:** netcode kbit/s delivered = snapshot + city chunks + city
  reliable (topology, baselines, hashes, bootstraps). Pass-through kinds
  (match stats, energy, roster) are excluded because they are not encoder
  output.
- **Latency:** "drawn behind": how far behind the server the client draws
  dynamic bodies (p50). This is sent→drawn: link latency plus the
  interpolation delay.
- **Error:** per class, p50 at the render time / at "now":
  - city phases: the chunk-weighted lever error;
  - snapshot classes: position error.
- **Pareto error axis:** the chunk-weighted mean lever error over every city
  body not yet settled ("active"). Settled bodies carry the reliable settle
  pose and are about 5 mm everywhere. Also the share of on-screen city area
  perceptibly wrong.
- **Tooling:** `scripts/perf/netlab2-tune.py <matrixDirs>
  [--pareto | --relative]` produces every table here from `report.json` and
  `stream.json`.

## Baseline: production (measured)

Clean 2c84b393 tree (lab and client), production knobs, `lab.recorded_repairs=0`.

| Bundle | Link | Netcode kbit/s (snap / city dgram / city reliable) | Datagram latency p50 / p99 ms | Drawn behind p50 ms |
|---|---|---|---|---:|
| v2c0 | loopback | 261.3 (45.4 / 183.9 / 32.0) | 0.1 / 0.1 | 16.6 |
| v2c0 | lan | 261.3 (45.4 / 183.9 / 32.0) | 1.0 / 1.3 | 17.4 |
| v2c0 | cable | 261.0 (45.4 / 183.6 / 32.0) | 12.1 / 15.4 | 29.7 |
| v2c0 | lte | 253.3 (44.2 / 177.1 / 32.0) | 89.5 / 124 | 139.6 |
| v2c0 | poor-mobile | 253.7 (44.1 / 177.5 / 32.0) | 161.3 / 1,995 | 209.6 |
| v2c0 | bw-capped | 261.3 (45.4 / 183.9 / 32.0) | 44.1 / 10,461 | 69.7 |
| v2c1 | lan | 232.3 (35.9 / 164.4 / 32.0) | 1.0 / 1.3 | 17.4 |
| v2c1 | lte | 226.3 (34.9 / 159.4 / 32.0) | 89.4 / 124 | 140.8 |
| rec1 | lan | 95.0 (42.1 / 46.8 / 6.1) | 1.0 / 1.3 | 14.7 |
| rec1 | lte | 92.0 (41.0 / 44.9 / 6.1) | 89.6 / 124 | 146.7 |

Error per class, p50 m, render / now (v2c0):

| Link | City resting | Settling | Landing | Just freed | Falling | Ballistic snapshot body | Colliding | Vehicle | Player | Meteor render p50 / p99 | Stale frames (max ms) | City moving never drawn | Repairs |
|---|---|---|---|---|---|---|---|---|---|---|---|---:|---:|
| loopback | 0.198 / 0.198 | 0.198 / 0.204 | 0.064 / 0.311 | 0.028 / 0.557 | 0.008 / 1.521 | 0.010 / 0.264 | 0.003 / 0.070 | 0.001 / 0.001 | 0.001 / 0.001 | 0.13 / 0.37 | 821 (967) | 9 | 0 |
| lan | 0.198 / 0.198 | 0.198 / 0.204 | 0.062 / 0.311 | 0.027 / 0.557 | 0.008 / 1.521 | 0.010 / 0.272 | 0.003 / 0.073 | 0.001 / 0.001 | 0.001 / 0.001 | 0.13 / 0.37 | 819 (967) | 64 | 0 |
| cable | 0.198 / 0.198 | 0.198 / 0.204 | 0.064 / 0.332 | 0.027 / 0.595 | 0.008 / 1.622 | 0.010 / 0.369 | 0.003 / 0.118 | 0.001 / 0.001 | 0.001 / 0.001 | 0.13 / 0.37 | 816 (967) | 1,064 | 0 |
| lte | 0.198 / 0.198 | 0.218 / 0.232 | 0.240 / 0.416 | 0.204 / 0.722 | 0.039 / 1.676 | 0.009 / 1.266 | 0.003 / 0.536 | 0.001 / 0.001 | 0.001 / 0.001 | 0.13 / 0.37 | 844 (1,833) | 9,747 | 0 |
| poor-mobile | 0.198 / 0.198 | 0.232 / 0.240 | 0.232 / 0.490 | 0.168 / 1.065 | 0.062 / 2.035 | 0.009 / 1.790 | 0.003 / 0.786 | 0.001 / 0.001 | 0.001 / 0.001 | 0.14 / 0.38 | 1,485 (3,900) | 262,738 | 0 |
| bw-capped | 0.198 / 0.198 | 0.198 / 0.204 | 0.039 / 0.444 | 0.013 / 1.174 | 0.010 / 2.035 | 0.008 / 0.830 | 0.003 / 0.257 | 0.001 / 0.001 | 0.001 / 0.001 | 0.13 / 0.37 | 869 (933) | 437,132 | 0 |

Repairs: the city bootstraps the stream carried. With
`lab.recorded_repairs=0` these are only the ones the client asked for: none
on these runs.

**End to end** (measured): production → the new defaults plus the one-line
client fix, same bundles, all six links. Error columns are p50 m, render /
now.

| Bundle | Link | Netcode kbit/s | Resting r/n | Settling r/n | Landing r/n | Active mean r (m) | Perceptible | Ballistic body r/n | Drawn behind ms |
|---|---|---|---|---|---|---|---|---|---|
| v2c0 | loopback | 261.3 → 219.3 (-16.1%) | 0.198 / 0.198 → 0.019 / 0.020 | 0.198 / 0.204 → 0.034 / 0.054 | 0.064 / 0.311 → 0.049 / 0.273 | 0.222 → 0.088 | 1.18% → 0.15% | 0.010 / 0.264 → 0.010 / 0.264 | 16.6 → 16.6 |
| v2c0 | lan | 261.3 → 219.3 (-16.1%) | 0.198 / 0.198 → 0.019 / 0.020 | 0.198 / 0.204 → 0.034 / 0.054 | 0.062 / 0.311 → 0.049 / 0.273 | 0.222 → 0.088 | 1.18% → 0.15% | 0.010 / 0.272 → 0.010 / 0.273 | 17.4 → 17.4 |
| v2c0 | cable | 261.0 → 219.2 (-16.0%) | 0.198 / 0.198 → 0.019 / 0.020 | 0.198 / 0.204 → 0.036 / 0.056 | 0.064 / 0.332 → 0.051 / 0.292 | 0.222 → 0.088 | 1.19% → 0.15% | 0.010 / 0.369 → 0.010 / 0.370 | 29.7 → 29.7 |
| v2c0 | lte | 253.3 → 213.1 (-15.9%) | 0.198 / 0.198 → 0.020 / 0.021 | 0.218 / 0.232 → 0.054 / 0.070 | 0.240 / 0.416 → 0.168 / 0.366 | 0.260 → 0.117 | 1.74% → 0.33% | 0.009 / 1.266 → 0.009 / 1.252 | 139.6 → 139.9 |
| v2c0 | poor-mobile | 253.7 → 213.3 (-15.9%) | 0.198 / 0.198 → 0.023 / 0.023 | 0.232 / 0.240 → 0.060 / 0.082 | 0.232 / 0.490 → 0.163 / 0.490 | 0.487 → 0.303 | 1.75% → 0.46% | 0.009 / 1.790 → 0.009 / 1.780 | 209.6 → 206.6 |
| v2c0 | bw-capped | 261.3 → 219.3 (-16.1%) | 0.198 / 0.198 → 0.019 / 0.019 | 0.198 / 0.204 → 0.038 / 0.066 | 0.039 / 0.444 → 0.049 / 0.430 | 0.422 → 0.225 | 2.87% → 1.07% | 0.008 / 0.830 → 0.007 / 0.702 | 69.7 → 63.0 |
| v2c1 | loopback | 232.3 → 201.2 (-13.4%) | 0.198 / 0.198 → 0.019 / 0.019 | 0.204 / 0.211 → 0.042 / 0.060 | 0.077 / 0.311 → 0.064 / 0.282 | 0.246 → 0.111 | 3.25% → 0.58% | 0.011 / 0.314 → 0.011 / 0.314 | 16.6 → 16.6 |
| v2c1 | lan | 232.3 → 201.2 (-13.4%) | 0.198 / 0.198 → 0.019 / 0.019 | 0.204 / 0.211 → 0.042 / 0.060 | 0.077 / 0.321 → 0.064 / 0.282 | 0.245 → 0.110 | 3.23% → 0.57% | 0.011 / 0.320 → 0.011 / 0.321 | 17.4 → 17.4 |
| v2c1 | cable | 232.0 → 201.0 (-13.3%) | 0.198 / 0.198 → 0.019 / 0.019 | 0.204 / 0.211 → 0.043 / 0.062 | 0.082 / 0.332 → 0.066 / 0.301 | 0.246 → 0.111 | 3.25% → 0.57% | 0.011 / 0.413 → 0.011 / 0.415 | 29.7 → 29.7 |
| v2c1 | lte | 226.3 → 195.1 (-13.8%) | 0.198 / 0.198 → 0.020 / 0.020 | 0.232 / 0.240 → 0.058 / 0.072 | 0.292 / 0.444 → 0.185 / 0.390 | 0.288 → 0.141 | 5.14% → 1.39% | 0.011 / 1.332 → 0.011 / 1.335 | 140.8 → 142.2 |
| v2c1 | poor-mobile | 226.3 → 195.1 (-13.8%) | 0.204 / 0.204 → 0.022 / 0.023 | 0.232 / 0.248 → 0.066 / 0.088 | 0.311 / 0.522 → 0.174 / 0.506 | 0.505 → 0.354 | 6.54% → 3.59% | 0.011 / 1.846 → 0.011 / 1.876 | 207.0 → 207.4 |
| v2c1 | bw-capped | 232.3 → 201.2 (-13.4%) | 0.198 / 0.198 → 0.019 / 0.019 | 0.211 / 0.218 → 0.054 / 0.077 | 0.088 / 0.430 → 0.070 / 0.430 | 0.314 → 0.230 | 5.33% → 3.42% | 0.010 / 1.300 → 0.011 / 1.150 | 65.2 → 61.4 |
| rec1 | loopback | 95.0 → 88.2 (-7.2%) | 0.198 / 0.198 → 0.018 / 0.019 | 0.179 / 0.185 → 0.031 / 0.056 | 0.010 / 0.282 → 0.021 / 0.292 | 0.162 → 0.050 | 0.02% → 0.00% | 0.002 / 0.334 → 0.002 / 0.334 | 13.9 → 13.9 |
| rec1 | lan | 95.0 → 88.2 (-7.2%) | 0.198 / 0.198 → 0.018 / 0.019 | 0.179 / 0.185 → 0.031 / 0.058 | 0.010 / 0.292 → 0.021 / 0.301 | 0.162 → 0.050 | 0.02% → 0.00% | 0.002 / 0.347 → 0.002 / 0.345 | 14.7 → 14.7 |
| rec1 | cable | 95.0 → 88.2 (-7.2%) | 0.198 / 0.198 → 0.018 / 0.019 | 0.179 / 0.191 → 0.032 / 0.060 | 0.010 / 0.332 → 0.023 / 0.332 | 0.163 → 0.050 | 0.02% → 0.00% | 0.002 / 0.491 → 0.002 / 0.507 | 28.3 → 28.3 |
| rec1 | lte | 92.0 → 85.8 (-6.8%) | 0.198 / 0.198 → 0.019 / 0.019 | 0.265 / 0.273 → 0.068 / 0.088 | 0.416 / 0.506 → 0.211 / 0.459 | 0.309 → 0.128 | 0.06% → 0.01% | 0.002 / 2.123 → 0.002 / 2.021 | 146.7 → 147.9 |
| rec1 | poor-mobile | 92.7 → 85.4 (-7.8%) | 0.198 / 0.198 → 0.019 / 0.020 | 0.256 / 0.282 → 0.068 / 0.097 | 0.321 / 0.595 → 0.204 / 0.614 | 0.299 → 0.129 | 0.08% → 0.01% | 0.002 / 3.040 → 0.002 / 3.008 | 211.1 → 208.8 |
| rec1 | bw-capped | 95.0 → 88.2 (-7.2%) | 0.198 / 0.198 → 0.026 / 0.027 | 0.211 / 0.225 → 0.052 / 0.080 | 0.036 / 0.430 → 0.082 / 0.474 | 0.501 → 0.223 | 0.05% → 0.02% | 0.002 / 4.071 → 0.002 / 2.196 | 60.2 → 59.7 |

What the baseline says (measured unless marked):

- **Resting debris is 0.198 m off on every link, including loopback.** It is
  a bias, not a link effect. Settling debris is about the same.
- **The city stream dominates:** 83% of netcode bytes on the heavy bundle.
  The record mix is 98% ballistic at 31 B/record, and baselines are
  24 kbit/s.
- **Rate-limited links saturate.** The heavy stream peaks above 1 Mbit/s.
  On `poor-mobile` (1 Mbit/s) the datagram p99 is 2 s; on `bw-capped`
  (0.5 Mbit/s) it is 10.5 s, with 260k–440k body-frames of moving city
  bodies never drawn. Datagrams go first in the QUIC sender, so the reliable
  stream (topology, baselines) starves behind them. The encoder has no link
  feedback.
- **Latency** is link plus clock. The 91c814bb clock draws LTE ~140 ms
  behind the server; the b0502db9 clock drew it 331 ms behind.

## What was wrong, and the changes

### 1. Every moving body was sent ballistic (fixed, server)

The classifier calls a body ballistic when it reports no contacts, and the
native PhysX backend reports none. So every moving body qualified,
including rubble sliding or rolling on the ground: 88,658 of 90,520 records
(98%) on v2c0 (measured). A ballistic record costs twice:

- **Bytes:** it carries an absolute pose, 6 B more than a baseline delta.
- **Drawing:** the client extrapolates it under gravity for up to 8 ticks.
  A body at rest on the ground is drawn sinking by 0.5·g·(8/60)², then held
  there. That is 0.178 m at the client's −20 m/s² (**inferred** from the
  arithmetic; it matches the measured 0.185–0.198 m resting error).

**Change:** `ballistic_requires_free_fall`. The encoder tracks each body's
tick-to-tick acceleration. It sends the ballistic mode only after 2
consecutive ticks within 3 m/s² of world gravity, which is the same test
Netlab's truth model uses. After the change, 33% of records are ballistic:
the bodies actually falling.

### 2. Client gravity was 20, the world's is 9.81 (fixed, client, one line)

With −20, a real fall extrapolated for 133 ms missed by 9 cm, the same as
not modelling gravity at all (inferred, computed). Measured effect of this
line alone, with the server unchanged:

- falling debris on LTE: 0.045 → 0.016 m (v2c0), 0.130 → 0.017 m (rec1);
- the resting sink halves: 0.198 → 0.100 m.

### 3. The encoder judged the client against a pose the client does not draw (fixed, server)

The client does not hold a record's pose. It extrapolates the record's
velocity for up to 8 ticks, then holds (`PresentationTrack.extrapolate`,
undamped). The encoder compared truth with the last-sent pose. Two
consequences:

- **Stranded bodies.** A body that came to rest after its last record looked
  "within 2 cm of what the client has" and was never corrected, because the
  priority gate never sends to a quiescent body.
- **Wrong priority.** The error ratio that ranks everything else was
  computed against the wrong pose.

**Change:** `model_client_extrapolation`. The rest-unchanged skip and the
projected error now use the client's extrapolated pose. A resting body drawn
more than 4 cm off (position plus rotation × radius) gets one correcting
record, even while quiescent.

This alone *adds* 15% bytes (measured, h1c0). With ballistic-everything it
correctly sees every gravity-sunk body as wrong. With change 1 it saves 4–5%
bytes and lowers resting error.

### 4. Deltas were dropped whenever a baseline was late (fixed, server)

Once most records are deltas, their baseline matters. Baselines travel on
the reliable stream; deltas travel on datagrams, which the sender sends
first. The client drops a delta whose generation it has not received
(`cityClient.ts`). The encoder switched generations the tick it emitted a
baseline, so on a congested link every delta until the baseline arrived was
thrown away. Measured on rec1 bw-capped: baseline latency p99 was 2.9 s,
and landing error went 0.036 → 0.60 m with changes 1–3 alone.

**Change:** `baseline_reference_lag_ticks`. For the lag after emitting a
baseline, deltas stay on the previous generation. The client keeps the two
newest generations, so any lag below the interval is safe, and the encoder
clamps it there. Bodies awake only since the new baseline go absolute
meanwhile.

With the lag at 45 ticks, rec1 bw-capped landing recovered from 0.60 to
0.20 m. The rest needed a longer lag, which needs a longer interval (below).

### 5. Baselines were mostly resting rubble (fixed, server)

A baseline lists every awake body. A demolished city is mostly quiescent
rubble that never gets a delta record.

**Change:** `baseline_skips_quiescent`. Quiescent bodies are left out; a
rare record for one goes absolute (6 B more, once). The encoder only deltas
against poses it put in a baseline, and a test checks this.

**Change:** the baseline interval goes from 1 s to 2 s, with a 110-tick
(1.83 s) lag. Baseline bytes on v2c0 fall 24.0 → 5.2 kbit/s (measured).

### 6. A client joining mid-stream could not resolve deltas for up to 3.8 s (fixed, server)

A bootstrap (join, resync, repair) clears the client's baseline generations
and names the in-flight one as empty (`cityClient.ts`). So a client can
resolve no delta until the encoder references a generation emitted after
its bootstrap. With a 2 s interval and a 1.83 s lag that would be up to
3.8 s of dropped deltas after a join (inferred from the code; the lab barely
sees it, because each bundle's client joins once, before the capture).

**Change:** `ChunkStreamEncoder::note_client_bootstrap`. `add_client` (every
join) and the resync and repair sites in `main.rs` record the first
generation the client can hold, and that client gets absolute records
until the reference reaches it. Other clients keep their deltas. With the
lag off (older captures) it is a no-op.

### Tests

- `destruction/src/encoder.rs`: 10 new tests; 170 unit tests in the crate,
  all passing, plus the crate's integration tests. Server and netlab2: 183.
  Client city: 216.
  - `only_a_body_in_measured_free_fall_is_sent_ballistic`
  - `a_body_that_coasts_to_rest_is_left_drawn_where_it_stopped`
  - `a_resting_body_drawn_sunk_is_corrected_once`
  - `the_client_model_extrapolates_like_the_client_and_then_holds`
  - `deltas_keep_the_previous_baseline_until_the_new_one_can_have_arrived`
  - `the_baseline_lag_is_clamped_below_the_interval`
  - `baselines_leave_out_quiescent_bodies_and_deltas_follow_the_baseline`
  - `older_checkpoints_read_the_new_flags_as_off`
  - `the_client_model_matches_the_client_presentation_config`: reads
    `presentation.ts`, so neither side can change alone.
  - `a_client_bootstrapped_mid_stream_gets_absolutes_until_it_can_hold_a_baseline`
- `client/src/city/presentation.test.ts`: the gravity equals the world's.
- Calibration stays exact:
  - Every new flag is `#[serde(default)]` = off, so an encoder checkpoint
    from an older capture resumes with exactly the behaviour it was recorded
    with.
  - `netlab2 calibrate` passes on rec1 with this round's lab binary (with the
    b0502db9 client): 5,650 of 5,650 packets byte-identical, clock checks ok.
  - It passes on heavy-quick3-v2 c0 and c1 with the clean tree, and with this
    round's tree rebased on 2c84b393 (measured).
  - The lab turns the flags on for old bundles with knobs.

## Pareto front

All runs below use the gravity-fixed client and `lab.recorded_repairs=0`,
on the tree rebased to 2c84b393, so they compare **server settings only**. `rec` is the new defaults. Every other set is `rec` plus one
knob: `hz20`/`hz15` = `city.send_hz`, `ceilN` = `city.ceiling_bytes`,
`snap30` = `snapshot.interval_ticks=2`, `px1.5` = `city.error_budget_px`,
`age15` = `city.max_moving_age_ticks`, `stride4` = `city.rest_stride`.

**Mean change vs production over 4 bundles** (v2c0, v2c1, rec1, h1c0),
per link: netcode bytes / active city error / perceptible area / drawn-behind
latency. "On front" counts the (bundle, link) cells where no other set is at
least as good on all four axes and better on one (measured).

| set | lan: bytes / err / perceptible / latency | lte: bytes / err / perceptible / latency | poor-mobile: bytes / err / perceptible / latency | bw-capped: bytes / err / perceptible / latency | on front |
|---|---|---|---|---|---:|
| rec-hz15 | -33% / -35% / +4% / +0.0 ms | -33% / -36% / -28% / +0.7 ms | -33% / -42% / -29% / -2.3 ms | -33% / -6% / -52% / -4.1 ms | 16/16 |
| rec-hz20 | -25% / -38% / -13% / +0.0 ms | -25% / -32% / -8% / +0.7 ms | -25% / -50% / -44% / -2.0 ms | -25% / -14% / -55% / -4.3 ms | 10/16 |
| rec-ceil2.6k | -25% / -29% / -32% / +0.0 ms | -25% / -20% / -15% / +0.5 ms | -25% / -46% / -37% / -3.7 ms | -25% / -41% / -62% / -6.5 ms | 12/16 |
| rec-ceil5k | -18% / -38% / -38% / +0.0 ms | -18% / -29% / -24% / +0.8 ms | -18% / -50% / -45% / -3.4 ms | -18% / +1% / -25% / -5.2 ms | 7/16 |
| rec | -13% / -39% / -37% / +0.0 ms | -13% / -32% / -25% / +0.4 ms | -13% / -27% / -26% / -1.1 ms | -13% / -30% / -14% / -4.0 ms | 7/16 |
| prod | +0% / +0% / +0% / +0.0 ms | +0% / +0% / +0% / +0.0 ms | +0% / +0% / +0% / +0.0 ms | +0% / +0% / +0% / +0.0 ms | 0/16 |

**Reference bundle v2c0, absolute** (netcode kbit/s, active city error mean,
perceptible area, drawn behind p50; `*` = on the front among these sets on
that link):

| Set | lan | lte | poor-mobile | bw-capped |
|---|---|---|---|---|
| prod | 261 kbit/s, 0.154 m, 0.20%, 17 ms | 253 kbit/s, 0.186 m, 0.43%, 140 ms | 254 kbit/s, 0.419 m, 0.48%, 210 ms | 261 kbit/s, 0.364 m, 1.60%, 70 ms |
| rec | 219 kbit/s, 0.088 m, 0.15%, 17 ms * | 213 kbit/s, 0.117 m, 0.33%, 140 ms * | 213 kbit/s, 0.303 m, 0.46%, 207 ms | 219 kbit/s, 0.225 m, 1.07%, 63 ms |
| rec-ceil5k | 200 kbit/s, 0.091 m, 0.15%, 17 ms * | 195 kbit/s, 0.131 m, 0.38%, 142 ms | 194 kbit/s, 0.147 m, 0.35%, 203 ms * | 200 kbit/s, 0.343 m, 0.73%, 61 ms |
| rec-ceil2.6k | 176 kbit/s, 0.117 m, 0.16%, 17 ms * | 172 kbit/s, 0.157 m, 0.41%, 141 ms | 172 kbit/s, 0.177 m, 0.50%, 203 ms * | 176 kbit/s, 0.143 m, 0.19%, 58 ms * |
| rec-hz20 | 187 kbit/s, 0.090 m, 0.19%, 17 ms * | 181 kbit/s, 0.118 m, 0.35%, 142 ms * | 182 kbit/s, 0.144 m, 0.38%, 205 ms * | 187 kbit/s, 0.355 m, 0.44%, 62 ms |
| rec-hz15 | 164 kbit/s, 0.091 m, 0.22%, 17 ms * | 160 kbit/s, 0.114 m, 0.37%, 141 ms * | 160 kbit/s, 0.138 m, 0.46%, 205 ms * | 164 kbit/s, 0.322 m, 0.55%, 63 ms * |

Reading it (inferred from the tables):

- **`rec` beats production on every axis** in 23 of 24 (bundle, link) cells,
  6 links × 4 bundles. The exception is v2c1 bw-capped: perceptible area
  +9% (3.14% → 3.42%), while its error falls 0.253 → 0.230 m.
- **The city send rate is the biggest lever left.**
  - 20 Hz saves another 12 points of bytes (−25% vs production). It is
    better than production on average on every link, but worse on some
    cells (v2c1 bw-capped error, rec1 LTE perceptible area).
  - Against `rec` it trades fast-link fidelity for constrained-link fidelity:
    LAN perceptible area 0.15% → 0.19% (v2c0), poor-mobile error 0.303 →
    0.144 m.
  - 15 Hz (−33%) is on the front everywhere, but LAN perceptible area is 4%
    worse than *production*.
  - **Not changed:** a trade-off, and `CITY_CHUNK_STREAM_HZ` is a shared
    constant.
- **The ceiling is the only knob that fixes the saturated links.**
  - 2.6 kB per send: bw-capped perceptible area 1.60% → 0.19% and error
    0.364 → 0.143 m on v2c0.
  - It costs fast-link fidelity: LAN error 0.088 → 0.117 m against `rec`.
  - **Not changed:** a per-link ceiling (rate adaptation, proposal 1) gets
    both.
- **30 Hz snapshots** save 25% but add 19–29 ms of drawn-behind latency on
  every link. Rejected: latency is an objective.
- **Seed noise** (measured, v2c0 and h1c0, LTE and poor-mobile, seeds 1–4):
  - bytes ±0.5%;
  - active error ±3–12%;
  - perceptible area ±10%;
  - drawn-behind ±2 ms;
  - stale-body frames ±20%;
  - city moving bodies never drawn ±5% (±25% for `rec` on LTE).
  Differences smaller than these are not claimed.

Per-cell tables: `target/stream-tune/matrix/r3-pareto-cells.md` (every
set, bundle and link) and `r3-pareto-all.json`. The one-at-a-time sweep of
the other knobs (next section, 0a7d6ae5, before the rebase) is in
`pareto-cells.md`.

## Knobs that do not help (measured, one at a time, v2c0 and rec1, 4 links)

On top of changes 1, 3 and a 45-tick lag:

| Knob | Bytes | Effect |
|---|---|---|
| `city.error_budget_px` 1, 1.5, 3, 4 | −2% to +4% | error ±3% on LAN, mixed on lossy links; the model and the hard deadlines decide most sends |
| `city.rest_stride` 4, 16 | ±0.5% | no measurable effect |
| `city.linear_motion_mps` 0.15 / `angular_motion_rps` 0.2 | −1.5% | error +5% |
| `city.max_moving_age_ticks` 60 / 15 | −1.5% / +3% | LAN error +14% / −11%; lossy links mixed |
| `city.proximity_m` 80 | −3.6% | LAN error doubles (0.084 → 0.177 m); bodies leave interest while visible |
| `snapshot.dynamic_aoi_m` 60 | −0.5% | none |
| `snapshot.budget_bytes` 600 | 0 | never binds |
| baselines every 0.5 s | +9% | worse on lossy links (more generation switches) |
| `snapshot.interval_ticks` 2 (30 Hz) | −10% netcode (snapshots halve) | drawn behind +20 ms on LAN, +27 ms on LTE; poor-mobile error worse |

Quantisation is fixed by the wire format (cm positions, 32-bit quaternions,
1 cm/s and 1 mrad/s velocities). It is not a knob, and changing it needs a
client decoder change. The lanes are already the right ones: snapshots and
city poses on datagrams, topology and baselines reliable.

## Live confirmation

`scripts/perf/city-bench.sh --scenario quick --clients 3 --label <x>
--baseline target/netlab-v2/bundles/heavy-quick3-v2/report.json`, on ports
5101/5102/3513 under the GPU lock. The baseline is the heavy-quick3-v2
recording (clean 91c814bb). Two runs, both 3/3 paired bundles with 0 errors
(measured):

- **final:** this change rebased on 2c84b393 (all six changes, the
  gravity-fixed client, item 6 upstream).
  `target/stream-tune/city-bench/runs/20260924-113249-stream-tune-final`.
- **first:** the same on 0a7d6ae5, without change 6 or item 6.
  `target/stream-tune/city-bench/runs/20260924-111544-stream-tune-rec`.

| Metric (measured, live) | Client | Baseline | First | Final |
|---|---|---:|---:|---:|
| Bonds broken / peak active bodies | server | 40.1% / 634 | 22.7% / 450 | 30.3% / 410 |
| Body render error p99 (m) | c0 / c1 / c2 | 0.25 / 0.69 / 0.34 | 0.22 / 0.43 / 0.20 | 0.08 / 0.26 / 0.08 |
| Stale body draws | c0 / c1 / c2 | 7 / 4 / 8 | 1 / 1 / 1 | 1 / 1 / 1 |
| City bytes per moving body-second | c0 / c1 / c2 | 229.1 / 207.2 / 212.7 | 236.9 / 231.1 / 229.0 | 213.8 / 210.3 / 209.8 |
| City bytes per record | c0 | 30.98 | 29.86 | 29.74 |
| kbit/s (all kinds) | c0 / c1 / c2 | 263.9 / 235.6 / 243.7 | 171.1 / 161.2 / 162.2 | 197.8 / 190.1 / 188.7 |
| Send→arrive p99 (ms) | c0 / c1 / c2 | 5.5 / 4.8 / 4.8 | 4.2 / 4.5 / 3.9 | 4.2 / 4.2 / 4.2 |
| Structure repairs | c0 / c1 / c2 | 2 / 5 / 5 | 5 / 2 / 8 | 0 / 0 / 0 |
| Render clock back-steps | all | 0 | 0 | 0 |
| Meteor backward frames | c0 / c1 / c2 | 1 / 0 / 2 | 3 / 4 / 5 | 4 / 2 / 1 |

**The live run does not reproduce the session.** GPU rigid bodies are not
deterministic, and each run broke a different share of the city (the report
flags it). Totals such as kbit/s therefore mostly track how much was
destroyed.

- **Confirmed live** (measured):
  - the new defaults run cleanly with 3 clients;
  - drawn-body error p99 falls 62–77% and stale draws 75–88%, on every
    client;
  - bytes per record fall;
  - send→arrive latency does not rise;
  - zero structure repairs (item 6).
- **Bytes per moving body-second: indicative only.** It falls on c0 (−6.7%)
  and is within ±2% on c1/c2 in the final run; it rose 3–12% in the first
  run, which had half the baseline's destruction. The controlled comparison is
  the frozen-truth lab, where it goes **229.1 → 188.8 (−17.6%)**; the lab's
  production value reproduces the live baseline's 229.1 exactly.
- **Meteor backward frames: not attributed.** They are single-digit and move
  both ways. Meteors are drawn by the client meteor layer from the snapshot
  stream, which this change does not touch.

## Rate adaptation

Each client's city stream now picks its own byte budget and send cadence from
its measured link (`server/src/link_rate.rs`, on by default,
`VIBE_CITY_RATE_ADAPT=0` turns it off). A link that keeps up gets the static
ceiling, byte for byte as before. Only a link that cannot carry the stream is
paced. The wire format and protocol version are unchanged, and WebSocket
sessions are untouched.

### Signals (what the server can read, per connection)

| Signal | Source | Used for |
|---|---|---|
| Datagram send-buffer occupancy | quinn `datagram_send_buffer_space()` (1 MiB buffer, now set explicitly in `wt_transport_config`) | A queue at the sender |
| RTT above its 10 s minimum | quinn `stats().path.rtt` | A queue in the network |
| UDP bytes sent, lost bytes, packets sent / lost | quinn `stats().udp_tx`, `stats().path` | Delivery rate (the capacity samples); loss with a standing queue |
| Bytes the server queued, all lanes | new counter in `outbound::Sender` | The share the city does not own (snapshots, topology, baselines) |
| cwnd | quinn `stats().path.cwnd` | Not used: see below |
| Client ACKs / NACKs | – | None exist for city datagrams (open loop) |

**Where the queue forms** (measured, real transport, no privileges). The test
`quic_rate_tests` in `server/src/main.rs` runs a WebTransport session through
a userspace relay that paces the server-to-client direction at 1 Mbit/s, with
a 200 ms drop-tail queue and 15 ms one way. The server is configured as in
production (BBR), and the stream offers its worst case: the full ceiling on
every send.

- **quinn 0.11's BBR does not hold datagrams back.** Its window grew from
  360 kB to 1.2 MB over 8 s while the path dropped 55%. The datagram buffer
  never held more than 95 B.
- **The queue formed in the network instead.** RTT rose to 208 ms, 44.9% of
  datagrams were delivered, and one-way p50 was 206 ms.
- **So the controller reads both queues.** The sender buffer (the lab's old
  paced model; Cubic, or a pacing BBR) and RTT inflation (quinn's BBR today).
- **cwnd is not used.** It says nothing a delivery rate does not, and here it
  was plainly wrong.

### Controller (delay-based, BBR-like)

- **Free** (start state): the static ceiling, unchanged. The link becomes
  **Limited** after 3 consecutive sends (~100 ms) with either ≥ 2.4 kB in
  the datagram buffer or RTT ≥ 60 ms above its minimum. Loss alone never
  throttles: random loss is not congestion, which is why the server runs BBR.
- **Limited:** city rate = `gain × 0.9 × capacity − other traffic − standing
  queue / drain time`.
  - Standing queue: beyond 20 ms at the sender, or beyond 35 ms of RTT
    inflation, which allows the send bursts' own queueing.
  - Drain time: max(250 ms, 2 RTT).
  - Capacity: the max over 1.5 s of delivery samples (200 ms spans of UDP
    bytes less the lost share, less the growth of the network queue).
    - Only spans whose queue held steady may raise it; a busy span may lower
      it.
    - It falls by at most 20% per 200 ms, unless there is loss > 10% with a
      standing queue, which cuts it by 15% at once (at most once per 2 s).
  - Probing: one 200 ms phase in eight offers 1.25× and the next 0.75×. A
    probe that found ≥ 10% more with no queue makes the next one bolder (up
    to 2.5×).
- **Cadence:** the rate fills a token bucket (capped at 2 sends). A send
  smaller than 400 B is skipped and its budget carried, so below ~100 kbit/s
  of city share the send rate falls and each send gets bigger.
- **Release:** back to Free once the path has carried the full-ceiling rate
  plus the other traffic, with no standing queue, for 5 s. A constrained link
  stays Limited through quiet stretches (the allowance does not bind then),
  so the next collapse is paced from its first send.
- **Priority under the budget is the encoder's own**
  (`ChunkStreamEncoder::client_datagrams_within`). The allowance is a min with
  the encoder's ceiling. The same ranking applies, required records first,
  then error removed per byte, and only the cut line moves.

### Netlab: the new seam (S15) and its bound

The server stage now closes the loop on a simulated link. At each of the
scored client's sends it feeds the link model every packet departed so far,
reads the same signals production reads from quinn, and runs the production
controller. The link model also gained the network-queue behaviour measured
above (`bottleneckQueueMs`, the `*-nq` profiles). Details and bounds are in
[netlab-v2.md](netlab-v2.md) (S13, S15).

- **Relay run replayed through the model** (from 3 s on; quinn, 3 runs):
  - without adaptation: 44.3% delivered vs 44.8–44.9%; one-way p50 204 vs
    206 ms;
  - with it: p50 28.4 vs 28.4–31.3 ms; p99 137 vs 81–117 ms; capacity
    916 vs 780–930 kbit/s.
- **Reading the link never changes it** (unit test). Every fast-link cell
  below is byte-identical with and without the loop.
- **Late feedback** (`lab.rate_stale_ms`): the controller reads the link 100 or 250 ms late, on 4 constrained links × 2 bundles (measured):
  - it gets more conservative: netcode bytes −3% to −11%, and some sends are merged (skipped);
  - datagram p99 moves by −15 to +26 ms;
  - ALL draws pos@render p99 by at most +0.02 m, pos@now p99 by at most +0.12 m (v2c0 cap-1mbit-nq at 250 ms);
  - moving island-frames never drawn: 0 → 91 on systematic poor-mobile at 250 ms, otherwise unchanged or lower.

  The loop is not sensitive to the model's exact feedback timing at that scale.
- `netlab2 calibrate` still passes on heavy-quick3-v2 c0 and c1 (the
  recorded link is open loop). Measured, rebased on 3f3d891a:
  - c0: 11,063/11,063 packets byte-identical, clock p99 96 µs;
  - c1: 10,861/10,861 packets byte-identical.

### Results (measured, lab)

Frozen truth, no physics rerun. Arms: `off` = `city.rate_adapt=0` (identical
to the 3f3d891a lab on every profile, checked on both bundles), `on` =
production. Bundles: **systematic-2c-d1342419 c1** (spectator, 337 s,
16 demolitions; production knobs) and **heavy-quick3-v2 c0** (122 s; the
51ddcf48 defaults by knob, `lab.recorded_repairs=0`). Seed 1.

- **Fast links, unchanged** (loopback, lan, cable, lte, lossy-wifi, both
  bundles): the controller never left Free (0 limited sends), and every
  number (bytes, latency, every all-draws class) is identical, as are the
  lab tapes' packets.
- **1 Mbit/s cap** (`cap-1mbit`, the sender-queue model) and **0.5 Mbit/s cap**
  (`bw-capped`): below.

**systematic-2c-d1342419 c1**, off → on:

| Link | Netcode kbit/s | Datagram latency p50 / p99 ms | Reliable p99 ms | Datagrams lost | ALL draws pos@render p99 / pos@now p99 m | ALL missing draw-frames | Debris (chunk_debris) render p99 / now p99 m | Moving island-frames never drawn | Island first draw p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| poor-mobile | 231 → 216 | 159 / 1,629 → 156 / 216 | 5,220 → 740 | 3.0% → 3.1% | 0.118 / 0.39 → 0.091 / 0.25 | 330 → 466 | 1.17 / 3.89 → 0.85 / 2.10 | 433 → 0 | 4,989 → 755 |
| cap-1mbit | 238 → 223 | 35 / 1,507 → 35 / 79 | 5,064 → 732 | 0.0% → 0.0% | 0.052 / 0.27 → 0.039 / 0.16 | 222 → 212 | 0.66 / 3.10 → 0.42 / 1.34 | 0 → 0 | 4,556 → 436 |
| bw-capped | 238 → 194 | 43 / 6,348 → 38 / 98 | 16,535 → 1,882 | 0.0% → 0.0% | 4.427 / 6.32 → 0.052 / 0.20 | 100,911 → 287 | 37.52 / 41.34 → 0.94 / 2.04 | 1,019 → 105 | 18,350 → 1,099 |
| poor-mobile-nq | 220 → 215 | 158 / 356 → 157 / 255 | 906 → 611 | 5.1% → 3.0% | 0.103 / 0.28 → 0.097 / 0.26 | 640 → 656 | 1.14 / 2.64 → 0.94 / 2.17 | 0 → 0 | 1,021 → 1,343 |
| cap-1mbit-nq | 226 → 220 | 35 / 225 → 35 / 100 | 323 → 106 | 2.2% → 0.0% | 0.043 / 0.17 → 0.040 / 0.15 | 212 → 210 | 0.54 / 1.85 → 0.40 / 1.29 | 0 → 0 | 197 → 108 |
| bw-capped-nq | 200 → 187 | 38 / 241 → 38 / 204 | 512 → 277 | 8.2% → 0.2% | 0.080 / 0.28 → 0.054 / 0.19 | 643 → 213 | 1.52 / 3.31 → 0.56 / 1.57 | 0 → 0 | 339 → 175 |

**heavy-quick3-v2 c0**, off → on:

| Link | Netcode kbit/s | Datagram latency p50 / p99 ms | Reliable p99 ms | Datagrams lost | ALL draws pos@render p99 / pos@now p99 m | ALL missing draw-frames | Debris (chunk_debris) render p99 / now p99 m | Moving island-frames never drawn | Island first draw p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| poor-mobile | 213 → 194 | 160 / 1,699 → 157 / 223 | 8,469 → 784 | 3.0% → 3.1% | 0.849 / 2.04 → 0.103 / 0.28 | 638 → 220 | 8.46 / 9.32 → 1.03 / 2.10 | 0 → 0 | 8,569 → 875 |
| cap-1mbit | 219 → 199 | 35 / 1,580 → 34 / 88 | 8,202 → 437 | 0.0% → 0.0% | 0.634 / 1.73 → 0.080 / 0.19 | 352 → 169 | 7.93 / 9.03 → 0.52 / 1.52 | 0 → 0 | 8,445 → 575 |
| bw-capped | 219 → 174 | 39 / 9,049 → 37 / 107 | 21,775 → 1,181 | 0.0% → 0.0% | 3.765 / 6.12 → 0.088 / 0.26 | 315 → 145 | 13.75 / 21.63 → 1.17 / 2.10 | 0 → 0 | 21,945 → 1,005 |
| poor-mobile-nq | 200 → 185 | 158 / 354 → 156 / 313 | 770 → 752 | 5.7% → 3.3% | 0.107 / 0.31 → 0.118 / 0.30 | 150 → 267 | 1.03 / 2.55 → 1.29 / 2.55 | 0 → 0 | 789 → 764 |
| cap-1mbit-nq | 206 → 189 | 35 / 226 → 34 / 88 | 300 → 124 | 2.7% → 0.0% | 0.088 / 0.23 → 0.088 / 0.20 | 115 → 161 | 0.54 / 1.79 → 0.72 / 1.62 | 0 → 0 | 303 → 203 |
| bw-capped-nq | 180 → 170 | 37 / 236 → 37 / 148 | 446 → 164 | 7.7% → 0.0% | 0.122 / 0.37 → 0.088 / 0.24 | 168 → 159 | 2.64 / 3.42 → 1.06 / 1.97 | 0 → 0 | 594 → 187 |

What it says (inferred from the tables):

- **Latency falls on every constrained link.**
  - Datagram p99: 1.5–9 s → 79–223 ms with the queue at the sender; 225–356
    → 88–313 ms with it in the network.
  - Reliable p99 (topology, baselines) falls 5–18× at the sender and 1.3–3×
    in the network.
- **Error falls where the link saturated.**
  - bw-capped systematic: ALL draws pos@render p99 4.43 → 0.052 m, pos@now
    p99 6.32 → 0.20 m, missing draw-frames 100,911 → 287.
  - heavy-quick3-v2 on poor-mobile / 1 Mbit / 0.5 Mbit: debris render p99
    8.5 / 7.9 / 13.8 m → 1.0 / 0.5 / 1.2 m.
- **Moving debris never drawn** (`all_draws.first_draw`, islands):
  - systematic poor-mobile: 433 → 0 frames;
  - systematic bw-capped: 1,019 → 105 frames.
  - The island first-draw p99 falls 5–20× at the sender.
- **Loss falls with the queue in the network:** 7.7–8.2% → 0–0.2% on
  bw-capped-nq, 2.2–2.7% → 0% on cap-1mbit-nq.
- **Costs:**
  - Bytes fall 2–20%, by design.
  - With the queue in the network the capacity estimate sits below the path
    (0.7–0.9 of it), so debris render p99 rises on two cells (v2c0
    cap-1mbit-nq 0.54 → 0.72 m, poor-mobile-nq 1.03 → 1.29 m).
  - systematic poor-mobile-nq island first-draw p99 rises 1,021 → 1,343 ms,
    while its p50 and every error percentile are unchanged or lower.

**Seed replicates** (seeds 2–3, constrained links): seed 2 on poor-mobile, cap-1mbit, bw-capped, cap-1mbit-nq and bw-capped-nq, both bundles: every direction above holds (for example, systematic bw-capped datagram p99 6,347 → 98 ms, never-drawn island-frames 1,019 → 103; v2c0 poor-mobile ALL pos@render p99 0.822 → 0.118 m). Runs: `target/rate-adapt/final/seed2-*`.

### Live (measured)

`scripts/perf/city-bench.sh --scenario quick --clients 3` on loopback (ports 5501/5502/3553, GPU lock, bench out `target/rate-adapt/city-bench`), with a second run of the same build with `VIBE_CITY_RATE_ADAPT=0` as an A/B:

- `runs/20260924-125425-rate-adapt` (on);
- `runs/20260924-132254-rate-adapt-off` (off).

Both runs: 3/3 paired bundles, 0 errors.

- **The controller never engaged on loopback.** It logged 0 state changes in the whole run (`city stream rate adaptation` lines in `server.log`), so every client got the static ceiling, as in the lab's fast-link cells.
- **City encode cost:** step p95 0.167 ms, encode p95 0.160 ms (whole city 1.3% of the tick).

| Metric (measured, live) | stream-tune-final (2c84b393 + tuning) | this, off | this, on |
|---|---:|---:|---:|
| Bonds broken / peak active bodies | 30.3% / 410 | 32.5% / 418 | 28.8% / 374 |
| Server tick p95 / p99 ms | 25.8 / 44.0 | 32.4 / 53.1 | 23.4 / 42.0 |
| Server % ticks over 16.7 ms | 8.8 | 14.5 | 11.6 |
| kbit/s c0 / c1 / c2 | 197.8 / 190.1 / 188.7 | 192.5 / 176.2 / 172.8 | 189.3 / 181.4 / 180.2 |
| Send→arrive p99 ms c0 / c1 / c2 | 4.24 / 4.18 / 4.16 | 3.96 / 3.97 / 3.73 | 4.10 / 3.68 / 3.60 |
| Structure repairs | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Body render error p99 m c0 / c1 / c2 | 0.08 / 0.26 / 0.08 | 0.16 / 1.89 / 0.32 | 0.13 / 2.15 / 0.35 |
| Budgets failed (of 27) | 9 | 11 | 11 |

Reading it:

- **No regression is attributable to rate adaptation** (measured, A/B). Off and on fail the same 11 budgets.
- **The body render error rise is not the controller's.**
  - It rose against stream-tune-final (c1 0.26 → 2.15 m) and is present with adaptation off too (1.89 m).
  - It is the dynamic-body snapshot class (146 matched samples on c1, so p99 is about the second-worst sample). The controller does not touch that stream.
  - The run also uses the 3f3d891a client, whose drawn-world probe changed (inferred).
- **Server tick variance is GPU physics** (dynamics 97.8% of the tick): each run broke a different share of the city.
- **Constrained links were not run live.** The existing netem tooling (`scripts/netem.sh`, `--impair-mode netem`) needs CAP_NET_ADMIN / root, and the in-process impairment acts after QUIC, so it cannot create a bottleneck the sender sees. That leaves the real-transport relay test above (no privileges) as the live-stack check for constrained links.

### Reproduce

```bash
N=target/rate-adapt/cargo/release/netlab2   # CARGO_TARGET_DIR of your build
B=target/netlab-v2/bundles/systematic-2c-d1342419/debug-reports/session-netlab2-20260924-115042-systematic-2c-c1
$N matrix --bundle $B --out <dir> --links loopback,lan,cable,lte,lossy-wifi,poor-mobile,cap-1mbit,bw-capped,poor-mobile-nq,cap-1mbit-nq,bw-capped-nq \
   --knob-sets "off:lab.recorded_repairs=0,city.rate_adapt=0;on:lab.recorded_repairs=0"
cargo test -p web-fps-server --bin web-fps-server -- --ignored rate_adaptation_on_real_quic --nocapture
```

### Tests

- `server/src/link_rate.rs`: 8 unit tests on a fluid link model, both queue
  locations.
  - Negative test: `a_fast_link_is_never_throttled`. Loopback- to 5 Mbit-
    class paths, collapse-burst demand, up to 20% random loss: every send
    keeps the ceiling.
  - Step response: 0.5 Mbit/s with the queue at the sender; 1 Mbit/s with a
    200 ms and a 2 s network queue.
  - Capacity drop and drain.
  - Loss response: random loss is not congestion, loss with a queue is.
  - Recovery: a faster path is found and released in 10.3 s.
  - Cadence on a 96 kbit/s path; disabled means always Full.
- `server/src/main.rs` `quic_rate_tests` (ignored, real time ~17 s): the
  real-transport relay test above.
- `destruction/src/encoder.rs`: `a_link_allowance_moves_only_the_cut_line`.
- `server/src/outbound.rs`: `the_sender_counts_the_bytes_it_queued_on_both_lanes`.
- `netlab2` `link.rs`: `reading_the_link_changes_nothing_and_reports_the_sender`,
  `the_network_queue_model_matches_quinn_through_a_paced_relay`.

### Risks

- **The network-queue signal is RTT.**
  - On a jittery path (real LTE), smoothed RTT can sit tens of ms above its
    minimum with no queue. The entry needs 60 ms for 3 consecutive sends,
    and the lab's RTT carries no jitter, so a false entry on a jittery fast
    link is not ruled out by these runs (inferred).
  - If one happens, the probes and the release rule bring the link back to
    the ceiling (about 10 s in the unit test).
- **The minimum RTT is windowed (10 s).** A link that stays queued for longer
  loses its baseline. Limited links drain every probe cycle, so this should
  not happen while adapting (inferred).
- **A pure policer (no queue, loss only) is not detected.** Loss alone never
  throttles, by design.
- **Capacity with the queue in the network is conservative:** 0.7–0.9 of the
  path in the lab, 780–930 of ~950 kbit/s through the relay. That trades a
  little fidelity for latency.
- **Only the scored client is closed-loop in the lab.** Other clients get
  the static ceiling there, which does not change the scored client's bytes.
- **quinn's BBR is the underlying problem.** It sends far above the path and
  lets the network drop the rest. Adaptation keeps the offered load under the
  path, which also removes the snapshots' share of that loss (relay test:
  44.9% → 100% delivered). But the first ~100–200 ms of a collapse, before
  the link counts as constrained, still overruns it. Pacing quinn (Cubic, or
  a fixed BBR) is a separate decision.

## City latency and topology delivery

Items 12-16 of the [2026-09-24 session analysis](mac-metal-session-analysis-2026-09-24.md)
made the city's presentation correct: its render clock stays behind the pose
stream and holds for promotions in flight. That left two weaknesses. This
round measured both on the same frozen truth and addressed the second. The
first turned out to be mostly the link itself. Claims are marked
**measured** or **inferred**; "87b40c9e" is that commit's server and client.

### Summary

- **Constrained links** (0.5-1 Mbit/s, poor-mobile): wrong-identity
  chunk-frames fall 8-5,000× to the fast-link level. Topology arrives in
  datagram time: p99 0.6-1.9 s → 74-316 ms. The worst presentation lag
  (p1, the hold tail) falls 12-20 ticks at 0.5-1 Mbit/s and 2-9 ticks on
  poor-mobile, and debris pos@now p99 falls 28-53%.
  - This comes from **topology copies on the datagram lane** and a
    **reliable-stream signal in the rate controller**. Both are kept, on by
    default.
- **LTE**:
  - Presented lag is unchanged: p50 −10.2 → −10.0 ticks; p1 within seed
    noise.
  - Wrong identity is unchanged within seed noise.
  - Topology p99 falls 340 → 130 ms, island first-draw p99 376 → 209 ms,
    and missing draws 574 → 194.
  - About 4 of the 10 ticks are the one-way latency (measured, the render
    clock's lag). The other 6 are the fixed delay, and the jitter needs
    about 5 of them to present only ticks that have arrived (inferred, from
    the frame-lead percentile below).
  - A smaller delay (the adaptive delay, built and left opt-in) gives back
    about 1 tick on LTE and 2.5 on loopback. The price is more debris
    corrected in view. Extrapolating ahead of the data costs more.
- **Cost:** +6-8% netcode bytes for the copies. On the tightest link with
  the heavy bundle, debris render-time fidelity is lower, because bytes go
  to topology first.

### The weaknesses and their root causes (measured, systematic c1, 87b40c9e)

1. **Latency on jittery links.**
   - Presented tick (render tick minus the playout delay) behind the
     server: p50 10.2 ticks on LTE and 14.1 on poor-mobile, p1 34.5 and
     42.3.
   - Per frame on LTE, the render clock is 4.0 ticks behind the server.
     That is the one-way latency, since the clock is anchored to arrivals.
     On top of it comes the fixed 6-tick delay.
   - The tail is the topology hold. 717 LTE frames were held for a
     promotion that the reliable stream delivered late: topology p99 340 ms
     against 124 ms for datagrams, head-of-line blocked on 3% loss.
2. **Topology starved on constrained links.**
   - The QUIC sender writes datagrams before stream data (quinn; the lab
     models it).
   - With the city filling its share of the path, a fracture's topology or
     a baseline waits behind the pose stream. Topology p99 was 799 ms on
     cap-1mbit and 1,924 ms on bw-capped (0.5 Mbit/s), baselines 679 /
     1,944 ms.
   - Wrong-identity chunk-frames were 2,548 and 39,830.
   - The task's 26,193 (systematic poor-mobile) and 631k (heavy) were
     measured before rate adaptation (129e0dac) was in the lab. At 87b40c9e
     they are 3,686 and 757.

### What was built

**1. Topology copies on the datagram lane: kept, on**
(`destruction/src/encoder.rs` `EncoderConfig::topology_datagram_copies`,
default 2; client `cityClient.ts` `acceptTopology`). A length-detected
wire change, no protocol bump:

- **The copy.** Each reliable topology message is also copied, byte for
  byte, at the client's next two sends. The copy travels in record-less
  chunk datagrams (`PKT_CITY_CHUNKS`, record count 0) as trailer sections:
  tag `0xC7`, seq, part, parts, length, bytes (`wire.rs`
  `CHUNKS_TRAILER_TOPOLOGY_PART`).
  - Older decoders read `record_count` records and stop, so they ignore
    the trailer.
  - Messages larger than a datagram are split into parts.
  - First copies go before repeats, and all copies go ahead of the send's
    records.
  - The copy datagram is stamped with the previous send's tick, so no
    client's pose clock advances on it.
- **The reliable message still goes.** The client applies whichever copy
  arrives first, strictly in `topo_seq` order:
  - a copy ahead of a missing seq waits;
  - late copies and reliable duplicates are dropped;
  - a structure repair that arrives behind copies is restated, and the
    kept messages since it are re-applied for its structures
    (`reapplyForStructures`).
- **Gap evidence holds the presentation.** A copy can show that a message
  is missing. The presentation then holds below that message's tick, which
  is exact from its first piece (`topologyGapLimit`, bounded to 1 s like
  the existing hold).
- **The lead cap stays on.** A copy-only datagram keeps the lead cap on
  (`streamAliveAtMs`). Otherwise, while the rate controller withheld poses,
  the cap lapsed after 300 ms and the clock ran 30+ ticks past the server
  (measured, bw-capped-nq).
- **Copies are paid from the send's budget.** Records get what the copies
  leave (`SendPlan::after_topology`, `RateController::sent_topology`).
- **Old captures are unchanged.** Captures made before this read the
  setting as 0 and replay byte-exact. The lab turns it on with
  `city.topology_copies=2`.

**2. A reliable-stream signal in the rate controller: kept, on**
(`server/src/link_rate.rs`, `reliable_queue_ms` 60, `reliable_drain_ms`
150; `outbound` counts the bytes queued on the reliable lane):

- **The estimate.** The controller estimates the stream's unsent bytes as
  reliable bytes queued, less the wire bytes that were not datagrams. That
  is UDP bytes, minus an assumed 24 B per packet, minus the datagram bytes
  that left quinn's buffer. The estimate is floored at zero.
- **The yield.** On a link the datagram or network-queue signals have made
  `Limited`, reliable bytes that have waited 60 ms make the city give the
  backlog back within 150 ms.
- **It never makes a link limited.** The first version let a waiting
  stream enter the limited state.
  - In the lab that helped a little more (cap-1mbit baselines p99 306
    instead of 410 ms).
  - Live on loopback, it put all three links `Limited` at their joins and
    kept them there for the whole run (0 B buffered, capacity estimate
    133-650 kbit/s; `20260924-152415-quick-3c-citylat` `server.log`).
    That capture also failed byte calibration (city chunks 1-17%
    identical), because the recorded link replays live plans open loop.
  - The estimate cannot tell a stream starved by datagrams from one that
    is flow-controlled or still in the server's own queue. The lab models
    neither (seam S15).
- **The estimate errs low in the lab.** Against the lab model's own count
  of unsent stream bytes, estimate minus truth is p1 −0.3 to −1.1 kB,
  p50 0 and p99 0. It is never more than 1.2 kB over, on any constrained
  cell (`rate-trace.jsonl`).

**3. An adaptive playout delay: built, off** (`cityClient.ts`
`ADAPTIVE_PLAYOUT_DELAY`; `/city?adaptiveDelay=1`, lab
`CITY_ADAPTIVE_DELAY=1`):

- **The rule.** The wire-v2 delay is the 99th percentile over 4 s of the
  render clock's lead over the newest streamed tick. The lead is sampled
  at every frame before the lead cap. The delay stays within 3-6 ticks,
  and the lead cap follows the current delay.
- **What the percentile keeps.** At that percentile the cap stops the
  clock no more often than the fixed delay did.
- **Why it is off.** The ticks it gives back are paid for in corrections:
  with less delay, a record more often lands after the presentation
  passed its tick, and fast debris is then corrected in view.
  - Measured with the delay fixed at 6 / 5 / 4 / 3 ticks on the
    20260924-161728 capture (c1), loopback:
    - presented tick behind the server p50: 5.2 / 4.2 / 3.2 / 2.3;
    - presented jumps over 4 m: 54 / 67 / 72 / 79;
    - correction snaps: 25 / 31 / 33 / 37;
    - debris pos@render p99: 0.134 / 0.143 / 0.153 / 0.163 m;
    - pos@now p99: 2.55 / 2.24 / 2.04 / 1.85 m.
  - On LTE the adaptive delay stays near 5 (the lead's tail is the jitter).
    With both kept changes it gains 0.9 tick at p50 (−10.0 → −9.1), for
    215 vs 211 jumps on the systematic bundle and 38 vs 34 on the
    20260924-162732 capture.
  - Loopback gains 2.5 ticks, for 206 vs 198 jumps (systematic) and 41 vs
    31 (the 162732 capture).
  - It is a choice between being fewer ticks behind and fewer visible
    corrections, not a fix, so the default is unchanged.

### Options tried and not kept (measured)

| Option | Result | Verdict |
|---|---|---|
| Delay from datagram arrivals (p98 of render clock minus tick at arrival, + 1 tick) | LTE lag p50 −10.2 → −8.4, but frames with the presentation stopped 4.2% → 6.2% (−8.0 and 7.6% at p95). Arrivals are measured against a clock the cap already holds to the newest tick, so the estimate collapses to its floor. Exploratory runs, not kept. | replaced by the frame-lead estimate |
| Frame-lead estimate at p95 / p97 / p99 (floor 2) | LTE lag p50 −8.7 / −8.5 / −9.1; stopped frames 4.5% / 4.9% / 4.0% (fixed: 4.2%). Exploratory runs, not kept. | p99 |
| Delay floor 2 or 4 instead of 3 | the fixed-delay sweep above: every tick less costs corrections | 3, and the delay itself off |
| Gravity-aware extrapolation of ballistic debris ahead of the presentation (4 / 8 ticks) | LTE debris pos@now p99 1.91 → 1.43 / 1.14 m, but pos@render p99 0.12 → 0.75 / 1.34 m, and presented jumps over 4 m 228 → 282 / 687: a body jumps by the lead whenever its class flips (`ahead4-sys`, `ahead8-sys`) | rejected |
| Holding only the affected bodies | with copies the hold runs on 275 of 39,845 LTE frames (0.7%), 0 on cap-1mbit and bw-capped-nq, and the p50 lag does not move with it | not built: it could touch under 1% of frames |
| Gap hold only with the missing message's exact tick, or no gap hold (LTE, poor-mobile, 3 seeds) | identical lag and wrong identity with the exact-only variant; without the gap hold, poor-mobile seed 2 wrong identity 45 → 477 | kept as built |
| One topology copy instead of two | LTE wrong identity 529 → 1,419, lag p1 −26.4 → −34.0; lossless constrained links unchanged (`c1-sys`) | two |
| Copies after the records | the presentation reached a tick from its send's first datagram while the promotion rode the last (18 ms later at 0.5 Mbit/s) | copies first |
| Reliable signal entering the limited state | see above: every loopback link limited, live | entry removed |
| `reliable_drain_ms` 300 / 600 (with entry) | heavy c1 bw-capped debris pos@render p99 0.77 → 0.80 / 0.70 m; systematic bw-capped baselines p99 585 → 1,227 ms at 600 | 150 |

### Attribution (measured, systematic c1, seed 1)

"Topology delivered" is the first copy or reliable message to arrive, from
the end of the message's tick, read from the lab tape. "Both" is this
change's default.

| Link | Arm | Wrong identity | Presented − server p50 / p1 (ticks) | Topology delivered p99 (ms) | Baseline parts p99 (ms) | Debris pos@render / pos@now p99 (m) |
|---|---|---:|---|---:|---:|---|
| loopback | 87b40c9e | 0 | -5.2 / -16.6 | 0 | 0 | 0.088 / 1.52 |
| loopback | copies | 0 | -5.2 / -16.6 | 0 | 0 | 0.088 / 1.52 |
| loopback | reliable signal | 0 | -5.2 / -16.6 | 0 | 0 | 0.088 / 1.52 |
| loopback | both (this change) | 0 | -5.2 / -16.6 | 0 | 0 | 0.088 / 1.52 |
| loopback | adaptive delay alone (opt-in) | 0 | -2.7 / -16.4 | 0 | 0 | 0.088 / 1.34 |
| loopback | both + adaptive delay | 0 | -2.7 / -16.4 | 0 | 0 | 0.088 / 1.34 |
| lte | 87b40c9e | 448 | -10.2 / -34.5 | 340 | 346 | 0.114 / 2.39 |
| lte | copies | 529 | -10.0 / -26.4 | 130 | 362 | 0.118 / 2.55 |
| lte | reliable signal | 448 | -10.2 / -34.5 | 340 | 346 | 0.114 / 2.39 |
| lte | both (this change) | 529 | -10.0 / -26.4 | 130 | 362 | 0.118 / 2.55 |
| lte | adaptive delay alone (opt-in) | 832 | -9.4 / -34.8 | 340 | 346 | 0.118 / 2.39 |
| lte | both + adaptive delay | 523 | -9.1 / -26.0 | 130 | 362 | 0.118 / 2.47 |
| poor-mobile | 87b40c9e | 3686 | -14.1 / -42.3 | 770 | 728 | 0.130 / 4.15 |
| poor-mobile | copies | 456 | -14.0 / -37.8 | 216 | 938 | 0.122 / 3.31 |
| poor-mobile | reliable signal | 7309 | -14.0 / -41.2 | 749 | 597 | 0.130 / 4.15 |
| poor-mobile | both (this change) | 456 | -13.8 / -33.1 | 217 | 755 | 0.114 / 3.00 |
| poor-mobile | adaptive delay alone (opt-in) | 3677 | -13.6 / -42.3 | 770 | 728 | 0.138 / 4.02 |
| poor-mobile | both + adaptive delay | 456 | -13.2 / -33.1 | 217 | 755 | 0.118 / 3.00 |
| poor-mobile-nq | 87b40c9e | 5620 | -13.8 / -37.4 | 619 | 641 | 0.126 / 3.77 |
| poor-mobile-nq | copies | 425 | -13.8 / -36.0 | 316 | 581 | 0.114 / 3.20 |
| poor-mobile-nq | reliable signal | 5620 | -13.8 / -37.4 | 619 | 641 | 0.126 / 3.77 |
| poor-mobile-nq | both (this change) | 425 | -13.8 / -36.0 | 316 | 581 | 0.114 / 3.20 |
| poor-mobile-nq | adaptive delay alone (opt-in) | 7575 | -13.1 / -37.4 | 619 | 641 | 0.134 / 3.77 |
| poor-mobile-nq | both + adaptive delay | 425 | -13.3 / -36.0 | 316 | 581 | 0.118 / 3.20 |
| cap-1mbit | 87b40c9e | 2548 | -7.3 / -31.5 | 799 | 679 | 0.103 / 2.72 |
| cap-1mbit | copies | 250 | -7.3 / -20.9 | 75 | 612 | 0.094 / 1.97 |
| cap-1mbit | reliable signal | 826 | -7.3 / -28.1 | 403 | 407 | 0.100 / 2.17 |
| cap-1mbit | both (this change) | 250 | -7.3 / -19.1 | 74 | 410 | 0.094 / 1.91 |
| cap-1mbit | adaptive delay alone (opt-in) | 2564 | -4.9 / -31.5 | 799 | 679 | 0.107 / 2.64 |
| cap-1mbit | both + adaptive delay | 250 | -5.1 / -19.0 | 74 | 410 | 0.097 / 1.79 |
| bw-capped | 87b40c9e | 39830 | -7.8 / -40.7 | 1924 | 1944 | 0.179 / 4.57 |
| bw-capped | copies | 15 | -7.8 / -23.0 | 114 | 2256 | 0.148 / 2.24 |
| bw-capped | reliable signal | 1248 | -7.6 / -36.1 | 738 | 547 | 0.143 / 2.91 |
| bw-capped | both (this change) | 355 | -7.7 / -20.8 | 111 | 921 | 0.158 / 2.17 |
| bw-capped | adaptive delay alone (opt-in) | 39999 | -6.9 / -40.2 | 1924 | 1944 | 0.204 / 4.43 |
| bw-capped | both + adaptive delay | 355 | -6.3 / -20.7 | 111 | 921 | 0.158 / 2.10 |

The reliable signal alone does not reduce wrong identity: topology still
waits on the stream until a link is limited, and poor-mobile went 3,686 →
7,309 on this seed. What it brings is the baselines (cap-1mbit 679 → 407,
bw-capped 1,944 → 547 ms) and, with the copies, a shorter tail.

### Before / after (measured)

87b40c9e (`base-*`) against this tree (`fin-*`), production knobs plus
`city.topology_copies=2` on captures that predate it, seed 1, recorded pace.

- **Frames stopped** counts frames whose presented tick advanced by under
  0.05 ticks per server tick of wall time. That includes the server's own
  stalls.
- **Topology delivered** and **baseline parts** are read from the lab tape.
- `netlab2 compare` output is in `target/city-latency/compare/<bundle>/compare.md`.

**systematic-2c-d1342419 c1:**

| Link | Wrong-identity chunk-frames | Presented − server tick p50 / p1 (ticks) | Frames stopped | Debris pos@render p99 (m) | Debris pos@now p99 (m) | ALL pos@render / pos@now p99 (m) | ALL missing / extra | Island first draw p99 (ms) | Topology delivered p99 (ms) | Baseline parts p99 (ms) | kbit/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 0 → 0 | -5.2 / -16.6 → -5.2 / -16.6 | 3.2% → 3.2% | 0.088 → 0.088 | 1.52 → 1.52 | 0.026 / 0.138 → 0.026 / 0.138 | 12 / 2562 → 12 / 2562 | 10 → 10 | 0 → 0 | 0 → 0 | 240 → 261 |
| lan | 0 → 0 | -5.3 / -16.6 → -5.3 / -16.6 | 3.2% → 3.2% | 0.085 → 0.085 | 1.52 → 1.52 | 0.026 / 0.138 → 0.026 / 0.138 | 0 / 2563 → 0 / 2559 | 10 → 10 | 1 → 1 | 1 → 1 | 240 → 261 |
| cable | 74 → 71 | -5.9 / -17.2 → -5.9 / -17.2 | 3.2% → 3.2% | 0.088 → 0.088 | 1.62 → 1.62 | 0.026 / 0.153 → 0.026 / 0.158 | 11 / 2568 → 10 / 2568 | 22 → 23 | 15 → 15 | 15 → 16 | 240 → 261 |
| lte | 448 → 529 | -10.2 / -34.5 → -10.0 / -26.4 | 4.2% → 3.6% | 0.114 → 0.118 | 2.39 → 2.55 | 0.029 / 0.265 → 0.030 / 0.265 | 574 / 4235 → 194 / 4604 | 376 → 209 | 340 → 130 | 346 → 362 | 240 → 261 |
| lossy-wifi | 84 → 106 | -6.0 / -29.0 → -6.0 / -31.2 | 4.0% → 4.0% | 0.100 → 0.100 | 1.68 → 1.73 | 0.029 / 0.168 → 0.029 / 0.168 | 67 / 3740 → 109 / 3858 | 84 → 41 | 92 → 58 | 107 → 95 | 240 → 261 |
| poor-mobile | 3686 → 456 | -14.1 / -42.3 → -13.8 / -33.1 | 5.2% → 4.0% | 0.130 → 0.114 | 4.15 → 3.00 | 0.029 / 0.444 → 0.032 / 0.343 | 312 / 4610 → 224 / 3685 | 755 → 329 | 770 → 217 | 728 → 755 | 225 → 242 |
| poor-mobile-nq | 5620 → 425 | -13.8 / -37.4 → -13.8 / -36.0 | 4.3% → 4.2% | 0.126 → 0.114 | 3.77 → 3.20 | 0.031 / 0.366 → 0.030 / 0.354 | 325 / 3563 → 116 / 4348 | 1343 → 336 | 619 → 316 | 641 → 581 | 223 → 243 |
| cap-1mbit | 2548 → 250 | -7.3 / -31.5 → -7.3 / -19.1 | 3.6% → 3.4% | 0.103 → 0.094 | 2.72 → 1.91 | 0.027 / 0.240 → 0.027 / 0.198 | 3 / 2674 → 1 / 2810 | 436 → 151 | 799 → 74 | 679 → 410 | 225 → 243 |
| cap-1mbit-nq | 391 → 284 | -7.3 / -19.4 → -7.4 / -22.4 | 3.3% → 3.6% | 0.094 → 0.094 | 1.97 → 2.04 | 0.027 / 0.191 → 0.027 / 0.204 | 11 / 2730 → 0 / 3044 | 108 → 99 | 110 → 111 | 117 → 127 | 222 → 242 |
| bw-capped | 39830 → 355 | -7.8 / -40.7 → -7.7 / -20.8 | 4.9% → 4.5% | 0.179 → 0.158 | 4.57 → 2.17 | 0.027 / 0.430 → 0.030 / 0.232 | 58 / 2749 → 12 / 2946 | 1099 → 226 | 1924 → 111 | 1944 → 921 | 196 → 206 |
| bw-capped-nq | 488 → 352 | -7.5 / -23.2 → -7.8 / -24.9 | 3.5% → 4.7% | 0.148 → 0.191 | 2.24 → 2.39 | 0.031 / 0.232 → 0.032 / 0.256 | 4 / 2617 → 17 / 2886 | 175 → 175 | 293 → 226 | 227 → 259 | 189 → 204 |

**heavy-quick3-v2 c1:**

| Link | Wrong-identity chunk-frames | Presented − server tick p50 / p1 (ticks) | Frames stopped | Debris pos@render p99 (m) | Debris pos@now p99 (m) | ALL pos@render / pos@now p99 (m) | ALL missing / extra | Island first draw p99 (ms) | Topology delivered p99 (ms) | Baseline parts p99 (ms) | kbit/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 0 → 0 | -5.2 / -16.9 → -5.2 / -16.9 | 2.9% → 2.9% | 0.179 → 0.179 | 1.62 → 1.62 | 0.110 / 0.179 → 0.110 / 0.179 | 1 / 286 → 1 / 286 | 9 → 9 | 0 → 0 | 0 → 0 | 236 → 252 |
| lan | 0 → 0 | -5.3 / -16.9 → -5.3 / -16.9 | 2.9% → 2.9% | 0.179 → 0.179 | 1.62 → 1.62 | 0.110 / 0.185 → 0.110 / 0.185 | 1 / 286 → 1 / 285 | 9 → 9 | 1 → 1 | 1 → 1 | 236 → 252 |
| cable | 6 → 6 | -5.9 / -17.6 → -5.9 / -17.6 | 2.9% → 3.0% | 0.179 → 0.185 | 1.73 → 1.73 | 0.110 / 0.191 → 0.110 / 0.191 | 1 / 287 → 1 / 286 | 22 → 23 | 16 → 15 | 17 → 16 | 236 → 252 |
| lte | 122 → 34 | -9.8 / -21.5 → -9.9 / -21.6 | 4.1% → 3.5% | 0.218 → 0.211 | 2.32 → 2.24 | 0.114 / 0.273 → 0.114 / 0.265 | 0 / 342 → 0 / 339 | 306 → 148 | 355 → 131 | 348 → 337 | 236 → 252 |
| lossy-wifi | 156 → 54 | -5.9 / -17.4 → -5.9 / -17.6 | 3.7% → 3.8% | 0.198 → 0.185 | 1.68 → 1.68 | 0.114 / 0.191 → 0.114 / 0.191 | 2 / 335 → 2 / 332 | 111 → 69 | 110 → 67 | 96 → 146 | 236 → 252 |
| poor-mobile | 757 → 51 | -13.4 / -33.0 → -13.4 / -25.4 | 4.4% → 3.6% | 0.218 → 0.301 | 3.77 → 3.00 | 0.114 / 0.490 → 0.118 / 0.378 | 50 / 325 → 53 / 595 | 947 → 230 | 886 → 232 | 987 → 752 | 213 → 225 |
| poor-mobile-nq | 231 → 57 | -13.4 / -29.5 → -13.4 / -25.8 | 4.8% → 3.9% | 0.403 → 0.430 | 3.42 → 3.20 | 0.118 / 0.444 → 0.118 / 0.403 | 1 / 339 → 1 / 345 | 722 → 331 | 657 → 323 | 616 → 895 | 208 → 220 |
| cap-1mbit | 12 → 13 | -7.1 / -21.3 → -7.1 / -19.2 | 3.2% → 3.1% | 0.218 → 0.232 | 2.47 → 2.04 | 0.114 / 0.273 → 0.114 / 0.240 | 1 / 288 → 0 / 286 | 647 → 98 | 546 → 80 | 370 → 282 | 213 → 226 |
| cap-1mbit-nq | 13 → 14 | -7.1 / -19.2 → -7.1 / -19.3 | 3.0% → 3.2% | 0.248 → 0.292 | 2.10 → 2.17 | 0.114 / 0.240 → 0.118 / 0.256 | 1 / 296 → 1 / 298 | 211 → 174 | 154 → 151 | 145 → 145 | 210 → 222 |
| bw-capped | 3090 → 12 | -7.3 / -32.7 → -7.4 / -20.5 | 4.1% → 3.8% | 0.321 → 0.746 | 3.77 → 2.55 | 0.114 / 0.474 → 0.122 / 0.332 | 1 / 292 → 1 / 301 | 981 → 148 | 1437 → 112 | 1526 → 732 | 188 → 193 |
| bw-capped-nq | 14 → 13 | -7.3 / -24.5 → -7.5 / -24.5 | 3.5% → 4.6% | 1.065 → 0.655 | 2.81 → 2.72 | 0.130 / 0.366 → 0.126 / 0.366 | 607 / 307 → 40 / 336 | 215 → 345 | 287 → 237 | 287 → 517 | 179 → 193 |

**heavy-quick3-v2 c0:**

| Link | Wrong-identity chunk-frames | Presented − server tick p50 / p1 (ticks) | Frames stopped | Debris pos@render p99 (m) | Debris pos@now p99 (m) | ALL pos@render / pos@now p99 (m) | ALL missing / extra | Island first draw p99 (ms) | Topology delivered p99 (ms) | Baseline parts p99 (ms) | kbit/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 0 → 0 | -5.3 / -16.9 → -5.3 / -16.9 | 2.6% → 2.6% | 0.198 → 0.198 | 1.68 → 1.68 | 0.110 / 0.185 → 0.110 / 0.185 | 51 / 655 → 51 / 655 | 17 → 17 | 0 → 0 | 0 → 0 | 264 → 280 |
| lan | 0 → 0 | -5.3 / -16.9 → -5.3 / -16.9 | 2.7% → 2.7% | 0.198 → 0.198 | 1.68 → 1.68 | 0.110 / 0.185 → 0.110 / 0.185 | 51 / 655 → 52 / 655 | 17 → 17 | 1 → 1 | 1 → 1 | 264 → 280 |
| cable | 3 → 3 | -5.9 / -17.5 → -5.9 / -17.6 | 2.7% → 2.6% | 0.198 → 0.198 | 1.73 → 1.73 | 0.114 / 0.198 → 0.114 / 0.198 | 51 / 648 → 51 / 650 | 22 → 22 | 16 → 15 | 16 → 16 | 264 → 280 |
| lte | 142 → 45 | -9.9 / -21.5 → -9.8 / -21.5 | 3.6% → 3.0% | 0.218 → 0.218 | 2.32 → 2.24 | 0.114 / 0.282 → 0.114 / 0.265 | 46 / 677 → 46 / 666 | 246 → 136 | 365 → 141 | 355 → 526 | 264 → 280 |
| lossy-wifi | 3 → 58 | -5.9 / -17.6 → -5.9 / -17.4 | 3.2% → 3.3% | 0.218 → 0.218 | 1.73 → 1.73 | 0.114 / 0.198 → 0.114 / 0.198 | 112 / 682 → 111 / 666 | 94 → 81 | 95 → 75 | 120 → 96 | 264 → 280 |
| poor-mobile | 92 → 54 | -13.5 / -29.5 → -13.5 / -25.9 | 4.5% → 3.5% | 0.232 → 0.403 | 3.65 → 3.00 | 0.114 / 0.506 → 0.118 / 0.390 | 44 / 1535 → 44 / 785 | 872 → 213 | 773 → 228 | 874 → 642 | 238 → 250 |
| poor-mobile-nq | 3371 → 74 | -13.6 / -36.4 → -13.5 / -26.0 | 4.3% → 3.5% | 0.522 → 0.634 | 3.65 → 3.20 | 0.118 / 0.474 → 0.126 / 0.430 | 44 / 683 → 67 / 848 | 739 → 353 | 800 → 341 | 924 → 777 | 233 → 247 |
| cap-1mbit | 12 → 12 | -7.2 / -21.2 → -7.2 / -19.2 | 3.0% → 2.9% | 0.218 → 0.321 | 2.47 → 2.17 | 0.114 / 0.282 → 0.118 / 0.248 | 48 / 649 → 48 / 643 | 647 → 85 | 547 → 81 | 437 → 284 | 239 → 250 |
| cap-1mbit-nq | 12 → 12 | -7.2 / -19.3 → -7.2 / -19.5 | 2.8% → 2.9% | 0.332 → 0.321 | 2.17 → 2.24 | 0.118 / 0.248 → 0.118 / 0.256 | 48 / 660 → 48 / 660 | 245 → 186 | 172 → 166 | 143 → 148 | 235 → 250 |
| bw-capped | 3476 → 12 | -7.4 / -32.5 → -7.4 / -20.5 | 4.2% → 3.7% | 0.354 → 0.906 | 3.65 → 2.64 | 0.114 / 0.474 → 0.122 / 0.343 | 47 / 639 → 47 / 639 | 936 → 139 | 1415 → 112 | 1318 → 733 | 207 → 213 |
| bw-capped-nq | 12 → 12 | -7.4 / -23.4 → -7.6 / -24.5 | 3.5% → 4.1% | 1.100 → 0.849 | 2.81 → 2.81 | 0.130 / 0.378 → 0.130 / 0.378 | 730 / 649 → 114 / 656 | 214 → 297 | 220 → 231 | 289 → 367 | 196 → 212 |

**20260924-131437-quick-3c-syncfix c1** (recorded with the 87b40c9e client):

| Link | Wrong-identity chunk-frames | Presented − server tick p50 / p1 (ticks) | Frames stopped | Debris pos@render p99 (m) | Debris pos@now p99 (m) | ALL pos@render / pos@now p99 (m) | ALL missing / extra | Island first draw p99 (ms) | Topology delivered p99 (ms) | Baseline parts p99 (ms) | kbit/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 0 → 0 | -5.1 / -14.9 → -5.1 / -14.9 | 1.8% → 1.8% | 0.114 → 0.114 | 1.97 → 1.97 | 0.032 / 0.174 → 0.032 / 0.174 | 1 / 485 → 1 / 485 | 10 → 10 | 0 → 0 | 0 → 0 | 219 → 236 |
| lan | 0 → 0 | -5.1 / -14.9 → -5.1 / -14.9 | 1.9% → 1.9% | 0.114 → 0.114 | 1.97 → 1.97 | 0.032 / 0.174 → 0.032 / 0.174 | 0 / 482 → 0 / 484 | 10 → 10 | 1 → 1 | 1 → 1 | 219 → 236 |
| cable | 3 → 3 | -5.8 / -15.5 → -5.8 / -15.5 | 2.0% → 1.9% | 0.122 → 0.118 | 2.04 → 2.04 | 0.032 / 0.191 → 0.032 / 0.191 | 1 / 488 → 1 / 486 | 41 → 22 | 15 → 15 | 16 → 16 | 219 → 236 |
| lte | 749 → 24 | -9.9 / -36.1 → -9.8 / -35.6 | 3.4% → 3.0% | 0.321 → 0.179 | 3.00 → 2.81 | 0.038 / 0.378 → 0.039 / 0.321 | 0 / 871 → 0 / 549 | 246 → 142 | 324 → 131 | 329 → 322 | 219 → 236 |
| lossy-wifi | 12 → 6 | -5.9 / -29.2 → -5.9 / -32.6 | 2.9% → 3.7% | 0.198 → 0.191 | 2.17 → 2.72 | 0.038 / 0.211 → 0.034 / 0.265 | 0 / 556 → 7 / 706 | 43 → 44 | 89 → 55 | 76 → 147 | 219 → 236 |
| poor-mobile | 61 → 64 | -13.7 / -33.0 → -13.6 / -40.1 | 3.8% → 3.5% | 0.185 → 0.218 | 4.43 → 3.77 | 0.036 / 0.490 → 0.038 / 0.474 | 175 / 456 → 486 / 919 | 625 → 229 | 789 → 229 | 573 → 565 | 214 → 227 |
| poor-mobile-nq | 118 → 45 | -13.7 / -39.0 → -13.6 / -44.8 | 4.1% → 3.3% | 0.232 → 0.232 | 4.57 → 4.43 | 0.033 / 0.540 → 0.038 / 0.522 | 119 / 720 → 0 / 837 | 591 → 295 | 762 → 347 | 566 → 643 | 213 → 231 |
| cap-1mbit | 12 → 12 | -7.1 / -26.0 → -7.1 / -34.0 | 2.3% → 2.8% | 0.148 → 0.163 | 2.64 → 2.91 | 0.032 / 0.273 → 0.032 / 0.292 | 1 / 479 → 0 / 592 | 162 → 79 | 611 → 86 | 310 → 254 | 214 → 228 |
| cap-1mbit-nq | 12 → 12 | -7.2 / -36.8 → -7.1 / -17.6 | 2.3% → 2.0% | 0.179 → 0.126 | 3.00 → 2.55 | 0.031 / 0.292 → 0.033 / 0.240 | 0 / 629 → 1 / 477 | 121 → 87 | 151 → 136 | 101 → 100 | 213 → 227 |
| bw-capped | 29865 → 12 | -7.5 / -35.9 → -7.4 / -18.6 | 3.2% → 2.8% | 3.202 → 0.225 | 6.53 → 2.72 | 0.031 / 0.522 → 0.037 / 0.273 | 3 / 532 → 1 / 481 | 1213 → 128 | 1622 → 108 | 1311 → 490 | 188 → 194 |
| bw-capped-nq | 12 → 12 | -7.2 / -35.7 → -7.4 / -20.9 | 2.5% → 3.3% | 0.191 → 0.174 | 3.00 → 2.91 | 0.034 / 0.301 → 0.036 / 0.301 | 1 / 541 → 1 / 470 | 170 → 167 | 227 → 207 | 183 → 198 | 180 → 188 |

**20260924-162732-quick-3c-citylat4 c1** (recorded with this tree; the
87b40c9e server and client replayed with `--client-root` and the
87b40c9e lab binary):

| Link | Wrong-identity chunk-frames | Presented − server tick p50 / p1 (ticks) | Frames stopped | Debris pos@render p99 (m) | Debris pos@now p99 (m) | ALL pos@render / pos@now p99 (m) | ALL missing / extra | Island first draw p99 (ms) | Topology delivered p99 (ms) | Baseline parts p99 (ms) | kbit/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 0 → 0 | -5.3 / -15.0 → -5.3 / -20.3 | 3.1% → 3.7% | 0.097 → 0.097 | 1.97 → 1.97 | 0.016 / 0.038 → 0.016 / 0.038 | 0 / 585 → 0 / 585 | 8 → 8 | 0 → 0 | 0 → 0 | 156 → 167 |
| lan | 0 → 0 | -5.4 / -15.0 → -5.4 / -20.4 | 3.1% → 3.7% | 0.097 → 0.097 | 1.97 → 1.97 | 0.016 / 0.038 → 0.016 / 0.038 | 1 / 585 → 1 / 585 | 9 → 9 | 1 → 1 | 1 → 1 | 156 → 167 |
| cable | 17 → 17 | -6.0 / -15.8 → -6.1 / -21.2 | 3.2% → 3.8% | 0.100 → 0.097 | 2.10 → 2.10 | 0.016 / 0.040 → 0.016 / 0.042 | 1 / 585 → 1 / 589 | 22 → 23 | 15 → 15 | 15 → 15 | 156 → 167 |
| lte | 99 → 36 | -10.4 / -21.0 → -10.1 / -27.4 | 4.2% → 4.1% | 0.138 → 0.130 | 3.20 → 3.00 | 0.017 / 0.058 → 0.018 / 0.058 | 60 / 1622 → 58 / 1256 | 364 → 119 | 399 → 124 | 347 → 348 | 156 → 167 |
| lossy-wifi | 22 → 9 | -5.9 / -16.0 → -6.2 / -21.7 | 3.9% → 4.4% | 0.122 → 0.114 | 2.10 → 2.10 | 0.018 / 0.045 → 0.017 / 0.043 | 1 / 787 → 0 / 1135 | 48 → 96 | 111 → 56 | 137 → 87 | 156 → 167 |
| poor-mobile | 1194 → 422 | -13.8 / -45.2 → -13.9 / -30.1 | 4.4% → 4.6% | 0.168 → 0.134 | 5.20 → 3.89 | 0.017 / 0.080 → 0.017 / 0.068 | 59 / 1521 → 55 / 817 | 907 → 237 | 1325 → 214 | 592 → 547 | 148 → 157 |
| poor-mobile-nq | 184 → 57 | -14.1 / -30.3 → -13.8 / -29.9 | 4.4% → 4.4% | 0.174 → 0.130 | 4.43 → 4.15 | 0.018 / 0.072 → 0.018 / 0.070 | 0 / 1589 → 0 / 1607 | 413 → 245 | 734 → 280 | 554 → 554 | 150 → 158 |
| cap-1mbit | 514 → 12 | -7.2 / -36.0 → -7.3 / -22.4 | 3.4% → 3.6% | 0.134 → 0.100 | 3.77 → 2.55 | 0.016 / 0.051 → 0.016 / 0.046 | 1 / 590 → 0 / 592 | 254 → 96 | 1112 → 78 | 440 → 306 | 149 → 158 |
| cap-1mbit-nq | 12 → 23 | -7.3 / -19.9 → -7.3 / -22.4 | 3.0% → 3.6% | 0.110 → 0.100 | 2.72 → 2.55 | 0.016 / 0.046 → 0.016 / 0.048 | 0 / 590 → 0 / 592 | 144 → 104 | 187 → 117 | 129 → 88 | 149 → 158 |
| bw-capped | 63310 → 12 | -7.8 / -40.0 → -7.5 / -22.5 | 4.3% → 4.2% | 4.723 → 0.134 | 7.68 → 2.91 | 0.019 / 0.075 → 0.017 / 0.051 | 66 / 592 → 1 / 595 | 2337 → 273 | 3182 → 218 | 1936 → 461 | 135 → 142 |
| bw-capped-nq | 191 → 23 | -7.4 / -17.2 → -7.5 / -23.0 | 3.1% → 4.2% | 0.204 → 0.232 | 2.72 → 2.91 | 0.018 / 0.051 → 0.017 / 0.052 | 1 / 594 → 0 / 595 | 269 → 162 | 215 → 160 | 127 → 141 | 132 → 140 |

**Seed replicates, systematic c1, seeds 1 / 2 / 3:**

| Link | Wrong identity, seeds 1 / 2 / 3: 87b40c9e → this | Presented − server p1 (ticks) | Debris pos@render p99 (m) | Debris pos@now p99 (m) |
|---|---|---|---|---|
| lte | 448 / 965 / 579 → 529 / 446 / 631 | -34.5 / -30.7 / -21.2 → -26.4 / -33.6 / -33.6 | 0.114 / 0.118 / 0.118 → 0.118 / 0.110 / 0.110 | 2.39 / 2.55 / 2.24 → 2.55 / 2.32 / 2.24 |
| lossy-wifi | 84 / 136 / 111 → 106 / 0 / 0 | -29.0 / -29.0 / -18.7 → -31.2 / -18.6 / -26.6 | 0.100 / 0.107 / 0.097 → 0.100 / 0.100 / 0.103 | 1.68 / 1.68 / 1.62 → 1.73 / 1.62 / 1.91 |
| poor-mobile | 3686 / 3938 / 2517 → 456 / 45 / 558 | -42.3 / -40.2 / -41.3 → -33.1 / -38.2 / -39.5 | 0.130 / 0.118 / 0.122 → 0.114 / 0.114 / 0.118 | 4.15 / 3.77 / 4.02 → 3.00 / 3.31 / 3.10 |
| poor-mobile-nq | 5620 / 974 / 1942 → 425 / 366 / 365 | -37.4 / -35.6 / -33.3 → -36.0 / -40.0 / -36.9 | 0.126 / 0.134 / 0.110 → 0.114 / 0.126 / 0.114 | 3.77 / 3.42 / 3.31 → 3.20 / 3.77 / 3.10 |
| cap-1mbit | 2548 / 2671 / 2882 → 250 / 250 / 250 | -31.5 / -28.9 / -29.0 → -19.1 / -20.9 / -19.1 | 0.103 / 0.103 / 0.103 → 0.094 / 0.094 / 0.094 | 2.72 / 2.64 / 2.64 → 1.91 / 1.97 / 1.91 |
| bw-capped | 39830 / 40095 / 40799 → 355 / 12 / 352 | -40.7 / -40.7 / -40.7 → -20.8 / -22.6 / -26.4 | 0.179 / 0.179 / 0.179 → 0.158 / 0.143 / 0.158 | 4.57 / 4.57 / 4.57 → 2.17 / 2.24 / 2.24 |

What it says (inferred from the tables):

- **Weakness 2 is closed.** Wrong identity on the constrained links falls
  to the fast-link level on every bundle:
  - bw-capped: 39,830 → 355 (heavy 3,090 / 3,476 → 12; the two live
    captures 29,865 / 63,310 → 12);
  - cap-1mbit: 2,548 → 250 (live 514 → 12);
  - poor-mobile: 3,686 / 3,938 / 2,517 → 456 / 45 / 558 over three seeds
    (heavy 757 → 51);
  - poor-mobile-nq: 5,620 / 974 / 1,942 → 425 / 366 / 365.
- **Topology and first draws arrive sooner.** Topology arrives in datagram
  time. Island first-draw p99 falls 2-9×, and the hold tail (p1 lag)
  shortens on the sender-queue links: bw-capped −40.7 → −20.8, cap-1mbit
  −31.5 → −19.1.
- **Debris pos@now p99 falls** there by 28-53% (bw-capped 4.57 → 2.17 m,
  cap-1mbit 2.72 → 1.91 m, poor-mobile 4.15 → 3.00 m).
- **Fast links are untouched:** loopback, lan and cable are identical
  within rounding, apart from the bytes.
- **LTE (weakness 1): the presented lag does not move.**
  - p50 −10.2 → −10.0 / −10.1 over seeds. p1 is −34.5 / −30.7 / −21.2 →
    −26.4 / −33.6 / −33.6, seed noise.
  - The copies do deliver topology at 130 instead of 340 ms p99, halve the
    island first-draw p99, and cut missing draws 574 → 194.
  - Wrong identity is unchanged within seed noise (448 / 965 / 579 →
    529 / 446 / 631).
  - The holds that remain are records overtaking their copy: the lab's
    iid jitter reorders datagrams of one send, a documented over-estimate
    of real LTE. Each costs a short hold and ~0.4 s of delay shrink.

**Costs** (measured):

- **Bytes.** The copies add 21 kbit/s on the systematic bundle (8% of
  netcode bytes), 17 kbit/s on the heavy one (7%) and 11 kbit/s on the
  162732 capture (6%). On a limited link that comes out of the pose budget.
- **Pose fidelity on the tightest link, heavy bundle.**
  - bw-capped debris pos@render p99 rises 0.32 → 0.75 m (c1) and 0.35 →
    0.91 m (c0); poor-mobile 0.22 → 0.30 / 0.23 → 0.40 m.
  - pos@now p99 falls meanwhile (bw-capped 3.77 → 2.55 / 3.65 → 2.64 m).
  - Topology and reliable bytes now go first. Each change alone gives
    part of it (c1 bw-capped: copies 0.54 m, reliable signal 0.60 m).
  - On the systematic bundle debris pos@render improves there
    (0.18 → 0.16 m).
- **The lead cap holds on copy-only sends.** On the 162732 capture,
  loopback's p1 lag goes −15.0 → −20.3 ticks and stopped frames 3.1% →
  3.7%. Those are sends with no records, so nothing is moving: 87b40c9e's
  clock ran past the stream there, this one stops.
- **Snapshots on the 0.5 Mbit/s link** are drawn 3.6 ms later p50
  (compare.md `drawn behind server`, systematic bw-capped): the copies
  share the link.

### Calibration (measured)

`netlab2 calibrate` with this tree's client:

- **(a) Bytes: 100% on every bundle, every kind.** Copies are off in their
  checkpoints.
  - systematic c1: 34,331 / 34,331;
  - heavy c0: 11,063 / 11,063;
  - heavy c1: 10,861 / 10,861;
  - 131437 c1: 11,732 / 11,732.
- **Heavy c0, c1 and the 131437 capture pass every check.** With the
  adaptive delay off, this client draws exactly what 87b40c9e drew when
  there are no copies.
- **Systematic fails only (d),** as with 87b40c9e: debris 0.28 m, drawn /
  not drawn 0.30%. It was recorded with the older d1342419 city clock.
- **The capture recorded with this tree,**
  `target/city-latency/city-bench/runs/20260924-162732-quick-3c-citylat4`,
  **passes every check on all three clients.**
  - Bytes: 3,919 / 3,919 (c0), 3,919 / 3,919 (c1), 3,901 / 3,901 (c2).
    Record-less copy datagrams are included, so the lab reproduces the
    live copies byte for byte.
  - Clock offset p99 in the last 10 s: 97 / 4 / 16 µs.
  - Debris chunks vs the live renderer p99: 0.6 / 4.4 / 0.7 cm.
  - Drawn / not drawn and body keys: 0 mismatches.

### Live (measured)

`scripts/perf/city-bench.sh --scenario quick --clients 3` (ports
5801/5802/3583, GPU lock, out `target/city-latency/city-bench`),
`runs/20260924-162732-quick-3c-citylat4`:

- **Budgets: 17 of 27 pass, 3/3 paired bundles, 0 errors.**
  - The failures are the server's tick and sim rate (GPU physics, 97%
    dynamics).
  - Client CPU hitches: 2 over 100 ms, 3 over 33 ms.
  - Meteor arc jump 1.1 m and 3 backward frames. Both meteor budgets also
    fail on 87b40c9e.
  - self_error_p99 0.51 m against a 0.5 limit (the own avatar, not the
    city).
- **The rate controller logged no state change.** Every loopback link
  stayed `Free`.
- **Streaming health:** 0 packets lost, 0 server drops, send → arrive p99
  4.2-4.3 ms, 0 render-clock back-steps, 0 structure repairs, 0 bodies
  below ground.
- **Compared with the 87b40c9e run** (`20260924-131437-quick-3c-syncfix`,
  which broke 44% of bonds against 25% here, so indicative only):
  - server tick p95 30.5 → 22.4 ms;
  - netcode 219-241 → 167-179 kbit/s per client;
  - presented jumps over 4 m 38 / 29 / 55 → 41 / 79 / 43;
  - correction snaps 17 / 13 / 13 → 11 / 10 / 12;
  - drawn teleports 64 / 59 / 65 → 28 / 26 / 28.
- **Constrained links were not run live.** netem needs root, as before.
  The lab's closed loop and the real-QUIC relay test (below) stand in.

### Tests

Every one fails on 87b40c9e or does not compile there, except the guards.

- `destruction/src/encoder.rs`:
  - `topology_copies_go_ahead_of_the_records_at_two_sends`;
  - `large_topology_copies_are_split_and_first_copies_go_first`;
  - `an_older_checkpoint_resumes_without_topology_copies`.
- `destruction/src/wire.rs`: `a_topology_part_trailer_follows_the_records`.
- `server/src/link_rate.rs`. The fluid model gains a datagrams-first
  reliable lane.
  - `a_reliable_stream_on_a_limited_link_is_given_the_path`: 6 kB bursts
    on a saturated 1 Mbit/s link wait at most 265 ms with the signal and
    594 ms without it;
  - `a_waiting_stream_alone_does_not_limit_a_link` (guard; it encodes the
    live finding);
  - `reliable_bursts_on_a_fast_link_are_not_throttled` (guard).
- `server/src/bin/netlab2/link.rs`:
  `the_link_reports_reliable_bytes_and_the_stream_backlog`.
- `client/src/city/cityClient.test.ts`:
  - "CityClient topology copies" (5): a copy that beats its reliable
    message is applied once; a copy ahead of a missing seq waits; parts
    reassemble in any order; the presentation holds below a missing
    message whose first piece arrived; the lead cap holds while only
    copies arrive;
  - "CityClient repair behind topology copies": restated, then
    re-applied, no resync;
  - "CityClient adaptive playout delay": off by default (guard); when on,
    a steady link is drawn within 3.5 ticks of the server and never past
    the newest datagram; a jittery link keeps a delay in (2, 6] (guard).
- `client/src/city/wire.test.ts`: the trailer after the golden datagram.
- **Suites:** destruction 203, server 143 (+1 ignored), netlab2 73,
  client `src/city` 243, all passing. The real-QUIC relay test (`quic_rate_tests`, ignored) passes with
  the controller change. From 3 s: 100% delivered, one-way p50 30.3 ms,
  capacity 941 kbit/s.

### Risks

- **The reliable-backlog estimate on real quinn** is unchecked with stream
  traffic.
  - The relay test sends datagrams only.
  - The estimate errs high on a flow-controlled stream, on bytes still in
    the server's queue, or if quinn's per-packet overhead is under 24 B.
  - It can therefore take budget only on a link already limited, and only
    after 60 ms. It can no longer limit a link.
- **Older clients** get copies they ignore: 11-21 kbit/s. Their pose clock
  is untouched, since the header tick is the previous send's.
- **Repairs behind copies** were exercised in the lab on the heavy
  bundle's replayed repairs: on c1, 3 of 5 on poor-mobile and bw-capped.
  All 5 applied, with 0 resyncs and 0 hash mismatches, where 87b40c9e
  applied 2 and asked for a full resync (measured). A repair older than
  the 128 kept messages falls back to the full resync.
- **Hash checks** compare only when the client's seq equals the hash's.
  With copies ahead, 124-157 of 157 ran on the systematic bundle (fewest on
  poor-mobile), against 157. There were no mismatches either way.
- **Lab jitter is iid per packet**, so a send's datagrams reorder more than
  on real LTE. The remaining LTE holds, records overtaking their copy, may
  be fewer live (inferred).

## Netcode scoreboard (2026-09-24)

One table per bundle: the netcode as it was before today's work against
HEAD (2fddb511), on the same frozen server truth, the same links and the
same link seed. Every number is **measured** in Netlab v2 unless marked
**inferred**. Per-class tables (p50/p95/p99 at render and now, missing /
extra / wrong identity for players, vehicles, bodies, meteors and the three
chunk classes) are in [netcode-scoreboard-2026-09-24.md](netcode-scoreboard-2026-09-24.md).
The rounds that followed the scoreboard are below:
[compact self state and explicit removals](#next-wins-compact-self-state-and-explicit-removals),
then [late snapshots and idle players and vehicles](#next-wins-late-snapshots-and-idle-players-and-vehicles),
then [city send cadence and playout delay](#city-send-cadence-and-playout-delay).

The commits scored: 0eb6f3fd (clock, interpolation, meteor handover),
9b81c8c3 (match stats datagram), 91c814bb (read-rate-independent clock,
stale bodies), 2c84b393 (settle check), 51ddcf48 (encoder models the drawn
pose), 129e0dac (rate adaptation), 87b40c9e (city render clock, topology
hold), 38d6f964 (topology copies), 28a7eb10 (tick scale, meteor arc,
interest exits, stall recovery).

### What "before" and "after" mean

Netlab v2 landed after the first of these commits (b0502db9), so there is no
pre-work lab. Both arms run one lab binary, built from 2fddb511; the old
behaviour comes from the old client tree and from the knobs that gate every
server change.

| Stage | Before | After |
|---|---|---|
| Client (decode, clocks, interpolation, city client, pose steps) | **e3fdf5cc** (0eb6f3fd's parent) via `--client-root`. That tree predates the renderers' shared pose steps, so `scripts/perf/netlab2-prework/install.sh` adds them: `cityPoseStore.ts` and `netEntityPoses.ts` from 3f3d891a (the renderers' pose logic is unchanged from e3fdf5cc to 3f3d891a~1, checked by diff) and a `meteorPlacement.ts` that is e3fdf5cc `MeteorLayer`'s placement loop without the mesh work. Without them the lab scores no chunks and no meteors for this client. | HEAD 2fddb511 |
| Snapshot builder | `snapshot_builder.rs` at HEAD: unchanged since b0502db9, byte-identical to the pre-refactor server (netlab-v2.md, legacy captures). The 4-byte wall-clock trailer (0eb6f3fd) is subtracted from the before arm's snapshot bytes (`--before-no-trailer`: 4 B per delivered snapshot, 1.9 kbit/s at 60 Hz). | HEAD |
| City encoder | HEAD's encoder with every 51ddcf48 / 38d6f964 flag off: `city.ballistic_free_fall=0, city.client_model=0, city.baseline_interval_ticks=60, city.baseline_lag_ticks=0, city.baseline_skip_quiescent=0, city.topology_copies=0`. With these flags off the encoder is the pre-change one byte for byte (the heavy-quick3-v2 capture, recorded before 51ddcf48, calibrates 100%). | Production values set explicitly (`...=1, 120, 110, 1, 2`), so bundles recorded before a change get it too |
| Rate adaptation | `city.rate_adapt=0` (static ceiling) | on (production) |
| Match stats, energy, roster, meteor launches | Recorded bytes (pass-through, seam S5), the same in both arms. All four bundles were recorded after 9b81c8c3, so the before arm carries the new match-stats datagram: it **understates** the pre-work bytes. Measured live before that commit: match stats were 31-34% of bytes on the quick 3-client bench, 10.8% in the owner's session (session analysis item 7). | same |
| Both | seed 1, recorded server pace, `lab.recorded_repairs=0` (the client's own repair requests are counted and never answered, seam S6) | same |

The owner's-session cells were run again with the next round's lab binary
(to leave out frames before its server capture opened from the lag); on
captures that do not record the new snapshot options it replays the same
bytes (11,502 / 11,503 packets with either binary, the odd one a lab-only
snapshot after the capture closed).

### Bundles and links

- **systematic-2c-d1342419 c1**: the frozen destruction bundle (16 buildings,
  337 s), spectator.
- **heavy-quick3-v2 c1**: quick scenario, 3 clients, 122 s, spectator.
- **20260924-162732-quick-3c-citylat4 c1**: the latest live city-bench capture
  (recorded with the 38d6f964 tree), spectator.
- **session-20260924-213925-ondf3t**: the owner's play session (server
  ff84dec6 from target/play; the client predates 28a7eb10, **inferred** from
  its tape header having no `serverTickUs`), the recording player, 78 s of
  capture. Its own avatar and driven vehicle are left out of `overall` (S11).
- Links: loopback, lan, cable, lte, lossy-wifi, poor-mobile(-nq),
  cap-1mbit(-nq), bw-capped(-nq) (`netlab2 profiles`).

Columns: netcode kbit/s is snapshots plus every city kind; "all kinds" adds
the pass-through kinds. "Presented − server" is the city's presented tick
(render tick minus playout delay) minus the tick the server had completed,
per frame (p50 / p1; `netlab2-scoreboard.py lag`, frames before the server
capture opened left out). "Bodies drawn behind server" is the dynamic-body
render time's lag behind the server (negative: drawn ahead of it,
extrapolated). First draw is from the server completing a body's first moving
tick to the first frame that draws it. Clock back-steps count both render
clocks. Repairs asked are the city repairs the client requested.

### systematic-2c-d1342419 c1 (before → after)

| Link | Netcode kbit/s (snapshot + city) | All kinds kbit/s | Presented − server tick p50 / p1 | Bodies drawn behind server p50 ms | Island first draw p50 / p99 ms | Body first draw p50 / p99 ms | ALL pos@render p50/p95/p99 m | ALL pos@now p50/p95/p99 m | Missing / extra / wrong identity | Clock back-steps | Repairs asked |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 293.7 → 259.3 | 295.7 → 261.2 | -4.8 / -7.5 → -5.2 / -16.6 | -4.1 → 15.0 | 0 / 10 → 0 / 10 | 2 / 9 → 2 / 9 | 0.003/0.185/0.211 → 0.003/0.011/0.025 | 0.003/0.185/0.232 → 0.003/0.014/0.138 | 192 / 222,781 / 0 → 66 / 2,634 / 0 | 888 → 0 | 91 → 0 |
| lan | 293.7 → 259.3 | 295.7 → 261.2 | -4.8 / -7.5 → -5.3 / -16.6 | -3.2 → 15.9 | 0 / 10 → 0 / 10 | 6 / 10 → 6 / 10 | 0.003/0.185/0.211 → 0.003/0.011/0.025 | 0.003/0.185/0.232 → 0.003/0.014/0.138 | 196 / 222,769 / 214 → 51 / 2,631 / 0 | 900 → 0 | 91 → 0 |
| cable | 293.6 → 259.0 | 295.6 → 261.0 | -5.3 / -8.1 → -5.9 / -17.2 | 7.7 → 29.0 | 0 / 24 → 0 / 23 | 17 / 22 → 17 / 25 | 0.003/0.185/0.218 → 0.003/0.011/0.025 | 0.003/0.185/0.240 → 0.003/0.015/0.153 | 185 / 185,992 / 3,584 → 73 / 2,636 / 71 | 878 → 0 | 91 → 0 |
| lte | 286.8 → 251.6 | 288.8 → 253.6 | -3.4 / -10.2 → -10.0 / -26.4 | 73.3 → 148.4 | 69 / 343 → 60 / 209 | 93 / 124 → 93 / 118 | 0.003/0.185/0.265 → 0.003/0.012/0.029 | 0.003/0.191/0.301 → 0.003/0.016/0.265 | 802 / 40,127 / 70,697 → 359 / 4,656 / 529 | 866 → 0 | 91 → 0 |
| lossy-wifi | 286.5 → 251.7 | 288.5 → 253.7 | -0.6 / -6.6 → -6.0 / -31.2 | 6.3 → 64.9 | 0 / 46 → 0 / 41 | 19 / 39 → 16 / 41 | 0.003/0.185/0.248 → 0.003/0.012/0.028 | 0.003/0.185/0.256 → 0.003/0.015/0.168 | 475 / 46,561 / 17,520 → 247 / 3,910 / 106 | 932 → 0 | 91 → 0 |
| poor-mobile | 287.0 → 233.3 | 289.0 → 235.3 | -6.8 / -96.8 → -13.8 / -33.0 | 135.4 → 214.0 | 155 / 5273 → 135 / 329 | 144 / 190 → 152 / 184 | 0.003/0.185/0.273 → 0.003/0.012/0.031 | 0.003/0.191/0.416 → 0.003/0.017/0.343 | 1,097 / 159,779 / 147,427 → 386 / 3,721 / 456 | 1,074 → 0 | 84 → 0 |
| poor-mobile-nq | 272.3 → 234.0 | 274.3 → 235.9 | -7.3 / -20.5 → -13.8 / -36.0 | 136.4 → 215.0 | 152 / 590 → 129 / 336 | 157 / 193 → 150 / 186 | 0.003/0.185/0.273 → 0.003/0.012/0.030 | 0.003/0.191/0.366 → 0.003/0.016/0.354 | 916 / 59,771 / 115,390 → 272 / 4,392 / 425 | 926 → 0 | 89 → 0 |
| cap-1mbit | 293.7 → 240.7 | 295.7 → 242.7 | -6.1 / -94.0 → -7.3 / -19.1 | 29.6 → 58.1 | 33 / 5123 → 26 / 151 | 38 / 53 → 36 / 53 | 0.003/0.185/0.218 → 0.003/0.011/0.027 | 0.003/0.185/0.301 → 0.003/0.015/0.198 | 296 / 84,973 / 62,515 → 89 / 2,864 / 250 | 1,194 → 0 | 84 → 0 |
| cap-1mbit-nq | 277.9 → 239.9 | 279.9 → 241.9 | -5.6 / -16.7 → -7.4 / -22.4 | 30.5 → 58.9 | 31 / 201 → 22 / 99 | 36 / 62 → 39 / 49 | 0.003/0.185/0.225 → 0.003/0.011/0.027 | 0.003/0.185/0.273 → 0.003/0.015/0.204 | 311 / 58,439 / 20,786 → 89 / 3,098 / 284 | 1,144 → 0 | 91 → 0 |
| bw-capped | 293.7 → 204.2 | 295.7 → 206.2 | -6.4 / -429.0 → -7.7 / -20.8 | 38.9 → 67.6 | 372 / 30182 → 37 / 226 | 43 / 5085 → 43 / 76 | 0.004/0.198/9.946 → 0.003/0.012/0.030 | 0.004/0.211/12.079 → 0.003/0.015/0.232 | 177,804 / 499,351 / 2,730,569 → 87 / 3,005 / 355 | 2,138 → 0 | 62 → 0 |
| bw-capped-nq | 242.2 → 200.7 | 244.1 → 202.7 | -4.8 / -18.7 → -7.8 / -24.9 | 37.9 → 69.0 | 42 / 386 → 34 / 175 | 44 / 219 → 43 / 100 | 0.003/0.185/0.265 → 0.003/0.011/0.032 | 0.003/0.191/0.378 → 0.003/0.015/0.256 | 1,383 / 118,437 / 52,566 → 103 / 2,932 / 352 | 1,446 → 0 | 89 → 0 |

### heavy-quick3-v2 c1 (before → after)

| Link | Netcode kbit/s (snapshot + city) | All kinds kbit/s | Presented − server tick p50 / p1 | Bodies drawn behind server p50 ms | Island first draw p50 / p99 ms | Body first draw p50 / p99 ms | ALL pos@render p50/p95/p99 m | ALL pos@now p50/p95/p99 m | Missing / extra / wrong identity | Clock back-steps | Repairs asked |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 230.7 → 217.8 | 232.5 → 219.6 | -4.7 / -9.0 → -5.2 / -16.9 | -7.7 → 16.5 | 0 / 9 → 0 / 9 | 4 / 7 → 4 / 7 | 0.000/0.179/0.218 → 0.000/0.012/0.039 | 0.000/0.179/0.248 → 0.000/0.017/0.174 | 187 / 2,631 / 0 → 30 / 244 / 0 | 1,348 → 0 | 25 → 0 |
| lan | 230.7 → 217.8 | 232.5 → 219.6 | -4.8 / -9.0 → -5.3 / -16.9 | -6.8 → 17.3 | 0 / 9 → 0 / 9 | 4 / 7 → 4 / 7 | 0.000/0.179/0.218 → 0.000/0.012/0.039 | 0.000/0.179/0.248 → 0.000/0.017/0.174 | 183 / 2,631 / 83 → 29 / 246 / 0 | 1,330 → 0 | 25 → 0 |
| cable | 230.4 → 217.6 | 232.2 → 219.4 | -5.2 / -9.6 → -5.9 / -17.5 | 4.1 → 28.9 | 0 / 22 → 0 / 22 | 19 / 22 → 19 / 22 | 0.000/0.179/0.218 → 0.000/0.012/0.040 | 0.000/0.179/0.256 → 0.000/0.017/0.185 | 187 / 2,636 / 1,151 → 31 / 249 / 6 | 1,290 → 0 | 25 → 0 |
| lte | 224.8 → 211.4 | 226.5 → 213.2 | -3.7 / -10.7 → -9.8 / -21.7 | 67.0 → 140.3 | 71 / 356 → 61 / 129 | 94 / 113 → 88 / 121 | 0.000/0.185/0.265 → 0.000/0.013/0.049 | 0.000/0.185/0.311 → 0.000/0.019/0.273 | 308 / 2,628 / 25,050 → 182 / 308 / 32 | 1,274 → 0 | 25 → 0 |
| lossy-wifi | 224.4 → 212.4 | 226.2 → 214.2 | -0.6 / -8.3 → -5.9 / -17.3 | 1.8 → 60.9 | 0 / 162 → 0 / 60 | 12 / 47 → 20 / 54 | 0.000/0.185/0.240 → 0.000/0.012/0.045 | 0.000/0.185/0.265 → 0.000/0.017/0.185 | 230 / 2,645 / 8,896 → 111 / 295 / 0 | 1,238 → 0 | 25 → 0 |
| poor-mobile | 224.8 → 188.9 | 226.5 → 190.6 | -7.1 / -50.2 → -13.4 / -25.7 | 129.7 → 203.9 | 430 / 8887 → 131 / 220 | 162 / 171 → 155 / 171 | 0.000/0.185/1.136 → 0.000/0.013/0.054 | 0.000/0.191/2.317 → 0.000/0.020/0.366 | 269 / 2,914 / 758,676 → 128 / 312 / 60 | 1,086 → 0 | 22 → 0 |
| poor-mobile-nq | 210.1 → 181.9 | 211.9 → 183.7 | -7.0 / -16.3 → -13.4 / -25.9 | 127.6 → 205.8 | 171 / 1323 → 139 / 323 | 155 / 195 → 153 / 196 | 0.000/0.185/0.282 → 0.000/0.013/0.058 | 0.000/0.185/0.378 → 0.000/0.020/0.390 | 213 / 2,631 / 84,667 → 175 / 309 / 51 | 1,080 → 0 | 24 → 0 |
| cap-1mbit | 230.7 → 195.0 | 232.5 → 196.8 | -6.1 / -48.5 → -7.1 / -19.1 | 25.2 → 53.8 | 59 / 8769 → 19 / 71 | 37 / 53 → 37 / 52 | 0.000/0.185/0.906 → 0.000/0.013/0.045 | 0.000/0.185/2.171 → 0.000/0.017/0.232 | 128 / 2,903 / 721,414 → 44 / 258 / 10 | 1,240 → 0 | 22 → 0 |
| cap-1mbit-nq | 215.4 → 181.6 | 217.2 → 183.4 | -5.6 / -13.1 → -7.1 / -19.3 | 24.4 → 54.1 | 45 / 312 → 21 / 174 | 38 / 62 → 41 / 54 | 0.000/0.179/0.232 → 0.000/0.013/0.056 | 0.000/0.185/0.292 → 0.000/0.017/0.248 | 160 / 2,648 / 10,969 → 46 / 255 / 12 | 1,282 → 0 | 25 → 0 |
| bw-capped | 230.7 → 166.6 | 232.5 → 168.4 | -6.2 / -259.4 → -7.3 / -19.8 | 32.6 → 59.5 | 388 / 22349 → 35 / 120 | 46 / 7082 → 46 / 62 | 0.000/0.191/4.286 → 0.000/0.013/0.075 | 0.000/0.265/6.321 → 0.000/0.018/0.292 | 1,475 / 10,266 / 1,914,589 → 33 / 269 / 12 | 998 → 0 | 17 → 0 |
| bw-capped-nq | 188.0 → 166.4 | 189.7 → 168.2 | -4.6 / -18.0 → -7.3 / -21.4 | 28.8 → 60.3 | 69 / 595 → 41 / 230 | 46 / 153 → 46 / 62 | 0.000/0.185/0.273 → 0.000/0.013/0.072 | 0.000/0.185/0.403 → 0.000/0.018/0.301 | 293 / 2,798 / 33,989 → 42 / 261 / 12 | 1,164 → 0 | 25 → 0 |

### 20260924-162732-quick-3c-citylat4 c1 (before → after)

| Link | Netcode kbit/s (snapshot + city) | All kinds kbit/s | Presented − server tick p50 / p1 | Bodies drawn behind server p50 ms | Island first draw p50 / p99 ms | Body first draw p50 / p99 ms | ALL pos@render p50/p95/p99 m | ALL pos@now p50/p95/p99 m | Missing / extra / wrong identity | Clock back-steps | Repairs asked |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 172.2 → 165.0 | 174.2 → 167.0 | -4.8 / -7.7 → -5.3 / -20.3 | -4.3 → 16.1 | 0 / 8 → 0 / 8 | 4 / 8 → 4 / 8 | 0.000/0.008/0.191 → 0.000/0.007/0.016 | 0.000/0.010/0.198 → 0.000/0.007/0.038 | 0 / 2,900 / 0 → 16 / 593 / 0 | 324 → 0 | 5 → 0 |
| lan | 172.2 → 165.0 | 174.2 → 167.0 | -4.9 / -7.8 → -5.4 / -20.4 | -3.4 → 17.0 | 0 / 9 → 0 / 9 | 8 / 9 → 8 / 9 | 0.000/0.008/0.191 → 0.000/0.007/0.016 | 0.000/0.010/0.198 → 0.000/0.007/0.038 | 1 / 2,900 / 7 → 12 / 591 / 0 | 330 → 0 | 5 → 0 |
| cable | 172.0 → 164.7 | 174.0 → 166.8 | -5.4 / -8.4 → -6.1 / -21.2 | 7.6 → 29.7 | 0 / 23 → 0 / 23 | 18 / 21 → 16 / 19 | 0.000/0.008/0.191 → 0.000/0.007/0.016 | 0.000/0.011/0.198 → 0.000/0.007/0.042 | 1 / 2,901 / 859 → 16 / 597 / 17 | 334 → 0 | 5 → 0 |
| lte | 167.6 → 160.3 | 169.6 → 162.3 | -3.2 / -9.5 → -10.1 / -27.4 | 73.8 → 147.6 | 64 / 313 → 64 / 119 | 76 / 108 → 91 / 126 | 0.000/0.011/0.211 → 0.000/0.007/0.017 | 0.000/0.015/0.225 → 0.000/0.007/0.058 | 12 / 2,912 / 15,154 → 101 / 1,261 / 36 | 220 → 0 | 5 → 0 |
| lossy-wifi | 166.5 → 159.3 | 168.5 → 161.3 | -1.2 / -6.9 → -6.2 / -21.7 | 6.6 → 64.5 | 0 / 73 → 5 / 96 | 21 / 42 → 26 / 43 | 0.000/0.009/0.204 → 0.000/0.007/0.017 | 0.000/0.012/0.211 → 0.000/0.007/0.043 | 69 / 2,904 / 3,711 → 44 / 1,141 / 9 | 300 → 0 | 5 → 0 |
| poor-mobile | 167.9 → 150.9 | 170.0 → 152.9 | -7.4 / -65.2 → -13.9 / -30.1 | 133.5 → 211.3 | 189 / 3198 → 131 / 237 | 158 / 181 → 149 / 183 | 0.000/0.011/0.211 → 0.000/0.007/0.017 | 0.000/0.019/0.256 → 0.000/0.007/0.068 | 318 / 3,029 / 42,934 → 135 / 826 / 422 | 380 → 0 | 5 → 0 |
| poor-mobile-nq | 160.7 → 150.7 | 162.7 → 152.7 | -7.3 / -21.0 → -13.8 / -29.8 | 133.7 → 212.0 | 159 / 1042 → 139 / 245 | 158 / 183 → 155 / 183 | 0.000/0.012/0.211 → 0.000/0.007/0.018 | 0.000/0.016/0.240 → 0.000/0.007/0.070 | 260 / 2,945 / 27,248 → 46 / 1,607 / 57 | 252 → 0 | 5 → 0 |
| cap-1mbit | 172.2 → 155.5 | 174.2 → 157.5 | -6.3 / -61.7 → -7.3 / -22.4 | 28.6 → 54.8 | 46 / 3057 → 24 / 96 | 37 / 43 → 35 / 43 | 0.000/0.008/0.191 → 0.000/0.007/0.016 | 0.000/0.013/0.211 → 0.000/0.007/0.046 | 215 / 3,020 / 28,989 → 22 / 600 / 12 | 416 → 0 | 5 → 0 |
| cap-1mbit-nq | 165.0 → 155.5 | 167.0 → 157.5 | -6.2 / -17.3 → -7.3 / -22.4 | 28.8 → 55.1 | 35 / 221 → 23 / 104 | 38 / 43 → 40 / 43 | 0.000/0.008/0.191 → 0.000/0.007/0.016 | 0.000/0.012/0.204 → 0.000/0.007/0.048 | 49 / 2,930 / 6,454 → 26 / 598 / 23 | 334 → 0 | 5 → 0 |
| bw-capped | 172.2 → 139.6 | 174.2 → 141.6 | -6.1 / -305.1 → -7.5 / -22.5 | 31.8 → 59.4 | 86 / 12395 → 38 / 273 | 50 / 1068 → 42 / 56 | 0.000/0.017/1.472 → 0.000/0.007/0.017 | 0.000/0.064/2.724 → 0.000/0.007/0.051 | 4 / 3,427 / 474,561 → 23 / 600 / 12 | 564 → 0 | 22 → 0 |
| bw-capped-nq | 149.1 → 137.5 | 151.1 → 139.6 | -5.5 / -16.9 → -7.5 / -23.0 | 31.8 → 59.7 | 63 / 378 → 36 / 162 | 39 / 207 → 41 / 108 | 0.000/0.009/0.204 → 0.000/0.007/0.017 | 0.000/0.013/0.218 → 0.000/0.007/0.052 | 240 / 2,933 / 13,302 → 22 / 599 / 23 | 382 → 0 | 26 → 0 |

### The owner's session, session-20260924-213925-ondf3t (before → after)

| Link | Netcode kbit/s (snapshot + city) | All kinds kbit/s | Presented − server tick p50 / p1 | Bodies drawn behind server p50 ms | Island first draw p50 / p99 ms | Body first draw p50 / p99 ms | ALL pos@render p50/p95/p99 m | ALL pos@now p50/p95/p99 m | Missing / extra / wrong identity | Clock back-steps | Repairs asked |
|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 592.8 → 567.1 | 594.5 → 568.8 | -4.5 / -29.6 → -5.4 / -18.2 | -5.3 → 20.8 | 0 / 105 → 0 / 105 | - / - → - / - | 0.000/0.185/0.366 → 0.000/0.014/0.066 | 0.000/0.204/1.252 → 0.000/0.091/2.035 | 79 / 0 / 83 → 117 / 0 / 0 | 188 → 0 | 20 → 0 |
| lan | 592.8 → 567.1 | 594.5 → 568.8 | -4.6 / -29.9 → -5.4 / -18.2 | -4.4 → 21.5 | 0 / 105 → 0 / 105 | - / - → - / - | 0.000/0.185/0.366 → 0.000/0.014/0.064 | 0.000/0.204/1.252 → 0.000/0.091/2.035 | 84 / 0 / 100 → 89 / 0 / 174 | 190 → 0 | 20 → 0 |
| cable | 592.6 → 566.6 | 594.3 → 568.3 | -5.0 / -30.6 → -6.1 / -18.8 | 6.6 → 33.2 | 0 / 105 → 0 / 105 | - / - → - / - | 0.000/0.191/0.366 → 0.000/0.014/0.062 | 0.000/0.211/1.336 → 0.000/0.097/2.171 | 63 / 0 / 462 → 84 / 0 / 184 | 206 → 0 | 20 → 0 |
| lte | 576.1 → 551.1 | 577.8 → 552.7 | -2.5 / -12.5 → -10.2 / -24.2 | 72.0 → 146.2 | 96 / 333 → 74 / 226 | - / - → - / - | 0.000/0.204/0.796 → 0.000/0.015/0.070 | 0.000/0.240/1.571 → 0.000/0.130/2.724 | 311 / 1 / 16,407 → 32 / 0 / 98 | 212 → 0 | 20 → 0 |
| lossy-wifi | 574.1 → 548.2 | 575.8 → 549.9 | -1.3 / -9.3 → -5.9 / -18.4 | 4.6 → 65.7 | 0 / 115 → 0 / 115 | - / - → - / - | 0.000/0.198/0.490 → 0.000/0.015/0.077 | 0.000/0.218/1.136 → 0.000/0.097/2.171 | 187 / 3 / 2,891 → 122 / 0 / 352 | 196 → 0 | 20 → 0 |
| poor-mobile | 577.9 → 413.3 | 579.6 → 414.9 | -17.4 / -149.7 → -14.4 / -27.9 | 172.1 → 220.4 | 604 / 8365 → 165 / 315 | - / - → - / - | 0.000/0.248/9.629 → 0.000/0.017/0.094 | 0.000/1.252/14.202 → 0.000/0.179/3.645 | 400 / 0 / 309,598 → 36 / 0 / 419 | 362 → 0 | 15 → 0 |
| poor-mobile-nq | 473.6 → 413.4 | 475.3 → 415.1 | -8.2 / -28.3 → -15.7 / -35.6 | 142.4 → 221.3 | 186 / 1682 → 164 / 335 | - / - → - / - | 0.000/0.225/2.035 → 0.000/0.017/0.100 | 0.000/0.332/4.286 → 0.000/0.204/3.889 | 294 / 2 / 52,315 → 30 / 0 / 278 | 230 → 0 | 19 → 0 |
| cap-1mbit | 592.8 → 431.4 | 594.5 → 433.1 | -19.5 / -146.1 → -7.7 / -21.4 | 62.6 → 75.3 | 152 / 8186 → 41 / 134 | - / - → - / - | 0.000/0.218/9.322 → 0.000/0.015/0.082 | 0.000/1.065/13.749 → 0.000/0.118/2.553 | 398 / 0 / 282,842 → 102 / 0 / 961 | 530 → 0 | 16 → 0 |
| cap-1mbit-nq | 482.0 → 411.9 | 483.7 → 413.6 | -5.7 / -29.9 → -7.8 / -25.1 | 34.8 → 76.5 | 51 / 390 → 41 / 171 | - / - → - / - | 0.000/0.204/1.252 → 0.000/0.016/0.100 | 0.000/0.265/3.100 → 0.000/0.130/2.813 | 145 / 7 / 8,533 → 104 / 0 / 959 | 258 → 0 | 20 → 0 |
| bw-capped | 537.9 → 279.2 | 539.6 → 280.9 | -328.8 / -771.7 → -9.0 / -22.4 | 5489.4 → 90.6 | 32 / 213 → 58 / 235 | 7841 / 12171 → - / - | 0.000/17.815/76.488 → 0.000/0.023/0.256 | 0.000/25.437/109.215 → 0.000/0.153/3.002 | 39,977 / 0 / 3,910,819 → 97 / 0 / 1,154 | 520 → 0 | 4 → 0 |
| bw-capped-nq | 325.7 → 258.1 | 327.4 → 259.8 | -14.2 / -30.0 → -9.7 / -27.8 | 127.0 → 92.8 | 143 / 637 → 68 / 360 | - / - → - / - | 0.000/0.282/6.321 → 0.000/0.028/0.390 | 0.000/0.614/7.929 → 0.000/0.179/3.308 | 184 / 4 / 22,248 → 99 / 0 / 1,167 | 238 → 0 | 21 → 0 |

### Summary

Measured unless marked:

- **Bytes.** Netcode kbit/s falls on every cell: 4-12% on the fast links
  (systematic 293.7 → 259.3 on LAN, heavy 230.7 → 217.8, citylat4 172.2 →
  165.0, the owner's session 592.8 → 567.1), and 6-48% on the rate-limited
  ones, where rate adaptation paces the city (systematic bw-capped 293.7 →
  204.2, the owner's session 537.9 → 279.2). The before arm already has the
  small match-stats datagram, so the real pre-work saving is larger
  (**inferred** from item 7's live 31-34% share).
- **Fidelity at the render time.** ALL draws pos@render p99 falls on every
  cell: 5-12× on loopback, LAN, cable and LTE (LAN: 0.211 → 0.025 m, 0.218 →
  0.039, 0.191 → 0.016, 0.366 → 0.064), 4-300× on the constrained links. The main contributors (per-class file): resting
  debris drawn 17 cm low (chunk_debris pos@render p50 0.174 → 0.007-0.009 m),
  retired cannonballs drawn for 4 s (body p95 161-172 m → 0.002 m), meteors
  held after impact (meteor p99 37.5 → 0.017 m on the systematic bundle and
  the owner's session; 49 → 18 m and 151 → 15 m on heavy and citylat4, where
  rocks that never streamed stay on their arc for a staleness window, item 16).
- **Identity.** Wrong-identity chunk-frames on LTE: 70,697 → 529
  (systematic), 25,050 → 32, 15,154 → 36, 16,407 → 98; on poor-mobile
  147,427 → 456 and 758,676 → 60; on bw-capped 2.73 M → 355 and 3.91 M →
  1,154. Extra draw-frames on the systematic bundle's loopback: 222,781 →
  2,634 (floor-retired chunks and stale bodies).
- **Sync.** Clock back-steps 188-2,138 per run → 0 on every cell. Repairs
  asked 4-91 → 0 on every cell.
- **First draw.** Unchanged on fast links (island p99 8-24 ms, 105 ms on the
  owner's session); on LTE island
  p99 313-356 → 119-226 ms; on poor-mobile 3.2-8.9 s → 0.2-0.3 s.
- **Latency is the cost.** The pre-work client drew ahead of the server
  (bodies −4 to −8 ms behind on loopback, i.e. extrapolated, with hundreds
  of back-steps) and presented the city ahead of its data (LTE −2.5 to −3.7
  ticks). HEAD draws bodies 15-21 ms behind the server on loopback and
  140-148 ms on LTE, and presents the city 5.2-5.4 ticks behind on
  loopback and 9.8-10.2 on LTE. So **pos@now** (what a viewer comparing
  screens sees) improves less: p99 0.232 → 0.138 m (systematic loopback),
  0.198 → 0.038 (citylat4), and gets worse on the owner's session (1.25 →
  2.04 m loopback, 1.57 → 2.72 m LTE), whose fast heavy debris is drawn later
  (chunk_debris pos@now p99 5.4 → 8.7 m loopback) (**inferred**: the item-12
  presentation delay; the old number was bought by drawing ticks that had not
  arrived).

### Remaining gaps (ranked, after HEAD)

1. **Bodies drawn after the server retired them** (fast links too): 2,302-
   2,306 body draw-frames on the systematic bundle's LAN, 9% of its body
   draws; 591-593 on citylat4; 3,952 on LTE. The client infers a removal
   (bodyPresence.ts) at the next missed cold refresh, up to 1 s late.
   **Fixed below** (explicit removals).
2. **Vehicles drawn up to 3 s after they left the stream**: the owner's
   session, vehicle pos@render p95 / p99 16.2 / 17.8 m on every link, 333 of
   1,385 vehicle draw-frames (a car pushed out of the 80 m interest radius,
   held at its last pose by the 180-tick stale rule). **Fixed below.**
3. **Snapshot fixed cost**: 60 B of every 60 Hz snapshot is fixed, 21 B of it
   a support block that is zero or names a support that does not move on
   every snapshot of all four bundles (**measured** from
   `snapshot-inputs.jsonl`: a support on 48-70% of recipient-ticks, every
   one `entity_id` 1 at zero velocity; see finding 1 below). **Fixed below** (compact self state).
4. **LTE latency** (presented −10 ticks, bodies 140-148 ms behind). About 4
   ticks are the one-way latency and the rest the playout delay the ±35 ms
   jitter needs (city-latency round). A smaller delay trades
   corrections drawn in view (adaptive delay, built and off), and drawing
   ahead of the data was rejected there. **Partly fixed**
   ([city send cadence and playout delay](#city-send-cadence-and-playout-delay)):
   with the city stream at 60 Hz the delay is 5 ticks, and the city is
   presented 0.9-1.3 ticks nearer the server on every fast link (LTE
   −10.0 → −8.8). The snapshot stream's bodies (140-148 ms on LTE, 15-21 ms
   on loopback) are unchanged.
5. **Snapshots discarded as out of order.** **Fixed**
   ([late snapshots](#next-wins-late-snapshots-and-idle-players-and-vehicles)).
   The client drops a whole snapshot
   older than the newest it has. On the lab's poor-mobile link that is 38% of
   snapshots (measured on citylat4 c1, both arms), and a cold refresh
   (vehicles at rest every 0.5 s, bodies every 1 s) goes with it; vehicle
   missing draw-frames swing 0-662 per cell with the link seed. The lab's
   iid jitter over-reorders compared with real LTE (known limit), so the
   real share is unknown. Candidate: apply an older snapshot's entities whose
   own newest sample is older (entity-level ordering).
6. **Idle bytes**: **fixed**
   ([idle players and vehicles](#next-wins-late-snapshots-and-idle-players-and-vehicles)).
   With nothing moving the city stream is silent and the
   snapshot is everything: 64.4 kbit/s on citylat4 c1 (2 remote players and
   a car sent every tick though at rest; players have no hot/cold split).
   The compact self state below takes 10 kbit/s of it.
7. **Debris pos@now on heavy sessions** (the owner's: p99 8.7 m loopback): the
   price of the presentation delay; unchanged.

Finding 1 (**measured**, not fixed): the self state's support block names
city structures as dynamic bodies. In all four bundles every recipient-tick
with a support reports `entity_id` 1 (on citylat4 with local positions like
(-32.7, 10.8, -6.5)), and snapshot handle 1 is a cannonball in `body_meta`.
`physx_runtime.rs` `player_support` takes the bridge body's `user_id`,
which for the city's kinematic structure bodies collides with the dynamic
body ids (**inferred**). Harmless today: the client reads only the support's
velocity, which is zero there.

### Next wins: compact self state and explicit removals

Gaps 1-3 above, fixed in the snapshot stream. Both are wire changes detected
by length, with no protocol version bump, and both are on by default
(`SnapshotConfig::PRODUCTION`). WebSocket stays disabled.

**1. Compact self state** (`server/src/protocol.rs` `SnapshotV2Packet::compact_self`,
`snapshot_builder.rs` `SnapshotConfig::compact_self`).

- The self state's 21-byte support block (handle, local position, velocity,
  flags, angular velocity) is left out, 33 → 12 bytes, when the support's
  quantised velocity and angular velocity are zero.
- The client reads only the support velocity (`gameRuntime.ts` passes
  `localSupport?.velocity` to the thin predictor, which treats absent as
  zero), so what it does is unchanged. Every client since before e3fdf5cc
  already length-detects the block (`decodeSnapshotV2Packet`: 33, 27 or 12
  bytes, from the bytes left after the entities), so older clients read the
  compact form as "no support". A test decodes both forms to equal packets.
- 21 B on every snapshot: about 10 kbit/s per client at 60 Hz, 20-25% of
  the snapshot stream.

**2. Explicit removals** (`SnapshotV2Packet::removals`, `SnapshotConfig::removals`,
client `netcodeClient.ts` `applyBodyRemovals` and the vehicle removal).

- The builder remembers, per recipient, which bodies and vehicles it has sent
  and which are in the recipient's interest. When one leaves the interest
  (or the world) after it was sent, the next 6 snapshots name it in a
  section after the wall-clock trailer: tag `0xE7`, count, then per entry a
  u16 handle (vehicles `0x8000 | handle`, the support handle's convention)
  and a u8 age (ticks since the removal). At most 8 entries a snapshot; the
  section is not charged to the byte budget (1,100 + 26 B stays under the
  1,160 B datagram limit).
- A snapshot that carries a removals section always carries the full 33-byte
  self state, so older clients, which detect the self state by length, still
  read it right, and never read past the trailer.
- The client holds a named body at its last sample until its render time
  reaches the removal tick, then drops it; a vehicle likewise on the player
  render clock. A removal older than a sample the entity has had since is
  ignored (it came back). A server without the section changes nothing: the
  inference in bodyPresence.ts and the 180-tick vehicle rule still decide.
- An entity that leaves is sent at once when it returns (its cold-refresh
  clock is reset), and an entity entering the stream is carried in its first
  3 snapshots whatever its hot/cold state (`SNAPSHOT_ENTRY_SENDS`). Without
  that, a lost first send of a car at rest left it undrawn until its 0.5 s
  refresh (first lab pass: systematic poor-mobile vehicle missing 222 → 491;
  with it 222 → 63).
- Cost: 3 B × 6 per removal plus the 21-byte support block that a snapshot
  with a section carries: 0.17 kbit/s per client in the live run below (17
  removals per client in 122 s).

**Calibration.** Captures record which format their server ran
(`SnapshotBaseline::compact_self` / `removals`, `snapshot-baseline.json`); a
capture without the fields replays with both off, and the knobs
`snapshot.compact_self` / `snapshot.removals` override. With this round's lab
binary `netlab2 calibrate` passes every byte check on the older captures
(measured): systematic c1 34,331 / 34,331, heavy c1 10,861 / 10,861,
citylat4 c1 11,582 / 11,582, the owner's session 11,502 / 11,503 (one
lab-only snapshot at the capture's end, the same with the HEAD lab binary).
The new live capture below was recorded with both on.

**Results** (measured, lab, seed 1): HEAD against HEAD plus this change,
`snapshot.compact_self=1,snapshot.removals=1`, every other knob as the
after arm above.


**systematic-2c-d1342419 c1**, HEAD → this change:

| Link | Netcode kbit/s | ALL missing / extra | Body missing / extra | Meteor missing / extra | Vehicle missing; pos@render p99 m | ALL pos@render / pos@now p99 m |
|---|---|---|---|---|---|---|
| loopback | 259.3 → 250.1 (-3.5%) | 66 / 2,634 → 94 / 280 | 12 / 2,306 → 38 / 125 | 41 / 176 → 43 / 3 | 0; 0.002 → 0; 0.002 | 0.025 / 0.138 → 0.025 / 0.138 |
| lan | 259.3 → 250.1 (-3.5%) | 51 / 2,631 → 80 / 275 | 13 / 2,302 → 40 / 120 | 37 / 177 → 39 / 3 | 0; 0.002 → 0; 0.002 | 0.025 / 0.138 → 0.025 / 0.138 |
| cable | 259.0 → 249.9 (-3.5%) | 73 / 2,636 → 101 / 290 | 19 / 2,305 → 45 / 133 | 43 / 177 → 44 / 3 | 0; 0.002 → 0; 0.002 | 0.025 / 0.153 → 0.025 / 0.153 |
| lte | 251.6 → 242.8 (-3.5%) | 359 / 4,656 → 349 / 600 | 62 / 3,952 → 173 / 421 | 104 / 528 → 109 / 3 | 186; 0.002 → 60; 0.002 | 0.029 / 0.265 → 0.029 / 0.265 |
| lossy-wifi | 251.7 → 242.9 (-3.5%) | 247 / 3,910 → 248 / 835 | 51 / 2,852 → 149 / 313 | 87 / 536 → 92 / 0 | 108; 0.002 → 6; 0.002 | 0.028 / 0.168 → 0.028 / 0.168 |
| poor-mobile | 233.3 → 224.9 (-3.6%) | 386 / 3,721 → 323 / 781 | 78 / 3,115 → 176 / 449 | 83 / 144 → 84 / 7 | 222; 0.002 → 63; 0.005 | 0.031 / 0.343 → 0.031 / 0.343 |
| poor-mobile-nq | 234.0 → 225.9 (-3.4%) | 272 / 4,392 → 563 / 919 | 59 / 3,803 → 152 / 442 | 97 / 163 → 121 / 0 | 115; 0.002 → 290; 0.003 | 0.030 / 0.354 → 0.029 / 0.378 |
| cap-1mbit | 240.7 → 232.0 (-3.6%) | 89 / 2,864 → 143 / 429 | 29 / 2,506 → 83 / 172 | 59 / 175 → 58 / 2 | 0; 0.002 → 1; 0.002 | 0.027 / 0.198 → 0.027 / 0.198 |
| cap-1mbit-nq | 239.9 → 231.3 (-3.6%) | 89 / 3,098 → 158 / 364 | 34 / 2,670 → 95 / 168 | 54 / 173 → 61 / 0 | 0; 0.002 → 1; 0.002 | 0.027 / 0.204 → 0.027 / 0.198 |
| bw-capped | 204.2 → 196.2 (-3.9%) | 87 / 3,005 → 139 / 412 | 23 / 2,624 → 95 / 193 | 51 / 174 → 43 / 2 | 0; 0.002 → 0; 0.002 | 0.030 / 0.232 → 0.030 / 0.232 |
| bw-capped-nq | 200.7 → 191.6 (-4.6%) | 103 / 2,932 → 137 / 501 | 28 / 2,543 → 66 / 219 | 57 / 170 → 59 / 6 | 0; 0.002 → 1; 0.002 | 0.032 / 0.256 → 0.031 / 0.256 |

**heavy-quick3-v2 c1**, HEAD → this change:

| Link | Netcode kbit/s | ALL missing / extra | Body missing / extra | Meteor missing / extra | Vehicle missing; pos@render p99 m | ALL pos@render / pos@now p99 m |
|---|---|---|---|---|---|---|
| loopback | 217.8 → 209.7 (-3.7%) | 30 / 244 → 30 / 31 | 14 / 244 → 14 / 31 | 15 / 0 → 15 / 0 | 0; 0.002 → 0; 0.002 | 0.039 / 0.174 → 0.039 / 0.174 |
| lan | 217.8 → 209.7 (-3.7%) | 29 / 246 → 29 / 34 | 14 / 246 → 14 / 34 | 14 / 0 → 14 / 0 | 0; 0.002 → 0; 0.002 | 0.039 / 0.174 → 0.039 / 0.174 |
| cable | 217.6 → 209.6 (-3.7%) | 31 / 249 → 31 / 37 | 16 / 249 → 16 / 37 | 14 / 0 → 14 / 0 | 0; 0.002 → 0; 0.002 | 0.040 / 0.185 → 0.040 / 0.185 |
| lte | 211.4 → 203.6 (-3.7%) | 182 / 308 → 67 / 106 | 53 / 308 → 53 / 106 | 12 / 0 → 12 / 0 | 115; 0.002 → 0; 0.002 | 0.049 / 0.273 → 0.049 / 0.273 |
| lossy-wifi | 212.4 → 204.6 (-3.7%) | 111 / 295 → 60 / 87 | 39 / 295 → 39 / 87 | 20 / 0 → 20 / 0 | 51; 0.002 → 0; 0.002 | 0.045 / 0.185 → 0.045 / 0.185 |
| poor-mobile | 188.9 → 180.9 (-4.2%) | 128 / 312 → 92 / 104 | 58 / 312 → 63 / 104 | 20 / 0 → 28 / 0 | 50; 0.002 → 0; 0.002 | 0.054 / 0.366 → 0.056 / 0.366 |
| poor-mobile-nq | 181.9 → 173.2 (-4.8%) | 175 / 309 → 129 / 105 | 48 / 309 → 53 / 105 | 11 / 0 → 17 / 0 | 115; 0.002 → 58; 0.002 | 0.058 / 0.390 → 0.058 / 0.390 |
| cap-1mbit | 195.0 → 187.3 (-3.9%) | 44 / 258 → 39 / 49 | 25 / 258 → 25 / 49 | 18 / 0 → 13 / 0 | 0; 0.002 → 0; 0.002 | 0.045 / 0.232 → 0.045 / 0.232 |
| cap-1mbit-nq | 181.6 → 175.4 (-3.4%) | 46 / 255 → 48 / 44 | 23 / 255 → 26 / 44 | 22 / 0 → 21 / 0 | 0; 0.002 → 0; 0.002 | 0.056 / 0.248 → 0.054 / 0.248 |
| bw-capped | 166.6 → 159.1 (-4.5%) | 33 / 269 → 46 / 54 | 20 / 265 → 33 / 50 | 12 / 0 → 12 / 0 | 0; 0.002 → 0; 0.002 | 0.075 / 0.292 → 0.075 / 0.292 |
| bw-capped-nq | 166.4 → 158.8 (-4.6%) | 42 / 261 → 34 / 55 | 28 / 257 → 25 / 51 | 13 / 0 → 8 / 0 | 0; 0.002 → 0; 0.002 | 0.072 / 0.301 → 0.070 / 0.301 |

**20260924-162732-quick-3c-citylat4 c1**, HEAD → this change:

| Link | Netcode kbit/s | ALL missing / extra | Body missing / extra | Meteor missing / extra | Vehicle missing; pos@render p99 m | ALL pos@render / pos@now p99 m |
|---|---|---|---|---|---|---|
| loopback | 165.0 → 155.6 (-5.7%) | 16 / 593 → 18 / 34 | 8 / 593 → 10 / 34 | 7 / 0 → 7 / 0 | 0; 0.002 → 0; 0.002 | 0.016 / 0.038 → 0.016 / 0.038 |
| lan | 165.0 → 155.6 (-5.7%) | 12 / 591 → 14 / 33 | 5 / 591 → 7 / 33 | 6 / 0 → 6 / 0 | 0; 0.002 → 0; 0.002 | 0.016 / 0.038 → 0.016 / 0.038 |
| cable | 164.7 → 155.3 (-5.7%) | 16 / 597 → 17 / 36 | 10 / 597 → 11 / 36 | 4 / 0 → 4 / 0 | 0; 0.002 → 0; 0.002 | 0.016 / 0.042 → 0.016 / 0.042 |
| lte | 160.3 → 151.2 (-5.7%) | 101 / 1,261 → 105 / 102 | 23 / 1,261 → 27 / 102 | 20 / 0 → 20 / 0 | 57; 0.008 → 57; 0.008 | 0.017 / 0.058 → 0.017 / 0.058 |
| lossy-wifi | 159.3 → 150.2 (-5.7%) | 44 / 1,141 → 46 / 74 | 25 / 1,141 → 27 / 74 | 19 / 0 → 19 / 0 | 0; 0.010 → 0; 0.010 | 0.017 / 0.043 → 0.017 / 0.043 |
| poor-mobile | 150.9 → 142.4 (-5.6%) | 135 / 826 → 304 / 120 | 39 / 826 → 31 / 120 | 40 / 0 → 36 / 0 | 55; 0.003 → 237; 0.004 | 0.017 / 0.068 → 0.017 / 0.068 |
| poor-mobile-nq | 150.7 → 142.4 (-5.5%) | 46 / 1,607 → 53 / 99 | 22 / 1,607 → 23 / 99 | 24 / 0 → 29 / 0 | 0; 0.009 → 0; 0.007 | 0.018 / 0.070 → 0.017 / 0.070 |
| cap-1mbit | 155.5 → 146.3 (-5.9%) | 22 / 600 → 21 / 44 | 15 / 600 → 15 / 44 | 6 / 0 → 5 / 0 | 0; 0.002 → 0; 0.002 | 0.016 / 0.046 → 0.016 / 0.046 |
| cap-1mbit-nq | 155.5 → 146.2 (-6.0%) | 26 / 598 → 27 / 46 | 20 / 598 → 21 / 46 | 5 / 0 → 5 / 0 | 0; 0.002 → 0; 0.002 | 0.016 / 0.048 → 0.016 / 0.048 |
| bw-capped | 139.6 → 131.0 (-6.1%) | 23 / 600 → 26 / 53 | 13 / 600 → 19 / 53 | 9 / 0 → 7 / 0 | 0; 0.002 → 0; 0.002 | 0.017 / 0.051 → 0.017 / 0.051 |
| bw-capped-nq | 137.5 → 125.8 (-8.5%) | 22 / 599 → 28 / 52 | 13 / 599 → 18 / 52 | 8 / 0 → 9 / 0 | 0; 0.002 → 0; 0.002 | 0.017 / 0.052 → 0.017 / 0.052 |

**session-20260924-213925-ondf3t (the player)**, HEAD → this change:

| Link | Netcode kbit/s | ALL missing / extra | Body missing / extra | Meteor missing / extra | Vehicle missing; pos@render p99 m | ALL pos@render / pos@now p99 m |
|---|---|---|---|---|---|---|
| loopback | 567.1 → 561.0 (-1.1%) | 117 / 0 → 117 / 0 | - / - → - / - | 20 / 0 → 20 / 0 | 0; 17.815 → 0; 0.020 | 0.066 / 2.035 → 0.064 / 2.035 |
| lan | 567.1 → 561.0 (-1.1%) | 89 / 0 → 89 / 0 | - / - → - / - | 17 / 0 → 17 / 0 | 0; 17.815 → 0; 0.020 | 0.064 / 2.035 → 0.062 / 2.035 |
| cable | 566.6 → 560.5 (-1.1%) | 84 / 0 → 87 / 0 | - / - → - / - | 17 / 0 → 19 / 0 | 0; 17.815 → 1; 0.020 | 0.062 / 2.171 → 0.062 / 2.171 |
| lte | 551.1 → 545.1 (-1.1%) | 32 / 0 → 32 / 0 | - / - → - / - | 32 / 0 → 32 / 0 | 0; 17.815 → 0; 0.020 | 0.070 / 2.724 → 0.070 / 2.724 |
| lossy-wifi | 548.2 → 542.3 (-1.1%) | 122 / 0 → 100 / 0 | - / - → - / - | 30 / 0 → 30 / 0 | 25; 18.401 → 3; 0.018 | 0.077 / 2.171 → 0.077 / 2.171 |
| poor-mobile | 413.3 → 410.3 (-0.7%) | 36 / 0 → 36 / 0 | - / - → - / - | 36 / 0 → 34 / 0 | 0; 18.401 → 2; 0.023 | 0.094 / 3.645 → 0.094 / 3.529 |
| poor-mobile-nq | 413.4 → 408.8 (-1.1%) | 30 / 0 → 32 / 0 | - / - → - / - | 30 / 0 → 31 / 0 | 0; 17.815 → 1; 0.027 | 0.100 / 3.889 → 0.097 / 4.017 |
| cap-1mbit | 431.4 → 426.8 (-1.1%) | 102 / 0 → 103 / 0 | - / - → - / - | 20 / 0 → 19 / 0 | 0; 17.815 → 2; 0.020 | 0.082 / 2.553 → 0.082 / 2.553 |
| cap-1mbit-nq | 411.9 → 419.3 (+1.8%) | 104 / 0 → 102 / 0 | - / - → - / - | 21 / 0 → 17 / 0 | 0; 17.815 → 2; 0.020 | 0.100 / 2.813 → 0.085 / 2.724 |
| bw-capped | 279.2 → 275.6 (-1.3%) | 97 / 0 → 97 / 0 | - / - → - / - | 20 / 0 → 19 / 0 | 0; 17.815 → 1; 0.020 | 0.256 / 3.002 → 0.256 / 2.906 |
| bw-capped-nq | 258.1 → 249.9 (-3.2%) | 99 / 0 → 98 / 0 | - / - → - / - | 22 / 0 → 19 / 0 | 0; 17.815 → 1; 0.020 | 0.390 / 3.308 → 0.506 / 3.417 |

What it says:

- **Bytes** fall 3.4-8.5% on every link of the three 60 Hz bundles (8-9.4
  kbit/s per client on the fast links) and 1.1% (6.1 kbit/s) on the owner's
  session, whose server ran at about 43 ticks/s and whose bytes are 95% city.
  On a rate-limited link the controller can give the freed bytes to the city
  (the owner's session on cap-1mbit-nq: +1.8%).
- **Idle** (citylat4 c1, loopback, the capture's last 4 s with nothing
  moving and the city stream silent): 64.4 → 54.3 kbit/s (−16%).
- **Bodies drawn after they left the stream** (body extra) fall 66-95% on
  every cell: LAN 2,302 → 120 (systematic), 246 → 34 (heavy), 591 → 33
  (citylat4); LTE 3,952 → 421, 308 → 106, 1,261 → 102. Meteor extra on the
  systematic bundle 177 → 3 (LAN), 528 → 3 (LTE).
- **The cost is a few missing frames per removal of a moving body**: body
  missing on the systematic bundle 12 → 38 (loopback), 62 → 173 (LTE); heavy
  and citylat4 within +13 / −8. A moving body is held no longer than its last
  sample (bodyPresence.ts's rule for a moving body, now applied when it is
  named, not up to 15 ticks later), so a ball retired at tick T is hidden
  from its last sample at T−1, up to a tick before truth drops it
  (**inferred**). Holding it to T instead measured worse: heavy LTE body
  pos@render p99 0.038 → 0.366 m (first lab pass).
- **Vehicles**: the owner's session vehicle pos@render p99 17.8 → 0.020 m on
  every link (pos@now p95 16.2 → 0.72 m on loopback); vehicle missing 0 →
  0-3.
- **Unchanged or lower**: ALL pos@render / pos@now p99 on every fast-link
  cell (the owner's session LAN pos@render p99 0.064 → 0.062 m, the vehicles), latency (bodies drawn behind the server within
  0.1 ms on fast links), wrong identity on fast links, clock back-steps (0).
  Body pos@render p99 on the jittery links moves both ways by a few
  centimetres at p99 (heavy poor-mobile 0.185 → 0.052 m, citylat4
  poor-mobile 0.052 → 0.100 m). On the network-queue links, where the rate
  controller re-spends the freed bytes, ALL p99 moves both ways too
  (systematic poor-mobile-nq pos@now 0.354 → 0.378 m; the owner's session
  bw-capped-nq pos@render 0.390 → 0.506 m, cap-1mbit-nq 0.100 → 0.085 m).
- **Seeds 1-3** on lte, poor-mobile and poor-mobile-nq (systematic and
  citylat4, 18 cells): body extra 44,206 → 4,792 (lower in all 18), body
  missing 761 → 1,740, vehicle missing 4,012 → 2,478, ALL missing 5,869 →
  5,444.
- **Vehicle missing on the jittery links is seed noise** (gap 5): 0-662
  draw-frames per cell in both arms. The cells that rose (citylat4
  poor-mobile 55 → 237, systematic poor-mobile-nq 115 → 290) are a parked
  car whose 0.5 s cold refreshes were discarded as out-of-order snapshots
  several times running (inspected on citylat4: no removal named it; 38.4%
  and 38.2% of snapshots arrived out of order in the two arms).

Gaps 4-7 of the scoreboard remained; [proposals](#proposals-not-implemented)
7 and 8 were the next two, and are
[implemented below](#next-wins-late-snapshots-and-idle-players-and-vehicles).

**Live** (measured; `scripts/perf/city-bench.sh --scenario quick --clients 3`
on this tree, ports 6501/6502/3653, GPU lock,
`target/net-scoreboard/city-bench/runs/20260924-215619-scoreboard-new`,
baseline the 162732 citylat4 capture):

- 3/3 paired bundles, 0 errors. Budgets: 20 of 27 pass (citylat4: 17). The
  failures are the server's tick and sim rate (tick p95 30.2 ms, sim rate
  0.88, worst 5 s 0.43: GPU physics, a heavier run, 34.4% of bonds broken
  against 24.9%), 4 client CPU hitches over 33 ms on c2, and c2's snapshot
  gap p99 57.5 ms (the server's own tick gaps).
- **The format is live**: 98.4% of snapshots carry the 12-byte self state on
  every client; the fixed part of a snapshot is 39.4 B against 60.0 B in the
  citylat4 capture; snapshot kbit/s 44.7-51.2 → 33.0-39.3 per client (the
  runs' entities differ). 17 removals per client (one of c1's a vehicle),
  each restated 6 times, 0.17 kbit/s in all, most of it the full self
  state that a snapshot with a removals section carries.
- **Fidelity**: body render error p99 0.15-0.21 → 0.04 m on every client;
  stale body draws 0-2 → 0; render-clock back-steps 0; structure repairs 0;
  0 packets lost; send → arrive p99 4.2-4.5 ms. kbit/s per client rose
  167-179 → 201-213 with the heavier destruction (indicative only).
- One city presentation clock rollback on c1 (0 in citylat4): the city
  client is untouched by this change, and the run's server fell to 0.43 of
  real time for 5 s (**inferred**: not this change).
- **Calibration of this capture with this tree: PASS on all three
  clients.** Bytes 11,788 / 11,788, 11,771 / 11,771 and 11,681 / 11,681
  byte-identical, snapshots 6,432 / 6,432 each (compact self states and
  removals sections included); clock offset p99 in the last 10 s 99-100 µs;
  lab vs live renderer p99: players 0.9-1.3 cm, vehicles 0.2-0.6 cm,
  bodies 5.0-6.1 cm, meteors 6.7-7.1 cm, intact chunks 0.00 mm, debris
  chunks 3.2-6.4 cm.

**Tests** (all fail or do not compile without the change, except the
guards):

- `server/src/snapshot_builder.rs` (new test module, 8):
  `a_body_retired_after_it_was_sent_is_named_in_the_next_snapshots`,
  `a_body_never_sent_is_never_named_and_one_that_returns_is_sent_at_once`,
  `a_vehicle_that_leaves_interest_is_named_with_the_vehicle_bit`,
  `an_entity_entering_the_stream_is_in_its_first_three_snapshots_even_at_rest`,
  `the_support_block_is_left_out_unless_the_support_moves`,
  `a_snapshot_with_removals_carries_the_full_self_state_then_the_section`
  (the exact bytes), and the guards
  `the_legacy_format_sends_no_removals_and_the_full_self_state` and
  `an_older_interest_baseline_reads_the_new_fields_as_empty`.
- `server/src/bin/netlab2/fixture_tests.rs`: the mid-match fixture now
  records the production format and replays byte for byte; without the
  recorded format (a legacy capture) no snapshot matches a production
  server's, and with the knobs they converge as before.
- `client/src/net/protocol.test.ts`: a 12-byte self state with the trailer
  decodes to exactly what the 33-byte zero block does; the removals section
  after the trailer, with the full self state before it; a snapshot without
  the section has none.
- `client/src/net/netcodeClient.test.ts`: a resting body named in a removals
  section is drawn until the render time reaches the removal and then
  dropped (not at the next cold refresh); a moving one is not held past its
  last sample; a removal older than a newer sample is ignored; a named
  vehicle is dropped one interpolation delay after its removal, where
  without the section the 180-tick rule still keeps it (guard).
- `scripts/perf/test_session_bundle.py`: the analysis decoder reads entities
  after a 12- or 33-byte self state, with or without the trailer and section.
- Suites: server 156 (+1 ignored) and netlab2 87 passing; client 1,172
  passing (4 skipped); `tsc` clean.

**Reproduce**

```bash
# the pre-work client, made scoreable (a worktree of e3fdf5cc)
git worktree add .claude/worktrees/net-prework e3fdf5cc --detach
scripts/perf/netlab2-prework/install.sh .claude/worktrees/net-prework
(cd .claude/worktrees/net-prework/client && npm run build:wasm)   # CC/AR for wasm32 as in netlab-v2.md
BEFORE=lab.recorded_repairs=0,city.ballistic_free_fall=0,city.client_model=0,city.baseline_interval_ticks=60,city.baseline_lag_ticks=0,city.baseline_skip_quiescent=0,city.topology_copies=0,city.rate_adapt=0
AFTER=lab.recorded_repairs=0,city.ballistic_free_fall=1,city.client_model=1,city.baseline_interval_ticks=120,city.baseline_lag_ticks=110,city.baseline_skip_quiescent=1,city.topology_copies=2
NEW=$AFTER,snapshot.compact_self=1,snapshot.removals=1
$N run --bundle <bundle> --out <runs>/before/<link> --link <link> --seed 1 --knob $BEFORE \
   --client-root .claude/worktrees/net-prework/client
$N run --bundle <bundle> --out <runs>/after/<link> --link <link> --seed 1 --knob $AFTER    # HEAD's client
scripts/perf/netlab2-scoreboard.py lag <runs>/*/*          # before pruning presented.bin
scripts/perf/netlab2-scoreboard.py table --before <runs>/before --after <runs>/after --before-no-trailer
```

### Next wins: late snapshots and idle players and vehicles

Proposals 7 and 8 (gaps 5 and 6 above). Base: 2a601833. Every number is
**measured** in Netlab v2 unless marked **inferred**.

**1. Late snapshots applied per entity** (client only: `netcodeClient.ts`
`applyLateSnapshotV2`).

- Before: a SnapshotV2 older than the newest one applied was dropped whole,
  with any cold refresh it carried. On the lab's iid-jitter links that is
  31-34% of snapshots on `lte`, 20-21% on `lossy-wifi` and 36-39% on
  `poor-mobile(-nq)` (every bundle; the late share is the same with and
  without this change, and moves by at most 0.6 points with change 2).
- Now what a late snapshot carries that is still news is applied, and nothing
  newer is undone:
  - a player, body or vehicle whose own newest sample is older than the
    snapshot (a parked car's refresh, a resting body's, an entity's entry
    sends) is applied as the newest snapshot would apply it;
  - an entity with newer samples gets the late sample inserted into its
    interpolation buffer, in order, which fills the gap it left;
  - its removals are noted (each already checks for a newer sample).
- A late snapshot never brings back a body or vehicle the client has dropped
  since (`dynamicBodyDroppedAtTick` / `vehicleDroppedAtTick`, kept 600 ticks),
  never moves the newest state back, and never feeds the clocks, the local
  player's state, prediction or reconciliation, or the stream-presence
  inference (bodyPresence.ts): those follow the newest snapshot, as before.
- No wire or server change; it helps against every server.

**2. Idle players and vehicles sent cold** (server:
`snapshot_builder.rs` `SnapshotConfig::idle_cold`; client: rest holds in
`interpolation.ts`).

- Before: every remote player in interest was in every snapshot, and so was
  every vehicle with a driver, parked or not (19 and 30 B each at 60 Hz). At
  idle on citylat4 c1 that was two standing players and an occupied parked
  car: 32.6 of 51.4 kbit/s of snapshots.
- Now a remote player or vehicle is sent in the snapshot its record changes
  (position by more than 2 mm, a vehicle's orientation by more than 2 snorm
  units, yaw, pitch, hp, flags, driver, type, or whether it moves), in the
  next three snapshots as it settles (`SNAPSHOT_REST_SENDS`), and then once
  per cold refresh (30 ticks, the vehicles' existing rate;
  `snapshot.cold_player_refresh_ticks`). An entity entering the stream counts
  as changed, so it is also in its first three snapshots.
- **Motion onset is never delayed**: the change test runs every snapshot
  against the last record sent, so the first tick an entity moves, turns or
  changes state is sent in that tick's snapshot (tests
  `a_player_that_moves_or_turns_is_sent_at_once`,
  `a_parked_car_with_a_driver_goes_cold_and_is_sent_when_it_moves`). A
  vehicle moving slower than the old 0.05 m/s hot threshold is now sent once
  its pose has drifted 2 mm, where it used to wait for its refresh.
- A standing player is sent with zero velocity. The character controller
  reports a constant -0.5 m/s ground snap for a grounded player (measured in
  every bundle's `world.bin`), which any client extrapolates for up to 100 ms
  once its render time passes the newest sample; with players sent every
  snapshot that never happened, with idle players cold it would sink them
  5 cm. The zero is what their position does, so old clients hold them too.
- Rest holds (client): when a player's or vehicle's sample follows a gap
  after a sample at rest (speed at most 0.05 m/s), the interpolator first
  inserts a copy of the resting sample one snapshot interval before it. It
  is then drawn where it stood until the snapshot before the one it moved in,
  instead of interpolated from its last refresh up to 0.5 s earlier. A late
  snapshot that lands in the gap replaces the hold and gets its own if it is
  now the first moving one (found in the lab: a first-moving snapshot
  arriving after the next one left a 13 cm onset error on citylat4
  bw-capped; fixed before the runs below). A sample that was moving (every
  grounded player from an older server, at -0.5 m/s) never gets a hold, so
  against a server without `idle_cold` nothing changes for players.
- Removals (2a601833) still name vehicles that leave; players have no
  removal and, as before, are drawn at their last pose once out of interest.
- **Format flag**: captures record `idle_cold` in `snapshot-baseline.json`
  (`SnapshotBaseline::idle_cold`); a capture without it (every capture
  before this change) replays with it off, byte for byte, and
  `snapshot.idle_cold` overrides it. It is not a wire-layout change: the
  snapshot carries fewer records, which every client already handles.

**Arms.** One lab binary (this tree), the same frozen truth, link and seed:

- **base**: the 2a601833 client via `--client-root` (a clean worktree of the
  base) and `snapshot.idle_cold=0` (the format the base server sends);
- **late**: this tree's client, `snapshot.idle_cold=0` (change 1, and the
  rest holds, which only matter for vehicles against this server);
- **both**: this tree's client, `snapshot.idle_cold=1` (changes 1 and 2);
- **compat**: the base client with `snapshot.idle_cold=1` (an old client on
  the new server).

Every arm uses the scoreboard's production knobs (`AFTER` below, plus
`snapshot.compact_self=1,snapshot.removals=1` for bundles recorded before
them), recorded pace, `lab.recorded_repairs=0`. 11 links × seeds 1-3 for
base, late and both; the compat arm on seed 1. The same five bundles as the
scoreboard, plus the live capture recorded against 2a601833's tree
(`target/net-scoreboard/city-bench/runs/20260924-215619-scoreboard-new`, c1).

**Summary** (sums or means over 11 links × 3 seeds = 33 cells per bundle;
base → late → both):

| Bundle | Netcode kbit/s (mean) | ALL missing | Vehicle missing | Player pos@render p99 m (mean) | Vehicle pos@render p99 m (mean) | Body pos@render p99 m (mean); body missing | Meteor missing |
|---|---|---|---|---|---|---|---|
| systematic-2c-d1342419 c1 | 230.8 → 230.8 → 224.8 | 7,573 → 5,397 → 5,413 | 1,768 → 62 → 57 | 0.013 → 0.002 → 0.002 | 0.002 → 0.002 → 0.002 | 0.015 → 0.003 → 0.003; 3,295 → 3,042 → 3,142 | 2,346 → 2,131 → 2,049 |
| heavy-quick3-v2 c1 | 188.3 → 188.3 → 183.8 | 1,887 → 1,530 → 1,413 | 241 → 0 → 0 | 0.008 → 0.002 → 0.002 | 0.002 → 0.002 → 0.002 | 0.021 → 0.002 → 0.002; 1,020 → 956 → 934 | 494 → 449 → 448 |
| citylat4 c1 | 145.7 → 145.7 → 136.0 | 1,971 → 988 → 1,032 | 852 → 0 → 0 | 0.009 → 0.002 → 0.002 | 0.004 → 0.003 → 0.002 | 0.019 → 0.002 → 0.002; 679 → 640 → 668 | 407 → 317 → 328 |
| scoreboard-new c1 | 180.5 → 180.5 → 172.7 | 1,535 → 1,195 → 1,218 | 249 → 12 → 21 | 0.005 → 0.002 → 0.002 | 0.003 → 0.002 → 0.002 | 0.013 → 0.002 → 0.002; 819 → 724 → 744 | 440 → 427 → 422 |
| the owner's session | 451.3 → 451.3 → 451.3 | 2,696 → 2,623 → 2,647 | 37 → 37 → 43 | - | 0.023 → 0.020 → 0.002 | -; 0 | 816 → 743 → 761 |

What it says:

- **Vehicles missing because their refresh arrived late: gone.** Vehicle
  missing draw-frames over the 33 cells fall 1,768 → 62 (systematic), 241 →
  0, 852 → 0 and 249 → 12. The seed-to-seed swing the scoreboard reported
  (gap 5) goes with it: on the jittery links the base ranges over the seeds
  are 9-60 (lte), 2-66 (lossy-wifi), 3-482 (poor-mobile) and 6-653
  (poor-mobile-nq) on the systematic bundle, 0-237 and 0-254 on citylat4's
  poor-mobile links; with late snapshots applied they are 1-9, 2-9, 3-7, 2-6
  and 0-0.
- **Interpolation gaps filled.** Players, vehicles and bodies were
  interpolated across the hole a dropped snapshot left; now the late sample
  is in the buffer. Mean player pos@render p99 0.005-0.013 → 0.002 m and body
  0.013-0.021 → 0.002-0.003 m on every bundle; the worst cells (seed 1): the
  systematic bundle's poor-mobile player 0.038 → 0.002 m and body 0.043 →
  0.003 m, citylat4 poor-mobile body 0.100 → 0.002 m. On the links that do
  not reorder (loopback, lan, cable) nothing changes, to the draw.
- **ALL missing** falls 3-50% (7,573 → 5,397 on the systematic bundle, 1,971
  → 988 on citylat4); meteor missing 3-22% lower. ALL pos@render / pos@now
  p99 are unchanged (they are chunk-dominated and chunks are on the city
  stream).
- **Bytes with idle players and vehicles cold, during play**: netcode kbit/s
  −2.6% (systematic), −2.4% (heavy), −6.7% (citylat4), −4.3%
  (scoreboard-new), 0 on the owner's session (it has no remote players in
  interest, and **inferred**: its other vehicles were unoccupied, already
  cold). That is the
  snapshot stream −18%, −16%, −29% and −25% (loopback: 35.4 → 29.1, 27.8 →
  23.4, 35.3 → 25.1, 33.0 → 24.8 kbit/s).
- **Bytes at idle** (loopback, the capture's last 4 s, all kinds): citylat4
  54.3 → 22.8 kbit/s (−58%; snapshots 51.4 → 19.8, with 2 standing players
  and an occupied parked car no longer every snapshot), systematic 46.7 →
  35.6 (−24%). The scoreboard-new and heavy captures do not end idle (a car
  still rolling, players walking), and their last 4 s change by −18% and 0.
- **Player and vehicle rows with idle-cold**: pos@render p99 at most
  0.0024 m (players) and 0.0053 m (vehicles) in every one of the 195 cells
  run with both changes (5 bundles, 13 links, 3 seeds), against 0.0024 and
  0.020 m with late snapshots alone. Player and vehicle missing move by at
  most 9 draw-frames per bundle over the 33 cells (scoreboard-new vehicles
  12 → 21, 2-5 frames a cell on the poor-mobile links). On the owner's
  session the other vehicles' pos@render p99 falls 0.020 → 0.002 m on every
  link (a few frames at 2 cm, max 0.020 → 0.006 m on loopback; the 0.3%
  extrapolated share there goes to 0, **inferred** as the cause).
- **The cost, on network-queue links only**: where rate adaptation re-spends
  the freed snapshot bytes on the city stream (bw-capped-nq: city 92.2 →
  94.7 kbit/s on citylat4, 107.7 → 112.0 on scoreboard-new), the queue and
  the datagram p99 latency grow (151 → 166 ms, 166 → 184 ms) and player
  pos@now p99 with them (citylat4 bw-capped-nq, mean of 3 seeds, 1.05 →
  1.52 m; 1.25 → 1.34 m on scoreboard-new; 1.44 → 1.51 m systematic). The
  same re-spending moves chunk wrong identity both ways: citylat4
  poor-mobile-nq 288 → 535 (3 seeds), systematic in all 6,523 → 5,988. The
  sender-queue links and every fast link: unchanged (**inferred**: the
  controller, as in the previous round, not the selection).
- **Clock back-steps 0, repairs asked 0** in every run of every arm.

**Old client, new server** (compat arm, seed 1): on loopback, lan and cable
the base client scores what this tree's client does on the same stream. On the reordering links an old client drops whole late snapshots,
and with players and parked cars cold a dropped rest send or refresh leaves a
longer hole: player pos@render p99 0.030 → 0.048 m (systematic lte), 0.038 →
0.049 m (poor-mobile); vehicle missing 63 → 368 (systematic poor-mobile),
0 → 185 (scoreboard-new poor-mobile-nq). The new client on the same stream:
0.002 m and 4 / 2. The web client is served with the server, so a stale tab
is the only old client (**inferred**); it stays correct, only rougher on
reordering links, and needs no protocol bump.

**Reordering: the lab's link against realistic LTE** (seam S13a in
[netlab-v2.md](netlab-v2.md)). The eleven links draw each packet's jitter on
its own, so at 60 Hz with ±35-40 ms of jitter a third of snapshots overtake
each other. LTE's radio layers deliver in order: a HARQ retransmission or a
scheduling gap delays the packets behind it rather than letting them pass,
and reordering on the path beyond is rare. The new `inOrder` profile field
(`lte-fifo`, `poor-mobile-fifo`: the same delay, jitter, loss and rate)
keeps send order, with the same random draws, so the two bound real LTE from
both sides. Seed 1, base → late → both:

| Bundle | Link | Late snapshots % | ALL missing / extra | Vehicle pos@render / pos@now p99 m; missing |
|---|---|---|---|---|
| systematic-2c-d1342419 | lte | 33.5 → 33.5 → 33.5 | 349 / 600 → 248 / 600 → 248 / 600 | 0.002 / 0.998; 60 → 0.002 / 0.998; 1 → 0.002 / 0.998; 1 |
| systematic-2c-d1342419 | lte-fifo | 0.0 → 0.0 → 0.0 | 159 / 491 → 159 / 491 → 159 / 491 | 0.002 / 1.031; 3 → 0.002 / 1.031; 3 → 0.002 / 1.031; 3 |
| systematic-2c-d1342419 | poor-mobile | 38.6 → 38.6 → 38.5 | 323 / 781 → 221 / 785 → 226 / 799 | 0.005 / 1.521; 63 → 0.002 / 1.521; 4 → 0.002 / 1.521; 4 |
| systematic-2c-d1342419 | poor-mobile-fifo | 0.0 → 0.0 → 0.0 | 164 / 517 → 164 / 517 → 144 / 495 | 0.002 / 1.521; 3 → 0.002 / 1.521; 3 → 0.002 / 1.521; 3 |
| heavy-quick3-v2 | lte | 30.9 → 30.9 → 30.9 | 67 / 106 → 46 / 111 → 46 / 111 | 0.002 / 0.877; 0 → 0.002 / 0.877; 0 → 0.002 / 0.877; 0 |
| heavy-quick3-v2 | lte-fifo | 0.0 → 0.0 → 0.0 | 45 / 91 → 45 / 91 → 45 / 91 | 0.002 / 0.936; 0 → 0.002 / 0.936; 0 → 0.002 / 0.936; 0 |
| heavy-quick3-v2 | poor-mobile | 35.7 → 35.7 → 35.6 | 92 / 104 → 69 / 104 → 66 / 108 | 0.002 / 1.293; 0 → 0.002 / 1.293; 0 → 0.002 / 1.293; 0 |
| heavy-quick3-v2 | poor-mobile-fifo | 0.0 → 0.0 → 0.0 | 52 / 97 → 52 / 97 → 46 / 96 | 0.002 / 1.336; 0 → 0.002 / 1.336; 0 → 0.002 / 1.336; 0 |
| 20260924-162732-quick-3c-citylat4 | lte | 33.8 → 33.8 → 33.8 | 105 / 102 → 41 / 102 → 41 / 102 | 0.008 / 1.174; 57 → 0.002 / 1.174; 0 → 0.002 / 1.174; 0 |
| 20260924-162732-quick-3c-citylat4 | lte-fifo | 0.0 → 0.0 → 0.0 | 36 / 82 → 36 / 82 → 36 / 82 | 0.002 / 1.174; 0 → 0.002 / 1.174; 0 → 0.002 / 1.174; 0 |
| 20260924-162732-quick-3c-citylat4 | poor-mobile | 38.2 → 38.2 → 38.2 | 304 / 120 → 45 / 120 → 56 / 120 | 0.004 / 1.622; 237 → 0.002 / 1.622; 0 → 0.002 / 1.622; 0 |
| 20260924-162732-quick-3c-citylat4 | poor-mobile-fifo | 0.0 → 0.0 → 0.0 | 28 / 79 → 28 / 79 → 29 / 80 | 0.002 / 1.676; 0 → 0.002 / 1.676; 0 → 0.002 / 1.676; 0 |
| 20260924-215619-scoreboard-new | lte | 32.2 → 32.2 → 32.2 | 68 / 103 → 56 / 103 → 56 / 103 | 0.003 / 1.472; 2 → 0.002 / 1.472; 2 → 0.002 / 1.472; 2 |
| 20260924-215619-scoreboard-new | lte-fifo | 0.0 → 0.0 → 0.0 | 33 / 99 → 33 / 99 → 33 / 99 | 0.002 / 1.521; 2 → 0.002 / 1.521; 2 → 0.002 / 1.521; 2 |
| 20260924-215619-scoreboard-new | poor-mobile | 37.2 → 37.2 → 37.1 | 35 / 127 → 31 / 127 → 48 / 129 | 0.004 / 1.970; 0 → 0.002 / 1.970; 0 → 0.002 / 2.035; 5 |
| 20260924-215619-scoreboard-new | poor-mobile-fifo | 0.0 → 0.0 → 0.0 | 37 / 84 → 37 / 84 → 37 / 102 | 0.002 / 2.102; 0 → 0.002 / 2.102; 0 → 0.002 / 2.102; 2 |
| session-20260924-213925-ondf3t | lte | 31.5 → 31.5 → 31.5 | 32 / 0 → 29 / 0 → 29 / 0 | 0.020 / 3.100; 0 → 0.020 / 3.100; 0 → 0.002 / 3.100; 0 |
| session-20260924-213925-ondf3t | lte-fifo | 0.0 → 0.0 → 0.0 | 19 / 0 → 19 / 0 → 19 / 0 | 0.020 / 3.202; 1 → 0.020 / 3.202; 1 → 0.003 / 3.202; 1 |
| session-20260924-213925-ondf3t | poor-mobile | 37.1 → 37.1 → 37.0 | 36 / 0 → 24 / 0 → 29 / 0 | 0.023 / 5.553; 2 → 0.020 / 5.553; 2 → 0.002 / 5.553; 4 |
| session-20260924-213925-ondf3t | poor-mobile-fifo | 0.0 → 0.0 → 0.0 | 56 / 6 → 56 / 6 → 55 / 6 | 0.020 / 5.553; 2 → 0.020 / 5.553; 2 → 0.002 / 5.553; 2 |

- With in-order delivery no snapshot is late, so base and late-snapshots
  are the same client there, and there is nothing for change 1 to fix. ALL
  missing on `lte-fifo` is 19-159 per bundle against 32-349 (base) and
  29-248 (late snapshots) on `lte`.
- In-order delivery costs latency instead: a jittered packet holds the ones
  behind it, so vehicle pos@now p99 is 0-7% higher on `lte-fifo` than on
  `lte` (1.031 vs 0.998 m systematic, 0.936 vs 0.877 heavy).
- **Inferred**: real LTE reorders far less than the lab's `lte` and delays
  more like `lte-fifo`; change 1 closes most of the gap between the two
  (ALL missing 349 → 248 against 159 on the systematic bundle), and the
  eleven scoreboard links keep iid jitter so this round stays comparable
  with the scoreboard. The share of late snapshots on real LTE is still not
  measured (the live benches run on loopback, 0 late).

**Calibration.** With this round's lab binary every byte check passes on
every bundle (`netlab2 calibrate`, measured): systematic c1 34,331 / 34,331,
heavy c1 10,861 / 10,861, citylat4 c1 11,582 / 11,582, the owner's session
11,502 / 11,503 (the lab-only snapshot after the capture closed, as before),
scoreboard-new c1 11,771 / 11,771 (snapshots 6,432 / 6,432). None of these
captures records `idle_cold`, so all replay with it off. The scoreboard-new
capture passes every check with this tree's client, as with the base
client: clock offset p99 in the last 10 s 100 µs, lab vs live renderer p99
players 0.9 cm, vehicles 0.6 cm, bodies 5.0 cm, meteors 7.1 cm, intact
chunks 0.00 mm, debris chunks 6.4 cm. On the three older captures the clock
and live-renderer checks fail identically with the base client and with this
one (their recordings predate the 28a7eb10 tick scale; by construction,
[netlab-v2.md](netlab-v2.md#calibration-the-proxy-check)).

**Live** (measured; `scripts/perf/city-bench.sh --scenario quick --clients 3`
on this tree rebased on 1425a742, ports 6701/6702/3673, GPU lock,
`target/net-next/city-bench/runs/20260925-002127-net-next`). The run is on
a new physics package (PhysX b5b18ecb, cuda-metal 80512aa, installed after
the scoreboard's live run), after one discarded warm-up run on it; its
baseline, the scoreboard's `20260924-215619-scoreboard-new`, ran on the old
package, so the comparison below is for reference, not a same-package A/B.

- 3/3 paired bundles, 0 errors. Budgets: 20 of 27 pass, as in the
  scoreboard's run. The failures are the server's tick and sim rate (tick
  p95 24.5 ms, sim rate 0.93, worst 5 s 0.56) and client hitches on c0 (2
  over 100 ms, 8 CPU-bound over 33 ms). Snapshot gap p99 49.2 ms, 0 packets
  lost, send → arrive p99 4.6-4.8 ms, render-clock back-steps 0, structure
  repairs 0.
- **The format is live**: the capture records `idle_cold` (with
  `compact_self` and `removals`). Remote-player records per snapshot 1.29-1.87
  → 0.27-0.55 per client, vehicle records 0.21-0.22 → 0.16-0.19; mean
  snapshot 78-93 → 55-66 B; snapshot kbit/s 33.0-39.3 → 24.6-29.4; kbit/s
  per client 200.6-213.1 → 185.3-200.3 (the runs' play differs; indicative).
  On loopback no snapshot arrives late, so change 1 has nothing to do live.
- **Fidelity**: vehicles drawn vs truth at the render time p99 0.002-0.004 m;
  remote players 0.006 m on c0 (0.010 before); body render error p99
  0.04-0.05 m. c1 and c2 report remote players p99 0.80 m in both runs, the
  driver-lift height (`DRIVER_ROOT_LIFT_M`) of a player sampled while
  driving (**inferred**; unchanged by this round).
- **Calibration of this capture with this tree: PASS on all three
  clients.** Bytes 12,370 / 12,370, 12,282 / 12,282 and 12,335 / 12,335
  byte-identical, snapshots 6,817 / 6,817 each; clock offset p99 in the last
  10 s 96-99 µs; lab vs live renderer p99: players 0.7-1.0 cm, vehicles
  0.4-0.8 cm, bodies 5.8-6.6 cm, meteors 5.9-7.1 cm, intact chunks 0.00 mm,
  debris chunks 1.8-5.2 cm. Negative control: the same capture replayed with
  `snapshot.idle_cold=0` matches 1,675 of 6,817 snapshots (24.6%).

**Tests** (fail or do not compile before the change, except the guards):

- `server/src/snapshot_builder.rs`:
  `a_standing_player_is_sent_until_it_settles_then_at_its_cold_refresh`
  (zero velocity when standing, three rest sends, refresh at 30 ticks; the
  legacy format sends it every snapshot with its -0.5 m/s),
  `a_player_that_moves_or_turns_is_sent_at_once`,
  `a_player_back_in_interest_is_sent_at_once`,
  `a_parked_car_with_a_driver_goes_cold_and_is_sent_when_it_moves` (and a
  driver getting out is a change; legacy guard), and the older-baseline
  guard extended to the new fields.
- `server/src/bin/netlab2/fixture_tests.rs`: the fixture's remote player now
  stands still for 80 ticks; `a_capture_from_before_idle_cold_replays_with_it_off`
  (a baseline without the field replays byte for byte; the knob turns it on
  and the standing player's snapshots differ). The mid-match fixture records
  the production format and still replays byte for byte.
- `server/src/bin/netlab2/link.rs`:
  `an_in_order_path_delays_but_never_reorders_except_stragglers` (same
  losses as the iid path, no packet overtaken, every arrival no earlier; with
  1% stragglers only they are late).
- `client/src/net/netcodeClient.test.ts`, late snapshots: a parked vehicle's
  refresh that arrives after a newer snapshot is applied; a vehicle whose
  first sends all arrived late is added; a late sample fills the players',
  bodies' and vehicles' interpolation without moving their newest state; and
  the guards: a body dropped after the late snapshot stays dropped, a
  removal named after it stands.
- Same file, rest holds: a player and a vehicle are held where they stood
  until the snapshot before they moved; a late snapshot inside the gap
  replaces the hold; a late first-moving snapshot moves the hold before it;
  guard: no hold after a moving sample (a grounded player from an older
  server).
- `client/src/net/debugTelemetry.test.ts`: the late-snapshot event wording.
- Suites: server 160 passing (+1 ignored), netlab2 93, client 1,181 passing
  (4 skipped), `tsc` clean, `test_session_bundle.py` 2.

**Reproduce**

```bash
N=<this tree's lab binary>          # CARGO_TARGET_DIR=... cargo build --release -p web-fps-server --bin netlab2
BASE=<a clean worktree of 2a601833>/client   # with its own npm run build:wasm
AFTER=lab.recorded_repairs=0,city.ballistic_free_fall=1,city.client_model=1,city.baseline_interval_ticks=120,city.baseline_lag_ticks=110,city.baseline_skip_quiescent=1,city.topology_copies=2,snapshot.compact_self=1,snapshot.removals=1
$N run --bundle <b> --out <runs>/base/seed<k>/<link> --link <link> --seed <k> --knob $AFTER,snapshot.idle_cold=0 --client-root $BASE
$N run --bundle <b> --out <runs>/p7/seed<k>/<link>   --link <link> --seed <k> --knob $AFTER,snapshot.idle_cold=0
$N run --bundle <b> --out <runs>/p78/seed<k>/<link>  --link <link> --seed <k> --knob $AFTER,snapshot.idle_cold=1
$N compare --a <runs>/base/seed1 --b <runs>/p78/seed1 --out <dir>
scripts/perf/netlab2-scoreboard.py arms --root <runs> --arms base,p7,p78 --seeds 1,2,3 \
   --links loopback,lan,cable,lte,lossy-wifi,poor-mobile,poor-mobile-nq,cap-1mbit,cap-1mbit-nq,bw-capped,bw-capped-nq
```

The late-snapshot share (`late_pct`) was read from each run's `lab.vltape`
(SnapshotV2 ticks in arrival order); the client stage now also reports it
(`client-stats.json` `snapshots.late`).

**Per bundle, seed 1** (base → late → both; the late share is the share of snapshots that arrived after a newer one; per-class tables base → both are in [netcode-scoreboard-2026-09-24.md](netcode-scoreboard-2026-09-24.md)):

**systematic-2c-d1342419 c1**, seed 1, base → late snapshots → both:

| Link | Netcode kbit/s | Late snapshots % | ALL missing / extra | Player pos@render / pos@now p99 m; missing | Vehicle pos@render / pos@now p99 m; missing | Body pos@render p99 m; missing / extra |
|---|---|---|---|---|---|---|
| loopback | 250.1 → 250.1 → 243.9 | 0.0 → 0.0 → 0.0 | 94 / 280 → 94 / 280 → 94 / 280 | 0.002 / 0.292; 1 → 0.002 / 0.292; 1 → 0.002 / 0.292; 1 | 0.002 / 0.077; 0 → 0.002 / 0.077; 0 → 0.002 / 0.077; 0 | 0.003; 38 / 125 → 0.003; 38 / 125 → 0.003; 38 / 125 |
| lan | 250.1 → 250.1 → 243.9 | 0.0 → 0.0 → 0.0 | 80 / 275 → 80 / 275 → 80 / 275 | 0.002 / 0.301; 1 → 0.002 / 0.301; 1 → 0.002 / 0.301; 1 | 0.002 / 0.085; 0 → 0.002 / 0.085; 0 → 0.002 / 0.085; 0 | 0.003; 40 / 120 → 0.003; 40 / 120 → 0.003; 40 / 120 |
| cable | 249.9 → 249.9 → 243.6 | 0.0 → 0.0 → 0.0 | 101 / 290 → 101 / 290 → 112 / 285 | 0.002 / 0.416; 1 → 0.002 / 0.416; 1 → 0.002 / 0.416; 1 | 0.002 / 0.179; 0 → 0.002 / 0.179; 0 → 0.002 / 0.174; 0 | 0.003; 45 / 133 → 0.003; 45 / 133 → 0.003; 53 / 128 |
| lte | 242.8 → 242.8 → 236.7 | 33.5 → 33.5 → 33.5 | 349 / 600 → 248 / 600 → 248 / 600 | 0.030 / 1.676; 2 → 0.002 / 1.676; 1 → 0.002 / 1.676; 1 | 0.002 / 0.998; 60 → 0.002 / 0.998; 1 → 0.002 / 0.998; 1 | 0.039; 173 / 421 → 0.003; 146 / 421 → 0.003; 146 / 421 |
| lossy-wifi | 242.9 → 242.9 → 236.8 | 21.3 → 21.3 → 21.3 | 248 / 835 → 239 / 835 → 239 / 835 | 0.012 / 0.877; 1 → 0.002 / 0.877; 1 → 0.002 / 0.877; 1 | 0.002 / 0.430; 6 → 0.002 / 0.430; 6 → 0.002 / 0.430; 6 | 0.013; 149 / 313 → 0.004; 147 / 313 → 0.004; 147 / 313 |
| poor-mobile | 224.9 → 224.9 → 219.5 | 38.6 → 38.6 → 38.5 | 323 / 781 → 221 / 785 → 226 / 799 | 0.038 / 2.317; 0 → 0.002 / 2.317; 1 → 0.002 / 2.317; 1 | 0.005 / 1.521; 63 → 0.002 / 1.521; 4 → 0.002 / 1.521; 4 | 0.043; 176 / 449 → 0.003; 140 / 453 → 0.003; 144 / 453 |
| poor-mobile-nq | 225.9 → 225.9 → 218.7 | 38.7 → 38.7 → 38.7 | 563 / 919 → 243 / 921 → 271 / 982 | 0.036 / 2.393; 0 → 0.002 / 2.393; 0 → 0.002 / 2.317; 2 | 0.003 / 1.521; 290 → 0.002 / 1.521; 2 → 0.002 / 1.472; 0 | 0.048; 152 / 442 → 0.003; 133 / 444 → 0.003; 167 / 425 |
| cap-1mbit | 232.0 → 232.0 → 226.2 | 3.4 → 3.4 → 3.5 | 143 / 429 → 137 / 429 → 136 / 335 | 0.002 / 0.849; 1 → 0.002 / 0.849; 1 → 0.002 / 0.849; 1 | 0.002 / 0.366; 1 → 0.002 / 0.366; 1 → 0.002 / 0.366; 0 | 0.004; 83 / 172 → 0.002; 81 / 172 → 0.002; 83 / 168 |
| cap-1mbit-nq | 231.3 → 231.3 → 223.7 | 3.4 → 3.4 → 3.4 | 158 / 364 → 158 / 364 → 144 / 329 | 0.002 / 0.936; 1 → 0.002 / 0.936; 1 → 0.002 / 0.936; 1 | 0.002 / 0.378; 1 → 0.002 / 0.378; 1 → 0.002 / 0.390; 1 | 0.003; 95 / 168 → 0.002; 95 / 168 → 0.002; 88 / 165 |
| bw-capped | 196.2 → 196.2 → 190.9 | 5.8 → 5.8 → 6.0 | 139 / 412 → 138 / 412 → 136 / 426 | 0.002 / 1.136; 1 → 0.002 / 1.136; 1 → 0.002 / 1.136; 1 | 0.002 / 0.416; 0 → 0.002 / 0.416; 0 → 0.002 / 0.416; 0 | 0.005; 95 / 193 → 0.002; 94 / 193 → 0.002; 80 / 205 |
| bw-capped-nq | 191.6 → 191.6 → 187.8 | 5.3 → 5.3 → 5.3 | 137 / 501 → 130 / 501 → 137 / 428 | 0.002 / 1.425; 1 → 0.002 / 1.425; 1 → 0.002 / 1.622; 1 | 0.002 / 0.444; 1 → 0.002 / 0.444; 1 → 0.002 / 0.444; 0 | 0.004; 66 / 219 → 0.003; 66 / 219 → 0.003; 84 / 217 |

**heavy-quick3-v2 c1**, seed 1, base → late snapshots → both:

| Link | Netcode kbit/s | Late snapshots % | ALL missing / extra | Player pos@render / pos@now p99 m; missing | Vehicle pos@render / pos@now p99 m; missing | Body pos@render p99 m; missing / extra |
|---|---|---|---|---|---|---|
| loopback | 209.7 → 209.7 → 205.3 | 0.0 → 0.0 → 0.0 | 30 / 31 → 30 / 31 → 30 / 31 | 0.002 / 0.677; 1 → 0.002 / 0.677; 1 → 0.002 / 0.677; 1 | 0.002 / 0.082; 0 → 0.002 / 0.082; 0 → 0.002 / 0.082; 0 | 0.002; 14 / 31 → 0.002; 14 / 31 → 0.002; 14 / 31 |
| lan | 209.7 → 209.7 → 205.3 | 0.0 → 0.0 → 0.0 | 29 / 34 → 29 / 34 → 29 / 34 | 0.002 / 0.699; 1 → 0.002 / 0.699; 1 → 0.002 / 0.699; 1 | 0.002 / 0.088; 0 → 0.002 / 0.088; 0 → 0.002 / 0.088; 0 | 0.002; 14 / 34 → 0.002; 14 / 34 → 0.002; 14 / 34 |
| cable | 209.6 → 209.6 → 205.2 | 0.0 → 0.0 → 0.0 | 31 / 37 → 31 / 37 → 31 / 37 | 0.002 / 0.796; 1 → 0.002 / 0.796; 1 → 0.002 / 0.796; 1 | 0.002 / 0.163; 0 → 0.002 / 0.163; 0 → 0.002 / 0.174; 0 | 0.002; 16 / 37 → 0.002; 16 / 37 → 0.002; 16 / 37 |
| lte | 203.6 → 203.6 → 199.3 | 30.9 → 30.9 → 30.9 | 67 / 106 → 46 / 111 → 46 / 111 | 0.008 / 1.908; 2 → 0.002 / 1.908; 1 → 0.002 / 1.908; 1 | 0.002 / 0.877; 0 → 0.002 / 0.877; 0 → 0.002 / 0.877; 0 | 0.038; 53 / 106 → 0.002; 33 / 111 → 0.002; 33 / 111 |
| lossy-wifi | 204.6 → 204.6 → 200.3 | 18.9 → 18.9 → 18.9 | 60 / 87 → 53 / 87 → 53 / 87 | 0.011 / 1.212; 1 → 0.002 / 1.212; 1 → 0.002 / 1.212; 1 | 0.002 / 0.390; 0 → 0.002 / 0.390; 0 → 0.002 / 0.390; 0 | 0.008; 39 / 87 → 0.002; 39 / 87 → 0.002; 39 / 87 |
| poor-mobile | 180.9 → 180.9 → 176.1 | 35.7 → 35.7 → 35.6 | 92 / 104 → 69 / 104 → 66 / 108 | 0.036 / 2.906; 1 → 0.002 / 2.906; 1 → 0.002 / 2.906; 1 | 0.002 / 1.293; 0 → 0.002 / 1.293; 0 → 0.002 / 1.293; 0 | 0.052; 63 / 104 → 0.002; 54 / 104 → 0.002; 47 / 108 |
| poor-mobile-nq | 173.2 → 173.2 → 165.0 | 35.7 → 35.7 → 35.0 | 129 / 105 → 66 / 105 → 55 / 107 | 0.024 / 2.813; 1 → 0.002 / 2.813; 1 → 0.002 / 3.002; 1 | 0.002 / 1.252; 58 → 0.002 / 1.252; 0 → 0.002 / 1.252; 0 | 0.097; 53 / 105 → 0.003; 48 / 105 → 0.002; 40 / 107 |
| cap-1mbit | 187.3 → 187.3 → 182.4 | 2.2 → 2.2 → 2.3 | 39 / 49 → 39 / 49 → 39 / 49 | 0.002 / 1.622; 1 → 0.002 / 1.622; 1 → 0.002 / 1.571; 1 | 0.002 / 0.332; 0 → 0.002 / 0.332; 0 → 0.002 / 0.332; 0 | 0.002; 25 / 49 → 0.002; 25 / 49 → 0.002; 25 / 49 |
| cap-1mbit-nq | 175.4 → 175.4 → 171.2 | 2.1 → 2.1 → 2.0 | 48 / 44 → 47 / 44 → 45 / 45 | 0.002 / 1.380; 1 → 0.002 / 1.380; 1 → 0.002 / 1.425; 1 | 0.002 / 0.332; 0 → 0.002 / 0.332; 0 → 0.002 / 0.332; 0 | 0.002; 26 / 44 → 0.002; 26 / 44 → 0.002; 26 / 45 |
| bw-capped | 159.1 → 159.1 → 155.0 | 4.2 → 4.2 → 3.7 | 46 / 54 → 46 / 54 → 36 / 54 | 0.002 / 1.622; 1 → 0.002 / 1.622; 1 → 0.002 / 1.622; 1 | 0.002 / 0.366; 0 → 0.002 / 0.366; 0 → 0.002 / 0.366; 0 | 0.002; 33 / 50 → 0.002; 33 / 50 → 0.002; 28 / 50 |
| bw-capped-nq | 158.8 → 158.8 → 153.6 | 3.8 → 3.8 → 3.8 | 34 / 55 → 34 / 55 → 30 / 57 | 0.002 / 1.571; 1 → 0.002 / 1.571; 1 → 0.002 / 1.521; 1 | 0.002 / 0.390; 0 → 0.002 / 0.390; 0 → 0.002 / 0.390; 0 | 0.002; 25 / 51 → 0.002; 25 / 51 → 0.002; 22 / 53 |

**20260924-162732-quick-3c-citylat4 c1**, seed 1, base → late snapshots → both:

| Link | Netcode kbit/s | Late snapshots % | ALL missing / extra | Player pos@render / pos@now p99 m; missing | Vehicle pos@render / pos@now p99 m; missing | Body pos@render p99 m; missing / extra |
|---|---|---|---|---|---|---|
| loopback | 155.6 → 155.6 → 145.4 | 0.0 → 0.0 → 0.0 | 18 / 34 → 18 / 34 → 18 / 34 | 0.002 / 0.198; 1 → 0.002 / 0.198; 1 → 0.002 / 0.198; 1 | 0.002 / 0.088; 0 → 0.002 / 0.088; 0 → 0.002 / 0.088; 0 | 0.002; 10 / 34 → 0.002; 10 / 34 → 0.002; 10 / 34 |
| lan | 155.6 → 155.6 → 145.4 | 0.0 → 0.0 → 0.0 | 14 / 33 → 14 / 33 → 14 / 33 | 0.002 / 0.204; 1 → 0.002 / 0.204; 1 → 0.002 / 0.204; 1 | 0.002 / 0.094; 0 → 0.002 / 0.094; 0 → 0.002 / 0.094; 0 | 0.002; 7 / 33 → 0.002; 7 / 33 → 0.002; 7 / 33 |
| cable | 155.3 → 155.3 → 145.2 | 0.0 → 0.0 → 0.0 | 17 / 36 → 17 / 36 → 17 / 35 | 0.002 / 0.343; 2 → 0.002 / 0.343; 2 → 0.002 / 0.343; 2 | 0.002 / 0.198; 0 → 0.002 / 0.198; 0 → 0.002 / 0.198; 0 | 0.002; 11 / 36 → 0.002; 11 / 36 → 0.002; 11 / 35 |
| lte | 151.2 → 151.2 → 141.3 | 33.8 → 33.8 → 33.8 | 105 / 102 → 41 / 102 → 41 / 102 | 0.026 / 1.571; 1 → 0.002 / 1.571; 1 → 0.002 / 1.571; 1 | 0.008 / 1.174; 57 → 0.002 / 1.174; 0 → 0.002 / 1.174; 0 | 0.028; 27 / 102 → 0.002; 22 / 102 → 0.002; 22 / 102 |
| lossy-wifi | 150.2 → 150.2 → 140.3 | 21.1 → 21.1 → 21.1 | 46 / 74 → 38 / 74 → 38 / 74 | 0.006 / 0.746; 0 → 0.002 / 0.746; 1 → 0.002 / 0.746; 1 | 0.010 / 0.490; 0 → 0.005 / 0.490; 0 → 0.002 / 0.490; 0 | 0.010; 27 / 74 → 0.002; 22 / 74 → 0.002; 22 / 74 |
| poor-mobile | 142.4 → 142.4 → 132.1 | 38.2 → 38.2 → 38.2 | 304 / 120 → 45 / 120 → 56 / 120 | 0.023 / 2.317; 0 → 0.002 / 2.317; 1 → 0.002 / 2.243; 1 | 0.004 / 1.622; 237 → 0.002 / 1.622; 0 → 0.002 / 1.622; 0 | 0.100; 31 / 120 → 0.002; 31 / 120 → 0.002; 42 / 120 |
| poor-mobile-nq | 142.4 → 142.4 → 132.6 | 37.9 → 37.9 → 38.5 | 53 / 99 → 44 / 99 → 52 / 100 | 0.023 / 2.393; 1 → 0.002 / 2.393; 0 → 0.002 / 2.317; 3 | 0.007 / 1.571; 0 → 0.002 / 1.571; 0 → 0.002 / 1.622; 0 | 0.064; 23 / 99 → 0.002; 23 / 99 → 0.002; 30 / 100 |
| cap-1mbit | 146.3 → 146.3 → 136.3 | 1.8 → 1.8 → 1.9 | 21 / 44 → 19 / 44 → 21 / 44 | 0.002 / 0.770; 1 → 0.002 / 0.770; 1 → 0.002 / 0.770; 1 | 0.002 / 0.390; 0 → 0.002 / 0.390; 0 → 0.002 / 0.390; 0 | 0.002; 15 / 44 → 0.002; 14 / 44 → 0.002; 15 / 44 |
| cap-1mbit-nq | 146.2 → 146.2 → 136.1 | 1.8 → 1.8 → 1.9 | 27 / 46 → 27 / 46 → 28 / 50 | 0.002 / 0.796; 1 → 0.002 / 0.796; 1 → 0.002 / 0.796; 1 | 0.002 / 0.390; 0 → 0.002 / 0.390; 0 → 0.002 / 0.390; 0 | 0.002; 21 / 46 → 0.002; 21 / 46 → 0.002; 21 / 50 |
| bw-capped | 131.0 → 131.0 → 121.6 | 3.1 → 3.1 → 3.7 | 26 / 53 → 25 / 53 → 32 / 49 | 0.002 / 0.906; 0 → 0.002 / 0.906; 0 → 0.002 / 0.966; 1 | 0.002 / 0.403; 0 → 0.002 / 0.403; 0 → 0.002 / 0.403; 0 | 0.002; 19 / 53 → 0.002; 18 / 53 → 0.002; 20 / 49 |
| bw-capped-nq | 125.8 → 125.8 → 119.9 | 3.0 → 3.0 → 3.3 | 28 / 52 → 28 / 52 → 30 / 55 | 0.002 / 1.065; 1 → 0.002 / 1.031; 1 → 0.002 / 1.908; 1 | 0.002 / 0.416; 0 → 0.002 / 0.416; 0 → 0.002 / 0.403; 0 | 0.002; 18 / 52 → 0.002; 18 / 52 → 0.002; 21 / 55 |

**20260924-215619-scoreboard-new c1**, seed 1, base → late snapshots → both:

| Link | Netcode kbit/s | Late snapshots % | ALL missing / extra | Player pos@render / pos@now p99 m; missing | Vehicle pos@render / pos@now p99 m; missing | Body pos@render p99 m; missing / extra |
|---|---|---|---|---|---|---|
| loopback | 198.7 → 198.7 → 190.5 | 0.0 → 0.0 → 0.0 | 27 / 29 → 27 / 29 → 27 / 29 | 0.002 / 0.311; 1 → 0.002 / 0.311; 1 → 0.002 / 0.311; 1 | 0.002 / 0.153; 0 → 0.002 / 0.153; 0 → 0.002 / 0.153; 0 | 0.002; 13 / 29 → 0.002; 13 / 29 → 0.002; 13 / 29 |
| lan | 198.7 → 198.7 → 190.5 | 0.0 → 0.0 → 0.0 | 27 / 29 → 27 / 29 → 27 / 29 | 0.002 / 0.321; 1 → 0.002 / 0.321; 1 → 0.002 / 0.321; 1 | 0.002 / 0.163; 0 → 0.002 / 0.163; 0 → 0.002 / 0.163; 0 | 0.002; 14 / 29 → 0.002; 14 / 29 → 0.002; 14 / 29 |
| cable | 198.5 → 198.5 → 190.3 | 0.0 → 0.0 → 0.0 | 29 / 34 → 29 / 34 → 29 / 34 | 0.002 / 0.416; 1 → 0.002 / 0.416; 1 → 0.002 / 0.416; 1 | 0.002 / 0.301; 0 → 0.002 / 0.301; 0 → 0.002 / 0.301; 0 | 0.002; 16 / 34 → 0.002; 16 / 34 → 0.002; 16 / 34 |
| lte | 194.0 → 194.0 → 186.0 | 32.2 → 32.2 → 32.2 | 68 / 103 → 56 / 103 → 56 / 103 | 0.014 / 1.425; 1 → 0.002 / 1.425; 1 → 0.002 / 1.425; 1 | 0.003 / 1.472; 2 → 0.002 / 1.472; 2 → 0.002 / 1.472; 2 | 0.028; 48 / 103 → 0.002; 36 / 103 → 0.002; 36 / 103 |
| lossy-wifi | 192.4 → 192.4 → 184.5 | 20.2 → 20.2 → 20.2 | 49 / 77 → 47 / 77 → 47 / 77 | 0.004 / 0.722; 1 → 0.002 / 0.722; 1 → 0.002 / 0.722; 1 | 0.002 / 0.677; 0 → 0.002 / 0.677; 0 → 0.002 / 0.677; 0 | 0.006; 30 / 77 → 0.002; 28 / 77 → 0.002; 28 / 77 |
| poor-mobile | 175.0 → 175.0 → 167.0 | 37.2 → 37.2 → 37.1 | 35 / 127 → 31 / 127 → 48 / 129 | 0.009 / 2.171; 0 → 0.002 / 2.171; 0 → 0.002 / 2.243; 1 | 0.004 / 1.970; 0 → 0.002 / 1.970; 0 → 0.002 / 2.035; 5 | 0.052; 18 / 127 → 0.002; 14 / 127 → 0.002; 26 / 129 |
| poor-mobile-nq | 177.1 → 177.1 → 169.5 | 36.3 → 36.3 → 36.5 | 77 / 115 → 50 / 115 → 59 / 121 | 0.013 / 2.637; 1 → 0.002 / 2.637; 0 → 0.002 / 2.813; 1 | 0.003 / 2.035; 0 → 0.002 / 2.035; 0 → 0.002 / 2.035; 2 | 0.037; 60 / 115 → 0.002; 34 / 115 → 0.002; 41 / 121 |
| cap-1mbit | 180.8 → 180.8 → 172.6 | 2.1 → 2.1 → 2.2 | 30 / 40 → 26 / 40 → 29 / 39 | 0.002 / 1.065; 1 → 0.002 / 1.065; 1 → 0.002 / 1.065; 1 | 0.002 / 0.506; 0 → 0.002 / 0.506; 0 → 0.002 / 0.506; 0 | 0.002; 17 / 40 → 0.002; 17 / 40 → 0.002; 21 / 39 |
| cap-1mbit-nq | 180.7 → 180.7 → 172.7 | 1.9 → 1.9 → 1.9 | 27 / 40 → 27 / 40 → 30 / 45 | 0.002 / 1.212; 1 → 0.002 / 1.212; 1 → 0.002 / 1.174; 1 | 0.002 / 0.506; 0 → 0.002 / 0.506; 0 → 0.002 / 0.506; 0 | 0.002; 17 / 40 → 0.002; 17 / 40 → 0.002; 19 / 45 |
| bw-capped | 150.3 → 150.3 → 142.9 | 3.6 → 3.6 → 4.0 | 31 / 50 → 31 / 50 → 26 / 48 | 0.002 / 1.174; 2 → 0.002 / 1.174; 2 → 0.002 / 1.212; 1 | 0.002 / 0.522; 0 → 0.002 / 0.522; 0 → 0.002 / 0.522; 0 | 0.002; 19 / 50 → 0.002; 19 / 50 → 0.002; 15 / 48 |
| bw-capped-nq | 138.2 → 138.2 → 131.7 | 3.5 → 3.5 → 3.7 | 30 / 53 → 30 / 53 → 28 / 49 | 0.002 / 1.252; 1 → 0.002 / 1.252; 1 → 0.002 / 1.336; 1 | 0.002 / 0.522; 0 → 0.002 / 0.522; 0 → 0.002 / 0.506; 0 | 0.002; 21 / 53 → 0.002; 21 / 53 → 0.002; 18 / 49 |

**session-20260924-213925-ondf3t (the player)**, seed 1, base → late snapshots → both:

| Link | Netcode kbit/s | Late snapshots % | ALL missing / extra | Player pos@render / pos@now p99 m; missing | Vehicle pos@render / pos@now p99 m; missing | Body pos@render p99 m; missing / extra |
|---|---|---|---|---|---|---|
| loopback | 561.0 → 561.0 → 561.0 | 0.0 → 0.0 → 0.0 | 117 / 0 → 117 / 0 → 117 / 0 | - / -; - → - / -; - → - / -; - | 0.020 / 1.031; 0 → 0.020 / 1.031; 0 → 0.002 / 1.031; 0 | -; - / - → -; - / - → -; - / - |
| lan | 561.0 → 561.0 → 561.0 | 0.0 → 0.0 → 0.0 | 89 / 0 → 89 / 0 → 89 / 0 | - / -; - → - / -; - → - / -; - | 0.020 / 1.031; 0 → 0.020 / 1.031; 0 → 0.002 / 1.031; 0 | -; - / - → -; - / - → -; - / - |
| cable | 560.5 → 560.5 → 560.5 | 0.0 → 0.0 → 0.0 | 87 / 0 → 87 / 0 → 87 / 0 | - / -; - → - / -; - → - / -; - | 0.020 / 1.252; 1 → 0.020 / 1.252; 1 → 0.002 / 1.252; 1 | -; - / - → -; - / - → -; - / - |
| lte | 545.1 → 545.1 → 545.1 | 31.5 → 31.5 → 31.5 | 32 / 0 → 29 / 0 → 29 / 0 | - / -; - → - / -; - → - / -; - | 0.020 / 3.100; 0 → 0.020 / 3.100; 0 → 0.002 / 3.100; 0 | -; - / - → -; - / - → -; - / - |
| lossy-wifi | 542.3 → 542.3 → 542.3 | 19.3 → 19.3 → 19.3 | 100 / 0 → 98 / 0 → 98 / 0 | - / -; - → - / -; - → - / -; - | 0.018 / 1.908; 3 → 0.020 / 1.908; 3 → 0.002 / 1.908; 3 | -; - / - → -; - / - → -; - / - |
| poor-mobile | 410.3 → 410.3 → 410.3 | 37.1 → 37.1 → 37.0 | 36 / 0 → 24 / 0 → 29 / 0 | - / -; - → - / -; - → - / -; - | 0.023 / 5.553; 2 → 0.020 / 5.553; 2 → 0.002 / 5.553; 4 | -; - / - → -; - / - → -; - / - |
| poor-mobile-nq | 408.8 → 408.8 → 408.8 | 36.0 → 36.0 → 36.0 | 32 / 0 → 24 / 0 → 24 / 0 | - / -; - → - / -; - → - / -; - | 0.027 / 6.321; 1 → 0.020 / 6.321; 1 → 0.002 / 6.321; 1 | -; - / - → -; - / - → -; - / - |
| cap-1mbit | 426.8 → 426.8 → 426.8 | 9.9 → 9.9 → 9.9 | 103 / 0 → 101 / 0 → 101 / 0 | - / -; - → - / -; - → - / -; - | 0.020 / 2.393; 2 → 0.020 / 2.393; 2 → 0.002 / 2.393; 2 | -; - / - → -; - / - → -; - / - |
| cap-1mbit-nq | 419.3 → 419.3 → 422.4 | 9.0 → 9.0 → 9.2 | 102 / 0 → 101 / 0 → 102 / 0 | - / -; - → - / -; - → - / -; - | 0.020 / 2.317; 2 → 0.020 / 2.317; 2 → 0.002 / 2.243; 1 | -; - / - → -; - / - → -; - / - |
| bw-capped | 275.6 → 275.6 → 275.9 | 10.6 → 10.6 → 10.4 | 97 / 0 → 97 / 0 → 101 / 0 | - / -; - → - / -; - → - / -; - | 0.020 / 2.724; 1 → 0.020 / 2.724; 1 → 0.002 / 2.813; 1 | -; - / - → -; - / - → -; - / - |
| bw-capped-nq | 249.9 → 249.9 → 254.4 | 7.3 → 7.3 → 7.4 | 98 / 0 → 97 / 0 → 105 / 0 | - / -; - → - / -; - → - / -; - | 0.020 / 2.553; 1 → 0.020 / 2.553; 1 → 0.002 / 2.553; 5 | -; - / - → -; - / - → -; - / - |

### City send cadence and playout delay

Gap 4 above (latency), and the "city send rate" lever the
[Pareto front](#pareto-front) left as a trade-off. Base: 3d96a192. Every
number is **measured** in Netlab v2 unless marked **inferred**.

**What changed** (on by default):

1. **The city stream sends every tick (60 Hz, was every other tick).**
   `CITY_CHUNK_STREAM_HZ` 30 → 60 and `EncoderConfig::validated` →
   `send_interval_ticks` 1.
   - The per-send ceiling is halved, 10,400 → 5,200 B
     (`CITY_CLIENT_CEILING_BYTES_PER_SEND`), so the byte-rate cap stays
     ~2.5 Mbit/s.
   - The rate controller works in bytes per second, so on a limited link
     it paces a 60 Hz stream to the same share. Below ~190 kbit/s of city
     share it skips sends (the 400 B minimum), so the cadence falls there by
     itself.
   - `VIBE_CITY_STREAM_HZ=30` puts a server back on the 30 Hz stream (the
     ceiling scales with it), for a live A/B or a rollback.
2. **The scheduler's perturbation test keeps its meaning at 60 Hz**
   (`EncoderConfig::innovation_window_ticks`, 2).
   - A body is sent when its velocity changed by 0.25 m/s (plus 0.35 × its
     angular change) since the previous send. Per send, that is an
     acceleration: 7.5 m/s² at 30 Hz, 15 m/s² at 60 Hz.
   - With the per-send test, 60 Hz sent 18% fewer records than 30 Hz and
     drew worse: systematic loopback 214.8 → 183.8 city kbit/s, debris
     pos@render p99 0.088 → 0.110 m, presented jumps over 4 m 198 → 322,
     correction snaps 77 → 179 (arm `h60`).
   - Now the change is scaled to a 2-tick window, and a perturbation
     counts at most once per window since the client's last record of the
     body. At 30 Hz the scale is exactly 1 and every record is at least a
     window old, so a 30 Hz stream is unchanged. Scaling alone
     (arm `x60`) restored the fidelity but cost +66% bytes: a body
     falling under gravity was then sent at every tick.
3. **The client's playout delay follows the cadence** (`cityClient.ts`).
   - The wire-v2 delay is the stream's send interval plus 4 ticks: 6 at
     30 Hz, as shipped, and 5 at 60 Hz.
   - The interval is the shortest advance of the newest streamed tick over
     the last second, at most 2. So a 30 Hz server is presented exactly as
     before (the 3d96a192 client and this one score identically on every
     30 Hz cell). A 60 Hz stream that the rate controller thins to every
     other tick gets 6 back.
   - The lead cap follows the same delay. `CITY_PLAYOUT_DELAY` (lab only)
     fixes the delay.

**Format gating.** Captures carry their encoder config in the checkpoint
(send interval, ceiling; `innovation_window_ticks` is absent and reads as 0,
the per-send test). So every capture before this replays at 30 Hz, byte for
byte:

- `netlab2 calibrate` (a) with this tree: 100% of lab packets byte-identical
  on all four bundles: net-next c1 12,282 / 12,282, scoreboard-new c1
  11,771 / 11,771, heavy c1 10,861 / 10,861, systematic c1 34,331 / 34,331.
- net-next c1 and scoreboard-new c1 pass every check with this client
  (clock offset p99 in the last 10 s 96 / 100 µs).
- Heavy c1 and systematic c1 fail the clock and live-renderer checks, as
  before. The 3d96a192 build fails heavy c1 with the same numbers (last
  window p99 6,551 µs, player 0.4237 m).
- The lab knobs for a server with the new defaults are
  `city.send_hz=60,city.ceiling_bytes=5200,city.innovation_window_ticks=2`.

**Arms.** One frozen truth, link and seed per cell. Production knobs as in
the previous round, plus `snapshot.idle_cold=1`, recorded pace,
`lab.recorded_repairs=0`.

- **base**: the 3d96a192 lab binary and client, 30 Hz, a 6-tick delay.
- **this change**: this tree's binary and client, 60 Hz, window 2, the
  delay from the cadence (5).
- **30 Hz / 5**: 30 Hz with the delay fixed at 5 (`CITY_PLAYOUT_DELAY=5`).
  This is the other way to get the tick back, and it separates the delay's
  share from the cadence's.

Also run on seed 1 only, 4 bundles × 12 links: 60 Hz with a 6-tick delay
(`y60`), 60 Hz with 4 (`y60d4`), 30 Hz with 4 (`h30d4`), and 3 topology copies
at 60 Hz (`cand3c`). The fixed-delay arm `y60d5` is the same stream and delay
as "this change": on the sys and net-next cells both were run, they are
identical to rounding.

**Coverage, and where it is thin:**

- Seed 1, every link, on all four bundles.
- Seed 2 only on systematic (every link) and on net-next (poor-mobile-nq,
  cap-1mbit-nq, bw-capped).
- No seed 3.
- The live bench is one run.

**Headline** (seed 1 unless marked; "presented − server" is the city's
presented tick against the server's completed tick, 1 tick = 16.7 ms):

- **Latency: 0.9-1.3 ticks less on every fast link of every bundle.**
  - loopback / lan: −5.2 to −5.5 → −4.1 to −4.4;
  - LTE: −9.8 to −10.1 → −8.5 to −8.9;
  - lte-fifo: −10.5 to −10.9 → −9.5 to −9.9;
  - constrained links: 0.7-1.5 ticks less.
  - The 30 Hz / 5 arm gets 0.8-1.0 tick of it without the cadence. The
    60 Hz stream alone with a 6-tick delay (`y60`) gets 0.0-0.6 tick. So
    the latency is the delay's, and what the cadence buys is that the
    delay can shrink without the costs below.
- **pos@now improves with it.**
  - Debris pos@now p99 falls 12-15% on loopback: systematic 1.521 →
    1.293 m, heavy 1.622 → 1.425, scoreboard-new 4.017 → 3.529, net-next
    2.171 → 1.908. On LTE it falls 0-12% (systematic 2.553 → 2.553,
    net-next 3.100 → 2.724).
  - ALL draws pos@now p99 falls too: systematic loopback 0.138 → 0.114 m,
    lte-fifo 0.273 → 0.240.
  - Snapshot classes (players, vehicles, bodies, meteors) are unchanged
    at render time. This is a city-only change: "bodies drawn behind
    server" is 15.0 / 17.4 ms on loopback in both arms.
- **Frames stopped by the lead cap** fall on the fast links (systematic
  loopback 0.6 → 0.2%, lte-fifo 1.0 → 0.6%). With a 5-tick delay at 30 Hz
  they rise instead (0.6 → 0.7%, 1.0 → 1.2%).
- **Presented jumps over 4 m and correction snaps, against base:**
  - fewer on systematic (loopback 198 → 188, snaps 77 → 76) and on net-next
    (60 → 49, 44 → 36; LTE 47 → 22, 35 → 9);
  - more on heavy (37 → 41, 14 → 17) and on scoreboard-new (43 → 46,
    8 → 11).
  - 30 Hz / 5 has more than base on all four (207, 64, 41, 47).
- **Island first draw p99** falls on LTE (systematic 209 → 130 ms, net-next
  155 → 138).
- **Bytes: +5-11% netcode on the fast links.** loopback: systematic
  243.9 → 269.6 kbit/s, heavy 205.3 → 228.6, scoreboard-new 190.5 → 204.9,
  net-next 183.3 → 198.0. That is the per-datagram overhead of twice the
  sends, plus the perturbation records a falling body still gets once per
  2 ticks.
- **Debris pos@render p99 is mixed on the fast links:**
  - worse on systematic (0.088 → 0.100 m) and heavy (0.126 → 0.153);
  - better on scoreboard-new (0.490 → 0.444) and net-next (0.292 → 0.265).
- **Wrong identity (chunk-frames) is mixed on the jittery fast links:**
  - systematic LTE 529 → 1,134 (seed 2: 446 → 149);
  - heavy LTE 32 → 64, scoreboard-new LTE 36 → 90;
  - net-next LTE 322 → 86;
  - lte-fifo: systematic 580 → 348 (seed 2 262 → 24), net-next 350 → 27,
    heavy 42 → 72.
  - Topology copies now go out 16 ms apart instead of 33, so records sent
    after both overtake them more often under the lab's iid jitter
    (**inferred** from the hold counts: systematic LTE topology hold frames
    275 → 851, records buffered for missing topology 3,803 → 19,425).
  - Three copies at 60 Hz (the same 2-tick span, +3-4% bytes) fixed
    systematic (LTE 1,134 → 119, lte-fifo 348 → 36, lossy-wifi seeds 1-2
    256 → 68) but made net-next worse (LTE 86 → 208, lte-fifo 27 → 151).
    It is not kept.

**Constrained links** (the rate controller in the loop; `Limited` on nearly
every send in both arms):

- **Datagram latency is held.** Datagram p99:
  - bw-capped 110.8 → 103.1 ms (systematic), 95.7 → 82.4 (net-next);
  - cap-1mbit-nq 114.2 → 114.9 and 108.2 → 119.3;
  - poor-mobile-nq 267.5 → 279.4 and 308.1 → 340.7 (seed 2: 275.4 → 287.3
    and 301.5 → 342.9), the one cell class where it rises: +4-14%.
- **Bytes rise 4-11%** (systematic bw-capped 190.9 → 204.3 kbit/s,
  poor-mobile-nq 218.7 → 237.5). On these links the controller's allowance
  does not bind on every send. The extra is demand that fits under the
  allowance, not an overrun: no cell's datagram p50 moves by over 1 ms.
- **Wrong identity falls sharply:**
  - cap-1mbit-nq 250 → 12 (systematic, both seeds) and 138-157 → 31;
  - bw-capped 355 → 15 and 155-161 → 23-44;
  - poor-mobile-nq 415 → 214 and 346-543 → 124-168.
  - One exception: systematic poor-mobile-nq seed 2, 54 → 229.
- **ALL missing and extra fall**, e.g. net-next bw-capped missing 85 → 28.
  Debris pos@now p99 falls 3-18%.
- **The cost is on the sender-queue 0.5 Mbit/s link, systematic and
  heavy:**
  - presented jumps over 4 m 294 → 334 and 281 → 334 (systematic seeds
    1-2), 75 → 95 (heavy);
  - correction snaps 157 → 188 / 145 → 189, 48 → 68;
  - debris pos@render p99 0.148 → 0.168 m / 0.138 → 0.168, 0.557 → 0.655.
  - net-next bw-capped improves instead (80 → 70 jumps).
  - Heavy poor-mobile-nq correction snaps 32 → 135 (seed 1 only).
  - **Inferred:** a limited link now gets more, smaller sends. Each send's
    allowance is cut from the same byte rate, so the cut line falls on
    more sends. The fix measured next paces a limited link at 30 Hz.

The constrained-link figures above are the 60 Hz stream on every link
(`city.limited_hz=0`). The default now sends a limited link at 30 Hz.

**Limited links at 30 Hz: kept, on**
(`RateConfig::limited_send_interval_s` 1/30 s; `VIBE_CITY_LIMITED_HZ=0`, lab
`city.limited_hz=0`, turns it off).

- **What it does.** While a client's rate controller is `Limited`, its city
  sends are at least 1/30 s apart (half a tick of slack). Each paced send
  carries the budget of two and may use two per-send ceilings, 10,400 B
  (`SendPlan::Limited` `sends`, the encoder's `ceiling_sends`).
- **What it leaves alone.**
  - Free links keep every tick.
  - A 30 Hz stream is untouched, since its interval is already 1/30 s.
  - The client sees tick advances of 2 and goes back to the 6-tick delay
    after a second, as the cadence rule already does.
  - The recorded link replays the live plans open loop, so no capture's
    bytes change.
  - Measured: with it off, the lab reproduces the previous arm exactly
    (systematic bw-capped: every column equal).
  - `netlab2 calibrate` with this build still passes net-next c1 and the new
    live capture c1 (bytes 12,282 / 12,282 and 13,078 / 13,078).

Seed 1 (seed 2 on the bw-capped links); base → 60 Hz everywhere → 60 Hz,
limited links at 30 Hz:

| Bundle | Link | Netcode kbit/s | Presented − server p50 | Jumps > 4 m | Snaps | Wrong identity | Debris pos@render / pos@now p99 m | Datagram p99 ms |
|---|---|---|---|---|---|---|---|---|
| systematic | loopback | 243.9 → 269.6 → 269.6 | -5.2 → -4.1 → -4.1 | 198 → 188 → 188 | 77 → 76 → 76 | 0 → 0 → 0 | 0.088 / 1.521 → 0.100 / 1.293 → 0.100 / 1.293 | 0.1 → 0.1 → 0.1 |
| systematic | bw-capped | 190.9 → 204.3 → 197.3 | -7.7 → -6.4 → -7.4 | 294 → 334 → 305 | 157 → 188 → 170 | 355 → 15 → 15 | 0.148 / 2.171 → 0.168 / 1.970 → 0.148 / 2.035 | 111 → 103 → 116 |
| systematic | bw-capped, seed 2 | 190.9 → 204.3 → 197.3 | -7.7 → -6.4 → -7.4 | 281 → 334 → 308 | 145 → 189 → 171 | 12 → 12 → 12 | 0.138 / 2.171 → 0.168 / 1.970 → 0.148 / 2.035 | 111 → 103 → 115 |
| systematic | bw-capped-nq | 187.8 → 203.2 → 194.9 | -7.8 → -6.4 → -7.4 | 317 → 319 → 287 | 161 → 173 → 158 | 318 → 12 → 12 | 0.179 / 2.393 → 0.174 / 2.393 → 0.168 / 2.393 | 218 → 227 → 225 |
| systematic | bw-capped-nq, seed 2 | 185.9 → 202.6 → 195.5 | -7.8 → -6.4 → -7.4 | 316 → 308 → 282 | 162 → 166 → 152 | 352 → 12 → 12 | 0.163 / 2.393 → 0.185 / 2.393 → 0.158 / 2.393 | 213 → 223 → 225 |
| systematic | cap-1mbit-nq | 223.7 → 245.2 → 232.9 | -7.4 → -6.2 → -7.1 | 202 → 225 → 189 | 87 → 106 → 83 | 250 → 12 → 12 | 0.094 / 1.970 → 0.097 / 1.847 → 0.100 / 1.908 | 114 → 115 → 138 |
| systematic | poor-mobile-nq | 218.7 → 237.5 → 228.6 | -14.0 → -12.5 → -13.8 | 231 → 267 → 230 | 150 → 131 → 156 | 415 → 214 → 558 | 0.126 / 3.308 → 0.122 / 3.002 → 0.130 / 3.529 | 268 → 279 → 319 |
| heavy | loopback | 205.3 → 228.6 → 228.6 | -5.2 → -4.2 → -4.2 | 37 → 41 → 41 | 14 → 17 → 17 | 0 → 0 → 0 | 0.126 / 1.622 → 0.153 / 1.425 → 0.153 / 1.425 | 0.1 → 0.1 → 0.1 |
| heavy | bw-capped | 155.0 → 169.3 → 166.4 | -7.3 → -6.2 → -7.1 | 75 → 95 → 85 | 48 → 68 → 58 | 12 → 12 → 12 | 0.557 / 2.472 → 0.655 / 2.243 → 0.522 / 2.243 | 106 → 98 → 103 |
| heavy | bw-capped, seed 2 | 155.0 → 169.3 → 166.4 | -7.3 → -6.2 → -7.0 | 76 → 95 → 84 | 49 → 68 → 57 | 12 → 12 → 12 | 0.557 / 2.472 → 0.655 / 2.243 → 0.522 / 2.243 | 105 → 97 → 102 |
| heavy | bw-capped-nq | 153.6 → 164.0 → 162.6 | -7.3 → -6.2 → -7.1 | 58 → 69 → 61 | 33 → 37 → 37 | 12 → 12 → 12 | 0.540 / 2.553 → 0.677 / 2.393 → 0.522 / 2.472 | 194 → 214 → 226 |
| heavy | bw-capped-nq, seed 2 | 153.4 → 163.4 → 162.8 | -7.3 → -6.2 → -7.1 | 62 → 73 → 66 | 38 → 39 → 39 | 12 → 12 → 12 | 0.576 / 2.553 → 0.722 / 2.393 → 0.474 / 2.393 | 192 → 213 → 221 |
| heavy | cap-1mbit-nq | 171.2 → 192.6 → 194.8 | -7.1 → -6.0 → -6.7 | 54 → 56 → 44 | 25 → 26 → 21 | 12 → 12 → 12 | 0.240 / 2.102 → 0.248 / 1.908 → 0.179 / 1.908 | 104 → 114 → 124 |
| heavy | poor-mobile-nq | 165.0 → 187.8 → 188.6 | -13.5 → -12.1 → -13.0 | 60 → 56 → 46 | 32 → 135 → 129 | 51 → 51 → 51 | 0.343 / 3.100 → 0.301 / 2.813 → 0.211 / 2.906 | 298 → 267 → 322 |

What it says (inferred from the table):

- **Corrections: most of the 0.5 Mbit/s regression goes, but not all.**
  - Jumps over 4 m on bw-capped: systematic 334 → 305 / 308 (base 294 /
    281); heavy 95 → 85 / 84 (base 75 / 76). Snaps: 188 → 170, 68 → 58.
  - Debris pos@render p99 is back at base or better on every bw-capped
    cell (0.168 → 0.148 m; heavy 0.655 → 0.522, base 0.557).
  - On bw-capped-nq and cap-1mbit-nq, jumps and snaps are at or below base
    on both bundles.
- **The limited links give their latency back.**
  - Presented lag is within 0.3-0.4 tick of base (systematic bw-capped
    −7.7 → −6.4 → −7.4), since the client's delay returns to 6.
  - Datagram p99 rises 0-25 ms (cap-1mbit-nq 115 → 138 ms, poor-mobile-nq
    279 → 319 ms): half as many sends, each twice the size.
- **Wrong identity keeps the 60 Hz gains on bw-capped and cap-1mbit-nq**
  (355 → 15, 250 → 12). But systematic poor-mobile-nq goes 214 → 558 against
  base 415, with debris pos@now p99 3.00 → 3.53 m (base 3.31). That is one
  seed; heavy poor-mobile-nq is unchanged (51).
- **Bytes:** 1-5% below the unpaced arm; 3-8% above base on systematic.
- **Kept on.** It trades the limited links' tick of latency for fewer
  corrections, and those links were the ones with a regression. Whether
  that is the better side of the trade is a judgment the numbers do not
  settle. `VIBE_CITY_LIMITED_HZ=0` reverts it on a server.
- **Evidence is thin:**
  - seed 1 only on poor-mobile-nq and cap-1mbit-nq;
  - two bundles;
  - no LTE-class limited link, since LTE never enters `Limited` in the lab.

**Verdict.** Kept as the default:

- On the fast links it cuts the city's latency by a tick (17 ms) and
  debris pos@now p99 by 12-15% on loopback, and frames stopped fall.
  Jumps and snaps are at or below base on two of four captures, and 3-4
  jumps and 3 snaps above it on the other two.
- On constrained links identity, missing and extra improve. With limited
  links paced at 30 Hz (the default, above), their lag is 0.3-0.4 tick
  better than base, not 1 tick.
- It is not a clean win:
  - +5-11% bytes on fast links;
  - more jumps and snaps on the 0.5 Mbit/s sender-queue link on two
    captures: 3-13% above base with the 30 Hz pacing, 13-27% without it;
  - wrong identity on iid-jitter LTE is mixed.
- The 30 Hz / 5-tick alternative gets most of the latency at no byte cost,
  but with more jumps than base on every capture, more stopped frames, and
  none of the identity gains. It is available as `VIBE_CITY_STREAM_HZ=30`,
  where the client then picks 6. Or `CITY_PLAYOUT_DELAY=5` in the lab.

**Old client, new server** (the 3d96a192 client on the 60 Hz stream, seed 1,
all four bundles). It keeps its 6-tick delay, so it draws what the 60 Hz stream
with a 6-tick delay draws: no latency gain, and no breakage.

- Systematic loopback: jumps 198 → 187, debris pos@now p99 1.521 → 1.472 m.
- net-next LTE: wrong identity 322 → 86.
- It has the 60 Hz stream's constrained-link costs, e.g. heavy bw-capped
  jumps 75 → 90.
- The web client is served with the server, so only a stale tab runs it
  (**inferred**).

**Delay sweep at 60 Hz** (seed 1, loopback / LTE; 6 → 5 → 4 ticks, then
30 Hz with 4). Each tick less is a tick less lag. Four ticks costs little
more in jumps than five on systematic (188 → 200) and net-next (49 → 49), but
debris pos@render p99 keeps rising (systematic 0.100 → 0.103, heavy 0.153 →
0.158 m), and it cuts into the margin beyond the send interval that the
jitter needs; it was run on seed 1 only. Five is the default,
the same margin beyond the send interval that 6 was at 30 Hz.

| Bundle | Link | Presented − server p50 | Frames stopped % | Debris pos@render / pos@now p99 m | Jumps > 4 m | Snaps |
|---|---|---|---|---|---|---|
| systematic | loopback | -5.1 → -4.1 → -3.1; 30 Hz/4 -3.3 | 0.2 → 0.2 → 0.2; 0.8 | 0.097 / 1.472 → 0.100 / 1.293 → 0.103 / 1.136; 0.091 / 1.212 | 187 → 188 → 200; 216 | 74 → 76 → 80; 86 |
| systematic | lte | -9.7 → -8.8 → -8.0; -8.6 | 0.9 → 1.0 → 1.2; 1.8 | 0.118 / 2.637 → 0.126 / 2.553 → 0.130 / 2.393; 0.130 / 2.317 | 212 → 219 → 229; 222 | 286 → 292 → 307; 338 |
| net-next | loopback | -5.2 → -4.2 → -3.3; -3.4 | 0.9 → 1.0 → 1.1; 1.3 | 0.256 / 2.102 → 0.265 / 1.908 → 0.273 / 1.676; 0.301 / 1.788 | 45 → 49 → 49; 65 | 31 → 36 → 36; 47 |
| net-next | lte | -9.8 → -8.9 → -8.2; -8.7 | 1.1 → 1.3 → 1.6; 2.2 | 0.191 / 3.002 → 0.211 / 2.724 → 0.232 / 2.553; 0.343 / 2.813 | 20 → 22 → 21; 50 | 8 → 9 → 9; 38 |

**systematic-2c-d1342419 c1, seed 1** (base → 30 Hz with a 5-tick delay → this change):

| Link | Netcode kbit/s | Datagram p50 ms | Datagram p99 ms | Presented − server p50 (ticks) | p1 | Frames stopped % | Island first draw p50 ms | p99 | ALL pos@render p99 m | ALL pos@now p99 m | Debris pos@render p99 m | Debris pos@now p99 m | ALL missing | ALL extra | Wrong identity | Presented jumps > 4 m | Correction snaps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 243.9 → 243.9 → 269.6 | 0.1 → 0.1 → 0.1 | 0.1 → 0.1 → 0.1 | -5.2 → -4.2 → -4.1 | -16.6 → -15.9 → -15.0 | 0.6 → 0.7 → 0.2 | 0 → 0 → 0 | 10 → 10 → 10 | 0.025 → 0.027 → 0.027 | 0.138 → 0.126 → 0.114 | 0.088 → 0.088 → 0.100 | 1.521 → 1.380 → 1.293 | 94 → 93 → 82 | 280 → 252 → 256 | 0 → 0 → 0 | 198 → 207 → 188 | 77 → 83 → 76 |
| lan | 243.9 → 243.9 → 269.6 | 1.0 → 1.0 → 1.0 | 1.3 → 1.3 → 1.3 | -5.3 → -4.3 → -4.2 | -16.6 → -16.0 → -15.1 | 0.6 → 0.8 → 0.2 | 0 → 0 → 0 | 10 → 10 → 10 | 0.025 → 0.027 → 0.027 | 0.138 → 0.126 → 0.114 | 0.085 → 0.088 → 0.100 | 1.521 → 1.380 → 1.293 | 80 → 80 → 82 | 275 → 249 → 253 | 0 → 0 → 0 | 193 → 201 → 189 | 73 → 77 → 76 |
| lte-fifo | 236.7 → 236.7 → 261.9 | 104.2 → 104.2 → 105.0 | 124.7 → 124.7 → 124.7 | -10.9 → -10.0 → -9.8 | -22.7 → -22.0 → -21.0 | 1.0 → 1.2 → 0.6 | 65 → 65 → 60 | 209 → 209 → 137 | 0.028 → 0.028 → 0.028 | 0.273 → 0.256 → 0.240 | 0.100 → 0.103 → 0.107 | 2.472 → 2.317 → 2.243 | 159 → 159 → 165 | 491 → 452 → 419 | 580 → 580 → 348 | 215 → 221 → 197 | 93 → 96 → 78 |
| lte | 236.7 → 236.7 → 261.9 | 89.6 → 89.6 → 89.6 | 124.3 → 124.3 → 124.3 | -10.0 → -9.2 → -8.8 | -26.4 → -26.7 → -34.5 | 1.1 → 1.4 → 1.0 | 60 → 60 → 49 | 209 → 209 → 130 | 0.029 → 0.031 → 0.030 | 0.265 → 0.256 → 0.265 | 0.118 → 0.126 → 0.126 | 2.553 → 2.393 → 2.553 | 248 → 248 → 214 | 600 → 572 → 667 | 529 → 529 → 1,134 | 211 → 213 → 219 | 323 → 326 → 292 |
| poor-mobile-nq | 218.7 → 218.7 → 237.5 | 158.0 → 158.0 → 157.2 | 267.5 → 267.5 → 279.4 | -14.0 → -13.2 → -12.5 | -39.0 → -39.2 → -38.0 | 1.5 → 1.8 → 1.3 | 129 → 129 → 128 | 272 → 272 → 250 | 0.029 → 0.031 → 0.029 | 0.390 → 0.378 → 0.343 | 0.126 → 0.134 → 0.122 | 3.308 → 3.202 → 3.002 | 271 → 271 → 249 | 982 → 997 → 881 | 415 → 423 → 214 | 231 → 243 → 267 | 150 → 158 → 131 |
| cap-1mbit-nq | 223.7 → 223.7 → 245.2 | 34.6 → 34.6 → 34.4 | 114.2 → 114.2 → 114.9 | -7.4 → -6.4 → -6.2 | -20.0 → -19.2 → -18.6 | 1.0 → 1.2 → 0.6 | 22 → 22 → 17 | 99 → 99 → 108 | 0.027 → 0.027 → 0.027 | 0.198 → 0.185 → 0.168 | 0.094 → 0.097 → 0.097 | 1.970 → 1.847 → 1.847 | 144 → 147 → 106 | 329 → 288 → 285 | 250 → 250 → 12 | 202 → 216 → 225 | 87 → 95 → 106 |
| bw-capped | 190.9 → 190.9 → 204.3 | 37.8 → 37.8 → 37.5 | 110.8 → 110.8 → 103.1 | -7.7 → -6.8 → -6.4 | -20.8 → -20.0 → -19.1 | 1.4 → 1.6 → 0.9 | 37 → 37 → 34 | 216 → 216 → 175 | 0.030 → 0.031 → 0.031 | 0.225 → 0.211 → 0.198 | 0.148 → 0.158 → 0.168 | 2.171 → 2.035 → 1.970 | 136 → 136 → 121 | 426 → 387 → 338 | 355 → 355 → 15 | 294 → 316 → 334 | 157 → 169 → 188 |

**20260925-002127-net-next c1, seed 1** (base → 30 Hz with a 5-tick delay → this change):

| Link | Netcode kbit/s | Datagram p50 ms | Datagram p99 ms | Presented − server p50 (ticks) | p1 | Frames stopped % | Island first draw p50 ms | p99 | ALL pos@render p99 m | ALL pos@now p99 m | Debris pos@render p99 m | Debris pos@now p99 m | ALL missing | ALL extra | Wrong identity | Presented jumps > 4 m | Correction snaps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| loopback | 183.3 → 183.3 → 198.0 | 0.1 → 0.1 → 0.1 | 0.1 → 0.1 → 0.1 | -5.2 → -4.3 → -4.2 | -18.8 → -18.5 → -18.0 | 1.1 → 1.2 → 1.0 | 0 → 0 → 0 | 9 → 9 → 9 | 0.022 → 0.023 → 0.025 | 0.094 → 0.088 → 0.091 | 0.292 → 0.301 → 0.265 | 2.171 → 1.970 → 1.908 | 74 → 74 → 56 | 34 → 34 → 34 | 0 → 0 → 0 | 60 → 64 → 49 | 44 → 46 → 36 |
| lan | 183.3 → 183.3 → 198.0 | 1.0 → 1.0 → 1.0 | 1.3 → 1.3 → 1.3 | -5.3 → -4.3 → -4.3 | -19.0 → -19.0 → -18.2 | 1.1 → 1.2 → 1.0 | 0 → 0 → 0 | 9 → 9 → 9 | 0.022 → 0.023 → 0.025 | 0.094 → 0.088 → 0.091 | 0.301 → 0.301 → 0.265 | 2.171 → 1.970 → 1.908 | 73 → 73 → 55 | 34 → 34 → 33 | 9 → 9 → 9 | 61 → 65 → 49 | 44 → 47 → 36 |
| lte-fifo | 178.0 → 178.0 → 191.8 | 103.3 → 103.3 → 104.1 | 124.6 → 124.6 → 124.7 | -10.9 → -10.1 → -9.9 | -24.0 → -24.0 → -24.6 | 1.3 → 1.5 → 1.2 | 73 → 73 → 71 | 161 → 161 → 138 | 0.023 → 0.024 → 0.026 | 0.153 → 0.148 → 0.138 | 0.273 → 0.282 → 0.185 | 3.417 → 3.202 → 3.100 | 112 → 112 → 32 | 79 → 79 → 74 | 350 → 350 → 27 | 45 → 46 → 23 | 28 → 31 → 10 |
| lte | 178.0 → 178.0 → 191.8 | 89.4 → 89.4 → 89.5 | 124.3 → 124.3 → 124.3 | -10.1 → -9.3 → -8.9 | -23.6 → -23.4 → -24.4 | 1.3 → 1.7 → 1.2 | 65 → 65 → 65 | 155 → 155 → 138 | 0.024 → 0.026 → 0.028 | 0.143 → 0.134 → 0.126 | 0.301 → 0.321 → 0.211 | 3.100 → 2.906 → 2.724 | 116 → 116 → 51 | 94 → 94 → 98 | 322 → 322 → 86 | 47 → 48 → 22 | 35 → 35 → 9 |
| poor-mobile-nq | 157.3 → 157.3 → 175.1 | 155.2 → 155.2 → 156.0 | 308.1 → 308.1 → 340.7 | -13.7 → -13.0 → -12.5 | -27.0 → -27.0 → -29.5 | 1.4 → 1.8 → 1.5 | 151 → 151 → 141 | 344 → 344 → 258 | 0.027 → 0.029 → 0.030 | 0.198 → 0.191 → 0.185 | 0.540 → 0.595 → 0.366 | 4.573 → 4.427 → 4.427 | 130 → 130 → 116 | 118 → 118 → 119 | 346 → 352 → 168 | 47 → 49 → 33 | 33 → 35 → 19 |
| cap-1mbit-nq | 163.7 → 163.7 → 175.6 | 33.5 → 33.5 → 33.4 | 108.2 → 108.2 → 119.3 | -7.3 → -6.3 → -6.2 | -21.0 → -20.7 → -20.0 | 1.2 → 1.4 → 1.1 | 34 → 34 → 30 | 166 → 166 → 74 | 0.024 → 0.026 → 0.027 | 0.122 → 0.114 → 0.110 | 0.416 → 0.474 → 0.354 | 2.906 → 2.724 → 2.724 | 76 → 76 → 26 | 47 → 47 → 43 | 138 → 138 → 31 | 43 → 48 → 24 | 30 → 33 → 13 |
| bw-capped | 145.9 → 145.9 → 152.8 | 35.7 → 35.7 → 35.9 | 95.7 → 95.7 → 82.4 | -7.5 → -6.5 → -6.4 | -20.9 → -20.6 → -20.0 | 1.3 → 1.5 → 1.2 | 43 → 43 → 40 | 174 → 174 → 119 | 0.028 → 0.030 → 0.032 | 0.134 → 0.130 → 0.122 | 1.252 → 1.336 → 1.252 | 3.645 → 3.529 → 3.308 | 85 → 85 → 28 | 43 → 43 → 35 | 155 → 155 → 23 | 80 → 85 → 70 | 60 → 64 → 49 |


**heavy-quick3-v2 c1, seed 1** (base → this change):

| Link | Netcode kbit/s | Datagram p99 ms | Presented − server p50 (ticks) | Frames stopped % | Debris pos@render p99 m | Debris pos@now p99 m | Wrong identity | Presented jumps > 4 m | Correction snaps |
|---|---|---|---|---|---|---|---|---|---|
| loopback | 205.3 → 228.6 | 0.1 → 0.1 | -5.2 → -4.2 | 0.2 → 0.1 | 0.126 → 0.153 | 1.622 → 1.425 | 0 → 0 | 37 → 41 | 14 → 17 |
| lan | 205.3 → 228.6 | 1.3 → 1.3 | -5.3 → -4.2 | 0.2 → 0.2 | 0.126 → 0.153 | 1.622 → 1.425 | 0 → 0 | 37 → 41 | 14 → 17 |
| lte-fifo | 199.3 → 221.4 | 124.7 → 124.7 | -10.5 → -9.5 | 0.7 → 0.6 | 0.138 → 0.168 | 2.472 → 2.243 | 42 → 72 | 39 → 42 | 16 → 19 |
| lte | 199.3 → 221.4 | 124.3 → 124.3 | -9.8 → -8.5 | 0.7 → 0.6 | 0.168 → 0.185 | 2.243 → 2.035 | 32 → 64 | 40 → 44 | 124 → 126 |
| poor-mobile-nq | 165.0 → 187.8 | 297.7 → 266.9 | -13.5 → -12.1 | 0.9 → 0.7 | 0.343 → 0.301 | 3.100 → 2.813 | 51 → 51 | 60 → 56 | 32 → 135 |
| cap-1mbit-nq | 171.2 → 192.6 | 104.3 → 113.6 | -7.1 → -6.0 | 0.5 → 0.5 | 0.240 → 0.248 | 2.102 → 1.908 | 12 → 12 | 54 → 56 | 25 → 26 |
| bw-capped | 155.0 → 169.3 | 106.1 → 97.7 | -7.3 → -6.2 | 0.8 → 0.6 | 0.557 → 0.655 | 2.472 → 2.243 | 12 → 12 | 75 → 95 | 48 → 68 |

**20260924-215619-scoreboard-new c1, seed 1** (base → this change):

| Link | Netcode kbit/s | Datagram p99 ms | Presented − server p50 (ticks) | Frames stopped % | Debris pos@render p99 m | Debris pos@now p99 m | Wrong identity | Presented jumps > 4 m | Correction snaps |
|---|---|---|---|---|---|---|---|---|---|
| loopback | 190.5 → 204.9 | 0.1 → 0.1 | -5.4 → -4.4 | 0.7 → 0.6 | 0.490 → 0.444 | 4.017 → 3.529 | 0 → 0 | 43 → 46 | 8 → 11 |
| lan | 190.5 → 204.9 | 1.3 → 1.3 | -5.5 → -4.5 | 0.7 → 0.6 | 0.506 → 0.459 | 4.149 → 3.645 | 3 → 3 | 43 → 46 | 8 → 12 |
| lte-fifo | 186.0 → 198.9 | 124.7 → 124.7 | -10.7 → -9.8 | 1.0 → 0.9 | 0.522 → 0.490 | 5.925 → 5.376 | 36 → 36 | 44 → 49 | 10 → 17 |
| lte | 186.0 → 198.9 | 124.3 → 124.3 | -9.9 → -8.7 | 1.1 → 1.1 | 0.595 → 0.522 | 5.376 → 4.878 | 36 → 90 | 46 → 50 | 11 → 27 |
| poor-mobile-nq | 169.5 → 176.2 | 326.0 → 280.2 | -13.3 → -12.6 | 1.2 → 1.1 | 0.655 → 0.699 | 7.676 → 6.744 | 65 → 147 | 50 → 56 | 18 → 33 |
| cap-1mbit-nq | 172.7 → 183.9 | 158.8 → 112.2 | -7.3 → -6.1 | 0.9 → 0.8 | 0.506 → 0.459 | 5.205 → 4.573 | 12 → 12 | 45 → 45 | 14 → 17 |
| bw-capped | 142.9 → 150.0 | 110.9 → 95.2 | -7.3 → -6.5 | 1.1 → 1.0 | 1.031 → 1.252 | 5.736 → 5.205 | 12 → 12 | 59 → 73 | 30 → 37 |


**systematic c1, seed 1, per class, base → this change** (pos@render p50 / p99; pos@now p50 / p99, m; missing / extra / wrong identity)

| Link | Class | pos@render | pos@now | m / e / w |
|---|---|---|---|---|
| loopback | player | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 0.292 → 0.001 / 0.292 | 1 / 0 / 0 → 1 / 0 / 0 |
| loopback | vehicle | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 0.077 → 0.001 / 0.077 | 0 / 0 / 0 → 0 / 0 / 0 |
| loopback | body | 0.001 / 0.003 → 0.001 / 0.003 | 0.080 / 1.472 → 0.080 / 1.472 | 38 / 125 / 0 → 38 / 125 / 0 |
| loopback | meteor | 0.002 / 0.017 → 0.002 / 0.017 | 1.676 / 7.676 → 1.676 / 7.676 | 43 / 3 / 0 → 43 / 3 / 0 |
| loopback | chunk_intact | 0.000 / 0.000 → 0.000 / 0.000 | 0.000 / 0.000 → 0.000 / 0.000 | 0 / 0 / 0 → 0 / 0 / 0 |
| loopback | chunk_debris | 0.007 / 0.088 → 0.008 / 0.100 | 0.008 / 1.521 → 0.009 / 1.293 | 12 / 152 / 0 → 0 / 128 / 0 |
| loopback | chunk_rubble | 0.005 / 0.009 → 0.005 / 0.009 | 0.005 / 0.009 → 0.005 / 0.009 | 0 / 0 / 0 → 0 / 0 / 0 |
| lte | player | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 1.676 → 0.001 / 1.622 | 1 / 0 / 0 → 1 / 0 / 0 |
| lte | vehicle | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 0.998 → 0.001 / 1.031 | 1 / 0 / 0 → 5 / 0 / 0 |
| lte | body | 0.001 / 0.003 → 0.001 / 0.003 | 0.746 / 9.629 → 0.746 / 9.629 | 146 / 421 / 0 → 128 / 376 / 0 |
| lte | meteor | 0.002 / 0.017 → 0.002 / 0.017 | 12.887 / 24.627 → 13.311 / 24.627 | 95 / 3 / 0 → 80 / 1 / 0 |
| lte | chunk_intact | 0.000 / 0.000 → 0.000 / 0.000 | 0.000 / 0.000 → 0.000 / 0.000 | 0 / 0 / 0 → 0 / 0 / 0 |
| lte | chunk_debris | 0.008 / 0.118 → 0.008 / 0.126 | 0.009 / 2.553 → 0.009 / 2.553 | 5 / 176 / 523 → 0 / 290 / 1,128 |
| lte | chunk_rubble | 0.005 / 0.009 → 0.005 / 0.009 | 0.005 / 0.009 → 0.005 / 0.009 | 0 / 0 / 6 → 0 / 0 / 6 |
| bw-capped | player | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 1.136 → 0.001 / 0.998 | 1 / 0 / 0 → 1 / 0 / 0 |
| bw-capped | vehicle | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 0.416 → 0.001 / 0.390 | 0 / 0 / 0 → 0 / 0 / 0 |
| bw-capped | body | 0.001 / 0.002 → 0.001 / 0.003 | 0.366 / 5.553 → 0.332 / 5.205 | 80 / 205 / 0 → 70 / 168 / 0 |
| bw-capped | meteor | 0.002 / 0.017 → 0.002 / 0.017 | 7.432 / 19.632 → 6.529 / 17.247 | 44 / 2 / 0 → 45 / 1 / 0 |
| bw-capped | chunk_intact | 0.000 / 0.000 → 0.000 / 0.000 | 0.000 / 0.000 → 0.000 / 0.000 | 0 / 0 / 0 → 0 / 0 / 0 |
| bw-capped | chunk_debris | 0.008 / 0.148 → 0.008 / 0.168 | 0.009 / 2.171 → 0.008 / 1.970 | 11 / 219 / 354 → 5 / 169 / 14 |
| bw-capped | chunk_rubble | 0.005 / 0.009 → 0.005 / 0.009 | 0.005 / 0.009 → 0.005 / 0.009 | 0 / 0 / 1 → 0 / 0 / 1 |

**net-next c1, seed 1, per class, base → this change** (pos@render p50 / p99; pos@now p50 / p99, m; missing / extra / wrong identity)

| Link | Class | pos@render | pos@now | m / e / w |
|---|---|---|---|---|
| loopback | player | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 0.273 → 0.001 / 0.273 | 1 / 0 / 0 → 1 / 0 / 0 |
| loopback | vehicle | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 0.174 → 0.001 / 0.174 | 0 / 0 / 0 → 0 / 0 / 0 |
| loopback | body | 0.001 / 0.002 → 0.001 / 0.002 | 0.103 / 2.035 → 0.103 / 2.035 | 11 / 34 / 0 → 11 / 34 / 0 |
| loopback | meteor | 0.006 / 14.202 → 0.006 / 14.202 | 2.637 / 16.698 → 2.637 / 16.698 | 11 / 0 / 0 → 11 / 0 / 0 |
| loopback | chunk_intact | 0.000 / 0.000 → 0.000 / 0.000 | 0.000 / 0.000 → 0.000 / 0.000 | 0 / 0 / 0 → 0 / 0 / 0 |
| loopback | chunk_debris | 0.008 / 0.292 → 0.008 / 0.265 | 0.011 / 2.171 → 0.011 / 1.908 | 51 / 0 / 0 → 33 / 0 / 0 |
| loopback | chunk_rubble | 0.005 / 0.009 → 0.005 / 0.009 | 0.005 / 0.009 → 0.005 / 0.009 | 0 / 0 / 0 → 0 / 0 / 0 |
| lte | player | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 1.521 → 0.001 / 1.571 | 1 / 0 / 0 → 1 / 0 / 0 |
| lte | vehicle | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 1.571 → 0.001 / 1.472 | 0 / 0 / 0 → 0 / 0 / 0 |
| lte | body | 0.001 / 0.002 → 0.001 / 0.003 | 0.614 / 9.946 → 0.614 / 9.946 | 36 / 94 / 0 → 33 / 98 / 0 |
| lte | meteor | 0.006 / 13.749 → 0.006 / 15.152 | 17.815 / 25.437 → 18.401 / 26.274 | 17 / 0 / 0 → 17 / 0 / 0 |
| lte | chunk_intact | 0.000 / 0.000 → 0.000 / 0.000 | 0.000 / 0.000 → 0.000 / 0.000 | 0 / 0 / 0 → 0 / 0 / 0 |
| lte | chunk_debris | 0.008 / 0.301 → 0.008 / 0.211 | 0.012 / 3.100 → 0.012 / 2.724 | 62 / 0 / 318 → 0 / 0 / 82 |
| lte | chunk_rubble | 0.005 / 0.009 → 0.005 / 0.009 | 0.005 / 0.009 → 0.005 / 0.009 | 0 / 0 / 4 → 0 / 0 / 4 |
| bw-capped | player | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 1.065 → 0.001 / 0.849 | 1 / 0 / 0 → 1 / 0 / 0 |
| bw-capped | vehicle | 0.001 / 0.002 → 0.001 / 0.002 | 0.001 / 0.614 → 0.001 / 0.595 | 0 / 0 / 0 → 0 / 0 / 0 |
| bw-capped | body | 0.001 / 0.002 → 0.001 / 0.002 | 0.321 / 5.376 → 0.292 / 5.039 | 21 / 43 / 0 → 17 / 35 / 0 |
| bw-capped | meteor | 0.006 / 13.749 → 0.006 / 13.311 | 8.459 / 19.007 → 7.676 / 19.007 | 7 / 0 / 0 → 10 / 0 / 0 |
| bw-capped | chunk_intact | 0.000 / 0.000 → 0.000 / 0.000 | 0.000 / 0.000 → 0.000 / 0.000 | 0 / 0 / 0 → 0 / 0 / 0 |
| bw-capped | chunk_debris | 0.009 / 1.252 → 0.009 / 1.252 | 0.011 / 3.645 → 0.012 / 3.308 | 56 / 0 / 155 → 0 / 0 / 23 |
| bw-capped | chunk_rubble | 0.005 / 0.009 → 0.005 / 0.009 | 0.005 / 0.009 → 0.005 / 0.009 | 0 / 0 / 0 → 0 / 0 / 0 |

**Live** (measured; one run, `scripts/perf/city-bench.sh --scenario quick
--clients 3` from this tree, ports 7001/7002/3703, GPU lock,
`target/net-cadence/city-bench/runs/20260925-040411-net-cadence`). Another
process was using the GPU during the run, so tick numbers are indicative
only.

- **Run health:** 3/3 paired bundles, 0 errors; 19 of 27 budgets pass (20 on
  the net-next run).
  - The server's tick and sim-rate budgets fail, as on every recent run:
    tick p95 24.5 → 31.9 ms, dynamics mean 9.8 → 14.1 ms, GPU wait p95
    19.3 → 28.2 ms. That is physics, on a busy GPU.
  - Client c2 had 11 hitches over 100 ms and 15 CPU-bound over 33 ms.
    Its send → arrive p99 is 117 ms against 4.1-4.5 ms on c0 and c1
    (**inferred:** the receive timestamps of a stalled page, not the link;
    0 packets lost, 0 server drops).
- **City encoder:** encode p95 per send 0.168 → 0.227 ms, step p95 0.329 →
  0.320 ms, now at every tick.
- **Rate controller:** 0 state changes, so every loopback link stayed
  `Free`.
- **Wire and client health:** snapshot gap p99 49.1 ms, render-clock
  back-steps 0, structure repairs 0, body render error p99 0.04 m.
- **Bytes:** 165.8 / 157.3 / 159.8 kbit/s per client, against 200.3 / 185.3 /
  193.8 on the net-next run. That run broke 35% of bonds, this one 25.7%,
  so the comparison is indicative only.
- **Calibration of this capture with this tree: PASS on all three clients.**
  - Bytes 12,950 / 12,950, 13,078 / 13,078 and 12,874 / 12,874
    byte-identical, 60 Hz city chunks included (5,820 / 5,948 / 5,744).
  - Clock offset p99 in the last 10 s: 92-100 µs.
  - Lab vs live renderer p99: players 1.1-1.2 cm, vehicles 0.1-0.3 cm,
    bodies 5.3-6.7 cm, meteors 5.3-8.1 cm, intact chunks 0.00 mm, debris
    chunks 0.7-4.6 cm.
  - The replayed client ran the 60 Hz stream with the 5-tick delay
    (`streamIntervalTicks` 1, `sampleDelayTicks` 5, c1).
- **Not run live:** the `VIBE_CITY_STREAM_HZ` override was added after the
  bench's build. The default path is the same constants.

**Tests** (fail or do not compile before the change, except the guards):

- `destruction/src/encoder.rs`:
  - `the_stream_is_sent_every_tick_under_the_same_byte_rate_cap`;
  - `an_older_checkpoint_resumes_at_its_cadence_without_an_innovation_window`;
  - `an_accelerating_body_is_refreshed_as_often_at_60_hz_as_at_30`: a body
    at 9 m/s² gets as many records at 60 Hz as at 30, and fewer than half
    as many with the per-send test;
  - `at_30_hz_the_innovation_window_changes_no_record` (guard).
  - `topology_copies_go_ahead_of_the_records_at_two_sends` now reads the
    cadence. The stream test helper sends at the config's interval.
- `server/src/link_rate.rs`:
  - `the_controller_paces_a_60_hz_stream_as_it_paced_30_hz` (guard). Fast
    links are never throttled, 0.5 Mbit/s holds the 30 Hz queue and rate
    bounds, and 96 kbit/s merges sends. The fluid model gained a cadence
    and a ceiling.
  - `a_limited_60_hz_link_is_sent_every_other_tick`: never two limited
    sends in consecutive ticks, each standing for two, at the unpaced
    arm's byte rate within 10%. Off, it sends every tick. Free links and
    30 Hz streams are untouched.
- `destruction/src/encoder.rs`:
  `a_paced_send_may_use_the_ceiling_of_the_sends_it_stands_for`.
- `server/src/city.rs`:
  `the_stream_runs_at_60_hz_and_vibe_city_stream_hz_goes_back_to_30`.
- `client/src/city/cityClient.test.ts`, "CityClient playout delay and the
  send cadence":
  - a 60 Hz stream is presented with a 5-tick delay, more than 0.8 tick
    nearer the server than 30 Hz, and never past its newest datagram;
  - a jittery 60 Hz link stays behind its newest datagram;
  - a 60 Hz stream thinned to every other tick gets 6 back.
  - All three fail on the 3d96a192 client (run there).
- Suites:
  - destruction 181 passing;
  - server 163 (+1 ignored);
  - netlab2 95;
  - client 1,195 (4 skipped);
  - `tsc -b` clean.

**Reproduce**

```bash
N=<this tree's lab binary>; BASE=<a clean worktree of 3d96a192>
P=lab.recorded_repairs=0,city.ballistic_free_fall=1,city.client_model=1,city.baseline_interval_ticks=120,city.baseline_lag_ticks=110,city.baseline_skip_quiescent=1,city.topology_copies=2,snapshot.compact_self=1,snapshot.removals=1,snapshot.idle_cold=1
$BASE/target/.../netlab2 run --bundle <b> --out <runs>/base/seed<k>/<link> --link <link> --seed <k> --knob $P --client-root $BASE/client
$N run --bundle <b> --out <runs>/cand/seed<k>/<link> --link <link> --seed <k> \
   --knob $P,city.send_hz=60,city.ceiling_bytes=5200,city.innovation_window_ticks=2
CITY_PLAYOUT_DELAY=5 $N run ... --knob $P          # 30 Hz with a 5-tick delay
scripts/perf/netlab2-scoreboard.py lag <runDir>     # presented-lag.json, before pruning presented.bin
```

Runs: `target/net-cadence/runs/<bundle>/<arm>/seed<k>/<link>` (`sys`, `hq`,
`new`, `nn`; arms `base`, `cand`, `h30d5`, `y60`, `y60d5`, `y60d4`,
`h30d4`, `x60`, `h60`, `cand3c`, `candcompat`, `lim30` (limited links at
30 Hz), `lim0` (the same build with it off), and `m30` / `y30`, this tree
at 30 Hz, identical to `base` on every cell). Calibration:
`target/net-cadence/calibrate/*.log`.

## Proposals not implemented

In order of expected value (inferred from the numbers above):

1. ~~**Rate adaptation.**~~ Implemented: [Rate adaptation](#rate-adaptation).
2. **Acknowledged delivery for the first record of a body.** The stream is
   open loop, so a lost first record is noticed only by the age deadline.
   Resending a body's first record once, one send later, would cost ~1% of
   records (fractures per second over records per second), and it targets the
   "never drawn" metric that trends up on LTE.
3. **Ballistic delta mode.** Ballistic records are always absolute (16 B
   pose); a baseline-relative variant saves 6 B on the 33% of records that
   remain ballistic, about 7% of city bytes. Wire change: client decoder.
4. **Topology on its own reliable stream.** (Topology now also rides the
   datagram lane, which removes its head-of-line blocking without a
   transport change: [City latency and topology delivery](#city-latency-and-topology-delivery).
   Baselines still share the one stream.) Baseline parts (up to 32 kB)
   sit ahead of topology on the one ordered stream; reliable HOL p99 is
   286 ms on LTE. Fractures would appear sooner. Transport change on both
   sides.
5. ~~**Snapshot self-state.**~~ Implemented without a flag, since every
   client already length-detects the support block:
   [compact self state](#next-wins-compact-self-state-and-explicit-removals).
6. ~~**An explicit "bodies removed" list.**~~ Implemented, for vehicles too:
   [explicit removals](#next-wins-compact-self-state-and-explicit-removals).
7. ~~**Entity-level ordering of late snapshots.**~~ Implemented:
   [late snapshots](#next-wins-late-snapshots-and-idle-players-and-vehicles).
8. ~~**Stationary players and vehicles at 60 Hz.**~~ Implemented:
   [idle players and vehicles](#next-wins-late-snapshots-and-idle-players-and-vehicles).

## Risks and limits

- **Open loop.** City datagrams are not acknowledged. The client model
  assumes the client got what was sent; a lost record is repaired only by the
  error or age gates. City moving bodies never drawn trend up on LTE: mean of
  4 seeds 9,626 → 10,642 (v2c0) and 10,375 → 12,474 (h1c0), with overlapping
  ranges. They trend down on poor-mobile. Proposal 2 targets this.
- **Landing debris on the light bundle.** rec1 landing p50 goes 0.010 →
  0.021 m on LAN and 0.036 → 0.082 m on bw-capped. The client model sends
  fewer records for fast in-contact bodies whose linear extrapolation is
  within 2 px. On the heavy bundles landing improves on every link except
  v2c0 bw-capped (0.039 → 0.049 m).
- **Newly freed bodies go absolute for longer.** A generation is referenced
  for up to 3.8 s (2 s interval plus 1.83 s lag). This is counted in the
  byte figures: bytes per record are 29.2, against 24–25 for an all-delta
  stream.
- **A joining or resynced client gets absolutes for up to 3.8 s** (change
  6), 6 B more per record for that client in that window. This is the price
  of the longer lag, and it is not in the lab figures (the scored clients
  joined before their captures).
- **The client model mirrors two client constants** (the 8-tick window and
  gravity). A test on each side reads the other, so a drift fails CI.
- **Lab limits:** see [netlab-v2.md](netlab-v2.md#known-limits).
  - The link model is a paced ideal, with no slow start.
  - Feedback is open loop (seam S6).
  - One scored client per bundle.
- **Saturated links** were not fixed by the defaults above (datagram p99 in
  seconds on poor-mobile and bw-capped). [Rate adaptation](#rate-adaptation)
  fixes them.

## Reproduce

```bash
# lab binary + client wasm in this tree (docs/netlab-v2.md "How to run")
N=target/stream-tune/cargo/release/netlab2
B=target/netlab-v2/bundles/heavy-quick3-v2/debug-reports/session-netlab2-20260924-103109-quick-3c-c0
REC=city.ballistic_free_fall=1,city.client_model=1,city.baseline_skip_quiescent=1,city.baseline_interval_ticks=120,city.baseline_lag_ticks=110
$N matrix --bundle $B --out <dir> --links loopback,lan,cable,lte,poor-mobile,bw-capped \
   --knob-sets "prod:lab.recorded_repairs=0;rec:lab.recorded_repairs=0,$REC"
scripts/perf/netlab2-tune.py <dir> [--pareto]
```

The knobs are needed only for bundles recorded before this change: their
encoder checkpoints carry the old configuration. A bundle recorded with this
server has the new defaults in its checkpoint.
