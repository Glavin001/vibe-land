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
| `vibe-land-builder` | CUDA 12.8 devel, PhysX 5, Blast, Rust, Node 22 + wasm-pack (~19 GB) | when `docker/Dockerfile.builder` or `docker/vibe-clone` changes, or on dispatch |
| `vibe-land-server` | Ubuntu + the binary, `libPhysXGpu_64.so`, `libcudart`, scenes, the built client | every push that touches the server (689 MB) |

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
The CUDA kernel is compiled for `sm_70` through `sm_120` -- Volta to Blackwell,
eight architectures -- with a PTX fallback above that, because the fleet rents
whatever the marketplace has spare and the cheapest supply is the oldest. The
floor is Volta rather than Pascal because PTX only JITs forward: below the
lowest cubin there is no rescue. The list lives in `docker/Dockerfile`, not the
toolchain image, since it is a decision about where the fleet may land.

```bash
./scripts/build-image.sh                  # tags sha-<commit>
./scripts/smoke-image.sh <image:tag>      # needs a GPU host with Docker
./scripts/smoke-image.sh --cpu <image>    # everything but the GPU assertions
```

### Run one yourself

To rent a single Vast box by hand and get a server on it, follow
[`RUN-ON-VASTAI.md`](RUN-ON-VASTAI.md) — a step-by-step runbook, including the
one mistake that cannot be undone (the UDP port has to be declared when the
instance is created).

Anywhere else, the image is self-contained: the only thing it needs from the
host is the driver, which arrives through the [NVIDIA container
toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
The package is private, so `docker login ghcr.io` with a `read:packages` token
first. `latest` only moves on pushes to `main`; a `sha-` tag is what a branch
build publishes and what the fleet is pinned to.

```bash
docker run --gpus all \
  -p 4001:4001 -p 4443:4443 -p 4433:4433/udp \
  -e PUBLIC_IPADDR=<the address players will reach you on> \
  ghcr.io/glavin001/vibe-land-server:latest
```

Then open `https://<ip>:4443/city`. The image carries the built client and
serves it over TLS on `WEB_BIND_ADDR`, because a browser will not open a
WebTransport session from an insecure context and `http://<public-ip>` is not
one. The certificate is the same self-signed one WebTransport pins, so the
browser warns once; supplying `WT_CERT_PEM`/`WT_KEY_PEM` removes the warning.
Plain HTTP on `4001` is unchanged and still serves health checks and the
dev-server proxy — it just cannot host the page.

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

## The city a box serves

`docker/entrypoint.sh` sets `VIBE_CITY_SCENE=fractured-downtown.json` and
`VIBE_CITY_GRID=1`, so a deployed box serves the real city: 27 buildings,
24,105 chunks, 131x153 m, ~12 m streets.

**It did not always.** The entrypoint set no scene, so the server fell back to
the compiled-in default in `server/src/city.rs` -- `high-rise-3f-local.json`, a
three-floor block. A rented box reported 2,919 chunk bodies and 16 structures
and looked completely healthy, because it was: it was healthily serving a toy.
`scripts/smoke-image.sh` now asserts both that the downtown ships and that the
entrypoint selects it.

Override per box; both are read once at process start, so a change needs a
fresh instance:

```
-e VIBE_CITY_SCENE=fractured-highrise-10f.json    # small, for a weak box
-e VIBE_CITY_GRID=1                                # see below before raising
```

**Do not raise the grid on the downtown.** That pack is already a laid-out
block spanning 289x273 m; the grid tiles whole districts and multiplies 24,105
chunks by grid squared. Grid is for widening a *single-building* pack.

| Scene | Chunks | Use |
| --- | --- | --- |
| `high-rise-3f-local.json` | ~180/building | local iteration only — the old accidental default |
| `fractured-highrise-10f.json` | small | fast iteration on stress behaviour |
| `fractured-district.json` | 15,918 | spaced so it **cannot** collapse onto itself |
| `fractured-downtown.json` | **24,105** | the shipped default |

## Renting a box on Vast.ai

Two products, two launch modes, and getting the mode wrong is the single most
common way to end up with a box you cannot use.

| | Production server | Dev box |
| --- | --- | --- |
| Image | `ghcr.io/glavin001/vibe-land-server:sha-<12>` | `ghcr.io/glavin001/vibe-land-builder:cuda12.8-physx-ovphysx-5.5.1` |
| Launch mode | `--args` — container as-is, runs the ENTRYPOINT, **no SSH** | `--ssh --direct` — SSH injected, **ENTRYPOINT not run** |
| Disk | 25 GB | 80 GB |
| Starts itself | yes, the image's entrypoint | yes, via `--onstart-cmd 'vibe-autostart'` |
| Your channel | `vastai logs <id>` only | a shell |

Both need the same ports, and **ports can only be declared at creation**:

```
-p 4001:4001 -p 4443:4443 -p 4433:4433/udp
```

### Templates

A Vast template saves image, ports, disk, on-start and the offer filter, so
renting becomes picking a host. Create one at
<https://cloud.vast.ai/templates/>; the exact field values for the dev box are
in `.claude/skills/vastai-deploy/SKILL.md`, along with why each one matters.

Creating a template **from the CLI needs an API key with `api.template`
access** — an ordinary instance key fails with `Authorization Error. Your key
lacks the api.template route access`, which the CLI surfaces only as `The
response is not valid JSON`.

### Pick a host that forwards UDP

```
reliability>0.98 num_gpus=1 cuda_max_good>=12.8 direct_port_count>=256
inet_up>=200 rentable=true disk_space>=80 compute_cap>=700
```

`direct_port_count>=256` is the filter that matters. Some hosts accept the UDP
port mapping and never forward the datagrams: the box boots, heartbeats, serves
`/city` and answers `/healthz` with `"ok"` while every player times out on the
QUIC handshake — and it bills the whole time. Observed correlation is 2/2 above
that threshold working and 3/3 below it failing (n=5, so a strong hint rather
than a law), and **`datacenter` does not predict it** — a datacenter 3090 in
Czechia black-holed UDP. The server also self-tests at boot and exits 78 rather
than billing silently.

### Dev box, start to finish

```bash
vastai create instance <offer_id> \
  --image ghcr.io/glavin001/vibe-land-builder:cuda12.8-physx-ovphysx-5.5.1 \
  --disk 80 --ssh --direct \
  --env '-p 4001:4001 -p 4443:4443 -p 4433:4433/udp' \
  --onstart-cmd 'vibe-autostart --downtown <branch>'

vastai ssh-url <id>      # read the port from here, never from memory
```

The box clones, compiles the server and client, mints a certificate and starts
a 24,105-chunk city before you can log in. `cat /root/.vibe-boot-state` says
`building`, `ready` or `failed`; `/root/README.md` on the box covers the rest.

**Read the SSH port from the API each time.** `vastai recycle` remaps host
ports, so a command that worked five minutes ago can start refusing
connections.

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
- **There is no automatic CPU fallback, and the image needs a driver to start
  at all.** `physx_gpu` and `rapier` are separate backends chosen by
  `VIBE_PHYSICS_BACKEND`; PhysX itself has none (`physx-bridge/src/lib.rs`).
  Worse, the binary carries `libcuda.so.1` as a hard `DT_NEEDED`, so with no
  driver the loader kills it before the backend is ever read. That is why the
  bundle carries a CUDA driver stub in `lib-stubs/`, off the library path, which
  only `smoke-image.sh --cpu` opts into. Adding a real fallback would be worse
  than the failure: a box whose CUDA init quietly failed would serve a different
  snapshot rate and client movement mode while heartbeating healthy, and the
  fleet would keep paying for it.
- **`server-image` waits for the toolchain, and now does so by itself.**
  `builder-image` and `server-image` are triggered by the same push and run
  concurrently, so a commit that changes both would build the server against the
  *previously* published toolchain. That is not theoretical: commit 1884281
  moved Node into the builder, and `server-image` failed in 5m20s with
  `npm: command not found` in the `web` stage while the correct builder was
  still ten minutes out. `server-image.yml` now polls for a `builder-image` run
  on the same commit and blocks until it succeeds — no run means the toolchain
  did not change and the published tag is already right.

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
