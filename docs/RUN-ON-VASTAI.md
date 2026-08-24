# Run a GPU game server on Vast.ai

A runbook for renting one box by hand and getting a server running on it. No
control plane, no Cloudflare, no fleet — just the image running somewhere with a
GPU, verified with `curl`. For how the automated fleet does this, see
`ORCHESTRATION.md`.

Budget 10 minutes; most of it is the image pull. The container serves the game
page as well as the game, so one `docker run` is the whole deployment — no
control plane, and nothing to run on your own machine.

## The one thing that will bite you

**Declare the ports when you create the instance. They cannot be added later.**

Vast gives each declared container port a random external port and injects the
mapping as `VAST_UDP_PORT_<internal>`. There is no way to add a port to a
running instance, so a box created without one can never serve players — the
entrypoint detects this and exits `78` on purpose, rather than coming up and
advertising an address nobody can reach.

If you take one thing from this page: **both** ports go in **Docker options** at
create time — `4443` for the game page and `4433/udp` for the game. Neither can
be added later.

## What you need

| | |
|---|---|
| A Vast.ai account with credit | https://vast.ai |
| ~$0.30/hr | a 24 GB datacenter GPU |

The image needs an NVIDIA GPU. Any card the CUDA kernels were compiled for
works: `sm_80` (A100), `sm_86` (A10, 3090), `sm_89` (4090), `sm_90` (H100).
Anything newer JITs from PTX. **24 GB VRAM or more** — the destruction city is
what sets that floor.

### No credentials needed

`ghcr.io/glavin001/vibe-land-server` is **public**. Anonymous `docker pull`
works, and Vast needs no registry login. (A bare `curl` against the GHCR API
answers `401` even for public packages — it wants a token exchange first — so
that is not evidence of the package being private.)

## 1. Pick the image tag

Tags are immutable and named for the commit they were built from. List what has
been published:

```bash
gh api /users/glavin001/packages/container/vibe-land-server/versions \
  --jq '.[0:5][] | .metadata.container.tags[]'
```

Or take the tag from the most recent green `server-image` run:
https://github.com/Glavin001/vibe-land/actions/workflows/server-image.yml

It looks like `sha-eccdc209a2d3`. There is a `latest`, but it only moves on
pushes to `main` — prefer a `sha-` tag so you know exactly what you are running.

## 2. Create the instance

In the Vast.ai console:

1. **Search** for an offer. Filter to **On-Demand**, **Datacenter**, GPU RAM
   **≥ 24 GB**. Reliability ≥ 0.98 and download ≥ 300 Mbps are what the fleet
   asks for and are a good idea by hand too.
2. **Edit Image & Config**:
   - **Image path**: `ghcr.io/glavin001/vibe-land-server:sha-eccdc209a2d3`
   - **Launch mode**: `Entrypoint` (the image has its own — do **not** pick
     Jupyter or SSH, they replace it)
   - **Docker options** — this is the part that cannot be fixed later:
     ```
     -p 4001:4001 -p 4443:4443 -p 4433:4433/udp
     ```
     `4443` is the HTTPS port the game page is served on; `4433/udp` carries
     the game itself; `4001` is plain HTTP for health checks.
   - **Disk**: **30 GB**
3. **Rent**.

Same thing from the CLI, if you have [`vastai`](https://pypi.org/project/vastai/)
set up (`pip install vastai && vastai set api-key <key>`):

```bash
vastai search offers \
  'verified=true rentable=true datacenter=true gpu_ram>=24000 inet_down>=300 dph<0.5' \
  --order 'dph_total' --limit 5

vastai create instance <OFFER_ID> \
  --image ghcr.io/glavin001/vibe-land-server:sha-eccdc209a2d3 \
  --disk 30 \
  --args '-p 4001:4001 -p 4443:4443 -p 4433:4433/udp'
```

Nothing else is required. `PUBLIC_IPADDR` and `VAST_UDP_PORT_4433` are injected
by Vast; the entrypoint reads them, mints a certificate and starts the server.

## 3. Check it came up

Give it a couple of minutes to pull ~650 MB and validate a CUDA scene, then
open the instance's **Logs** in the console. You want:

```
[entrypoint] public endpoint: <ip>:<external-port>/udp (container 4433)
[entrypoint] minting a self-signed P-256 certificate for IP:<ip> (12 days)
[entrypoint] no CONTROL_PLANE_URL: running unmanaged, clients connect to this server directly.
[entrypoint] starting game server
```

Then, from anywhere — the external TCP port is on the instance card, next to
`4001`:

```bash
curl http://<ip>:<external-tcp-port>/healthz
```

```json
{"status":"ok","physics_backend":"physx_gpu","physics_gpu_required":true,
 "sim_hz":60,"snapshot_hz":60,"active_matches":0,"players":0}
```

**`"physics_backend":"physx_gpu"` is the assertion that matters.** It means
PhysX validated a CUDA scene on the real device. Anything else and the GPU is
not being used.

And the address a browser would connect to:

```bash
curl "http://<ip>:<external-tcp-port>/session-config?match_id=demo"
```

```json
{"url":"https://<ip>:<external-udp-port>/game",
 "server_certificate_hash_hex":"28134f1e…"}
```

The `url` host and port must be the **external** ones. If you see `4433` there,
the port mapping was missing and the box is unusable — destroy it and recreate
with the Docker options above.

## 4. Play on it from a browser

The container serves the game page itself. The entrypoint prints the address on
startup — check the instance logs for:

```
[entrypoint]   open:  https://<ip>:<external-4443-port>/city
```

Open it. The browser will warn once about the certificate; accept it and the
page loads. Then the city streams over WebTransport.

### Why HTTPS, and why the warning

A browser refuses to open a WebTransport session from an insecure context, and
`http://<public-ip>` is not one — only `localhost` is exempt. So the page has to
arrive over HTTPS or the game cannot connect at all. The box serves it with the
same self-signed certificate the entrypoint mints for WebTransport, which is why
there is a warning and why accepting it is enough: the page and the game session
are pinned to the very same certificate.

Two consequences worth knowing:

- `/session-config` is fetched **same-origin** from that page, so there is no
  CORS and no mixed content to trip over.
- Plain HTTP on `4001` is still there and unchanged, for health checks and for
  the dev-server proxy. It just cannot host the page.

To lose the warning entirely, mount a real certificate and point
`WT_CERT_PEM`/`WT_KEY_PEM` at it — the entrypoint prefers a supplied certificate
over minting one, and the same pair serves both the page and WebTransport:

```bash
docker run --gpus all \
  -p 4001:4001 -p 4443:4443 -p 4433:4433/udp \
  -v /etc/letsencrypt/live/example.com:/certs:ro \
  -e WT_CERT_PEM=/certs/fullchain.pem -e WT_KEY_PEM=/certs/privkey.pem \
  -e PUBLIC_IPADDR=<your ip> \
  ghcr.io/glavin001/vibe-land-server:<tag>
```

### Alternative: run the client locally

Still supported, and useful when iterating on client code against a remote box.
Point the dev server's proxy at the instance and open `/city` on localhost:

```bash
SERVER_HOST=<instance ip> SERVER_PORT=<external port for 4001> \
  npm --prefix client run dev
```

`client/vite.config.ts` proxies `/session-config`, `/healthz`, `/ws` and
`/city-manifest` there, so the page fetches them same-origin from `localhost` —
which browsers exempt from the secure-context rule. Only metadata crosses the
proxy; QUIC still goes straight to the box.

## Troubleshooting

**Container exits immediately, logs show `exit 78` and `VAST_UDP_PORT_4433 is
not set`.**
The instance was created without the UDP mapping. It cannot be added — destroy
it and recreate with `-p 4433:4433/udp` in Docker options.

**`error while loading shared libraries: libcuda.so.1`.**
No NVIDIA driver is reaching the container. The box has no GPU, or the launch
mode replaced the entrypoint. Check `nvidia-smi` works on the instance.

**`"physics_backend":"rapier"` when you expected `physx_gpu`.**
Something set `VIBE_PHYSICS_BACKEND=rapier`. The image defaults to `physx_gpu`;
`rapier` is the CPU backend and exists for contract checks on machines without a
GPU. Unset it. There is deliberately **no** automatic fallback — if PhysX cannot
get a CUDA scene it fails loudly rather than quietly serving degraded physics.

**Pull fails with `denied`.**
The package is public, so this is not a credentials problem — check the image
path and tag are spelled right.

**It runs but nobody can connect.**
Confirm `/session-config` advertises the external port, and that you are dialling
UDP — the game is WebTransport over QUIC, so a TCP-only path will not work.

## Running it somewhere else

Nothing here is Vast-specific except the port mapping. On any host with an
NVIDIA GPU and the
[container toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):

```bash
docker run --gpus all \
  -p 4001:4001 -p 4443:4443 -p 4433:4433/udp \
  -e PUBLIC_IPADDR=<address players will reach you on> \
  ghcr.io/glavin001/vibe-land-server:sha-eccdc209a2d3
```

With no `VAST_*` variables present the entrypoint runs standalone and publishes
the container's own port. `PUBLIC_UDP_PORT` overrides the advertised port if you
publish on a different one.

## Joining the fleet (optional)

To have the box report to the control plane instead of running unmanaged, add:

| Variable | |
|---|---|
| `CONTROL_PLANE_URL` | the Worker's public URL |
| `HEARTBEAT_TOKEN` | must match the Worker's secret |
| `SERVER_DO_ID` | the row the fleet expects to hear from |
| `MATCHES_PER_BOX` | defaults to 6 |

In practice you do not do this by hand — the fleet sets all four when it rents a
box. See `ORCHESTRATION.md`.
