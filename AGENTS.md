## Cursor Cloud specific instructions

### Overview

This is a multiplayer browser FPS game ("vibe-land") with two services:

| Service | Tech | Directory | Port |
|---------|------|-----------|------|
| Game server | Rust (Axum + Rapier3D) | `server/` | 4001 (default) |
| Web client | TypeScript (Vite + React Three Fiber) | `client/` | 3001 (default) |

### First-time setup

Local Rust/WASM prerequisites for browser builds:

```bash
rustup update stable && rustup default stable   # Rust >= 1.86
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked                # needed for make setup / make setup-wasm
```

Then run:

```bash
make setup   # copies .env.example → .env, builds WASM, installs client deps
```

Or step by step:

```bash
cp .env.example .env   # edit WT_HOST, cert paths, ports as needed
                       # set VITE_MULTIPLAYER_HTTP_ORIGIN only when the SPA points at a different multiplayer origin

# Preferred local shared-WASM rebuild. This also regenerates
# client/src/net/sharedConstants.ts and writes the bundle to
# client/src/wasm/pkg/.
cd client && npm run build:wasm

cd client && npm install
```

### Running (together)

```bash
make dev   # starts server + client in parallel; Ctrl-C stops both
```

### Running the server

```bash
make server
# or: cd server && cargo run
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
- **Client (WASM):** `cd client && npm run build:wasm`
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
- `server/.cargo/config.toml` makes `cd server && cargo run` use the same practical server defaults as `WT_STRICT_SNAPSHOT_DATAGRAMS=1 RUST_LOG=info cargo run --release -p web-fps-server`: info logging, strict snapshot datagrams, and an optimized dev profile.
- Local wasm builds require the `wasm32-unknown-unknown` Rust target. The preferred entrypoint is `cd client && npm run build:wasm`; it ensures `wasm-pack` exists, regenerates `client/src/net/sharedConstants.ts`, and writes the output to `client/src/wasm/pkg/`.
- `shared/Cargo.toml` pulls `wasm-bindgen`, `js-sys`, `console_error_panic_hook`, and `blast-stress-solver` only for `wasm32-unknown-unknown`. No local PhysX clone or C++ toolchain is required. `cargo check` / `cargo build -p web-fps-server` never touch the Blast backend; only the wasm build does. See `docs/BLAST_INTEGRATION.md` for details.
- The web client is a single SPA build. Runtime route selection decides between `/play` multiplayer and `/practice` firing range; build mode no longer selects that behavior.
- `VITE_MULTIPLAYER_HTTP_ORIGIN` is optional. Leave it unset for same-origin deployments; set it when the SPA is hosted separately from the Rust/WebTransport backend.
- The `rapier3d` 0.30 API is used. Key notes: `KinematicCharacterController` is in `rapier3d::control`.
- The client's old files (`GameRuntime.ts`, `predictedFpsController.ts`, `voxelWorld.ts`, `connectSpacetime.ts`) depend on `@dimforge/rapier3d-compat` and SpacetimeDB bindings which are excluded from tsconfig for the MVP. The active client entry point is `src/main.tsx`.
- Remote player rendering uses imperative Three.js mesh creation inside a `useFrame` loop on a `<group ref>`. The meshes are colored capsules with player ID labels.
- Snapshots are sent as QUIC datagrams when they fit within path MTU (~1200 bytes); otherwise they fall back to the reliable stream automatically. The client's `decodeServerReliablePacket` handles both paths.
