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

## Local Preview Mode

To run the game entirely in one browser tab with no Rust server, WebSocket, or WebTransport dependency:

```bash
cd client
npm run dev:local-preview
```

To build the static browser-only preview bundle:

```bash
cd client
npm run build:local-preview
```

This mode keeps the normal client prediction/render path, but swaps the remote server transport for an in-browser authoritative WASM session seeded with the demo world, vehicle, and dynamic bodies.

## Vercel Deployment

The repo includes a root [vercel.json](/Users/glavin/Development/vibe-land/vercel.json:1) that deploys the static `local-preview` client bundle.

- Vercel build target: `client/dist`
- Vercel build command: `npm --prefix client run build:vercel-local-preview`
- Local/full multiplayer dev remains unchanged:
  use `make dev` or `cd client && npm run dev` plus the Rust server

This means Vercel preview deployments host the browser-only single-player preview, while local development can still run the full multiplayer stack.

> **HTTPS is required** — WebTransport only works in secure contexts. When `WT_CERT_PEM`/`WT_KEY_PEM` are set in `.env`, Vite serves HTTPS automatically using those certs. In dev (no certs set), the server generates a self-signed cert; Chrome/Edge accept it via hash pinning.

Or run manually:

```bash
cp .env.example .env   # edit WT_HOST, cert paths, etc.
                       # for local WT on macOS, prefer WT_HOST=127.0.0.1 to avoid localhost resolving to ::1 first

# Build shared WASM module (once, or after changes to shared/)
cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg && cd ..

# Terminal 1 — game server
cd server && RUST_LOG=info cargo run

# Terminal 2 — web client
cd client && npm install && npm run dev
```

See `AGENTS.md` for full setup details, lint, and build instructions.
