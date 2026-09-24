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

**Not changed, stated as trade-offs:** the per-send byte ceiling and the
city send rate are the two large levers left; see
[the Pareto front](#pareto-front). A lower ceiling is the only knob that
fixes the saturated 0.5–1 Mbit/s links, and it costs error on fast links. The
real fix there is rate adaptation, [proposed](#proposals-not-implemented)
below.

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

## Proposals not implemented

In order of expected value (inferred from the numbers above):

1. **Rate adaptation.** Set each client's city ceiling from the QUIC path's
   delivery rate or congestion window. This is server-only: quinn exposes
   path stats. The lab shows a fixed 1.3–2.6 kB ceiling cures the saturated
   links (bw-capped mean error 0.36 → 0.14 m, perceptible area 8× lower) but
   costs 30–60% error on fast links. Only a per-link ceiling gets both.
   The ceiling's allowance is already per client, so the rate would be the
   only new input.
2. **Acknowledged delivery for the first record of a body.** The stream is
   open loop, so a lost first record is noticed only by the age deadline.
   Resending a body's first record once, one send later, would cost ~1% of
   records (fractures per second over records per second), and it targets the
   "never drawn" metric that trends up on LTE.
3. **Ballistic delta mode.** Ballistic records are always absolute (16 B
   pose); a baseline-relative variant saves 6 B on the 33% of records that
   remain ballistic, about 7% of city bytes. Wire change: client decoder.
4. **Topology on its own reliable stream.** Baseline parts (up to 32 kB)
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
- **Saturated links are not fixed.** poor-mobile and bw-capped still
  saturate at peaks with the new defaults (datagram p99 in seconds). Only a
  lower ceiling or rate adaptation addresses that.

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
