# Netlab v2: frozen server truth through the production netcode

Netlab v2 measures **netcode sync efficiency** on its own: what the
production server encoders send for a recorded session, what a client would
receive over a given link, and what the production client would draw from it,
scored against the server's frozen truth. The same bundle replays
identically every run, so a netcode change, a knob or a link profile is priced
on the same data. It does not measure server runtime (the city benchmark,
[city-bench.md](city-bench.md), does) or rendering (paused).

It needs no GPU and runs a 75 s session in about 1.5 s, or 1.3 s per matrix
cell.

- Source: `server/src/bin/netlab2/` (Rust stages) and `client/netlab/v2/`
  (the client stage).
- Output: `/Users/glavin/Development/vibe-land/target/netlab-v2/`.
- Live counterpart: [client/netlab/README.md](../client/netlab/README.md).

## Architecture

```
 paired session bundle (debug-reports/session-<id>/)
 ├─ server/world.bin ............ authoritative players/vehicles/bodies per tick
 ├─ server/snapshot-inputs.jsonl  per snapshot tick: acked input seq, support,
 │                                melee flags, SnapshotV2 wall-clock stamp  [new]
 ├─ server/snapshot-baseline.json snapshot interest state + handles at capture open [new]
 ├─ server/city/encoder.tape .... what the city encoder was fed, per tick
 ├─ server/city/encoder-checkpoint.json.zst  encoder state before the 1st captured tick [new]
 ├─ server/city/cameras.jsonl ... every player's camera per send tick, in call order
 ├─ server/ticks.jsonl .......... per-tick wall time and phase costs
 ├─ server/sendlog.bin .......... every packet sent: tick, queue/send time, size, CRC32
 └─ client.vltape ............... every packet received + arrival time, frames, clock
        │
        ▼
 ┌─ SERVER STAGE (Rust, netlab2::stream) ──────────────────────────────────────┐
 │ snapshot: snapshot_builder::build_recipient_snapshot  ← same fn as server   │
 │           + protocol::encode_server_packet                                  │
 │ city:     ChunkStreamEncoder::from_checkpoint, then per tick                │
 │           ingest_tick → take_topology_messages → maybe_emit_baseline →      │
 │           topology_hash_message; send ticks: encode_send → client_datagrams │
 │           per camera (live call order); bootstraps where the server sent them│
 │ other kinds: recorded bytes, at their send-log queue time (pass-through)    │
 │ timing:   each packet at its phase in its tick (ticks.jsonl) or ideal 60 Hz │
 └──────────────────────────────────────────────────────────────────────────────┘
        │ (packets, queue times, lanes)
        ▼
 ┌─ LINK (Rust, netlab2::link) ─────────────────────────────────────────────────┐
 │ recorded: each packet arrives when the live one did (calibration)          │
 │ simulated: seeded WebTransport/QUIC model, netemProfiles.json profiles      │
 └──────────────────────────────────────────────────────────────────────────────┘
        │ lab.vltape (VLCTAPE2, the live client's own tape format)
        ▼
 ┌─ CLIENT STAGE (Node, client/netlab/v2/clientStage.mts) ──────────────────────┐
 │ cityTape.decodeCityTape → cityReplay.createReplayPlayer (routeInboundPacket, │
 │ NetcodeClient via replayWorld, CityClient) with the WASM clock_sync.rs clock │
 │ per frame: getRenderTimeUs / getDynamicBodyRenderTimeUs / sample* /         │
 │ getInterpolatedDynamicBodyState, meteorPlacement.placeMeteor,               │
 │ CityClient.samplePresentation                                               │
 └──────────────────────────────────────────────────────────────────────────────┘
        │ displayed.bin (VLDISP01), presented.bin (VLPRES01)
        ▼
 ┌─ SCORER (Rust, netlab2::score + destruction::netlab::score) ─────────────────┐
 │ per class: error vs truth at render time and "now", staleness,              │
 │ extrapolation, artifact gates, clock back-steps, meteors, city chunks       │
 └──────────────────────────────────────────────────────────────────────────────┘
        ▼
 report.json / report.md per run; matrix.md, compare.md; calibration.md
```

## Production code at each stage

| Stage | Production code used (imported, not copied) | How |
|---|---|---|
| Snapshot selection, budget, quantisation, packet | `server/src/snapshot_builder.rs` `build_recipient_snapshot`, `server/src/protocol.rs` `encode_server_packet`, `shared` `make_net_player_state` / `make_net_dynamic_body_state` | The per-recipient body of `MatchState::broadcast_snapshot` was moved into `snapshot_builder.rs` unchanged; the live server calls it, and the lab compiles the same file with `#[path]`. |
| City stream | `vibe_land_destruction::encoder::ChunkStreamEncoder` (all calls), `wire` | Crate dependency; state resumed with `from_checkpoint`. |
| Capture formats | `session_capture.rs`, `send_log.rs` readers | Compiled in with `#[path]`. |
| Client decode, routing | `client/src/net/inbound.ts` `routeInboundPacket`, `protocol.ts` decoders | Through `cityReplay.ts`. |
| Client state, clock, interpolation | `netcodeClient.ts`, `interpolation.ts` (`ServerClockEstimator`, `RenderClock`, interpolators), WASM `WasmClockSync` (`netcode/src/clock_sync.rs`) | Dynamic import from `--client-root`; the WASM class is registered exactly as `sharedPhysics.ts` does. The TypeScript fallback clock is never used, and the stage checks it isn't (`usesWasmClock`). |
| City client | `cityClient.ts` | Through `cityReplay.ts`. |
| Meteors | `vfx/meteorPlacement.ts` `placeMeteor`, `vfx/meteorFlights.ts` | Called per frame the way `MeteorLayer` calls them. |

`--client-root <dir>` points the client stage at another checkout's `client/`
(which needs its own `npm run build:wasm`). The stage checks that its WASM
build is newer than every `netcode/` and `shared/` source it was built from,
and refuses a stale build. That is how a before/after comparison measures
exactly the client in each tree.

## Seams: where the lab substitutes something

Every substitution is listed here, with the reason it is faithful and the
measurement that bounds it.

| # | Seam | Why it is faithful | Bound (measured) |
|---|---|---|---|
| S1 | The physics tick is replaced by `world.bin`. | It is recorded at the end of the tick. Nothing between `broadcast_snapshot` and the end of the tick touches the arena (roster, pings and stats only). | 4,446/4,446 snapshots byte-identical (rec1). |
| S2 | Recipient inputs are replayed from `snapshot-inputs.jsonl`: client-to-server feedback (acked input seq), support state, melee flag and wall stamp. | They are the builder's non-world arguments, recorded at the call. | Included in S1's byte match. |
| S3 | A capture starts mid-match. The snapshot interest memory comes from `snapshot-baseline.json` and the encoder from `encoder-checkpoint`. | These are the exact state at the first captured tick (see below). | City: 1,204/1,204 packets byte-identical. Negative control: without the baseline, the fixture test diverges. |
| S4 | The city call sequence is mirrored: ingest, topology, baseline, hash, then `encode_send` / `client_datagrams`, with cameras in `cameras.jsonl` order and bootstraps at the ticks the send log shows. | This is only the order of calls. Every byte comes from the encoder. The observer pipeline (`VIBE_CITY_OBSERVER_PIPELINE`, Blast backend only) is not modelled. | 100% city bytes (rec1). |
| S5 | Non-netcode packets (welcome, roster, body metadata, shots, match stats, meteor launches, pings, energy, batteries) pass through: recorded bytes at the recorded queue time. Packets from before the capture opened are sent at their arrival time minus the lane's median latency. | They are not optimisation targets, and their bytes and times are what the server produced. | Joined 10,207/10,207 by CRC32 and length (rec1). |
| S6 | Client-to-server feedback is open loop. Resyncs, repairs and bootstraps happen at the recorded ticks; acks come from S2. `--knob lab.recorded_repairs=0` withholds the recorded structure repairs, so the client's own counters show whether its ledger stays in sync without them. | On a reliable stream the client asks for nothing new: the client stage reports `nacksSent` = `resyncRequestsSent` = 0 on every profile. | Counted in `client-stats.json` and the report's `city sync` line. |
| S7 | Packet timing inside a tick comes from `ticks.jsonl` phases: city at the end of `tick_city`, snapshot after it, bootstraps at the tick end. `--pace ideal` puts ticks exactly 1/60 s apart, with no server slowdown. | The recorded pace is the server's real timeline. Ideal pacing isolates netcode from server runtime. | Loopback lane latency p50 0.6 ms matches the live send-to-arrive p50 of 0.15–0.8 ms. |
| S8 | **Client clock call schedule.** The lab reads the render clocks once per recorded frame, at its recorded time (the live clock probe's instant). The live page also reads them at other instants within the frame. Since the clock-fix change the server clock's output and the render clocks' delay slew depend on the snapshots and the local time only, not on when or how often they are read (`clock_sync.rs`, unit tests at 60 Hz, 240 Hz and arrival-only reads); before it the output was path dependent (its slew and hold clamps acted per call). | Exact for a client with the clock-fix change; for older clients exact whenever the server keeps pace. | rec1 (older client, recorded with it): clock offset vs live last 10 s p99 18 µs; whole run p50 135 µs, p99 8.9 ms, max 15.8 ms, all in the first 20 s (server stalls up to 608 ms). |
| S9 | The client stage replays through `createReplayPlayer` (the /cityreplay page's player), not the WebTransport classes. `performance.now()` is the tape clock on the page origin, and each packet is handled at its arrival time. | Same `routeInboundPacket`, decoders and client objects. The transports only add sockets. | Lab vs the same code on the recorded tape: 0.000 m (rec1). |
| S10 | Renderers are not imported. The lab replicates two glue rules: `DynamicBodiesRenderer` skips meteor bodies, and `MeteorLayer`'s call into `placeMeteor`. The city layer's distance-based sample stride is not applied, because the stride lands on the same pose. | Positions are what the renderers are handed. | Lab vs live renderer samples. rec1: bodies p50 0.000 m, p99 0.53 m; vehicles p99 1.6 cm. Bench c0: bodies p99 5.7 cm, players 1.3 cm, vehicles 2.8 mm. |
| S11 | The recording player is spectated. With no inputs there is no prediction. | Reported as `self_spectated` and excluded from conclusions. | – |
| S12 | The server capture clock is mapped to the tape clock with the pairing clock samples (NTP midpoint, median). | Loopback round trip is about 2 ms. | Spread 1.1–4.7 ms; lane latency p50 0.6 ms. |
| S13 | The link model is simulated (below). | It follows quinn 0.11 as configured (see the list below). Not validated against netem yet (limits). | – |
| S14 | The client starts cold at the tape's first city bootstrap. The live client had the session's history. | A newly joined client does the same. | Included in S8's early windows. |

### The mid-match start: decision

Session captures open whenever a client asks, long after tick 0. Before this
change the lab could not resume from them: the city encoder's ledger, per-body
classifiers, baseline cadence, topology sequence and every client's sequence
and interest state were unknown, and so was the snapshot selection's
per-recipient memory. There were two options: bootstrap the lab the way a
newly joined client is bootstrapped, or record the state. Only recording the
state reproduces the live bytes, so the capture now writes it:

- `encoder-checkpoint.json.zst`: `ChunkStreamEncoder::checkpoint()` (new; serde
  on the encoder's state types), written by `feed_encoder` immediately before
  the first captured tick is pushed. It is one clone per capture on the tick
  thread; serialisation runs on the writer thread.
- `snapshot-baseline.json`: each connected player's `RecipientInterest` and
  the handle tables, written when the capture opens.
- `snapshot-inputs.jsonl`: per snapshot tick, through the tick writer's
  channel. It never blocks; drops are counted.

Captures made before this change still load. The lab recovers acks from the
tape, assumes no support, starts the encoder fresh, and marks every
consequence in `warnings` (the "legacy" row below).

## The link model

- **Recorded:** each packet takes the live packet's fate and arrival time.
  A lab packet maps to the live one with the same tick, kind and ordinal.
- **Simulated:** this models the production transport (`outbound.rs` +
  wtransport/quinn 0.11 as the server configures it).
  - **Lanes:** two, as `wants_unreliable_delivery` assigns them. Snapshots,
    city chunks and pings go on datagrams; everything else goes on the
    ordered reliable stream.
  - **Sender:** one QUIC sender, paced at the bottleneck rate (the ideal of
    the BBR controller the server selects). Queues build at the sender, where
    quinn keeps them, not in the network.
  - **Datagrams first:** within the sender, datagrams go before stream data;
    quinn writes DATAGRAM frames before STREAM frames.
  - **Datagram buffer:** 1 MiB, dropping the oldest when full (quinn's
    default buffer, drop-oldest send).
  - **Oversize:** a datagram over `maxDatagramBytes` (default 1160) is refused.
    A snapshot is then dropped (the strict rule); any other kind falls back to
    the stream (`classify_outbound_delivery`).
  - **Stream:** stream bytes travel in 1140-byte packets. A lost packet is
    re-sent after RTT × 9/8 + jitter (QUIC's time threshold; datagrams at
    60 Hz keep ACKs flowing), ahead of new data. A frame is delivered only
    when it and every earlier byte have arrived; the time spent waiting is
    reported as head-of-line (HOL) blocking.
  - **Path:** `delayMs` one way, plus uniform jitter of ±`jitterMs`.
    `lossPct` Bernoulli loss or a `gemodelPct` Gilbert-Elliott burst model,
    and `reorderPct` stragglers. `rateMbit` sets the bottleneck.
  - **Overflow:** a reliable backlog above quinn's 10 MB send window is
    reported (`send_window_overflows`). Production would fill the 256-deep
    outbound queue there and close the connection.
  - **Randomness:** a seeded splitmix64 RNG. The same seed gives the same
    bytes; `lab.vltape` is bit-identical across runs.
- **No link feedback into the encoders:** production has none. The snapshot
  budget (1100 B) and the city ceiling (10.4 kB per send) are fixed. The only
  coupling is the outbound queue: a full datagram queue drops, and a full
  reliable queue closes the connection.

Profiles are read from `client/netlab/netemProfiles.json`, the live netlab's
table: `loopback`, `lan`, `cable`, `wifi-good`, `wifi-bad`, `lossy-wifi`,
`lte`, `poor-mobile`, `congested`, `loss-burst`, `bw-capped`. `netlab2
profiles` lists them. `loopback`, `lan`, `cable`, `poor-mobile`, `lossy-wifi`
and `bw-capped` were added for Netlab v2, using only the fields the live
netlab already reads.

## Knobs (`--knob k=v`, comma-separated)

These are the knobs production actually has, with their production defaults:

| Knob | Production | Code |
|---|---|---|
| `snapshot.budget_bytes` | 1100 | `STRICT_SNAPSHOT_DATAGRAM_TARGET_BYTES` |
| `snapshot.interval_ticks` | 1 (60 Hz) | `physics.snapshot_hz()` |
| `snapshot.player_aoi_m`, `snapshot.vehicle_aoi_m`, `snapshot.dynamic_aoi_m`, `snapshot.dynamic_aoi_exit_m` | 80 each | `shared` constants |
| `snapshot.cold_dynamic_refresh_ticks` / `snapshot.cold_vehicle_refresh_ticks` | 60 / 30 | resting-entity refresh |
| `snapshot.hot_speed_mps`, `snapshot.hot_near_m` | 0.05, 12 | hot/cold split |
| `city.send_hz` | 30 | `CITY_CHUNK_STREAM_HZ` |
| `city.ceiling_bytes` | 10400 (0 = none) | `CITY_CLIENT_CEILING_BYTES_PER_SEND` |
| `city.error_budget_px` | 2.0 | encoder |
| `city.burst_capacity_sends`, `city.burst_max_multiple` | 0, 4 | encoder |
| `city.baseline_interval_ticks` | encoder default | baselines |
| `city.proximity_m` | 120 | interest |
| `city.max_eval` | 1200 | `VIBE_CITY_MAX_EVAL` |
| `city.rest_stride` | 8 | `EncoderConfig::rest_eval_stride` |
| `city.linear_motion_mps`, `city.angular_motion_rps` | 0.05, 0.08 | priority motion thresholds |
| `city.max_moving_age_ticks`, `city.contact_target_age_ticks` | 30, 5 | priority age targets |
| `city.ballistic_free_fall` | 1 (0 in older captures) | ballistic record mode only in measured free fall |
| `city.client_model` | 1 (0 in older captures) | judge against the client's extrapolated pose; rest corrections |
| `city.baseline_lag_ticks` | 110 (0 in older captures) | deltas stay on the previous baseline this long |
| `city.baseline_skip_quiescent` | 1 (0 in older captures) | quiescent bodies left out of baselines |

`city.baseline_interval_ticks` is 120 on new servers (60 before). A knob
applies over the capture's encoder checkpoint, which carries the config the
live encoder ran with, so a bundle recorded before these changes replays the
old behaviour unless the knobs turn it on. The tuning round that added them
is in [netcode-tuning.md](netcode-tuning.md).

One lab-only knob, not a production setting: `lab.recorded_repairs` (default
1). With 0 the structure repairs the live server sent this client
(`PKT_CITY_STRUCTURE_BOOTSTRAP`) are not replayed (seam S6), and the stream
summary counts them as withheld.

## Metrics

- **Classes.** Bodies are classified from truth kinematics at the render tick:
  - `resting`: under 0.05 m/s and 0.05 rad/s.
  - `about_to_move`: resting now, moving faster than 0.5 m/s within 0.5 s.
  - `fast_projectile`: faster than 20 m/s.
  - `ballistic`: acceleration within 3 m/s² of g.
  - `colliding`: anything else that moves.
  - `meteor_body_after_flight`: a meteor's body drawn as a plain ball after
    its flight is forgotten.
  - `no_truth`: not in truth at that tick.
  - Also `player`, `vehicle`, `self_spectated`.
  - Meteors as `MeteorLayer` places them, by source (arc, body, hold).
  - City chunks, scored by `destruction::netlab::score` (chunk-weighted,
    lever-arm error, perceptibility; see
    [destruction-codec docs](city-v3-protocol-2026-08.md)).
- **Per class:**
  - Error vs truth at the render time (interpolation and extrapolation).
  - Error vs truth "now" (the tick the server had completed at that wall
    time: what a viewer comparing screens sees).
  - Rotation error.
  - Age of the newest sample.
  - Extrapolated share: drawn past the newest sample while actually moving.
  - Gates: freeze, reversal, snap, teleport, overshoot, and artifacts per
    minute.
- **Clock:**
  - Render-time back-steps (count, total, max) for players and bodies.
  - Interpolation delays.
  - How far the body render time is behind the server.
  - Clock lag (`clock.lag_ms`): the tick the server had completed at each
    frame's probe minus the client's server-time estimate there, i.e. the
    clock's own share of "behind the server", without the render delay.
- **Stale draws** (`stale`): plain bodies drawn after truth stopped having
  them or while they are outside the recipient's interest radius
  (`DYNAMIC_BODY_AOI_EXIT_RADIUS_M`, production 80 m) at the render tick,
  and how long after they left (render clock, split by the truth speed when
  they left: over 2 m/s or not); and the same for meteors drawn from their
  body. Bodies drawn before their first tick in truth (a render time behind
  a new body's first snapshot) are not stale and are not counted.
- **Bytes:** per lane and per kind: packets, bytes, kbit/s delivered, fates
  (lost, sender-dropped, strict-drop, fallback), queue-to-arrival latency, HOL.
- **Selection totals:** what the budget left out (from the builder and the
  encoder's summaries).
- **City sync** (`city_sync`, from the city client's counters): repairs the
  client asked for (`resyncRequestsSent`: each one is a structure or full
  bootstrap from a live server), ledger-hash checks and mismatches, settle
  rejects, settles applied after the stream went silent, topology sequence
  gaps, NACKs, and the repairs it applied. On a lossless link repairs asked
  must be 0 (item 6 of the 2026-09-24 session analysis); run it with
  `lab.recorded_repairs=0` so the recorded repairs do not mask a divergence.

## Calibration (the proxy check)

`netlab2 calibrate --bundle <bundle>` uses the recorded link and pace, and
runs the client stage twice: over the lab's tape and over the recorded tape.
It exits 1 on failure.

- **(a) Bytes.** Every lab-generated packet is compared with the live send-log
  record for the same tick, kind and ordinal (CRC32 and length), per kind.
- **(b) Client.**
  - Clock offset and both delays against the live per-frame clock probe:
    - converged over the last 10 s: p99 ≤ 200 µs;
    - whole run: p99 ≤ 20 ms, the bound for S8;
    - delays: p99 ≤ 0.5 ms.
  - Lab drawn positions against the same client on the recorded tape:
    p99 ≤ 1 cm.
  - Informational: lab drawn positions against the live renderers
    (`live-samples.json` / `client-<n>-drawn.jsonl`).
- **(c) Divergences.** Each one is named in `calibration.md`.

Calibration checks the lab against a live recording, so it runs the client
that made the recording (`--client-root` at that tree). A client whose clock
differs from the recording's fails (b)'s convergence check by construction:
the clock-fix client on rec1 is 2.9 ms p99 from the live probe in the last
10 s (the old clock's output), with the lab still 0.000 m from the same
client on the recorded tape. Calibrate a changed clock on a bundle recorded
with it.

**rec1**: exact capture, 75 s loopback, PhysX GPU, this tree's server and
client (`client/netlab/v2/record-bundle.sh`). The session has cannonballs, a
meteor, a demolition and a drive. PASS.

| Check | Result |
|---|---|
| (a) snapshot_v2 | 4446/4446 byte-identical |
| (a) city_chunks / topology / baseline / topo_hash | 898/898, 195/195, 74/74, 37/37 |
| (b) clock offset vs live, p99 per 10 s window | 11.7 ms, 12.5, 1.5, 1.8, 1.2, 0.33, 0.027, 0.018 ms |
| (b) delays vs live, p99 (frames with no server stall in the preceding 3 s) | players 0.27 ms, bodies 0.10 ms |
| (b) lab vs same client on recorded tape | 0.000 m, every kind |
| lab vs live renderer (727 samples), p50 / p99 | bodies 0.000 / 0.53 m, vehicles 0.000 / 0.016 m |

**Legacy captures** (made before this change):

- **paired-capture run1** (old server, old client). 4,402 of 5,658
  snapshots are identical but for the wall-clock trailer, which that server
  predates. All 1,256 others are explained by inputs it did not record:
  1,172 differ in the support state and 84 in counts caused by the empty
  interest baseline.
  - City topology and hash messages: 100%. Chunks and baselines: 0%, because
    the fresh encoder has different per-client sequence state.
  - This is the evidence that the refactored `build_recipient_snapshot` is
    byte-identical to the pre-refactor `broadcast_snapshot` on live data. The
    server crate's 115 tests also pass, none of them modified.
- **city-bench netcode-clock quick-3c c0** (the 0eb6f3fd client, a legacy
  server capture). Clock offset vs live: p50 0.5 ms, p99 3.2 ms. Lab vs live
  renderer: bodies p99 5.7 cm, players 1.3 cm, vehicles 2.8 mm.

## First results: rec1, all links, production knobs, recorded pace

| Link | kbit/s down | Datagrams lost | Retransmits | Reliable HOL p99 ms | Bodies drawn behind server p50 ms | Ballistic err@now p50 m | Colliding err@now p50 m | City lever p99 m (perceptible) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| recorded | 217 | 0 | 0 | 0 | 13.8 | 0.43 | 0.44 | 0.248 (0.02%) |
| lan | 217 | 0 | 0 | 0.2 | 13.0 | 0.39 | 0.45 | 0.248 (0.02%) |
| cable | 217 | 3 | 6 | 2.7 | 24.5 | 0.52 | 0.57 | 0.248 (0.02%) |
| wifi-good | 216 | 21 | 28 | 31.5 | 79.5 | 1.54 | 1.53 | 0.265 (0.02%) |
| lossy-wifi | 214 | 177 | 225 | 69.6 | 173.4 | 2.41 | 2.56 | 0.366 (0.06%) |
| lte | 214 | 152 | 188 | 286 | 332.7 | 4.80 | 4.76 | 0.474 (0.06%) |
| poor-mobile | 214 | 169 | 151 | 533 | 403.2 | 5.99 | 5.58 | 0.444 (0.08%) |
| bw-capped (0.5 Mbit/s) | 217 | 0 | 0 | 0 | 91.6 | 7.27 | 7.95 | 0.557 (0.05%) |

Error at render time (interpolation fidelity) stays at 2 mm p50 on every
link. The cost of a worse link is latency: the client draws further behind
the server. There are no clock back-steps on any link, and 0 artifacts/min
on the physical-body classes.

`--pace ideal` removes the server's own slowdowns (the recorded link is
refused there, because its arrival times belong to the recorded pace). On
LAN, the body delay goes from 19.5 to 17.1 ms and "behind server" from 13.0 to
9.0 ms: that difference is what server runtime, not netcode, costs on this
capture. LTE and poor-mobile barely move (337.7 and 405.5 ms), because there
the link dominates.

Knob trade-offs (LTE):

| Knob | kbit/s | Snapshot kbit/s | Behind server p50 ms | Ballistic err@now p50 |
|---|---:|---:|---:|---:|
| production | 214 | 41 | 333 | 4.80 m |
| `snapshot.interval_ticks=2` (30 Hz) | 193 | 21 | 352 | 5.37 m |
| `snapshot.interval_ticks=3` (20 Hz) | 187 | 14 | 329 | 4.91 m |
| `city.send_hz=15` | 196 | 41 | 337 | 4.84 m |
| `snapshot.dynamic_aoi_m=40` | 212 | 39 | 333 | 9.19 m (err@render p50 4.1 m, 59% extrapolated) |

`snapshot.budget_bytes=600` and `city.ceiling_bytes` of 5k or 20k change
nothing on rec1: one player and a light scene never reach either limit. A
multi-client city-bench capture is needed to price truncation
(`client/netlab/v2/record-bench.sh`).

Before/after on the same frozen truth (`netlab2 compare`): the pre-0eb6f3fd
client (1a35ecf8 tree, `--client-root`) against the 0eb6f3fd client.

| Link | Metric | Pre-clock client | 0eb6f3fd client |
|---|---|---:|---:|
| recorded | render-time back-steps | 10 | 0 |
| recorded | body delay p50 | 5 ms | 19.8 ms |
| lte | back-steps | 16 | 0 |
| lte | colliding artifacts/min | 34.3 | 0 |
| lte | colliding extrapolated | 68% | 0% |
| lte | bodies behind server p50 | 74 ms | 333 ms |
| lte | ballistic err@now p50 | 1.10 m | 4.80 m |
| poor-mobile | behind server p50 | 133 ms | 403 ms |

## Findings (measured in the lab, not yet confirmed live)

All three are fixed (items 9-11 of the
[2026-09-24 session analysis](mac-metal-session-analysis-2026-09-24.md));
the before/after on rec1 is below them.

1. **The rate-aware clock lags much more than the link delay under jitter,
   and more the more often it is polled.** These are lab runs on bench-c0
   through the WASM clock; the polling decomposition uses its TypeScript copy,
   which `serverClockModel.test.ts` keeps equal to it. Lag is truth minus the
   clock's server-time output.

   | One-way link | Polled at frames (as live) | Polled at arrivals |
   |---|---:|---:|
   | 90 ms, no jitter | 84 ms | 83 ms |
   | 90 ms ± 10 | 141 ms | 74 ms |
   | 90 ms ± 35 | 276 ms | 108 ms |
   | 25 ms ± 8 | 52 ms | 11 ms |

   The output's hold and slew are applied per call (`serverClockModel.ts`
   `serverNowUs`), so the lag grows with both jitter and polling frequency.
   This is the "behind server" column above, and the cost of the 0eb6f3fd
   client's zero back-steps on WAN profiles. It is a handoff to the clock work.
   It is also the mechanism behind seam S8.
2. **Retired and out-of-range cannonballs linger.** Bodies absent from truth
   (`no_truth`) and `fast_projectile` bodies are drawn for up to 4 s at their
   last streamed pose (`DYNAMIC_BODY_STALE_TICKS` = 240): p50 30 m from
   truth, 66% extrapolated. The live renderer samples of rec1 confirm it: 60
   of 759 drawn-body samples are bodies the server no longer has, and 403 are
   more than 5 m from truth-now.
3. **A meteor's body keeps rolling out of range after impact.** The meteor
   layer holds it where last seen, 43 m p99 from truth. The body then
   reappears as a plain ball after the flight is forgotten
   (`meteor_body_after_flight`, 138 m p50).

**After the fix** (rec1, recorded pace, the b0502db9 client via
`--client-root` against the clock-fix tree; `netlab2 compare`). The jitter
probes are `--profiles` entries `d90` (90 ms), `d90j10`, `d90j35` and
`d25j8` (one-way delay ± uniform jitter, no loss):

| Link | Client | Clock lag p50 / p99 ms | Behind server p50 ms | Stale body frames (max ms after it left) | Meteor err p99 m | Meteor body as a ball, frames |
|---|---|---:|---:|---:|---:|---:|
| loopback | b0502db9 | -7.5 / 45.3 | 12.4 | 6,017 (3,983) | 43.28 | 366 |
| loopback | clock-fix | -5.9 / 36.5 | 13.9 | 321 (233) | 0.18 | 0 |
| lte | b0502db9 | 274.4 / 309.7 | 332.7 | 5,673 (3,767) | 44.28 | 369 |
| lte | clock-fix | 87.9 / 125.6 | 146.7 | 235 (200) | 0.18 | 0 |
| d90 | b0502db9 | 82.1 / 136.7 | 101.9 | 6,013 (3,983) | 43.33 | 367 |
| d90 | clock-fix | 83.7 / 127.0 | 103.4 | 304 (233) | 0.18 | 0 |
| d90j35 | b0502db9 | 275.0 / 306.5 | 333.8 | 5,683 (3,783) | 42.54 | 370 |
| d90j35 | clock-fix | 87.9 / 118.9 | 146.6 | 230 (200) | 0.18 | 0 |

Read-rate sweep, d90j35 clock lag p50 at `--frames 60` / `120` / recorded:
190.1 / 278.1 / 275.0 ms before, 89.2 / 87.9 / 87.9 ms after. Back-steps: 0
on every run.

## How to run

```bash
# once per tree: the lab binary (no GPU features) and the client WASM
CARGO_TARGET_DIR=/Users/glavin/Development/vibe-land/target/netlab-v2/cargo \
  cargo build --release -p web-fps-server --bin netlab2
(cd client && CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/clang \
  AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/llvm-ar npm run build:wasm)
N=/Users/glavin/Development/vibe-land/target/netlab-v2/cargo/release/netlab2

$N calibrate --bundle <bundle> --out <dir>             # the proxy check; exit 1 = fail
$N run --bundle <bundle> --out <dir> --link lte --seed 1 [--pace ideal] [--knob snapshot.interval_ticks=2]
$N matrix --bundle <bundle> --out <dir> --links recorded,lan,lte,poor-mobile \
   --knob-sets 'production:;snap-30Hz:snapshot.interval_ticks=2;city-15Hz:city.send_hz=15'
$N matrix ... --client-root /path/to/other/tree/client  # same frozen truth, other client
$N compare --a <runOrMatrixDir> --b <runOrMatrixDir> --out <dir>
$N run ... --link d90j35 --profiles <file>              # a profile table other than netemProfiles.json
$N profiles

# a new exact capture (GPU lock; ports 4501/4502/3503); needs the server built with
# --features native-destruction into the same CARGO_TARGET_DIR
client/netlab/v2/record-bundle.sh <outDir> [seconds]      # record.mjs session + live-samples.json
client/netlab/v2/record-bench.sh <outDir> [scenario] [n]  # city-bench driver, n clients
```

A run directory holds:

- `lab.vltape`: what the client received.
- `stream.json`: bytes, fates and selection totals.
- `displayed.bin` and `presented.bin`.
- `client-stats.json`: WASM check, nacks, city client stats.
- `report.json` / `report.md`.
- `calibration.*`, when calibrating.

`NETLAB2_CLIENT_ARGS` passes experiments to the client stage (`--frame-start
after|cpu`: where in the frame the draw happens; `--frames 60|120`: a fixed
cadence instead of the recorded frames).

## Known limits

- **Wire v3 (debris codec) is not supported.** The encoder checkpoint does
  not cover the v3 live lanes, and the client stage refuses v3 tapes. Every
  city session so far is v2.
- **One scored client per bundle.** Other players' encoder state is driven
  (cameras and joins), but only the bundle's player is regenerated and
  scored. Run each client's bundle in turn.
- **V1 (non-strict) snapshots.** The builder carries V1, but the lab has only
  been calibrated on V2. PhysX GPU matches require V2.
- **Client-to-server feedback is open loop (S6).** A link bad enough to make
  the client NACK or resync would not get the server's answers. The client
  stage counts both, and they were 0 in every run here.
- **The congestion controller is the paced ideal.** There is no slow start or
  cwnd dynamics, and it has not yet been validated against the live netlab's
  netem runs on the same profile. Jitter is iid (netem's default), which
  over-reorders datagrams compared with real LTE.
- **Seams S8 and S14:** the client clock diverges during server stalls and
  from a cold start by up to about 16 ms, measured.
- **Budgets are not stressed by rec1.** A multi-client, high-destruction exact
  capture is needed to price truncation.
- **The capture additions are production changes.** Recording them costs one
  encoder clone at capture start, and per snapshot tick one small JSON line
  per recipient (off the tick thread).
- **Node 22.1 has no zstd,** so `presented.bin` is uncompressed there. The
  reader accepts either.
