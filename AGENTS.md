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
- **Client (WASM):** `cd shared && wasm-pack build --target web --out-dir ../client/pkg`
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

### World publishing backends (filesystem or R2)

The world builder at `/builder/world` can publish worlds to durable storage; published worlds appear in `/gallery` and can be played from the gallery via `/practice/shared/<id>`. The feature is gated on server-side env vars and is hidden when nothing is configured.

Two backends are supported behind a single `WorldStorage` interface (`api/_lib/storage.ts`):

| Backend | Env var(s) | When to use |
| --- | --- | --- |
| **Filesystem** (`api/_lib/fsStorage.ts`) | `WORLDS_STORAGE_DIR=/path/to/dir` | Local dev without docker, self-hosted installs with a persistent disk, cheapest path for single-machine deployments. Takes precedence when set. |
| **R2 / any S3-compatible** (`api/_lib/r2Storage.ts`) | `R2_ACCOUNT_ID` + `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` + `R2_BUCKET` (or `R2_ENDPOINT` to target MinIO/LocalStack) | Vercel deployments, multi-instance setups, Cloudflare R2 in production. |

Both backends implement write-once semantics (the filesystem uses POSIX `O_EXCL`; R2 uses `IfNoneMatch: '*'`), gzip-compressed world payloads, and share the same on-disk key layout (`published/<id>.world.json` + `published/<id>.screenshot.jpg`). The filesystem backend adds a sidecar `published/<id>.meta.json` because the filesystem doesn't have an equivalent of S3 user metadata.

Endpoints (Vercel serverless functions in `/api`):

- `GET /api/worlds/config` → `{ enabled }` based on whether R2 creds are present
- `POST /api/worlds/publish` → server generates a UUID, HEAD-checks for collisions, stores gzipped JSON
- `GET  /api/worlds` → ListObjectsV2 + per-item HeadObject (decodes base64 metadata)
- `GET  /api/worlds/<id>` → fetches and decompresses
- `POST /api/worlds/<id>/screenshot` → uploads JPEG (requires the world to exist)
- `GET  /api/worlds/<id>/screenshot` → streams the JPEG

The R2 client lives in `api/_lib/r2.ts` and supports any S3-compatible backend via `R2_ENDPOINT`. With a custom endpoint set, path-style addressing is enabled automatically so `localhost` works without wildcard DNS.

#### End-to-end smoke test (`npm run r2:test`)

One script at `scripts/test-r2-e2e.mts` exercises the full publishing pipeline against either backend. It boots an in-process `http.Server`, routes to the real `api/worlds/*.ts` handlers, and runs the 23-check suite (publish / list / get / screenshot upload / screenshot get / 404 on missing world / config backend-kind check). It picks the backend automatically:

```bash
# Filesystem backend — no external services, just a writable directory.
WORLDS_STORAGE_DIR=/tmp/vibe-land-worlds npm run r2:test

# R2 backend via MinIO — starts a local S3-compatible server first.
npm run r2:up
npm run r2:test
```

#### Local MinIO via docker-compose

`docker-compose.yml` at the repo root brings up MinIO + a one-shot bucket-init container. The compose file uses **`network_mode: host`** for both services so it works on Docker daemons without iptables/bridge NAT (e.g. sandboxes).

```bash
npm run r2:up      # boot MinIO on :9000 (S3) and :9001 (web console)
npm run r2:logs    # tail minio logs
npm run r2:down    # stop, keep data
npm run r2:reset   # stop and wipe the named volume
```

Then add the MinIO block from `.env.example` to a `.env.local` at the repo root and either run `vercel dev` or run the e2e test above.

##### Booting Docker on a sandbox without root systemd

Some environments (e.g. CI sandboxes) ship the Docker binaries but no daemon. To get a working `dockerd` for the compose stack:

```bash
# Terminal 1 (run in background)
sudo dockerd --storage-driver=vfs --iptables=false > /tmp/dockerd.log 2>&1 &

# Terminal 2 — open the socket for the unprivileged shell, then verify
sudo chmod 666 /var/run/docker.sock
docker info     # should show "Storage Driver: vfs"
```

The `--iptables=false` flag is important because most sandboxes can't manage netfilter rules. The compose file is configured to use host networking precisely so the resulting daemon (which has no working bridge NAT or embedded DNS) still routes container-to-container traffic via `localhost`.

### Non-obvious notes

- Rust toolchain must be >= 1.86. Run `rustup update stable && rustup default stable` if needed.
- The shared WASM crate (`shared/`) is compiled separately with `wasm-pack` and output to `client/pkg/`. This must be rebuilt whenever `shared/` changes.
- The web client is a single SPA build. Runtime route selection decides between `/play` multiplayer and `/practice` firing range; build mode no longer selects that behavior.
- `VITE_MULTIPLAYER_HTTP_ORIGIN` is optional. Leave it unset for same-origin deployments; set it when the SPA is hosted separately from the Rust/WebTransport backend.
- The `rapier3d` 0.30 API is used. Key notes: `KinematicCharacterController` is in `rapier3d::control`.
- The client's old files (`GameRuntime.ts`, `predictedFpsController.ts`, `voxelWorld.ts`, `connectSpacetime.ts`) depend on `@dimforge/rapier3d-compat` and SpacetimeDB bindings which are excluded from tsconfig for the MVP. The active client entry point is `src/main.tsx`.
- Remote player rendering uses imperative Three.js mesh creation inside a `useFrame` loop on a `<group ref>`. The meshes are colored capsules with player ID labels.
- Snapshots are sent as QUIC datagrams when they fit within path MTU (~1200 bytes); otherwise they fall back to the reliable stream automatically. The client's `decodeServerReliablePacket` handles both paths.
