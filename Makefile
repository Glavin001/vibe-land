.PHONY: setup setup-wasm setup-client setup-blast blast-update dev server client check fmt clean

# ── First-time setup ─────────────────────────────────────────────────────────

## Full first-time setup: copy .env, clone Blast, build WASM, install client deps
setup: .env setup-blast setup-wasm setup-client
	@echo ""
	@echo "Setup complete. Run 'make dev' to start both server and client."

## Clone (or update) the pinned Blast stress solver into third_party/physx.
## See docs/BLAST_INTEGRATION.md for how to bump the pinned SHA.
setup-blast:
	./scripts/setup-blast.sh

## Re-run the Blast vendor step (idempotent; useful after bumping the pinned SHA).
blast-update: setup-blast

.env:
	cp .env.example .env
	@echo "Created .env from .env.example — edit as needed."

## Build the shared WASM module (run after any change to shared/).
## Post-processors:
##  - patch-wasi-stubs.mjs: inlines no-op JS stubs for wasi_snapshot_preview1
##    imports the Blast C++ backend drags in via libc++ / wasi-libc.
##  - patch-wasm-dtors.mjs: neutralises __funcs_on_exit / __stdio_exit in the
##    wasm binary so wasm-bindgen's command_export wrappers stop trapping on
##    every call.  See docs/BLAST_INTEGRATION.md for why both are needed.
setup-wasm:
	cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg
	node scripts/patch-wasi-stubs.mjs
	node scripts/patch-wasm-dtors.mjs

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
