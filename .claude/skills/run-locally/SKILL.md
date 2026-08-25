---
name: run-locally
description: Run the vibe-land stack on a dev box — game server, client, the city world, and the full orchestration stack — plus the WebTransport certificate requirements that make it connect. Use when starting the app locally, when the page loads but the game will not connect, or when a local server needs restarting on a clean city.
---

# Running vibe-land locally

## The two things that trip people up

**1. WebTransport needs a secure context.** A browser refuses to open a
WebTransport session from an insecure origin. `localhost` is exempt — anything
else is not. That is why running the client locally against a rented box works
while serving the same page over plain HTTP from that box does not.

**2. The certificate pin is strict.** `serverCertificateHashes` requires ECDSA
P-256, and Chrome refuses any certificate valid for more than 14 days *or*
already expired. **The page still loads either way** — it just says "Not Secure"
— so an expired cert presents as "the game will not connect", with
`QUIC_TLS_CERTIFICATE_UNKNOWN` buried in the console and nothing wrong
server-side.

```bash
./scripts/check-wt-cert.sh        # non-zero if expired or expiring soon
```

Run this first whenever a local session stops connecting. A 14-day cert is a
scheduled outage unless something watches it.

## Client

```bash
cd client
npm install
npm run dev          # predev builds the wasm packages automatically
```

`npm run build:wasm` builds two wasm packages — `shared` and
`research/destruction-codec`. It needs `wasm-pack` (auto-installed by
`ensure:wasm-pack`) and **`clang`**, because `zstd` compiles through `cc-rs` and
gcc cannot target wasm32.

The dev server proxies to the game server. Override with `.env` at the repo root:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVER_HOST` | `localhost` | game server host — **point this at a rented box** |
| `SERVER_PORT` | `4001` | game server HTTP port |
| `CLIENT_PORT` | `3001` | vite port |
| `WT_CERT_PEM` | — | set it and the dev server switches to HTTPS |

Pointing `SERVER_HOST`/`SERVER_PORT` at a remote box is the supported way to
play against a rented server from a local client.

## Game server

For the destructible city, use the script rather than `cargo run`:

```bash
./scripts/run-city-server.sh            # restart on the release build
./scripts/run-city-server.sh --status   # up? and how did the last one die
./scripts/run-city-server.sh --stop
./scripts/run-city-server.sh --debug
```

**Restart is the reset.** Destructibles are created in the PhysX scene at
startup and the bridge has no teardown for them, so a fresh process is the only
way to get an undamaged city.

The script also records `EXIT_STATUS`. A city server that segfaults under load
looks identical to one that exited cleanly if you only check whether the process
is gone — that is what caught a SIGSEGV a liveness check was reporting as
"server not running".

**Release is the default deliberately.** Debug builds carry 10–20× overhead on
every CPU phase of the tick, which is enough to make an in-budget server look
hopelessly slow. A profile taken from one sent this project chasing
optimizations it did not need.

Without a GPU, select the CPU backend:

```bash
VIBE_PHYSICS_BACKEND=rapier cargo run -p web-fps-server
```

## Full orchestration stack

Exercises the real control plane against a real game server, faking only the
Vast marketplace:

```bash
./scripts/dev-orchestration.sh up       # start everything, wait for READY
./scripts/dev-orchestration.sh status
./scripts/dev-orchestration.sh logs
./scripts/dev-orchestration.sh down
```

## Local R2 (MinIO)

```bash
npm run r2:up      # docker compose up -d
npm run r2:test
npm run r2:down
```

## Choosing a city

The default scene is small. Bigger ones cost more per tick — see
`docs/PERFORMANCE-ON-SMALL-GPUS.md` before scaling up.

| Scene | chunks | bonds | note |
| --- | ---: | ---: | --- |
| `high-rise-3f-local.json` | 318 | 1,083 | **default**, all cuboid |
| `high-rise-10f-local.json` | 1,032 | 3,624 | largest all-cuboid pack |
| `fractured-district.json` | 15,918 | 48,670 | ~34% convex hull |
| `fractured-downtown.json` | 24,105 | 74,543 | ~30% convex hull |

```bash
VIBE_CITY_SCENE=high-rise-10f-local.json VIBE_CITY_GRID=4 ./scripts/run-city-server.sh
```

**Hull chunks render as axis-aligned boxes** on the client, so the two large
scenes look like interpenetrating slabs even though the colliders are correct
(`server/src/city.rs:118`). Physics is right; visuals are not. Prefer all-cuboid
packs unless you specifically want the scale.

`VIBE_CITY_GRID` is the grid edge in buildings (1–16, default 4), so a grid of 4
is 16 buildings.

## Tests

```bash
cd client && npm run lint      # tsc --noEmit
cd client && npm test          # vitest
cd control-plane && npm test   # guards the fleet reaper — it spends money
cargo check && cargo fmt --all --check
cargo test
```

`cargo fmt --all --check` currently fails on the base branch (~325 diffs across
39 files). CI runs fmt **before** `cargo test`, so a fmt failure means the test
suite never ran — do not read a red Rust job as a test failure without checking
which step died.

## E2E

```bash
cd client && npm run e2e
```

City specs need a running server and are gated behind `E2E_CITY=1`:

```bash
E2E_CITY=1 E2E_CITY_WIRE=3 E2E_SKIP_WEB_SERVER=1 \
E2E_BASE_URL=https://127.0.0.1:6006 \
npx playwright test --config e2e/playwright.config.ts city-frame-profile
```

**To target a remote box, set `E2E_CITY_WT_URL=off`.** The default rewrites
`/session-config` to `127.0.0.1:4434` for a local stack, which would point the
run at nothing. The suite fails loudly if the session lands on WebSocket instead
of WebTransport — the two differ in exactly the way that matters for the pose
stream, and a whole investigation was once run against the wrong wire.

## netlab

The netcode measurement harness — turns "I see rubber-banding" into a
reproducible run with a layer verdict:

```bash
cd client
npm run netlab -- list-scenarios
npm run netlab -- run --scenario city-strafe --stack dev
npm run netlab -- run --scenario city-strafe --stack dev --impair lte
npm run netlab -- compare <baselineIterDir> <impairedIterDir>
```

24 scenarios live in `client/netlab/scenarios/`. Read `report.md` first.
