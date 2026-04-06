# Web FPS foundation: SpacetimeDB + Rust/Rapier authoritative sim + Three.js/R3F client

This bundle is the foundation I would hand to junior engineers for a serious browser FPS.

## Final stack decision

- **SpacetimeDB** = anonymous auth, identity/token persistence, presence, lobby/match roster, durable match metadata, post-match persistence.
- **Rust + Rapier dedicated gameplay server** = authoritative simulation, lag compensation, hitscan validation, block-world authority, snapshot generation.
- **Browser client (Three.js / R3F + Rapier JS)** = local prediction for the local player, replay/reconciliation, interpolation for remote entities, static-world collision mirroring for accurate client feel.

## Why this architecture

1. **SpacetimeDB should not own the hot 60/120 Hz physics loop.** Reducers are transactional, isolated, and docs explicitly warn that global/static/module state is not a safe persistence mechanism across reducer calls. That is a poor fit for a long-lived Rapier world.
2. **Colyseus is good, but not the best core for this project.** Its docs say it is an authoritative room/state-sync framework, but it does not provide client prediction today. Its WebTransport path is also marked experimental. For a project where the hard part is server-authoritative FPS netcode, custom Rust/Rapier code is the stronger core.
3. **Browser transport reality matters.** WebSocket is still the most compatible and mature browser transport. WebTransport is promising and increasingly available, but not the safest default for a public game foundation yet. This bundle uses **binary WebSocket** and keeps the gameplay protocol transport-agnostic.

## Netcode model implemented here

- Local player: **client-side prediction** against a mirrored static world.
- Server: **authoritative fixed tick** (60 Hz), validates movement and combat.
- Reconciliation: server acks the latest input sequence used; client rewinds to the authoritative state and **replays pending inputs**.
- Remote players: **snapshot interpolation** on a small delay buffer.
- Hitscan weapons: **server-side lag compensation / rewind** against historical target capsules.
- Slow projectiles: leave them server-authoritative and replicate from snapshots later.
- World edits: **chunk-versioned block sync**; stale edits trigger a **full chunk resync**.
- Latency estimation for lag compensation: **server-initiated ping nonce**, client immediate echo, server keeps smoothed one-way estimate.

## Recommended starting config

- Simulation tick: **60 Hz**
- Input send rate: **60 Hz**
- Snapshot send rate: **30 Hz** for <= 24 players; drop to **20 Hz** if bandwidth or world size forces it
- Interpolation delay: **66 ms** at 30 Hz snapshots; **100 ms** at 20 Hz snapshots
- History kept for lag compensation: **1000 ms**
- Client prediction replay window: **250-500 ms**
- Chunk size for block world: **16 x 16 x 16**
- Collision units: **1 world unit = 1 meter**

## Important design choices in this code

### 1) Kinematic FPS controller, not dynamic rigid body
Players are controlled with a Rapier character controller + capsule collider. This gives sane slide, stairs, slopes, and predictable reconciliation behavior.

### 2) Rewind only players for hitscan
For lag compensation, this code rewinds **player capsules**, not the entire world. Static world geometry is raycasted in its current state because it does not move.

### 3) Block-world sync is versioned by chunk
Each chunk has a version. Block edits carry the client’s expected chunk version. The server validates, increments version, updates physics, and broadcasts chunk diffs. If the client is stale, the server pushes the latest **full chunk**.

### 4) WebSocket first, WebTransport later
Ship WebSocket first. Only add WebTransport after production load testing.

## Files

### `server/`
- `main.rs` — websocket server, Spacetime token verification, match loop, snapshot scheduling, server-initiated latency pings
- `protocol.rs` — binary packet formats shared conceptually with TS
- `movement.rs` — authoritative player movement with Rapier character controller
- `lag_comp.rs` — rewound hitscan validation against historical capsules
- `voxel_world.rs` — authoritative block world, chunk versions, and static collision rebuilds

### `client/`
- `src/net/protocol.ts` — packet codec matching the Rust protocol
- `src/net/gameSocket.ts` — websocket client, packet routing, server ping echo, client ping measurement
- `src/net/interpolation.ts` — remote-player interpolation buffer
- `src/physics/predictedFpsController.ts` — local prediction and reconciliation
- `src/world/voxelWorld.ts` — client-side chunk state and Rapier static colliders
- `src/spacetime/connectSpacetime.ts` — anonymous SpacetimeDB connect + control-plane subscriptions

### `spacetimedb-module/`
- `src/module.ts` — anonymous identity/presence/lobby/match metadata example module

## What juniors still need to glue

- R3F scene graph and rendering
- weapon VFX/audio/UI
- mesh generation / greedy meshing for block chunks
- account UX / menus / matchmaking flow polish
- production metrics, observability, and deployment
- anti-cheat hardening beyond movement + server authority

## Production upgrades after this foundation works

1. Replace full chunk collider rebuilds with **compound or baked chunk colliders**.
2. Add **interest management / area-of-interest** for very large worlds.
3. Move from full-state snapshots to **delta snapshots per client baseline**.
4. Add **WebTransport** as an optional path for supported browsers.
5. Add **server-side replay/debug capture** for desync reports.
6. Add **bot / soak / packet-loss test harnesses** before launch.
