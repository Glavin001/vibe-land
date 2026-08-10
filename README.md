# vibe-land

Browser-first multiplayer FPS prototype with:

- Rust authoritative simulation server (Axum + Rapier3D)
- Browser-side client-side prediction via shared WASM physics (wasm-pack)
- WebTransport (QUIC/UDP) netcode with WebSocket fallback
- Lag compensation and snapshot interpolation
- three.js / React Three Fiber client

See `NETCODE_NOTES.md` for netcode design and current caveats.

## Quick start

```bash
make setup   # copy .env, build WASM, install client deps (once)
make dev     # start server + client in parallel
```

Open `https://localhost:5555` and click to join.

## Unified Web App

The client now ships as one SPA build with multiple entry routes:

- `/` launcher
- `/play` multiplayer
- `/practice` firing range (browser-only single-player)
- `/stats` server stats
- `/loadtest` browser load test
- `/moq` MoQ world-state streaming demo (see `moq/README.md`)

To run the firing range entirely in one browser tab with no Rust server, WebSocket, or WebTransport dependency:

```bash
cd client
npm run dev:practice
```

To build the deployable web app bundle:

```bash
cd client
npm run build
```

`/practice` runs the shared Rust authority directly in-browser. It does not use multiplayer prediction/reconciliation; the browser hosts the authoritative session and renders it immediately.

## Vercel Deployment

The repo includes a root [vercel.json](/Users/glavin/Development/vibe-land/vercel.json:1) that deploys the unified static client bundle.

- Vercel build target: `client/dist`
- Vercel build command: `npm --prefix client run build:vercel`
- Static assets under `/assets/*` are cached as immutable hashed files
- SPA routes revalidate on each request so browsers can reuse cached assets quickly after checking freshness

If the web app and Rust backend share the same origin, no extra client config is needed. If the SPA is hosted separately, set `VITE_MULTIPLAYER_HTTP_ORIGIN` to the public backend origin so `/play`, `/stats`, and `/loadtest` target the multiplayer server correctly.

This means one deploy can serve both multiplayer and single-player routes.

> **HTTPS is required** — WebTransport only works in secure contexts. When `WT_CERT_PEM`/`WT_KEY_PEM` are set in `.env`, Vite serves HTTPS automatically using those certs. In dev (no certs set), the server generates a self-signed cert; Chrome/Edge accept it via hash pinning.

Or run manually:

```bash
cp .env.example .env   # edit WT_HOST, cert paths, etc.
                       # optionally set VITE_MULTIPLAYER_HTTP_ORIGIN when the SPA and game backend use different origins
                       # for local WT on macOS, prefer WT_HOST=127.0.0.1 to avoid localhost resolving to ::1 first
                       # if WebTransport uses a different public hostname/port than WT_BIND_ADDR, set WT_PUBLIC_URL

# Build shared WASM module (once, or after changes to shared/)
cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg && cd ..

# Terminal 1 — game server
cd server && RUST_LOG=info cargo run

# Terminal 2 — web client
cd client && npm install && npm run dev
```

Production notes:

- The hostname returned by `/session-config` must be directly reachable over QUIC/UDP by the browser.
- For this repo's current origin WebTransport setup, use a `DNS only` record in Cloudflare for that hostname. Normal orange-cloud proxying was observed to break the WebTransport opening handshake.
- `WT_BIND_ADDR` controls the local UDP bind port. `WT_PUBLIC_URL` controls the public URL advertised to browsers.
- An explicit WebTransport port such as `https://vibe-land.glavin.ca:4002` is the most predictable setup when your main HTTPS site is served separately on `TCP 443`.
- If you use a custom hostname in `WT_PUBLIC_URL`, the certificate files in `.env` must cover that hostname.

## PhysX GPU authoritative server

PhysX is a process-start backend, not a per-match toggle. Build and run it on
an NVIDIA host with the PhysX GPU SDK and CUDA driver available:

```bash
PHYSX_ROOT=/root/PhysX/physx/install/linux-clang/PhysX \
  cargo build --release -p web-fps-server --features physx-gpu
VIBE_PHYSICS_BACKEND=physx_gpu \
WT_STRICT_SNAPSHOT_DATAGRAMS=1 \
  ./target/release/web-fps-server
```

Startup fails if the CUDA context or GPU scene cannot execute a validation
step. `/healthz` reports the selected backend and required GPU status. PhysX
sessions negotiate 60 Hz snapshots and thin-authoritative client movement;
incompatible clients are rejected.

Set `VITE_THIN_PRESENTATION_PREDICTION=0` when building the client to render
the interpolated authoritative local-player pose with no presentation offset.
This is the correctness baseline for thin-predictor tuning.

`scripts/package-physx-server.sh` creates a runtime bundle containing the
server and `libPhysXGpu_64.so`. Build `Dockerfile.physx-gpu` from that bundle
and run it with the NVIDIA container runtime. Switching back to Rapier requires
draining and restarting the process with `VIBE_PHYSICS_BACKEND=rapier`.

## Streaming world state over MoQ

`moq/` holds a proof of concept for carrying world state over
[Cloudflare's Media over QUIC relays](https://developers.cloudflare.com/moq/):
a Rust publisher splits a destruction sim into one MoQ track per region, each at
its own rate, and the `/moq` page subscribes to whichever tracks it wants.

```bash
make moq-publisher   # build the publisher
make moq-e2e         # local relay + publisher + headless Chromium, end to end
```

See `moq/README.md` for the track layout, the wire format, how it splits against
the existing WebTransport datagram path, and how to provision a Cloudflare relay.

See `AGENTS.md` for full setup details, lint, and build instructions.
