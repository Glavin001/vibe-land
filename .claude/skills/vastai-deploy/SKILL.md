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

## Facts worth not re-deriving

- **`RUST_LOG` unset produces an empty filter — no output at all, not even
  `ERROR`.** The image sets `RUST_LOG=info`; override to `debug` when needed.
- The `[destruction] CUDA stress solver active` line is a raw `println` and
  fires at match/scene creation, **not** at boot. Its absence is not evidence of
  a boot failure.
- Vast instances are themselves containers and **cannot run Docker**, so you
  cannot build an image on one. Build in CI.
- `vastai search offers` field names differ from the response field names.
  Verify a filter returns rows before trusting a zero result.
