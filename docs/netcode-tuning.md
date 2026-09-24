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

**Not changed, stated as trade-offs:** the per-send byte ceiling and the
city send rate are the two large levers left; see
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
5. **Snapshot self-state.** About 60 B of every snapshot is fixed (header,
   self state, trailer): 29 kbit/s at 60 Hz. The 21 B support block could be
   omitted when the player has no support, detected by a flag. Wire change.
6. **An explicit "bodies removed" list** for the snapshot stream, replacing
   the client's inference from the cold-refresh contract (bodyPresence.ts).
   Measured on v2c0: 19 snapshot bodies leave the player's stream in 122 s,
   one leave each. A length-detected trailer of 2-byte handles would add
   under 0.01 kbit/s even when repeated three times for loss (inferred), and
   nothing when empty.

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
