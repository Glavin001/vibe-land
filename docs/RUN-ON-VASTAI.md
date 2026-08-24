# Run a GPU game server on Vast.ai

A runbook for renting one box by hand and getting a server running on it. No
control plane, no Cloudflare, no fleet — just the image running somewhere with a
GPU, verified with `curl`. For how the automated fleet does this, see
`ORCHESTRATION.md`.

Budget 10 minutes; most of it is the image pull. Step 4 gets a browser onto the
box with `/city` rendering, no control plane involved.

## The one thing that will bite you

**Declare the UDP port when you create the instance. It cannot be added
later.**

Vast gives each declared container port a random external port and injects the
mapping as `VAST_UDP_PORT_<internal>`. There is no way to add a port to a
running instance, so a box created without one can never serve players — the
entrypoint detects this and exits `78` on purpose, rather than coming up and
advertising an address nobody can reach.

If you take one thing from this page: the ports go in **Docker options** at
create time.

## What you need

| | |
|---|---|
| A Vast.ai account with credit | https://vast.ai |
| A GitHub token with `read:packages` | the image is private — see below |
| ~$0.30/hr | a 24 GB datacenter GPU |

The image needs an NVIDIA GPU. Any card the CUDA kernels were compiled for
works: `sm_80` (A100), `sm_86` (A10, 3090), `sm_89` (4090), `sm_90` (H100).
Anything newer JITs from PTX. **24 GB VRAM or more** — the destruction city is
what sets that floor.

### Pull credentials

`ghcr.io/glavin001/vibe-land-server` is a private package, so an anonymous pull
gets a `401`. Create a classic GitHub token with the **`read:packages`** scope
at https://github.com/settings/tokens and keep it handy; Vast needs it to pull.

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
   - **Docker repository authentication**: username = your GitHub login,
     password = the `read:packages` token
   - **Launch mode**: `Entrypoint` (the image has its own — do **not** pick
     Jupyter or SSH, they replace it)
   - **Docker options** — this is the part that cannot be fixed later:
     ```
     -p 4001:4001 -p 4433:4433/udp
     ```
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
  --login '-u <GITHUB_USER> -p <READ_PACKAGES_TOKEN> ghcr.io' \
  --disk 30 \
  --args '-p 4001:4001 -p 4433:4433/udp'
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

This is the part that looks impossible and is not. Point the **dev server's
proxy** at your box and open `/city`:

```bash
# from the repo root
SERVER_HOST=<instance ip> SERVER_PORT=<external port mapped to 4001> \
  npm --prefix client run dev
```

Then open **http://localhost:5555/city** (or whatever `CLIENT_PORT` says).

That is the whole recipe. `client/src/app/join.ts` says why it works: with no
control plane configured it is inert and the client "keeps connecting straight
to whatever `VITE_MULTIPLAYER_HTTP_ORIGIN` points at, which is how local
development and the hand-run box keep working."

### Why the proxy rather than a direct URL

There is no `?server=<ip>` parameter, and pointing
`VITE_MULTIPLAYER_HTTP_ORIGIN` straight at `http://<ip>:4001` from a page served
over HTTPS will not work either. Two constraints collide:

- WebTransport needs a **secure context**, so the page must be HTTPS — except on
  `localhost`, which browsers exempt.
- The box's certificate is self-signed. `serverCertificateHashes` rescues the
  QUIC handshake, but a plain `fetch()` for `/session-config` over HTTPS to that
  origin is rejected, and over plain HTTP from an HTTPS page it is blocked as
  mixed content.

`client/vite.config.ts` already proxies `/session-config`, `/healthz`, `/ws` and
`/city-manifest` to `SERVER_HOST:SERVER_PORT`, so the page fetches them
**same-origin** from `localhost` and neither constraint applies. The browser
learns the certificate hash, then dials the box's UDP port directly over QUIC.
Game traffic never goes through the proxy — only the metadata does.

This is the same problem the control plane exists to solve, and the same shape
of answer: connect metadata has to arrive out of band. For a hand-run box the
dev-server proxy is that band; in production it is the Worker. Note the
consequence — a **deployed** HTTPS client cannot reach a hand-run box, which is
why this is a testing path and not a shipping one.

### Verified

Against the real image with the dev proxy pointed at it:

```
$ curl http://localhost:5555/session-config?match_id=city-default
{"url":"https://203.0.113.55:40999/game",
 "server_certificate_hash_hex":"56a9da57...","city_world":true,
 "city_manifest_hash":"1aba012b..."}

$ curl -o /dev/null -w '%{http_code} %{size_download}' \
    http://localhost:5555/city-manifest/1aba012b...
200 158711
```

The manifest matters: fetching it over HTTP from an HTTPS page is one of the
three failures recorded in `NETCODE_NOTES.md` — a match that connects and
simulates while rendering nothing. Through the proxy it is same-origin and fine.

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

**Pull fails with `denied` or `401`.**
The package is private. Check the token has `read:packages` and that the Vast
registry login used your GitHub username, not your email.

**It runs but nobody can connect.**
Confirm `/session-config` advertises the external port, and that you are dialling
UDP — the game is WebTransport over QUIC, so a TCP-only path will not work.

## Running it somewhere else

Nothing here is Vast-specific except the port mapping. On any host with an
NVIDIA GPU and the
[container toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):

```bash
docker login ghcr.io -u <GITHUB_USER> -p <READ_PACKAGES_TOKEN>
docker run --gpus all \
  -p 4001:4001 -p 4433:4433/udp \
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
