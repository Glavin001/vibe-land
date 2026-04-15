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
##
## `ensure-blast-stub.sh` drops a placeholder crate into
## `third_party/physx/blast/blast-stress-solver-rs/` when the real
## PhysX clone is missing, so Cargo's optional path dependency
## always resolves (see docs/BLAST_INTEGRATION.md).  If the real
## clone is present we also pass `--features destructibles` to
## compile the real Blast backend into the wasm module; otherwise
## the no-op backend keeps the JS bindings intact without the C++
## toolchain.
setup-wasm:
	./scripts/ensure-blast-stub.sh
	@if [ -d third_party/physx/.git ]; then \
	  echo "[make setup-wasm] building shared wasm WITH destructibles feature"; \
	  cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg -- --features destructibles; \
	else \
	  echo "[make setup-wasm] building shared wasm WITHOUT destructibles feature (no PhysX clone)"; \
	  cd shared && wasm-pack build --target web --out-dir ../client/src/wasm/pkg; \
	fi

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
