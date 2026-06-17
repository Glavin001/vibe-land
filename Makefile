.PHONY: setup setup-wasm setup-client setup-root \
        dev server client api api-dev \
        build build-wasm build-client build-server \
        start start-prod stop-prod \
        check check-server check-client fmt clean

# ── First-time setup ─────────────────────────────────────────────────────────

## Full first-time setup: copy .env, build WASM, install client + root deps
setup: .env setup-wasm setup-client setup-root
	@echo ""
	@echo "Setup complete."
	@echo "  make dev   — dev mode (Vite + Rust server + API)"
	@echo "  make build — build everything for production"
	@echo "  make start — run the production stack"

.env:
	cp .env.example .env
	@echo "Created .env from .env.example — edit as needed."

## Build the shared WASM module (run after any change to shared/)
setup-wasm:
	cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg

## Install client npm dependencies
setup-client:
	cd client && npm install

## Install root npm dependencies (tsx for the API server + AWS SDK for R2)
setup-root:
	npm install

# ── Development ──────────────────────────────────────────────────────────────

## Start Rust server + Vite client + Node API in parallel (needs `make setup`)
dev:
	@trap 'kill 0' INT; \
	  (cd server && RUST_LOG=info cargo run) & \
	  (cd client && npm run dev) & \
	  (npm run api:dev) & \
	  wait

## Start only the game server
server:
	cd server && RUST_LOG=info cargo run

server-with-logs:
	cd server && RUST_LOG=info RUST_BACKTRACE=1 cargo run 2>&1 | tee /tmp/vibe-server.log

## Start only the Vite client dev server
client:
	cd client && npm run dev

## Start only the Node API server (watch mode)
api api-dev:
	npm run api:dev

# ── Production build ─────────────────────────────────────────────────────────
# `make build` produces three artifacts:
#   * client/src/wasm/pkg       (shared physics WASM)
#   * client/dist/              (SPA bundle served as static files)
#   * target/release/server     (Rust game server binary)

## Build everything for production
build: build-wasm build-client build-server
	@echo ""
	@echo "Build complete. Run 'make start' to launch the production stack."

build-wasm:
	cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg

build-client: build-wasm
	cd client && npm ci && npm run build

build-server:
	cargo build --release -p server

# ── Production run ───────────────────────────────────────────────────────────
# `make start` runs both processes in the foreground for simple deployments.
# It expects `.env` to be populated (including WORLDS_STORAGE_DIR or R2_*)
# and uses the compiled artifacts from `make build`.
#
# By default the Node API also serves the SPA bundle on the same port
# (SERVE_STATIC=1), so a single port (API_PORT, default 3000) carries the
# full web surface. Put nginx in front for TLS, or set SERVE_STATIC=0 when
# nginx already serves client/dist directly.
#
# WebTransport runs on UDP and is NOT proxied by nginx — the Rust server
# binds WT_BIND_ADDR directly and must be reachable from browsers.

## Start the production stack (Rust server + Node API serving SPA)
start: start-prod

start-prod:
	@if [ ! -f target/release/server ]; then \
	  echo "target/release/server missing — run 'make build' first." >&2; exit 1; \
	fi
	@if [ ! -f client/dist/index.html ]; then \
	  echo "client/dist missing — run 'make build' first." >&2; exit 1; \
	fi
	@trap 'kill 0' INT TERM; \
	  (RUST_LOG=info ./target/release/server) & \
	  (SERVE_STATIC=$${SERVE_STATIC:-1} npm run api:start) & \
	  wait

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
	rm -rf client/src/wasm/pkg client/dist
