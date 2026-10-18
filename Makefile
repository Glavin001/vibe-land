.PHONY: setup setup-wasm setup-client dev server client check fmt clean \
	moq-publisher moq-publish moq-check moq-e2e

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

# ── MoQ world-state demo (moq/) ──────────────────────────────────────────────
#
# The publisher is its own Cargo workspace so its QUIC dependency tree stays out
# of `make check`. See moq/README.md.

## Build the MoQ world-state publisher
moq-publisher:
	cd moq/publisher && cargo build

## Publish world state to a relay:
##   MOQ_RELAY_URL=https://draft-16.cloudflare.mediaoverquic.com/<publish-token> make moq-publish
## The publisher reads the environment directly and does not load .env, so
## export the variable or pass it on the command line as above.
moq-publish:
	@test -n "$(MOQ_RELAY_URL)" || { \
	  echo "Set MOQ_RELAY_URL to your relay endpoint with a publish token in the path."; \
	  echo "See moq/README.md."; exit 1; }
	cd moq/publisher && cargo run

## Check + test the MoQ publisher (its own workspace, so `make check` misses it)
moq-check:
	cd moq/publisher && cargo fmt --check && cargo clippy --all-targets && cargo test

## End-to-end: local relay + publisher + headless Chromium.
## Needs moq-relay-ietf built from github.com/cloudflare/moq-rs; point
## MOQ_RELAY_BIN at it, or leave a moq-rs checkout beside this repo.
moq-e2e:
	node moq/e2e/verify-local.mjs

# ── Misc ─────────────────────────────────────────────────────────────────────

## Remove build artifacts
clean:
	cargo clean
	rm -rf client/src/wasm/pkg
