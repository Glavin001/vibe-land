## Cursor Cloud specific instructions

### Overview

This is a multiplayer browser FPS game ("vibe-land") with two services:

| Service | Tech | Directory | Port |
|---------|------|-----------|------|
| Game server | Rust (Axum + Rapier3D) | `server/` | 4001 |
| Web client | TypeScript (Vite + React Three Fiber) | `client/` | 3000 |

### Running the server

```bash
cd server
SKIP_SPACETIMEDB_VERIFY=1 RUST_LOG=info cargo run
```

- `SKIP_SPACETIMEDB_VERIFY=1` bypasses the SpacetimeDB token verification for local development.
- Health check: `curl http://localhost:4001/healthz`

### Running the client

```bash
cd client
npx vite --host 0.0.0.0 --port 3000
```

- Vite proxies `/ws/*` and `/healthz` to the Rust server on port 4001.
- Open `http://localhost:3000` in browser, click to join.

### Lint / type check

- **Server:** `cd server && cargo clippy` (warnings from unused foundation code are expected)
- **Client:** `cd client && npx tsc --noEmit`

### Build

- **Server:** `cd server && cargo build`
- **Client:** `cd client && npx vite build`

### Non-obvious notes

- Rust toolchain must be >= 1.86 for `rapier3d` 0.23.1 transitive dependencies (ICU crates). Run `rustup update stable && rustup default stable` if needed.
- The `rapier3d` 0.23.1 API differs from what the original NOTES.md describes. Key changes: no `BroadPhaseBvh` (use `QueryPipeline` directly), `KinematicCharacterController` is in `rapier3d::control`, and `move_shape`/`cast_ray` have different signatures.
- The client's old files (`GameRuntime.ts`, `predictedFpsController.ts`, `voxelWorld.ts`, `connectSpacetime.ts`) depend on `@dimforge/rapier3d-compat` and SpacetimeDB bindings which are excluded from tsconfig for the MVP. The active client entry point is `src/main.tsx`.
- Remote player rendering uses imperative Three.js mesh creation inside a `useFrame` loop on a `<group ref>`. The meshes are colored capsules with player ID labels.
