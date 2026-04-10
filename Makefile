.PHONY: setup setup-wasm setup-client dev server client check fmt clean

# ── First-time setup ─────────────────────────────────────────────────────────

## Full first-time setup: copy .env, build WASM, install client deps
setup: .env setup-wasm setup-client
	@echo ""
	@echo "Setup complete. Run 'make dev' to start both server and client."

.env:
	cp .env.example .env
	@echo "Created .env from .env.example — edit as needed."

## Build the shared WASM module (run after any change to shared/)
setup-wasm:
	cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg

## Install client npm dependencies
setup-client:
	cd client && npm install

# ── Development ──────────────────────────────────────────────────────────────

## Start server + client in parallel (requires 'make setup' first)
dev:
	@trap 'kill 0' INT; \
	  (cd server && RUST_LOG=info cargo run) & \
	  (cd client && npm run dev) & \
	  wait

## Start only the game server
server:
	cd server && RUST_LOG=info cargo run

## Start only the Vite client dev server
client:
	cd client && npm run dev

# ── Checks ───────────────────────────────────────────────────────────────────

## Run all checks (Rust + TypeScript)
check: check-server check-client

check-server:
	cargo check

check-client:
	cd client && npx tsc --noEmit

## Rust format check
fmt:
	cargo fmt --check

# ── Misc ─────────────────────────────────────────────────────────────────────

## Remove build artifacts
clean:
	cargo clean
	rm -rf client/src/wasm/pkg
