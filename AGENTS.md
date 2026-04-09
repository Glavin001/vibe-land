## Cursor Cloud specific instructions

### Overview

This is a multiplayer browser FPS game ("vibe-land") with two services:

| Service | Tech | Directory | Port |
|---------|------|-----------|------|
| Game server | Rust (Axum + Rapier3D) | `server/` | 4001 (default) |
| Web client | TypeScript (Vite + React Three Fiber) | `client/` | 3001 (default) |

### First-time setup

```bash
cp .env.example .env   # edit as needed
```

Build the shared WASM module (required before running the client):

```bash
cd shared
wasm-pack build --target web --out-dir ../client/pkg
```

Install client dependencies:

```bash
cd client && npm install
```

### Running the server

```bash
cd server
RUST_LOG=info cargo run
```

- Config (ports, allowed hosts, etc.) is loaded from `.env` in the repo root.
- Health check: `curl http://localhost:4001/healthz`

### Running the client

```bash
cd client
npx vite
```

- Port and allowed hosts come from `.env` (default: 3001).
- Vite proxies `/ws/*` and `/healthz` to the Rust server.
- Open `http://localhost:3001` in browser, click to join.

### Lint / type check

- **Server:** `cd server && cargo clippy` (warnings from unused foundation code are expected)
- **Client:** `cd client && npx tsc --noEmit`

### Build

- **Server:** `cd server && cargo build`
- **Client (WASM):** `cd shared && wasm-pack build --target web --out-dir ../client/pkg`
- **Client:** `cd client && npx vite build`

### Non-obvious notes

- Rust toolchain must be >= 1.86. Run `rustup update stable && rustup default stable` if needed.
- The shared WASM crate (`shared/`) is compiled separately with `wasm-pack` and output to `client/pkg/`. This must be rebuilt whenever `shared/` changes.
- The `rapier3d` 0.30 API is used. Key notes: `KinematicCharacterController` is in `rapier3d::control`.
- The client's old files (`GameRuntime.ts`, `predictedFpsController.ts`, `voxelWorld.ts`, `connectSpacetime.ts`) depend on `@dimforge/rapier3d-compat` and SpacetimeDB bindings which are excluded from tsconfig for the MVP. The active client entry point is `src/main.tsx`.
- Remote player rendering uses imperative Three.js mesh creation inside a `useFrame` loop on a `<group ref>`. The meshes are colored capsules with player ID labels.
