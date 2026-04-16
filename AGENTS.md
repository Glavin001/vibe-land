## Cursor Cloud specific instructions

### Overview

This is a multiplayer browser FPS game ("vibe-land") with two services:

| Service | Tech | Directory | Port |
|---------|------|-----------|------|
| Game server | Rust (Axum + Rapier3D) | `server/` | 4001 (default) |
| Web client | TypeScript (Vite + React Three Fiber) | `client/` | 3001 (default) |

### First-time setup

```bash
make setup   # copies .env.example → .env, builds WASM, installs client deps
```

**Linux system packages (recommended on a clean machine).** Without these, `make check` or a real destructibles WASM build will fail in non-obvious ways:

- **`libssl-dev`** and **`pkg-config`** — required so the Rust workspace can compile `openssl-sys` for the game server (`make check` / `cargo check` at the repo root). On Ubuntu/Debian: `sudo apt-get install -y libssl-dev pkg-config`.
- **`wasm32-unknown-unknown` target** — `rustup target add wasm32-unknown-unknown`.
- **`wasm-pack`** — the client’s `npm run build:wasm` / `predev` script installs it via Cargo if missing; you can also `cargo install wasm-pack --locked`.
- **Real Blast / destructibles WASM build** (only if `third_party/physx/` is a full PhysX clone, not the stub — see below): the `blast-stress-solver` C++ backend compiles with **clang** against the **WASI sysroot** and links **wasm libc++**. On Ubuntu 24.04 (Noble) this is satisfied by:
  - `sudo apt-get install -y wasi-libc libc++-18-dev-wasm32`
  If those packages are missing, `wasm-pack build … --features destructibles` fails with errors such as missing `bits/libc-header-start.h` or “wasm libc++.a not found”. The crate’s `build.rs` also supports overriding paths via **`BLAST_WASM_SYSROOT`**, **`BLAST_WASM_CXX_INCLUDE`**, **`BLAST_WASM_CXX_LIB_DIR`**, etc., if you use a custom WASI SDK — see `third_party/physx/blast/blast-stress-solver-rs/build.rs` when the vendor tree is present.

Or step by step:

```bash
cp .env.example .env   # edit WT_HOST, cert paths, ports as needed
                       # set VITE_MULTIPLAYER_HTTP_ORIGIN only when the SPA points at a different multiplayer origin

# Build the shared WASM module (required before running the client;
# re-run after any change to shared/)
cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg && cd ..

cd client && npm install
```

### Running (together)

```bash
make dev   # starts server + client in parallel; Ctrl-C stops both
```

### Running the server

```bash
make server
# or: cd server && RUST_LOG=info cargo run
```

- Config is loaded from `.env` in the repo root.
- Listens on TCP `SERVER_PORT` (default 4001) for WebSocket and UDP `WT_BIND_ADDR` (default 4002) for WebTransport.
- Health check: `curl http://localhost:4001/healthz`
- Session config (WT URL + cert hash): `curl http://localhost:4001/session-config?match_id=default`

### Running the client

```bash
make client
# or: cd client && npm run dev
```

- Port and allowed hosts come from `.env` (default: 5555).
- Vite proxies `/ws/*`, `/healthz`, and `/session-config` to the Rust server.
- When `WT_CERT_PEM`/`WT_KEY_PEM` are set, Vite serves **HTTPS** automatically (required for WebTransport).
- Open `https://localhost:5555` in browser, then use `/play` for multiplayer or `/practice` for the firing range.
- Press **F3** to toggle the debug overlay (shows transport, ping, FPS, physics stats).

### Lint / type check

```bash
make check         # runs both checks below
make check-server  # cargo check
make check-client  # tsc --noEmit
```

- `cargo clippy` warnings from unused foundation code are expected.

### Build

- **Server:** `cd server && cargo build`
- **Client (WASM):** `cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg` (or `make setup-wasm` / `npm run build:wasm` from `client/`, which runs `scripts/build-shared-wasm.sh` and enables `--features destructibles` when the real PhysX clone exists)
- **Client:** `cd client && npm run build`

### WebTransport infrastructure (infra/)

The `infra/` directory contains a standalone Go demo server and Playwright tests for verifying WebTransport (QUIC/HTTP3) connectivity. This runs independently of the Rust game server and is used to validate the Hetzner Cloud VPS setup.

**Running the demo server** (requires a TLS cert and `WT_DOMAIN` env var):

```bash
cd infra/webtransport-demo
go build -o webtransport-server .
WT_DOMAIN=wt.yourdomain.com ./webtransport-server
```

Serves `https://YOUR_DOMAIN/` (chat demo) and `https://YOUR_DOMAIN/diag` (capability diagnostic).

**Running automated tests** (from the server host):

```bash
cd infra/webtransport-tests
npm install
WT_DOMAIN=wt.yourdomain.com xvfb-run --auto-servernum node test-full.mjs   # all capabilities
WT_DOMAIN=wt.yourdomain.com xvfb-run --auto-servernum node test-chat2.mjs   # two-client broadcast
```

See `infra/WEBTRANSPORT_SETUP.md` for the full Hetzner VPS setup guide (DNS, firewall, TLS, systemd service, troubleshooting).

### WebTransport transport

The client prefers WebTransport (QUIC/UDP) and falls back to WebSocket (TCP) automatically.

**Dev (self-signed cert):** Leave `WT_CERT_PEM`/`WT_KEY_PEM` unset. The server generates a self-signed cert and exposes its hash via `/session-config`. The client pins the hash via `serverCertificateHashes`. Only Chrome/Edge support this; the 14-day cert limit means it regenerates on each server restart.

**Production (CA-signed cert, e.g. Let's Encrypt):** Set `WT_CERT_PEM` and `WT_KEY_PEM` in `.env`. The server loads the cert; `/session-config` returns an empty hash so the client skips pinning and relies on normal TLS validation. All modern browsers work.

Firewall requirements for WebTransport:
- Open UDP `WT_BIND_ADDR` port (default **4002**) inbound — both UFW and any cloud-level firewall (e.g. Hetzner).
- `ufw allow 4002/udp`

### Non-obvious notes

- Rust toolchain must be >= 1.86. Run `rustup update stable && rustup default stable` if needed.
- The shared WASM crate (`shared/`) is compiled separately with `wasm-pack` and output to `client/src/wasm/pkg/`. This must be rebuilt whenever `shared/` changes.
- `make setup` now clones the pinned NVIDIA Blast stress solver into `third_party/physx/` (gitignored) via `scripts/setup-blast.sh`. The `blast-stress-solver` dep is wasm-only AND optional (behind the `destructibles` Cargo feature) — `cargo check` / `cargo build -p web-fps-server` on a server dev box never touches the Blast C++ sources. Cargo still resolves the optional path dep during metadata, so a tiny placeholder crate at `stubs/blast-stress-solver-rs/` is dropped into `third_party/physx/blast/blast-stress-solver-rs/` by `scripts/ensure-blast-stub.sh` whenever the real clone is missing (e.g. Vercel preview builds). `scripts/build-shared-wasm.sh` detects whether the real PhysX clone is present and passes `--features destructibles` accordingly; when only the stub is present the wasm module still exposes the full destructibles JS API on `WasmSimWorld`, but every call is a no-op. See `docs/BLAST_INTEGRATION.md` for the full toolchain. The real crate ships pure-Rust stubs for every libc symbol libc++ references, so the final wasm has zero `env.*` and zero `wasi_snapshot_preview1.*` imports and `make setup-wasm` does no post-processing.
- **Destructibles + Rapier collision groups:** Blast scenario colliders may use `InteractionGroups` that only pair with `GROUP_1`. The player capsule uses `GROUP_3` and vehicles/dynamic props use `GROUP_2` (see `netcode/src/sim_world.rs` and `shared/src/wasm_api.rs`). If destructible chunk colliders keep a narrow filter, the **kinematic character controller** and **vehicle chassis** queries will not hit them and gameplay will **phase through** bricks. Integrations should assign destructible chunk colliders the **same membership/filter as static world geometry** (`GROUP_1` with filter `Group::all()`), and re-apply after fracture splits add new colliders. See `shared/src/destructibles_real.rs`.
- **Destructibles + Blast `step()` overwrites groups every frame:** The stress solver’s `BodyTracker` assigns debris / “multi” bodies to `GROUP_2` / `GROUP_3` with filters tuned for the demo (see `third_party/physx/blast/blast-stress-solver-rs/src/rapier/collision_groups.rs`). The **vehicle chassis** uses `GROUP_1` with filter **`GROUP_1 | GROUP_2` only** (so it does not hit the player capsule `GROUP_3`). After `DestructibleSet::step`, chunk bodies can end up as `GROUP_3` with a filter that **does not** match the chassis — **cars drive through** unless integration **re-applies** terrain-style groups **after every `step`**, and sets **`solver_groups`** to match **`collision_groups`** (Blast sets both in `apply_collision_groups_for_body`).
- The web client is a single SPA build. Runtime route selection decides between `/play` multiplayer and `/practice` firing range; build mode no longer selects that behavior.
- `VITE_MULTIPLAYER_HTTP_ORIGIN` is optional. Leave it unset for same-origin deployments; set it when the SPA is hosted separately from the Rust/WebTransport backend.
- The `rapier3d` 0.30 API is used. Key notes: `KinematicCharacterController` is in `rapier3d::control`.
- The client's old files (`GameRuntime.ts`, `predictedFpsController.ts`, `voxelWorld.ts`, `connectSpacetime.ts`) depend on `@dimforge/rapier3d-compat` and SpacetimeDB bindings which are excluded from tsconfig for the MVP. The active client entry point is `src/main.tsx`.
- Remote player rendering uses imperative Three.js mesh creation inside a `useFrame` loop on a `<group ref>`. The meshes are colored capsules with player ID labels.
- Snapshots are sent as QUIC datagrams when they fit within path MTU (~1200 bytes); otherwise they fall back to the reliable stream automatically. The client's `decodeServerReliablePacket` handles both paths.
