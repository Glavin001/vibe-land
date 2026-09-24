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
 │ per frame: getRenderTimeUs / getDynamicBodyRenderTimeUs / sample*, then the │
 │ renderers' own pose steps: netEntityPoses (players, bodies, vehicles),      │
 │ meteorPlacement.placeMeteorInFrame, cityPoseStore.advanceCityPoses (the     │
 │ city layer's chunk records and body poses, as the vertex shader reads them) │
 └──────────────────────────────────────────────────────────────────────────────┘
        │ displayed.bin (VLDISP01), drawn-chunks.bin (VLCHNK01), presented.bin (VLPRES01)
        ▼
 ┌─ SCORER (Rust, netlab2::score + destruction::netlab::score) ─────────────────┐
 │ ALL DRAWS (headline): every player, vehicle, body, meteor and city chunk     │
 │ drawn, vs truth at render time and "now"; missing / extra / wrong identity  │
 │ per class: staleness, extrapolation, artifact gates, clock back-steps,      │
 │ meteors, city bodies (lever arm, perceptibility)                            │
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
| Meteors | `vfx/meteorPlacement.ts` `placeMeteorInFrame` (→ `placeMeteor`), `vfx/meteorFlights.ts` | The call `MeteorLayer` makes per flight per frame, shared. |
| Players, bodies, vehicles | `scene/netEntityPoses.ts` `resolveRemotePlayerDraw`, `resolveDynamicBodyDraws`, `remoteVehicleDrawPose` | The pose step of `RemotePlayersRenderer`, `DynamicBodiesRenderer` and GameWorld's vehicle callback, extracted; the renderers call them and keep only mesh work. |
| City chunks | `city/cityPoseStore.ts` `CityPoseStore`, `initCityPoses`, `advanceCityPoses` | The chunk-record and body-pose tables the vertex shader composes (`citySlotMesh.ts` `CityGpuPoses` extends the store with its textures) and the per-frame step `CityChunksLayer` runs; the lab runs the same step and records what changed in the tables. |

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
| S6 | Client-to-server feedback is open loop. Resyncs, repairs and bootstraps happen at the recorded ticks; acks come from S2. `--knob lab.recorded_repairs=0` withholds the recorded structure repairs, so the client's own counters show whether its ledger stays in sync without them. | On a reliable stream the client asks for nothing new: the client stage reports `nacksSent` = `resyncRequestsSent` = 0 on every profile (rec1). A client that asks for repairs live gets them replayed at the recorded ticks: the 0a7d6ae5 systematic bundle's client asked for 21, and the lab client asks for the same 21 on the recorded link. | Counted in `client-stats.json`, the report's `city sync` line and the all-draws headline. |
| S7 | Packet timing inside a tick comes from `ticks.jsonl` phases: city at the end of `tick_city`, snapshot after it, bootstraps at the tick end. `--pace ideal` puts ticks exactly 1/60 s apart, with no server slowdown. | The recorded pace is the server's real timeline. Ideal pacing isolates netcode from server runtime. | Loopback lane latency p50 0.6 ms matches the live send-to-arrive p50 of 0.15–0.8 ms. |
| S8 | **Client clock call schedule.** The lab reads the render clocks once per recorded frame, at its recorded time (the live clock probe's instant). The live page also reads them at other instants within the frame. Since the clock-fix change the server clock's output and the render clocks' delay slew depend on the snapshots and the local time only, not on when or how often they are read (`clock_sync.rs`, unit tests at 60 Hz, 240 Hz and arrival-only reads); before it the output was path dependent (its slew and hold clamps acted per call). | Exact for a client with the clock-fix change; for older clients exact whenever the server keeps pace. | rec1 (older client, recorded with it): clock offset vs live last 10 s p99 18 µs; whole run p50 135 µs, p99 8.9 ms, max 15.8 ms, all in the first 20 s (server stalls up to 608 ms). |
| S9 | The client stage replays through `createReplayPlayer` (the /cityreplay page's player), not the WebTransport classes. `performance.now()` is the tape clock on the page origin, and each packet is handled at its arrival time. | Same `routeInboundPacket`, decoders and client objects. The transports only add sockets. | Lab vs the same code on the recorded tape: 0.000 m (rec1). |
| S10 | Renderers (three.js meshes) are not imported; their **pose steps are**: `netEntityPoses.ts` (which remote players, bodies and vehicles are drawn and where), `meteorPlacement.ts` `placeMeteorInFrame`, and `cityPoseStore.ts` `advanceCityPoses` (the city layer's chunk records and body poses, composed as the vertex shader composes them, hide rule included). Three things remain lab-side: (1) the dynamic-body `rendered` callback is `getInterpolatedDynamicBodyState`, the branch `MultiplayerGameRuntime.getRenderedDynamicBodyState` takes for any body the local player has not just touched (S11); (2) every draw is evaluated at the frame's time, where the live renderers each read `performance.now()` at their own instant in the frame; (3) the city layer's distance stride (`renderScheduling.ts`, 1-8 frames by camera distance) is not applied: it is a render-rate choice, and a deferred body is written later at that later frame's ledger pose, so it changes when a distant chunk is redrawn, never where. | Every drawn pose comes from the same functions the renderers call. | Lab vs live renderer samples, every class (calibration (d)), d1342419 systematic bundle c0 / c1, p99: players 1.4 / 1.3 cm, vehicles 0.2 / 0.3 cm, bodies 6.3 / 6.1 cm, meteors 10.3 / 9.3 cm (fast movers: (2) at ~50 m/s), intact chunks 0.00 mm, debris chunks 2.8 / 3.5 cm; chunk body keys agree on 99.9995% / 100% (6 of 1.29 M: one re-parent a frame apart, poses 7 mm apart), drawn / not drawn on 99.95%. |
| S11 | The recording player is replayed without its inputs, so without local prediction. The own avatar (camera / debug capsule at `client.getPosition()`, predicted) and the vehicle it drives (`localVehicleVisualPose`: prediction + `vehicleLocalMeshPose.ts` smoothing) are drawn from prediction live; the lab draws them from snapshots. So are bodies it has just touched (the local proxy, `hasRecentDynamicBodyInteraction`). | Scored as classes `own_avatar` and `vehicle_driven`, **left out of the headline `overall`**; body-proxy frames are not identified. A spectator client's bundle (c1 of the systematic bundle) has none of these. | – |
| S12 | The server capture clock is mapped to the tape clock with the pairing clock samples (NTP midpoint, median). | Loopback round trip is about 2 ms. | Spread 1.1–4.7 ms; lane latency p50 0.6 ms. |
| S13 | The link model is simulated (below). | It follows quinn 0.11 as configured (see the list below). Where the bottleneck queue forms is a profile choice: at the sender (every older profile, the paced ideal) or in the network (`bottleneckQueueMs`, the `*-nq` profiles), which is what quinn 0.11's BBR measurably does. Not validated against kernel netem (limits). | Network-queue model against real quinn 0.11 + BBR through a userspace 1 Mbit/s relay with a 200 ms drop-tail queue (`quic_rate_tests` in `server/src/main.rs`, same offered traffic, from 3 s on): without rate adaptation 44.3% of datagrams delivered vs 44.8–44.9% (3 runs), one-way p50 204 vs 206.3–206.6 ms. Quinn's datagram buffer peaked at 95 B there: the sender-queue model does not describe quinn's BBR on a slow path (`link::tests::the_network_queue_model_matches_quinn_through_a_paced_relay`). |
| S14 | The client starts cold at the tape's first city bootstrap. The live client had the session's history. | A newly joined client does the same. | Included in S8's early windows. |
| S15 | **Link feedback to the server stage** (closed loop, city rate adaptation). At each of the scored client's city sends the stage feeds the link model every packet departed so far (lab and pass-through, in the final run's order), reads it (`LinkSim::signals`), and passes that to the production controller (`server/src/link_rate.rs`, compiled in by `#[path]`), whose plan sets that send's allowance or skips it. The signals are what production reads from quinn: datagram-buffer occupancy (`datagram_send_buffer_space`), UDP bytes sent, packets sent/lost and lost bytes (losses declared RTT × 9/8 + jitter after the send), smoothed RTT (7/8 EWMA of ACKed packets, the network queue included), and the bytes the server queued, all lanes and (since the city-latency round) the reliable lane's share. From those the controller estimates the reliable stream's unsent bytes (`reliable_backlog`); the model reports its own count beside it (`rate-trace.jsonl` `stream_backlog_bytes`). Not modelled: the server's own outbound queue and stream flow control, which production's estimate also sees (live, loopback: a waiting stream at joins made every link `Limited` until the estimate was barred from entering that state), cwnd (production does not read it), quinn's ACK delay, and RTT jitter (the model's RTT samples carry the queue, not the path jitter). The deliveries are still computed by the open-loop `simulate` over the final packet list. On the recorded link, and with `city.rate_adapt=0`, the loop is open (the static ceiling). | Reading the link never changes it (`link::tests::reading_the_link_changes_nothing_and_reports_the_sender`: deliveries identical with and without reads). The controller is the production code. | Closed-loop model vs real quinn, same relay run with adaptation, from 3 s on: 100% vs 100% delivered, one-way p50 28.4 vs 28.4–31.3 ms, p99 137 vs 81–117 ms, capacity estimate at the end 916 vs 780–930 kbit/s (3 runs). Fast links (loopback, lan, cable, lte, lossy-wifi): byte-identical to the open loop on both bundles (the controller never leaves `Free`). Sensitivity to late feedback (`lab.rate_stale_ms`): see [netcode-tuning.md](netcode-tuning.md#rate-adaptation). Reliable-backlog estimate vs the model's count, every constrained cell of the systematic and heavy bundles: estimate − truth p1 −0.3 to −1.1 kB, p50 0, p99 0, never over by more than 1.2 kB (the estimate errs low, as designed); it assumes 24 B of QUIC overhead per packet against the model's 32. |

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

## Every rigid body the client draws

What the client draws, where its final render pose is resolved, and how the
lab scores it. "Shared" means the lab calls the very function the renderer
calls (imported from `--client-root`); "replicated" means the lab has its own
copy of a rule. Everything drawn is scored at render time and against truth
"now" (position; rotation where it is visible), and counted as missing, extra
or wrong-identity (see [All draws](#all-draws-the-headline)).

| Kind | Client chain to the final render pose | Lab | Scored as | Gap |
|---|---|---|---|---|
| Remote players | `NetcodeClient.getRenderTimeUs` → `remoteInterpolator.sample(id, t)` → `netEntityPoses.resolveRemotePlayerDraw` (sample or latest; a driver is lifted onto its vehicle and hidden) → `RemotePlayersRenderer` root position + yaw | Shared | `player`: position, yaw; missing = in truth within `PLAYER_AOI_RADIUS_M` (80 m) of the recipient, not driving, not drawn | Dead players' ragdolls are local cosmetic physics (only the root is scored). |
| Own avatar | `client.getPosition()` (local prediction; thin-authoritative: `getLocalPlayerRenderTimeUs` samples) → camera / debug capsule | Not reproducible (no inputs): drawn from its snapshots | `own_avatar`, **not in `overall`** | Prediction is not replayed (S11); a spectator bundle has no avatar to predict. |
| Remote vehicles | `getRenderTimeUs` → `sampleRemoteVehicle` → `netEntityPoses.remoteVehicleDrawPose` (sample or latest) → `VehiclesRenderer` chassis | Shared | `vehicle`: position, rotation; missing within `VEHICLE_AOI_RADIUS_M`; wrong identity = drawn vehicle type ≠ truth | Wheels are derived visuals (suspension), not scored. |
| Driven vehicle | Prediction → `vehicleLocalMeshPose.updateLocalVehicleMeshPose` smoothing → `VehiclesRenderer` | Not reproducible: drawn from snapshots | `vehicle_driven`, **not in `overall`** | S11. |
| Dynamic spheres / boxes (cannonballs, props) | `getDynamicBodyRenderTimeUs` → `MultiplayerGameRuntime.getRenderedDynamicBodyState` (local proxy if just touched, else `getInterpolatedDynamicBodyState`: interpolated, else latest) → `netEntityPoses.resolveDynamicBodyDraws` (meteor bodies skipped) → `DynamicBodiesRenderer` | Shared, with the non-interaction branch of `getRenderedDynamicBodyState` | `body`: position; rotation for boxes only (a plain ball is a uniformly coloured sphere, and SnapshotV2 carries no sphere orientation); missing within `DYNAMIC_BODY_AOI_RADIUS_M`; extra = drawn, not in truth; wrong identity = drawn shape ≠ truth shape | Bodies the recording player touches (local proxy) are drawn from snapshots in the lab. |
| Meteors in flight and after impact | `meteorFlights` → `meteorPlacement.placeMeteorInFrame` (arc until contact, with the arc's tumble `arcTumble`; then the streamed body interpolated / ≤ 250 ms extrapolated, hidden once it leaves the stream; a rock never streamed is hidden one staleness window after its planned landing) → `MeteorLayer` rock | Shared | `meteor`: position; rotation only when drawn from the body (on the arc the rock spins for show); hidden = not drawn; missing = meteor body in interest drawn by neither layer | The body's orientation is not streamed (sphere): the client integrates the streamed spin from the launch orientation, so a body-drawn rock's rotation error vs truth is drift (p99 ~170°), real but cosmetic; its spin matches truth (item 15 of the session analysis). |
| City: intact structure chunks | Ledger support body (serial 0) pose ∘ chunk rest offset, written by `cityPoseStore.initCityPoses` / `advanceCityPoses` into the chunk-record and body-pose tables → vertex shader `citySlotMatrix` | Shared (tables), composed in Rust exactly as the shader does | `chunk_intact`, per chunk | – |
| City: live debris | `CityClient.samplePresentation` (presentation track at `render_tick - playout_delay`) → ledger island pose → `advanceCityPoses` body write (records rewritten when the ledger re-parents or rebases a chunk) → shader | Shared | `chunk_debris` (truth island moving at the presented tick) | The layer's distance stride is left out (S10). |
| City: settled rubble | Settle record → ledger pose → one final body write → shader | Shared | `chunk_rubble` (truth island settled at the presented tick) | – |
| City: support bodies | The support body itself is one pose per structure (kinematic, never moves); it is what every intact chunk rides | Shared | Through its chunks (`chunk_intact`); the body-level city scorer skips it | – |
| City chunks hidden below ground | Shader collapses any chunk composed below `CHUNK_HIDE_Y_M` (-4 m), or with no record | Shared rule | Not drawn: missing if truth has it above -4 m; truth below -4 m (sunk, or retired at the 5 m floor) is not expected drawn | – |
| Batteries | `BatteriesRenderer`, raycast to the ground | Not scored | – | Static pickups, not physics bodies, and not in `world.bin`. |
| Shot traces | `shotTraces.tsx` pooled lines from shot events | Not scored | – | Not rigid bodies. |
| Dust, weather, ragdolls, vehicle wheels | Local visual effects | Not scored | – | Not networked rigid bodies. |

## The link model

- **Recorded:** each packet takes the live packet's fate and arrival time.
  A lab packet maps to the live one with the same tick, kind and ordinal.
- **Simulated:** this models the production transport (`outbound.rs` +
  wtransport/quinn 0.11 as the server configures it).
  - **Lanes:** two, as `wants_unreliable_delivery` assigns them. Snapshots,
    city chunks and pings go on datagrams. City chunks include the
    record-less datagrams that carry topology copies. Everything else goes
    on the ordered reliable stream.
  - **Sender:** one QUIC sender. On a profile without `bottleneckQueueMs`
    it is paced at the bottleneck rate (the ideal of the BBR controller the
    server selects), so queues build at the sender. With
    `bottleneckQueueMs` (the `*-nq` profiles) the sender does not hold back
    and the bottleneck queues up to that many ms and drops the rest
    (drop-tail); the queue then shows up as RTT and loss. That is what quinn
    0.11's BBR does through a paced relay (measured, S13): its window grew
    from 360 kB to 1.2 MB over 8 s while the path dropped 55%, and its
    datagram buffer never held more than 95 B.
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
- **Link feedback into the city encoder (S15):** production adapts each
  client's city allowance and send cadence to its link
  (`server/src/link_rate.rs`, `VIBE_CITY_RATE_ADAPT`, on by default). On a
  simulated link the lab closes the same loop: the controller reads the link
  model at each of the scored client's sends. The snapshot budget (1100 B)
  is fixed, and the city ceiling (10.4 kB per send) is the controller's
  upper bound. The per-send trace is `rate-trace.jsonl` in the run
  directory and the totals are `stream.city_rate` in `stream.json`.

Profiles are read from `client/netlab/netemProfiles.json`, the live netlab's
table: `loopback`, `lan`, `cable`, `wifi-good`, `wifi-bad`, `lossy-wifi`,
`lte`, `poor-mobile`, `congested`, `loss-burst`, `bw-capped`. `netlab2
profiles` lists them. `loopback`, `lan`, `cable`, `poor-mobile`, `lossy-wifi`
and `bw-capped` were added for Netlab v2, using only the fields the live
netlab already reads. `cap-1mbit` (1 Mbit/s, 30 ms, no loss) and the
network-queue variants `cap-1mbit-nq`, `bw-capped-nq` and `poor-mobile-nq`
(200 ms bottleneck queue) were added for rate adaptation; `bottleneckQueueMs`
is read by Netlab v2 only.

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
| `city.rate_adapt` | 1 (`VIBE_CITY_RATE_ADAPT`) | per-link rate adaptation of the city stream (S15); simulated links only, the recorded link is always open loop |
| `city.topology_copies` | 2 (0 in older captures) | datagram copies of each reliable topology message (`EncoderConfig::topology_datagram_copies`, [netcode-tuning.md](netcode-tuning.md#city-latency-and-topology-delivery)) |
| `city.reliable_queue_ms`, `city.reliable_drain_ms` | 60, 150 (0 = off) | the rate controller's reliable-stream signal (`RateConfig`): on a limited link, reliable bytes that waited this long are given the path within the drain time |

`city.baseline_interval_ticks` is 120 on new servers (60 before). A knob
applies over the capture's encoder checkpoint, which carries the config the
live encoder ran with, so a bundle recorded before these changes replays the
old behaviour unless the knobs turn it on. The tuning round that added them
is in [netcode-tuning.md](netcode-tuning.md).

The client's adaptive playout delay is built and off in production
(`/city?adaptiveDelay=1` turns it on). The client stage reads lab-only
overrides from its environment:

- `CITY_ADAPTIVE_DELAY=1` turns the delay on;
- `CITY_PLAYOUT_Q` sets the quantile (default 0.99);
- `CITY_PLAYOUT_MARGIN` sets the margin (ticks, default 0);
- `CITY_PLAYOUT_FLOOR` sets the floor (ticks, default 3);
- `CITY_PLAYOUT_WINDOW_MS` sets the window (default 4000).

A browser has no such environment.

Lab-only knobs, not production settings: `lab.rate_stale_ms` (default 0)
makes the rate controller read the link as it was that many ms before each
send, to bound S15's sensitivity to feedback delay; and `lab.recorded_repairs` (default
1). With 0 the structure repairs the live server sent this client
(`PKT_CITY_STRUCTURE_BOOTSTRAP`) are not replayed (seam S6), and the stream
summary counts them as withheld.

## All draws (the headline)

`report.md` opens with it and `report.json` carries it as `all_draws` (first
key; also `card.all_draws` and `headline.all_draws`): **every rigid body the
client draws, in every frame, against frozen truth**, per class and overall
(`server/src/bin/netlab2/unified.rs`; city chunks in `chunks.rs`).

- **Classes:** `player`, `vehicle`, `body` (dynamic spheres and boxes),
  `meteor`, `chunk_intact` (on its structure's support body), `chunk_debris`
  (on an island truth has moving at the presented tick), `chunk_rubble` (on
  an island truth has settled), and the two the lab cannot reproduce,
  `own_avatar` and `vehicle_driven` (S11), which are reported but **not in
  `overall`**.
- **Weighting:** one draw of one thing in one frame weighs 1: every chunk is a
  draw, every body is a draw. The bench city (16 structures, 3,258 chunks) is
  3,258 draws a frame and a cannonball 1, so `overall` is chunk-dominated; the
  class rows are the ones to read for bodies, vehicles and players.
- **Per class:** position error (m) and rotation error (°) at the render time
  and against truth now, p50 / p95 / p99 / max and mean (log histogram, 30
  bins a decade, ~8% resolution on percentiles; max and mean exact); draw-frames
  **missing** (in truth and in the recipient's interest at the render time, not
  drawn), **extra** (drawn, not in truth then) and **wrong identity** (a body
  drawn as the wrong shape, a vehicle as the wrong type, a chunk drawn on a
  body truth never had it on between the presented tick and now).
- **Render time** is each renderer's own: the player clock for players and
  vehicles, the dynamic-body clock for bodies and meteors, the city
  presentation's sample tick (`render_tick - playout_delay`) for chunks.
- **City chunks** are composed per chunk from the layer's tables
  (`drawn-chunks.bin`) exactly as the vertex shader composes them, and truth
  per chunk from the encoder tape and the manifest under the wire contract
  (`chunk_world = island_pose ∘ (rest_local - island_com)`, mass-weighted rest
  com; a chunk on its structure at `structure_pose ∘ rest_local`; a chunk
  whose island was retired is gone). A chunk's error only changes when its
  drawn record or body or its truth island changes, so each chunk's measure is
  kept and added with the number of frames it held (exact; a 337 s, 3,258
  chunk, 38,899 frame run scores in about 10 s).
- **First draw of a moving body** (`all_draws.first_draw`, per class
  `body`, `meteor`, `island`). For every body truth has moving faster than
  0.5 m/s, inside the recipient's dynamic-body interest (80 m) for dynamic
  bodies, and anywhere for city islands, the metric records:
  - the wall time from the server completing that first moving tick to the
    first frame that drew it (p50/p90/p99/max ms). A body already drawn
    before it moved counts as 0 and is counted separately;
  - the bodies never drawn at all, and their moving body-frames: frames in
    which truth had them moving at the render time.

  An island counts as drawn once any chunk's record names it.
- **Join window** (`all_draws_join`, a second table in report.md). This is the
  same metric over the frames within `NETLAB2_JOIN_WINDOW_S` (default 10 s) of
  the client's first frame and of every full city bootstrap it received. It
  shows how the client behaves just after it joins.
  - The lab client joins cold at the tape's first city bootstrap (S14), like a
    newly joined client.
  - Chunk scoring is split at window edges, so each held measure lies wholly
    inside or outside a window.
- **City sync** counters (repairs asked and applied, hash mismatches, settle
  rejects, topology gaps) print under the table: a structure repair rebuilds a
  structure's ledger, and that is where retired chunks come back drawn on the
  intact body (see Findings).
- Absent for a run whose client stage predates it (no `drawn-chunks.bin`: the
  chunk classes are missing and a note says so; old `report.json` files still
  load, `all_draws` is `null`).

Metric names for comparisons (`netlab2 compare` rows): `ALL draws pos@render
p50/p95/p99 m`, `ALL draws pos@now p50/p99 m`, `ALL draws missing / extra /
wrong identity`, and `draws <class> pos@render p99 m` / `pos@now p99 m` per
class. Nothing existing was renamed; the city scorer's line in the text summary
now reads `city bodies:` (it scores island bodies, not chunks) and adds the
render-time coverage fields below.

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
  - City bodies, scored by `destruction::netlab::score` (island bodies,
    chunk-weighted, lever-arm error, perceptibility; see
    [destruction-codec docs](city-v3-protocol-2026-08.md)). Its coverage
    count `missing_moving_body_frames` is judged at the server's current
    tick, so it also counts bodies promoted after the tick the client is
    presenting, which no client can show yet; `missing_moving_at_render_*`
    judges it at the presented tick (the real gap) and
    `missing_moving_born_after_render_body_frames` counts the difference
    (see "The missing moving body-frames" below).
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

## The missing moving body-frames (rec1 on LTE: 3,253)

The city bodies line of rec1 runs reported `missing moving body-frames`: 11 on
the recorded link, 3,253 on LTE (`det-1`). The check counted a truth island
body as missing when it was moving at the server's **current** tick and the
client had no pose for it. Re-scored with the presented tick split out
(measured, rec1, same displayed/presented streams):

| Link | At the server's tick (old figure) | of which promoted after the presented tick | At the presented tick |
|---|---:|---:|---:|
| recorded | 11 | 11 | 0 |
| lte | 3,253 | 1,222 | 1,995 |

- **1,222 are a scoring artifact.** They are bodies promoted after the tick
  the client presents (`render_tick - playout_delay`). The client holds
  topology to that tick (`cityClient.ts` `drainPendingTopology`), so no client
  can show them yet. All 11 on the recorded link are this.
- **1,995 are a real client gap on LTE.** At the presented tick these 162
  bodies had existed for 1 to 17 ticks (p50 3.8), and the client had not
  applied their promotion. The topology rides the reliable stream: on LTE its
  latency is p50 123 ms, p90 297 ms, p99 446 ms, while the datagrams that
  drive the city render clock arrive in 90 ms p50, 124 ms p99, and the
  playout delay is 6 ticks (100 ms). So a promotion can reach the client up
  to about 17 ticks after the pose stream says its body exists. Meanwhile the
  chunks stay drawn on the body they left. In the all-draws metric those
  chunk-frames are `chunk_debris` pose error plus `wrong_identity` (drawn on a
  body truth had already left), not a missing draw, because the chunks are
  drawn, only in the wrong place. (Mechanism inferred from these latencies;
  the counts are measured.)

The fix is in the scorer (`destruction/src/netlab/score.rs`, additive). The
old field keeps its meaning. `missing_moving_born_after_render_body_frames`
counts the artifact share. `missing_moving_at_render_body_frames` /
`_weight` judge coverage at the presented tick, and that is the number to
optimise. The client gap is left to the topology work (structure-sync).

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
  - Lab city chunk tables against the same client on the recorded tape
    (`chunks.rs` `chunks_diff`, every chunk every 30th frame): p99 ≤ 1 cm and
    no chunk drawn by one and not the other.
- **(c) Divergences.** Each one is named in `calibration.md`.
- **(d) Every class against the live renderers** (`client-<n>-drawn.jsonl`,
  10 Hz; `live-samples.json` for record.mjs bundles):
  - position p99: players and vehicles ≤ 5 cm, bodies and meteors ≤ 15 cm,
    intact chunks ≤ 1 mm, debris chunks ≤ 10 cm. The live renderers read the
    clock at their own instant in the frame, up to about 2 ms from the lab's
    frame time (S10): 12 cm at the ~60 m/s of the fastest cannonballs and
    meteors, 1-3 cm at walking or driving speed, nothing for a standing chunk;
  - coverage: players, vehicles, bodies, intact and debris chunks must all
    have live samples;
  - city chunks: the same body key for every sampled chunk, and drawn / not
    drawn agreeing on ≥ 99.9%.
  City chunk samples come from the city layer's own tables
  (`scene/cityDrawnSample.ts`: a rotating sample of up to 400 chunks on
  island bodies and 100 on support bodies, composed as the shader composes
  them), matched to the lab frame nearest the layer's frame time (≤ 17 ms).
  A bundle recorded before the sample existed has no city samples; the
  checks say so and do not fail on it.

Calibration checks the lab against a live recording, so it runs the client
that made the recording (`--client-root` at that tree). A client whose clock
differs from the recording's fails (b)'s convergence check by construction:
the clock-fix client on rec1 is 2.9 ms p99 from the live probe in the last
10 s (the old clock's output), with the lab still 0.000 m from the same
client on the recorded tape. Calibrate a changed clock on a bundle recorded
with it. The same holds for the city clock and hide rules of items 12-14 of
the session analysis: with that client the d1342419 bundle still passes every
byte check (34,331/34,331) but fails (d) for debris chunks (p99 0.28 m) and
drawn/not drawn (0.30%), by construction; the capture recorded with it
(`20260924-131437-quick-3c-syncfix`) passes every check.

The city-latency client, with its adaptive delay off (the default), passes
every check on that capture too. The capture recorded with the city-latency
tree (`target/city-latency/city-bench/runs/20260924-162732-quick-3c-citylat4`)
passes every check on all three clients. Its bytes (3,919 / 3,919 / 3,901
city chunk packets) include the record-less datagrams carrying topology
copies.

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

**systematic-2c-d1342419** (the frozen destruction bundle; its README is in
`target/netlab-v2/bundles/`): exact capture, 337 s, both clients, PASS with the
d1342419 client.

| Check | c0 (player) | c1 (spectator) |
|---|---|---|
| (a) snapshot_v2 / city_chunks / topology / baseline / topo_hash | 18,855 / 12,180 / 3,085 / 157 / 157, all byte-identical | 18,855 / 12,077 / 3,085 / 157 / 157, all byte-identical |
| (b) clock offset vs live, p99 after warm-up / last 10 s | 96 / 8 µs | 122 / 95 µs |
| (b) delays vs live, steady p99 | players 0.28 ms, bodies 0.10 ms | players 0.25 ms, bodies 0.10 ms |
| (b) lab vs recorded tape, entities / chunk tables p99 | 0.000 m / 0.005 mm | 0.000 m / 0.009 mm |
| (d) lab vs live p99: players / vehicles / bodies / meteors | 1.4 / 0.2 / 6.3 / 10.3 cm | 1.3 / 0.3 / 6.1 / 9.3 cm |
| (d) lab vs live p99: intact / debris chunks | 0.00 mm / 2.8 cm (1.29 M chunk samples) | 0.00 mm / 3.5 cm (0.55 M) |
| (d) chunk body keys / drawn agreement | 99.9995% / 99.95% | 100% / 99.95% |

The same checks pass on the two earlier recordings of the scenario with the
client each was recorded with (2c84b393; 0a7d6ae5 before the threshold on key
agreement), and on `heavy-quick3-v2` c0 and c1 with the d1342419 client
(that recording has no city chunk samples).

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

## Results: every draw, the systematic destruction bundle

All figures below are measured. The bundle is `systematic-2c-d1342419`, run
with the d1342419 client, production knobs, recorded pace and seed 1, and
re-scored with the final scorer. `pos@render` is the position error against
truth at the client's render time; `pos@now` is against the server's current
tick. `overall` counts every intact, debris and rubble chunk, player, vehicle,
body and meteor draw, and leaves out the own avatar and the driven vehicle.

c1 (spectator):

| Link | overall pos@render p50/p95/p99 m | overall pos@now p50/p95/p99 m | rot p99 render / now ° | missing | extra | wrong identity |
|---|---|---|---|---:|---:|---:|
| loopback | 0.003/0.012/0.036 | 0.003/0.014/0.118 | 1.29 / 3.10 | 174 | 202,361 | 0 |
| lan | 0.003/0.012/0.036 | 0.003/0.014/0.118 | 1.29 / 3.10 | 171 | 202,360 | 227 |
| lte | 0.003/0.015/0.091 | 0.003/0.016/0.163 | 2.91 / 4.43 | 777 | 3,918 | 61,092 |
| poor-mobile | 0.003/0.016/0.118 | 0.003/0.019/0.390 | 3.89 / 9.63 | 330 | 65,166 | 139,139 |

Per class, p99 position error at render / now (m), c1:

| Link | player | vehicle | body | meteor | chunk intact | chunk debris | chunk rubble |
|---|---|---|---|---|---|---|---|
| loopback | 0.049 / 0.474 | 0.037 / 0.077 | 0.301 / 1.970 | 1.47 / 19.0 | 0 / 0 | 0.332 / 0.966 | 0.009 / 0.009 |
| lan | 0.049 / 0.490 | 0.037 / 0.082 | 0.301 / 2.035 | 1.47 / 19.0 | 0 / 0 | 0.321 / 0.966 | 0.009 / 0.009 |
| lte | 0.051 / 1.676 | 0.039 / 0.998 | 0.301 / 9.32 | 1.47 / 34.0 | 0 / 0 | 0.677 / 1.136 | 0.009 / 0.009 |
| poor-mobile | 0.052 / 2.393 | 0.039 / 1.380 | 0.301 / 13.3 | 1.47 / 128 | 0 / 0 | 1.174 / 3.889 | 0.009 / 0.009 |

First draw of a moving body, c1 (delay p50 / p99 from the server completing
the first moving tick):

| Link | bodies (24) | islands (2,132) | never drawn |
|---|---|---|---|
| loopback | 2 / 9 ms | 0 / 10 ms | 0 |
| lan | 6 / 10 ms | 0 / 10 ms | 0 |
| lte | 91 / 110 ms | 65 / 376 ms | 0 |
| poor-mobile | 143 / 186 ms | 160 / 4,989 ms | 5 islands (433 moving frames) |

On all eight meteors the arc was drawn from the launch packet before the body
moved in interest, so their delay is 0.

c0 (the player; own avatar and driven vehicle excluded):

| Link | overall pos@render p50/p95/p99 m | overall pos@now p50/p95/p99 m | missing | extra | wrong identity | islands first draw p99 |
|---|---|---|---:|---:|---:|---:|
| loopback | 0.003/0.012/0.031 | 0.003/0.014/0.110 | 236 | 201,271 | 170 | 11 ms |
| lan | 0.003/0.012/0.031 | 0.003/0.014/0.110 | 238 | 201,271 | 401 | 11 ms |
| lte | 0.003/0.014/0.080 | 0.003/0.016/0.163 | 273 | 4,087 | 72,212 | 327 ms |
| poor-mobile | 0.003/0.015/0.110 | 0.003/0.018/0.390 | 410 | 64,411 | 185,571 | 5,173 ms (4 never) |

The join window (first 10 s) is 0.000 m on every link. On this bundle both
clients join during the idle intro, before anything moves, and receive no
later full bootstrap. The join window measures more on a capture that joins
mid-destruction.

- **Second bundle:** `heavy-quick3-v2` (the stream-tune agent's recording:
  quick scenario, 3 clients, 122 s).
  - c0 and c1 calibrate PASS with the current client.
  - Its live samples carry no city chunks, so chunk classes are scored but not
    live-calibrated.
  - c1 overall pos@render p99 (m): loopback 0.122, lte 0.148, poor-mobile
    1.174.
  - Wrong-identity chunk-frames on poor-mobile: 751,832.
  - Island first-draw p99 on poor-mobile: 8.9 s.
- **Negative control** (end to end, c1, recorded link):
  - The client stage shifted every class by 0.5 m in x
    (`NETLAB2_CLIENT_ARGS="--perturb player=0.5,vehicle=0.5,body=0.5,meteor=0.5,chunk_intact=0.5,chunk_island=0.5"`).
  - pos@render p50 moved to 0.506 m in every class: player, vehicle, body,
    intact, debris, rubble and own avatar. Meteor went from 0.354 to 0.576;
    overall went from 0.003 to 0.506.

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

From the all-draws metric on the systematic bundles. Counts are measured;
mechanisms marked *inferred* are read from the data.

Finding 1's remaining cost was measured again in the city-latency round
([netcode-tuning.md](netcode-tuning.md#city-latency-and-topology-delivery)):

- **Topology held on constrained and lossy links.** Topology copies on the
  datagram lane and a reliable-stream signal in the rate controller address
  it.
- **The later presentation on LTE.** This is mostly the link's one-way
  latency and jitter. A smaller playout delay trades it against
  corrections drawn in view. It is built and off.

Findings 1, 2, 3, 5 and 6 are addressed by items 12-16 of the
[2026-09-24 session analysis](mac-metal-session-analysis-2026-09-24.md),
where the before/after tables are; the mechanism of finding 1 turned out to
be the client's city render clock (a jitter-biased tick-rate estimate and a
clock that ran through server stalls), not the reliable lane alone. They are
confirmed on a live capture recorded with the fixed client (city bench
quick, 3 clients, `target/sync-fidelity/city-bench/runs/20260924-131437-quick-3c-syncfix`,
calibrates PASS).

1. **On lossy links, topology reaches the client later than the pose stream
   drives its presentation.**
   - Chunks stay drawn on the body they left. On c1 of the d1342419 bundle
     that is 61k wrong-identity chunk-frames on LTE and 139k on poor-mobile.
   - Island first-draw p99 is 376 ms on LTE and 5.0 s on poor-mobile, where 5
     islands are never drawn.
   - rec1 on LTE is the same effect: 1,995 of its 3,253 "missing moving
     body-frames" (above).
   - *Inferred mechanism:* topology rides the reliable stream (HOL-blocked on
     loss), while the render clock follows the datagrams.
2. **A structure repair resurrects retired chunks.** A repair rebuilds a
   structure's ledger from the server's, and chunks the server had retired
   come back on the intact support body at their rest pose.
   - Measured on the 0a7d6ae5 bundle: 247,773 `chunk_intact` extra
     chunk-frames. That client asked for 21 repairs on a lossless link;
     2c84b393 fixed the spurious requests.
   - The resurrection itself remains wherever a real repair happens
     (structure-sync).
3. **Chunks retired at the 5 m escape floor stay drawn at their last presented
   pose.** That pose is 3.5-3.75 m below ground: above the shader's -4 m hide
   depth, under the ground plane.
   - This is most of the ~200k debris "extra" chunk-frames on loopback, from
     5 chunks.
   - The sinking itself is the PhysX vehicle bug another agent is fixing.
4. **Debris error before and after 51ddcf48.** Debris pos@render p50 on
   loopback was 0.174 m on the 2c84b393 bundle and is 0.008 m on the d1342419
   bundle.
   - Two recordings of the same scenario, so the truths differ.
   - *Inferred:* before, resting-but-not-settled debris was drawn about 17 cm
     low, consistently in the destruction scorer's "resting" phase (pos p50
     0.168 m). 51ddcf48 makes the encoder judge the pose the client draws.
5. **Meteor orientation is not streamed.** SnapshotV2 carries no sphere
   orientation, so a rock drawn from its body has rotation error p99 172°.
   The rock is irregular, so this is visible but cosmetic.
6. **A meteor whose body never streams to a client stays on its arc.**
   - Measured on `heavy-quick3-v2` c1: meteor pos@render p90 68 m, p99 157 m.
     Two of seven flights end drawn on the arc.
   - *Inferred mechanism:* no streamed sample, so no contact is detected.
7. **Bodies are drawn after truth retired them for 7-8% of body draw-frames.**
   Measured as `body` extra; see the `stale` fields for the detection window.

Earlier findings on rec1 (fixed; kept for the record):


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

# the frozen destruction bundle (README beside it): prefer its spectator, c1
B=/Users/glavin/Development/vibe-land/target/netlab-v2/bundles/systematic-2c-d1342419/debug-reports
$N matrix --bundle $B/session-netlab2-20260924-115042-systematic-2c-c1 --out <dir> --links loopback,lan,lte,poor-mobile

# a new exact capture (GPU lock; ports 4501/4502/3503); needs the server built with
# --features native-destruction into the same CARGO_TARGET_DIR
client/netlab/v2/record-bundle.sh <outDir> [seconds]      # record.mjs session + live-samples.json
client/netlab/v2/record-bench.sh <outDir> [scenario] [n]  # city-bench driver, n clients
# (HTTP_PORT, WT_PORT, CLIENT_PORT, BIN and VITE_CACHE_DIR move it off the defaults.
#  Do not touch the client tree while it records: its dev server serves that tree,
#  and a changed file reloads the pages and loses the capture.)
```

A run directory holds:

- `lab.vltape`: what the client received.
- `stream.json`: bytes, fates and selection totals.
- `displayed.bin` (players, vehicles, bodies, meteors as drawn),
  `drawn-chunks.bin` (the city layer's pose tables, VLCHNK01, gzip) and
  `presented.bin` (city island bodies, for the city bodies scorer).
- `client-stats.json`: WASM check, nacks, city client stats.
- `report.json` / `report.md`.
- `calibration.*`, when calibrating.

`NETLAB2_WRONG_ID_DUMP=<file>` makes the scorer write one line per held
wrong-identity chunk measure (slot, drawn body, truth body, presented tick,
frames held, server tick): where the headline's wrong-identity count comes
from. A diagnostic; it changes no score.

`NETLAB2_CLIENT_ARGS` passes experiments to the client stage (`--frame-start
after|cpu`: where in the frame the draw happens; `--frames 60|120`: a fixed
cadence instead of the recorded frames; `--perturb class=m,...`: the negative
control, never for a measurement). `NETLAB2_JOIN_WINDOW_S` sets the join
window (default 10 s).

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
  stage counts both, and they were 0 in every run on the d1342419 bundle.
- **The congestion controller is an ideal, at either end.** The sender-queue
  profiles pace at the path rate; the network-queue profiles do not pace at
  all. Real quinn BBR on a slow path matched the second through a userspace
  relay (S13), with no slow start or cwnd dynamics modelled. Neither has been
  validated against kernel netem, which needs privileges. Jitter is iid
  (netem's default), which over-reorders datagrams compared with real LTE.
- **Seams S8 and S14:** the client clock diverges during server stalls and
  from a cold start by up to about 16 ms, measured.
- **Budgets:** rec1 does not stress them. The systematic bundles (2 clients, 16
  demolitions) and heavy-quick3-v2 (3 clients) are the captures to price
  truncation on.
- **Local prediction is not replayed (S11).** The own avatar, the driven
  vehicle and a body the player has just touched are drawn from snapshots in
  the lab. The first two are scored but left out of `overall`; the third is
  not identified.
- **Chunk truth relies on the wire contract's frame.** A chunk's truth pose is
  the island pose composed with `rest_local - island_com` (mass-weighted rest
  com), the rule the client also uses. A backend that broke that contract would
  be wrong on both sides and invisible here. It is a physics-side contract
  (`IslandPromotion` in `netcode/src/destruction_backend.rs`).
- **The city layer's distance stride is left out (S10).** Live, a body 1-8
  frames late on the stride is drawn at an older pose than the lab's. That
  cost is a rendering choice and is not charged to the netcode.
- **City chunk samples in the live recordings are a subset:** a rotating 500
  chunks per 10 Hz sample.
- **The capture additions are production changes.** Recording them costs one
  encoder clone at capture start, and per snapshot tick one small JSON line
  per recipient (off the tick thread).
- **Node 22.1 has no zstd,** so `presented.bin` is uncompressed there. The
  reader accepts either.
