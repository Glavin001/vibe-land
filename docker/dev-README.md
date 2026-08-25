# vibe-land dev box

You are on a rented GPU running the **toolchain image** — CUDA, a built PhysX 5
SDK, the Blast fork with the GPU stress solver, Rust, Node 22 and wasm-pack.
Everything needed to build and run the whole project is already here. The source
is not: it is cloned on demand so this image does not go stale on every push.

## It may already be running

If this box was created with `--onstart-cmd 'vibe-autostart <ref>'`, it started
cloning and building the moment the container came up, before anyone logged in.
The banner tells you which state it is in:

```bash
cat /root/.vibe-boot-state     # building | ready | failed
tail -f /root/vibe-boot.log
```

The box bills from boot, so the minutes between the container starting and you
connecting are already paid for. Spending them on the cold build is free;
leaving them idle is not.

Re-running is safe — `vibe-autostart` does nothing if the box is already
`ready`, so a recycle will not throw away a warm cache or restart a server
someone is using.

## Just run it

```bash
vibe-up
```

Clones the repo, builds the server and the client, mints a certificate, works
out this box's public address from the container's own port mapping, starts the
server, and prints the URL to open. Re-running skips whatever is already done.

```bash
vibe-up my-branch      # a branch, tag or commit
vibe-up --downtown     # the big scene
vibe-up --rebuild      # force a rebuild
vibe-up --status
vibe-up --stop
```

### Scenes

| Scene | Chunks | How |
| --- | --- | --- |
| `fractured-highrise-10f.json` | small — the default | *(nothing)* |
| `fractured-district.json` | 15,918 | `--scene fractured-district.json` |
| `fractured-downtown.json` | **24,105** | `--downtown` |

The downtown is the one that stresses a small GPU: 27 buildings, 131x153 m, 84 m
at the tallest, ~31,714 t, with ~12 m streets — so a toppling tower reaches its
neighbours and the city can be collapsed onto itself.

`fractured-district.json` deliberately spaces buildings by what they can reach
when they fall, so it **cannot** be knocked over into itself. That spacing exists
for a reason — PhysX sleeps per contact island, and merged rubble fields settle
as one — which makes the district the safer pack and the wrong one for watching
a city come down.

**Restart is the reset.** Destructibles are created in the PhysX scene at
startup and the bridge has no teardown for them, so the only way to get an
undamaged city is a fresh process — re-run `vibe-up`.

## Doing it by hand

```bash
vibe-clone                     # or: vibe-clone <branch|tag|commit>
cd /root/vibe-land
cargo build --release -p web-fps-server --features cuda-stress
(cd client && npm ci && npm run build)
VIBE_PUBLIC_IP=<ip> VIBE_UDP_PORT=<external 4433> scripts/run-city-server.sh
```

`--features cuda-stress`, not just `destruction`. Without it the CUDA stress
solver is compiled out and the CPU one runs **silently**. It does not converge:
measured on the dense downtown, the CPU broke 7,024 bonds where the GPU broke
3,283 on the same scenario. The extra breakage is solver residual, not physics.

## Build caches

`target/` and the cargo registry are symlinked into `/opt/vibe-cache`, so they
survive switching branches and re-cloning. Nothing is prebuilt — the first build
is cold by design, which is the trade for an image that only goes stale when the
toolchain moves. Mount a Vast volume at `/opt/vibe-cache` and you pay that once
per volume instead of once per box.

## Ports

Declared when the instance was created and **not changeable afterwards**. The
external ports differ per instance; `vibe-up` reads them from the container's
own environment.

| Purpose | Container | Notes |
| --- | --- | --- |
| web / `/city` | 4443 | HTTPS. WebTransport refuses to start from an insecure context, so the page must come from here |
| WebTransport | 4433/udp | the game traffic |
| control / health | 4001 | plain HTTP, for the fleet |

```bash
vastai show instance <id> --raw | jq '.ports'
```

## When it loads but will not connect

```bash
curl -sk https://<ip>:<web port>/healthz | jq
```

| Signal | Meaning |
| --- | --- |
| `udp_verified: false`, `session_configs_served` climbing | datagrams are not arriving — this host is not forwarding UDP |
| `wt_connection_attempts` climbing | packets do arrive; the handshake is failing — look at the certificate |
| `active_matches: 0`, match-stats says "unknown match" | matches are created on player connect; nobody got in |

**A bound socket proves nothing.** `PhysicsArena::new()` and `Endpoint::server()`
are both fatal at startup and both precede the web listener, so any box serving
the page has already initialised PhysX and bound UDP. Do not go looking for a
bind failure.

Some hosts accept the UDP port mapping and then never forward the datagrams. The
box looks perfectly healthy — boots, serves `/city`, answers `/healthz` with
`"ok"` — while every player times out on the QUIC handshake. That is what
`udp_verified` exists to catch.

## Things that will cost you an hour if you do not know them

- **`RUST_LOG` unset produces an empty filter — no output at all, not even
  `ERROR`.** `run-city-server.sh` defaults it to `info`.
- **`[destruction] CUDA stress solver active` fires at match creation, not at
  boot.** Its absence in a fresh log is not evidence of a failure; connect a
  player first.
- **You cannot build a Docker image here.** A Vast instance is itself a
  container without nesting privileges. Build the *project* here; build *images*
  in CI.
- **Server config is read once at process start**, so any `VIBE_*` change needs
  a restart.

## Pushing work back

No credentials are baked into this image — it is public on GHCR. Supply them at
runtime:

```bash
cd /root/vibe-land
git remote set-url origin https://<token>@github.com/Glavin001/vibe-land
git config user.name "..." && git config user.email "..."
```

## More

- `docs/CITY-DEBUGGING.md` — the city and its stats overlay
- `docs/PERFORMANCE-ON-SMALL-GPUS.md` — measured baseline and what to optimise
- `docs/ORCHESTRATION.md` — the fleet, the control plane and the images
- `.claude/skills/` — build, run, measure and deploy runbooks
