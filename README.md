# vibe-land

Browser-first multiplayer FPS prototype with:

- Rust authoritative simulation server (Axum + Rapier3D)
- Browser-side client-side prediction via shared WASM physics (wasm-pack)
- WebSocket netcode with lag compensation and snapshot interpolation
- three.js / React Three Fiber client

See `NETCODE_NOTES.md` for netcode design and current caveats.

## Quick start

```bash
cp .env.example .env

# Build shared WASM module
cd shared && wasm-pack build --target web --out-dir ../client/pkg && cd ..

# Terminal 1 — game server
cd server && RUST_LOG=info cargo run

# Terminal 2 — web client
cd client && npm install && npx vite
```

Open `http://localhost:3001` and click to join.

See `AGENTS.md` for full setup details, lint, and build instructions.
