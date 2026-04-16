# Netcode rewrite notes

This branch rewires the project around a custom authoritative Rust server and a browser WebTransport client.

## Core model

- Rust server owns the simulation.
- Rapier is used for server-side world collision and authoritative kinematic FPS movement.
- Browser client uses local Rapier kinematic prediction for the local player only.
- Client sends bundled recent inputs every fixed step over WebTransport datagrams.
- Server snapshots players + projectiles at 20 Hz with `server_time_us` and per-client `ack_input_seq`.
- Client reconciles the local player from authoritative snapshots and replays unacked inputs.
- Remote players are interpolated from buffered snapshots.
- Hitscan uses server-side lag compensation / rewind.
- Rockets are server-authoritative projectiles and are interpolated on clients.
- Owner rockets are sampled closer to estimated server-present time so they feel less delayed than remote rockets.

## Server routes

- `GET /healthz`
- `GET /session-config?match_id=default`

The browser first fetches `/session-config`, then opens a WebTransport session to `/game` using the returned certificate hash.

## Environment

Server env vars:

- `BIND_ADDR` default `0.0.0.0:4001`
- `WT_BIND_ADDR` default `0.0.0.0:4002`
- `WT_HOST` default `localhost`
- `WT_PUBLIC_URL` optional override for the full externally visible WebTransport base URL used in `/session-config`

## Client controls

- WASD / arrows: move
- Mouse: look
- Space: jump
- Shift: sprint
- Ctrl or C: crouch
- Left click: hitscan
- Right click: rocket

## Important caveat

The browser client was build-checked in this environment with `npm run build`.
The Rust server was not cargo-build-checked here because the Rust toolchain is not installed in this environment.
