# On-demand GPU game servers

Players get a GPU server when they want one and we stop paying for it when they
leave. A Cloudflare Worker rents boxes from Vast.ai, tracks their health, and
destroys them; the browser then talks straight to the box over WebTransport.

```
 Browser ── GET /join ─────────────► Worker (control-plane/)
    ▲   (poll until ready)              └── FleetDO ── Vast API: search/create/show/destroy
    │                                        ▲
    │  WebTransport QUIC/UDP, direct         │ heartbeat every 30 s (HTTPS 443)
    └────────────────────────► Vast GPU box: docker image → entrypoint → web-fps-server
```

Game traffic never passes through Cloudflare. The control plane hands out an
address plus a certificate hash, and that is the last it is involved.

## Why it is shaped this way

**The control plane never dials a game server.** Vast puts instances on random
high ports behind shared IPs. Everything the fleet knows arrives through
inbound heartbeats, which is also why a server that stops heartbeating is
assumed dead rather than investigated.

**Heartbeats carry the connect metadata.** A rented box serves a self-signed
certificate. Browsers accept that for WebTransport via `serverCertificateHashes`
but reject a plain `fetch()` to the same origin, so the client cannot read
`/session-config` off the box. The server sends it out instead and the control
plane relays it.

**Idle is measured in players, not matches.** A match loop outlives the last
player in it — the process keeps the PhysX scene alive — so match count never
returns to zero and would keep a box alive forever.

**Destroy, never stop.** A stopped Vast instance still bills for disk. If the
DELETE call fails the row stays put and retries on the next tick; a box is only
marked dead once Vast has confirmed it is gone. Orphan prevention outranks tidy
state.

**Hard caps are not optional.** Uptime and spend caps destroy a box even while
it reports itself healthy, because the expensive failure is a wedged server that
keeps heartbeating.

## Running it locally

Everything except the image build runs on a dev box:

```bash
./scripts/dev-orchestration.sh up       # mock Vast + control plane + GPU server
./scripts/dev-orchestration.sh status   # what the fleet thinks
./scripts/dev-orchestration.sh logs
./scripts/dev-orchestration.sh down
```

`up` starts a fake Vast marketplace (`control-plane/mock-vast/server.mjs`), a
`wrangler dev` control plane, asks it for a server, and then plays the part of
the entrypoint: it starts the real game server with the env a rented box would
receive. Only the marketplace is fake.

Then point a browser at the client with a control plane attached:

```
https://<host>:<client-port>/city?controlPlane=/cp
```

`/cp` is proxied to `wrangler dev` by the Vite config. Use the proxy rather than
an absolute `http://` URL: the dev server serves HTTPS whenever WebTransport
certificates are configured, and a browser refuses to let an HTTPS page fetch an
HTTP control plane. In production both sides are HTTPS and no proxy exists, so
`VITE_CONTROL_PLANE_URL` takes the Worker URL directly.

Or verify it headlessly, which asserts the full path including the QUIC
handshake and that the fleet observes the connected player:

```bash
node scripts/verify-orchestration-browser.mjs http://127.0.0.1:5556 http://127.0.0.1:9001
```

### Tests

```bash
cd control-plane && npm test     # fleet lifecycle: reaping, retries, caps
cd client && npx vitest run src/app/join.test.ts
cargo test -p web-fps-server heartbeat::
./scripts/smoke-entrypoint.sh    # container contract, no Docker needed
```

The control-plane suite is written against the failure modes rather than the
happy path: heartbeat loss, spend cap with phantom players, a DELETE that keeps
failing, and an eviction mid-create that must adopt the instance it already paid
for instead of renting a second one.

## The image

Two images, because image pull time is cold-start time a player waits through
and the toolchain must not travel to production.

| Image | Contents | Rebuilt |
|---|---|---|
| `vibe-land-builder` | CUDA 12.8 devel, PhysX 5, Blast, Rust (~15 GB) | when `docker/Dockerfile.builder` changes, or on dispatch |
| `vibe-land-server` | Ubuntu + the binary, `libPhysXGpu_64.so`, `libcudart`, scenes | every push that touches the server (~400 MB) |

The split is about caching, not compile time. Building PhysX is not the ordeal
it looks like: `libPhysXGpu_64.so` is a 347 MB closed CUDA blob that packman
downloads prebuilt, and what actually compiles is ~17 MB of static libs — a
short clang build. The builder image earns its place because it is built once
and reused by every deploy, so a per-commit build pays neither the download nor
the compile.

The server binary is built with `--features cuda-stress`, not just
`destruction`. Without it `NVBLAST_ENABLE_CUDA_STRESS` is undefined and the
stress solver silently falls back to the CPU, which cannot afford to converge:
on the dense downtown the CPU solver broke 7,024 bonds where the GPU broke
3,283 on the same scenario. The extra breakage is solver residual, not physics.
The CUDA kernel is compiled for `sm_80,sm_86,sm_89,sm_90` with a PTX fallback,
because the fleet rents whatever the marketplace has spare.

```bash
./scripts/build-image.sh                  # tags sha-<commit>
./scripts/smoke-image.sh <image:tag>      # needs a GPU host with Docker
./scripts/smoke-image.sh --cpu <image>    # everything but the GPU assertions
```

### Run one yourself

The image is self-contained: the only thing it needs from the host is the
driver, which arrives through the [NVIDIA container
toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

```bash
docker run --gpus all \
  -p 4001:4001 -p 4433:4433/udp \
  -e PUBLIC_IPADDR=<the address players will reach you on> \
  ghcr.io/glavin001/vibe-land-server:latest
```

`CONTROL_PLANE_URL` is optional. Without it the server runs unmanaged — no
heartbeats, no fleet, clients connect to it directly — which is the whole point
of the standalone path. `PUBLIC_UDP_PORT` overrides the advertised port when
the published port differs from the container's.

On Vast the entrypoint behaves differently on purpose: a `VAST_*` environment
with no UDP mapping exits 78 rather than starting, because the port cannot be
added to a running instance and a box that can never serve players should be
replaced rather than kept.

The entrypoint (`docker/entrypoint.sh`) resolves `VAST_UDP_PORT_<internal>` and
`PUBLIC_IPADDR`, mints a 12-day ECDSA P-256 certificate with the public IP as a
SAN, and execs the server. If the UDP mapping is missing it exits 78 rather than
starting: ports cannot be added to a running Vast instance, so a box without one
can never serve players, and failing fast gets it replaced.

> Docker cannot run on a Vast dev box — the instance is itself a container with
> no privilege to nest another. `scripts/smoke-entrypoint.sh` asserts the same
> contract natively (certificate shape, advertised endpoint, published hash);
> the image itself is built and smoke-tested in CI.

## Deploying

`.github/workflows/server-image.yml` is the single definition of the image
build. A push to any branch but `main` builds and publishes
`vibe-land-server:sha-<commit>` and then verifies it on a GPU-less runner —
every library resolves, the bundle is complete, and the container serves
`/healthz`, the right advertised endpoint and a pinned certificate hash.
`.github/workflows/deploy.yml` runs on pushes to `main` and *calls* that same
workflow, so what deploys is exactly what a branch exercised; it then runs the
control-plane tests, deploys the Worker with `SERVER_IMAGE` set to the image
just built, and checks `/fleet` reports it. Live instances are
unaffected — fleet state lives in the Durable Object and running boxes keep
serving the image they booted with until their uptime cap retires them.

### Required configuration

| Secret | Purpose |
|---|---|
| `VAST_API_KEY` | rent and destroy instances |
| `CLOUDFLARE_API_TOKEN` | `wrangler deploy` |
| `HEARTBEAT_TOKEN` | shared with every game server; authenticates heartbeats |
| `ADMIN_TOKEN` | `/fleet` and `/kill` |
| `GHCR_PULL_TOKEN` | `read:packages`; handed to Vast to pull the private image |

| Variable | Purpose |
|---|---|
| `BUILDER_IMAGE_TAG` | which toolchain image to compile against; optional, defaults to the tag `builder-image` publishes |
| `CONTROL_PLANE_URL` | public Worker URL, injected into every instance |

## Tuning

Worker vars, all in `control-plane/wrangler.jsonc`:

| Var | Default | Effect |
|---|---|---|
| `MATCHES_PER_BOX` | 6 | matches one box will host |
| `MAX_PLAYERS_PER_MATCH` | 16 | when a box is considered full |
| `IDLE_SHUTDOWN_MIN` | 10 | empty for this long → destroyed |
| `MAX_INSTANCE_UPTIME_H` | 6 | hard cap regardless of health |
| `MAX_INSTANCE_SPEND_USD` | 5 | hard cap on estimated spend |
| `BOOT_TIMEOUT_MIN` | 7 | booting longer than this → try another host |
| `HEARTBEAT_TIMEOUT_SEC` | 90 | silence for this long → destroyed |
| `MAX_PROVISION_ATTEMPTS` | 5 | hosts tried before reporting no capacity |

## Known gaps

- **No join tickets yet.** Anyone who can reach a box's UDP port can connect to
  it; `/join` is the only discovery path but it is not a credential. The server
  needs ticket verification before this is public.
- **One box at a time.** A second player arriving during a cold start waits for
  the first player's box rather than triggering a second rental.
- **`vast.ts` is written against the v0 API from documentation.** The mock
  mirrors it exactly, but the shapes need confirming against the real
  marketplace before the first production deploy.
- **The GPU assertions only run on a real box.** CI has no GPU, so
  `server-image.yml` runs `smoke-image.sh --cpu`: it proves the image is
  well-formed but not that PhysX validated a CUDA scene. Clear a new image for
  deploy by running `smoke-image.sh` without `--cpu` on a rented host, which is
  the only place `"physics_backend":"physx_gpu"` can be observed.
- **The first build has to wait for the toolchain.** `builder-image` and
  `server-image` are triggered by the same push and run concurrently, so a
  commit that changes both will build the server against a toolchain image that
  does not exist yet. Re-run `server-image` once the builder lands. Only the
  first one is affected; after that the toolchain is already published.

## Verified on a phone

The full path -- `/join`, a box rented on demand, a browser connecting straight
to it over WebTransport, a GPU destruction city streaming -- runs on iOS Safari
over both WiFi and cellular, with the manifest and per-match stats arriving on
the session rather than over HTTP.

Getting there turned up three things worth remembering, all documented in
`NETCODE_NOTES.md`:

- Safari can receive WebTransport datagrams but not send them, which silently
  demoted every iPhone to WebSocket while looking perfectly healthy.
- A manifest fetched over HTTP cannot work on a rented box, so a match would
  connect and simulate while rendering nothing.
- Endpoint mistakes look like browser crashes. A control plane advertising a
  loopback address sent the phone to dial itself; the connection failed, the
  session dropped back to the join screen, and it read as the page reloading.

`client/public/wt-diag.html` probes each capability separately on a device with
no devtools, and the client records the connect phase it is in -- including a
localStorage breadcrumb that survives an iOS memory reload. Both exist because
reasoning about the phone from here was consistently wrong.
