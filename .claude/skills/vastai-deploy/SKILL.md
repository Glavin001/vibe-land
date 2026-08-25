---
name: vastai-deploy
description: Rent, verify, operate and tear down a GPU game server on Vast.ai. Use when deploying the server image to a rented box, when a box boots but players cannot connect, when choosing an offer, or when a Vast instance needs diagnosing without SSH. Covers the UDP-forwarding failure that silently bills for a dead box.
---

# Deploying a game server to Vast.ai

The one thing that will bite you: **some Vast hosts accept the UDP port mapping
and then never forward the datagrams.** The box boots, heartbeats, serves
`/city`, answers `/healthz` with `"ok"` — and every player times out on the QUIC
handshake. It bills by the hour the whole time.

Two hosts did this before it was detectable. The image now self-tests, but you
still need to know the shape of the failure.

## 1. Pick an offer

```bash
pip install --user vastai
vastai set api-key <key>

vastai search offers \
  'reliability>0.98 num_gpus=1 gpu_ram>=12 cuda_max_good>=12.8 \
   direct_port_count>=256 inet_up>=200 rentable=true disk_space>=30 \
   compute_cap>=700' \
  -o dph_total
```

**`direct_port_count>=256` is the important filter.** Observed correlation with
working UDP forwarding: 2/2 above it worked, 3/3 below it failed (n=5, so a
strong hint rather than a law). **`datacenter` does NOT predict it** — a
datacenter 3090 in Czechia black-holed UDP.

Other selection notes:

- **GPU barely matters.** The CUDA stress solve is ~1.1 ms/tick. Prefer CPU
  clock and cores — the Blast serial walks are single-threaded. See
  `docs/PERFORMANCE-ON-SMALL-GPUS.md`.
- **Compute capability ≥ 7.0.** The image ships cubins for sm_70…sm_120.
- `gpu_ram` in a query is **GB**; the response reports **MB**.
- VRAM scales with `MATCHES_PER_BOX`, not city size. One match fits in ~12 GB.

## 2. Create the instance

```bash
vastai create instance <offer_id> \
  --image ghcr.io/glavin001/vibe-land-server:sha-<12> \
  --disk 25 \
  --label vibe-land \
  --env '-p 4001:4001 -p 4443:4443 -p 4433:4433/udp -e MATCHES_PER_BOX=1' \
  --args
```

- **`--args` with nothing after it** selects "container from your image as is",
  so the image's own ENTRYPOINT runs. This is the correct launch mode.
- **`--args` means no SSH.** `vastai execute` only works on *stopped*
  instances, so you cannot get a shell or run `nvidia-smi` on a running box.
  Vast's API also reports `gpu_util: null` for these. **Your only channel is
  `vastai logs`** — which is why the server logs so much.
- Ports must be declared **at creation**. They cannot be added later.
- All `VIBE_*` knobs are read **once at process start**, so **every
  configuration needs a fresh instance.**

## 3. Verify it came up

```bash
vastai show instance <id> --raw | python3 -c "
import json,sys; d=json.load(sys.stdin); p=d.get('ports') or {}
print(d.get('actual_status'), d.get('public_ipaddr'))
[print(f'  {k} -> {v[0][\"HostPort\"]}') for k,v in sorted(p.items())]"

vastai logs <id>
```

A healthy boot looks like this:

```
[entrypoint] public endpoint: <ip>:<ext>/udp (container 4433)
[entrypoint] starting game server
INFO validated PhysX GPU and CUDA scene initialization
INFO WebTransport endpoint listening  wt_addr=0.0.0.0:4433
INFO UDP reachability verified: the advertised endpoint reaches this process
INFO serving the client over https  addr=0.0.0.0:4443
```

Then open `https://<ip>:<4443-external-port>/city`. The certificate is
self-signed by design — accept the warning once. WebTransport pins the same
cert by hash, so the game connects regardless.

## 4. When UDP is broken

```
ERROR UDP UNREACHABLE: nothing sent to the advertised endpoint came back to
      this process ... exiting to have this box replaced.
```

The box exits 78 about 12 seconds in. **Vast restarts the container**, so you
get a crash loop rather than a stopped instance — it keeps billing. Destroy it
and pick another offer.

Knobs, set by `docker/entrypoint.sh` based on whether it detects Vast:

| Variable | On Vast | Elsewhere | Meaning |
| --- | --- | --- | --- |
| `UDP_VERIFY` | `fatal` | `warn` | boot probe; `off` disables |
| `UDP_WATCHDOG` | `fatal` | `warn` | later backstop: clients fetched `/session-config` but no QUIC packet arrived |

The probe reaches the public address by hairpinning through the host's own NAT.
Vast hosts do hairpin (measured); a laptop behind a home router often does not,
which is why it only warns off-Vast.

## 5. Diagnosing "loads the page but won't connect"

Read these in order — they discriminate between causes that look identical in a
browser (all present as `QUIC_NETWORK_IDLE_TIMEOUT`, `num_undecryptable_packets: 0`):

```bash
curl -sk https://<ip>:<web_port>/healthz | jq
```

| Signal | Meaning |
| --- | --- |
| `udp_verified: false` **and** `session_configs_served` climbing | datagrams are not arriving — host is not forwarding |
| `wt_connection_attempts` climbing | packets **do** arrive; handshake is failing — look at the certificate |
| `/healthz` unreachable but `/city` loads | the web listener is deliberately independent of the game server |
| page loads, `active_matches: 0`, `match-stats` says "unknown match" | matches are created on player connect — nobody got in |

**A bound socket proves nothing.** `Endpoint::server(...)?` is fatal at startup
and precedes the web listener, so *any box serving the page has already bound
UDP and initialised PhysX.* Do not go looking for a bind failure.

## 6. Teardown

```bash
vastai show instances
vastai destroy instance <id>
```

Instances bill until destroyed, including crash-looping ones. Check for strays
after any debugging session.

## Developing on a Vast box

**Rent the toolchain image itself:** `ghcr.io/glavin001/vibe-land-builder`. It
is the same image `docker/Dockerfile` compiles the server and the client with,
so it is proven able to build this project by every server-image CI run. It also
carries Node 22, wasm-pack, the `wasm32-unknown-unknown` target, a few dev tools
and `vibe-clone`.

There is no separate dev image. One existed and was deleted: once its warm build
came out, it was the builder plus four `RUN` lines — and the server image's
`web` stage needed three of those four anyway.

**Nothing is prebuilt.** An earlier attempt baked warm `target/` and
`node_modules` trees into a layer. That cost ~10 GB, went stale on the next
push, and caused every failure that image ever had. Persistence comes instead
from a **Vast volume mounted at `/opt/vibe-cache`**, which survives instance
destruction and accumulates real builds rather than one stale snapshot.

**Launch mode is the opposite of production.** Use `--ssh --direct`, which
injects SSH and does **not** run an ENTRYPOINT. `--args` (what the runtime image
uses) gives you a container as-is with no shell.

```bash
vastai create instance <offer_id> \
  --image ghcr.io/glavin001/vibe-land-builder:cuda12.8-physx-ovphysx-5.5.1 \
  --disk 80 --ssh --direct \
  --env '-p 4001:4001 -p 4443:4443 -p 4433:4433/udp' \
  --onstart-cmd 'vibe-autostart --downtown <branch>'

vastai show instance <id> --raw | jq -r '.public_ipaddr, .ports["22/tcp"][0].HostPort'
ssh -p <22 external> root@<ip>
```

**`--onstart-cmd 'vibe-autostart [--downtown] <branch>'` makes the box build
itself at boot**,
so it is ready — cloned, compiled, server running — before you connect. It is
the only hook available: `--ssh` replaces the image's ENTRYPOINT, so nothing in
the image can start work on its own. It returns immediately and works in the
background, so a slow build cannot wedge Vast's boot sequence or delay sshd, and
it does nothing if the box is already `ready`, so a recycle is safe.

The box bills from boot, so the minutes before you connect are paid for either
way. On the box: `cat /root/.vibe-boot-state` (building | ready | failed) and
`tail -f /root/vibe-boot.log`; the login banner shows the same thing.

**Read the SSH port from the API, not from memory** — `vastai recycle` remaps
host ports, which is why a working command can start refusing connections.

Options pass through to `vibe-up`, so the scene is chosen at instance creation
rather than by SSHing in afterwards. `--downtown` is `fractured-downtown.json`
— 24,105 chunks, the scene that actually stresses a small GPU; the default is a
much smaller high-rise.

**Confirmed working**: instance 48633720 (RTX A2000) was created with this
onstart and reached a playable city with no commands typed. Vast does run
`--onstart-cmd` in `--ssh --direct` mode — the container log carries
`[vibe-autostart] started in the background`.

Omit `--onstart-cmd` for a box that only builds when you ask it to.

On the box — one command does everything:

```bash
vibe-up                     # clone, build server + client, mint cert, run
vibe-up my-branch           # a branch, tag or commit
vibe-up --downtown          # the big scene (24,105 chunks)
vibe-up --status | --stop
```

It reads this box's public IP and its **external** port mapping from the
container's PID-1 environment (`VAST_UDP_PORT_4433`, `VAST_TCP_PORT_4443`) — an
SSH login shell does not inherit those — then prints the URL to open. `/root/README.md`
on the box covers the rest, and a login banner points at both.

By hand, if you need the pieces:

```bash
vibe-clone my-branch
cd /root/vibe-land
cargo build --release -p web-fps-server --features cuda-stress
(cd client && npm ci && npm run build)
VIBE_PUBLIC_IP=<ip> VIBE_UDP_PORT=<external 4433> ./scripts/run-city-server.sh
```

**`run-city-server.sh` without `VIBE_PUBLIC_IP` is a laptop script and will not
work on a rented box.** Five of its defaults are wrong there, each failing late
and looking like something else:

| Default | Why it breaks a rented box |
| --- | --- |
| `WT_PUBLIC_URL=https://209.121.195.117:40651` | a hardcoded home IP — clients dial someone else's router |
| `WT_BIND_ADDR=0.0.0.0:4434` | the images map container **4433**; off by one, so no datagram ever arrives |
| `BIND_ADDR=127.0.0.1:4003` | localhost-only, unreachable from outside |
| `WEB_BIND_ADDR` unset | the HTTPS listener never starts, and WebTransport refuses an insecure context — so `/city` cannot be served at all. Symptom: `ERR_SSL_PROTOCOL_ERROR` |
| `VIBE_WEB_DIR=/opt/vibe-land/web` | exists only in the *runtime* image. On a dev box the listener degrades to api-only and every page **404**s |

Setting `VIBE_PUBLIC_IP` and `VIBE_UDP_PORT` switches the script into remote
mode, which derives all five and mints the certificate.

`vibe-clone` symlinks `target/` and the cargo registry into `/opt/vibe-cache`,
so they survive switching refs and re-cloning. `client/node_modules` is
deliberately not linked — `npm ci` unlinks whatever is at that path, so the link
would last exactly one build, and it is the cheap cache anyway.

**The first build is cold and slow.** That is the trade for an image that never
goes stale. Mount a volume at `/opt/vibe-cache` and you pay it once per volume
rather than once per box.

**Disk: 60 GB.** The image alone is ~19 GB, and a release build of this
workspace is not small. Check the `builder-image` workflow summary and rent at
least double.

**Ports are still declared at creation** — you want 4001, 4443 and 4433/udp on a
dev box too, or you cannot play what you build.

**Credentials are deliberately not in the image** (it is public on GHCR). To
push:

```bash
git remote set-url origin https://<token>@github.com/Glavin001/vibe-land
git config user.name "..." && git config user.email "..."
```

**You still cannot build a Docker image here** — a Vast instance is a container
without nesting privileges. Build the *project* on the box; build *images* in
CI.

## A reusable template

A Vast **template** saves the whole recipe — image, ports, disk, onstart, and
the offer filter — so renting a box is picking a host and clicking Rent. Worth
doing: four of the settings below are ones that fail late and confusingly when
wrong, and a template stops you retyping them.

Create it at <https://cloud.vast.ai/templates/> → **New Template**:

| Field | Value |
| --- | --- |
| Name | `vibe-land dev box (auto-build, downtown)` |
| Image path | `ghcr.io/glavin001/vibe-land-builder` |
| Image tag | `cuda12.8-physx-ovphysx-5.5.1` |
| Launch mode | **SSH**, with **Direct** enabled |
| Docker options | `-p 4001:4001 -p 4443:4443 -p 4433:4433/udp` |
| On-start script | `vibe-autostart --downtown <branch>` |
| Disk | **80 GB** |
| Visibility | Private |

And set the template's search filter so it only offers hosts that work:

```
reliability>0.98 num_gpus=1 cuda_max_good>=12.8 direct_port_count>=256
inet_up>=200 rentable=true disk_space>=80 compute_cap>=700
```

Why each of those matters, since a template hides them once set:

- **SSH + Direct**, not "container as-is". `--ssh` injects SSH and does not run
  the image's ENTRYPOINT; `--args` gives a container with no shell. The runtime
  image wants the opposite mode.
- **Ports are declared at creation and cannot be added later.** Miss 4433/udp
  and the box can never serve players.
- **On-start is the only hook** that can start work, because `--ssh` replaces
  the ENTRYPOINT. It is what makes the box build itself before you log in.
- **80 GB**: the image alone is ~19 GB, and a release build is not small.
- **`direct_port_count>=256`** screens out hosts that accept the UDP mapping
  and then never forward the datagrams.

### The CLI equivalent

```bash
vastai create template \
  --name "vibe-land dev box (auto-build, downtown)" \
  --image ghcr.io/glavin001/vibe-land-builder \
  --image_tag cuda12.8-physx-ovphysx-5.5.1 \
  --ssh --direct --disk_space 80 \
  --env '-p 4001:4001 -p 4443:4443 -p 4433:4433/udp' \
  --onstart-cmd 'vibe-autostart --downtown <branch>' \
  --search_params 'reliability>0.98 num_gpus=1 cuda_max_good>=12.8 direct_port_count>=256 inet_up>=200 rentable=true disk_space>=80 compute_cap>=700'
```

**This needs an API key with `api.template` access**, which an ordinary
instance key does not have — it fails with

```
Authorization Error. Your key lacks the api.template route access
```

and the CLI reports only `The response is not valid JSON`, which does not point
at the cause. Either mint a key with that scope or use the web form above.

### Without a template

One command, no saved config:

```bash
vastai create instance <offer_id> \
  --image ghcr.io/glavin001/vibe-land-builder:cuda12.8-physx-ovphysx-5.5.1 \
  --disk 80 --ssh --direct \
  --env '-p 4001:4001 -p 4443:4443 -p 4433:4433/udp' \
  --onstart-cmd 'vibe-autostart --downtown <branch>'
```

## Facts worth not re-deriving

- **A custom image needs `/root/.ssh` pre-created, or `--ssh` boxes refuse every
  login.** sshd's StrictModes will not read an `authorized_keys` whose modes are
  wrong, and the error names the file, not the cause:

  ```
  Authentication refused: bad ownership or modes for file /root/.ssh/authorized_keys
  Failed publickey for root from <ip> ... ED25519 SHA256:<your key>
  ```

  The key is delivered and correct — `vastai attach ssh` will say "already
  associated" — so this looks like a key problem and is not one. Vast's own base
  image ships the directory correctly moded and appends; a custom image that
  never creates it gets a file sshd rejects. `docker/Dockerfile.builder` now
  creates it with 700/600. **You cannot diagnose this from the client side**:
  `vastai logs <id>` is where the sshd line appears.

- **`vastai execute` refuses to run on a *running* instance** ("Execute command
  only avail on stopped instances"), so it is useless for live debugging. To run
  something on a box you cannot SSH into, use
  `vastai update instance <id> --image <same image> --onstart <file>` followed by
  `vastai recycle instance <id>`. `--image` is required even when unchanged.
  Onstart output goes to `/root/onstart.log` **inside** the container, not to
  `vastai logs`.

- **`Error: remote port forwarding failed for listen port <n>`** repeating in the
  logs is Vast's *proxy* SSH tunnel failing to bind on its side. It does not
  affect the `--direct` route, and a `recycle` usually clears it.


- **`RUST_LOG` unset produces an empty filter — no output at all, not even
  `ERROR`.** The image sets `RUST_LOG=info`; override to `debug` when needed.
- The `[destruction] CUDA stress solver active` line is a raw `println` and
  fires at match/scene creation, **not** at boot. Its absence is not evidence of
  a boot failure.
- Vast instances are themselves containers and **cannot run Docker**, so you
  cannot build an image on one. Build in CI.
- `vastai search offers` field names differ from the response field names.
  Verify a filter returns rows before trusting a zero result.
