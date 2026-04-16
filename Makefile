.PHONY: setup setup-wasm setup-client dev server client check fmt clean

# ── First-time setup ─────────────────────────────────────────────────────────

## Full first-time setup: copy .env, build WASM, install client deps
setup: .env setup-wasm setup-client
	@echo ""
	@echo "Setup complete. Run 'make dev' to start both server and client."

.env:
	cp .env.example .env
	@echo "Created .env from .env.example — edit as needed."

## Build the shared WASM module (run after any change to shared/).
##
## The `blast-stress-solver` crate is published on crates.io with
## prebuilt wasm32 static libraries, so no local PhysX clone or C++
## toolchain is required.  Pass VIBE_NO_DESTRUCTIBLES=1 to build
## without the destructibles feature for faster iteration.
setup-wasm:
	./scripts/build-shared-wasm.sh

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

server-with-logs:
	cd server && RUST_LOG=info RUST_BACKTRACE=1 cargo run 2>&1 | tee /tmp/vibe-server.log

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
