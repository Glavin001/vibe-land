---
name: city-stack-run
description: Build, launch and headlessly verify the /city destruction stack on its own ports, including against a work-in-progress blast-stress-solver via BLAST_ROOT. Use when you need a playable /city URL, when running two builds side by side to compare them, or when a client connects but shows an empty world.
---

# Running and verifying the /city stack

Gets a real, playable `/city` URL and *proves* it works before handing it over.
`AGENTS.md` covers ordinary dev setup; this covers standing up a second, isolated
instance and verifying it without a human.

## Ports: never reuse another instance's

Only container ports Vast has mapped are publicly reachable. Read them:

```bash
tr '\0' '\n' < /proc/1/environ | grep "^VAST_\(TCP\|UDP\)_PORT" | sort
ss -tlnp; ss -ulnp          # what is already taken
```

A second instance needs **three** free ports: Caddy (TCP), the match server's
HTTP surface (localhost only), and WebTransport (**UDP**). Reusing a port that
another tree is serving is the single easiest way to break a running game.

## Launching

Caddy terminates TLS, serves `client/dist` and proxies the match server. Copy an
existing `.certs/city-play.Caddyfile` and change the listen port, the `root`, and
every `reverse_proxy` target. The SPA needs `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers or SharedArrayBuffer fails.

```bash
# Client bundle. The wasm step can fail spuriously the first time while
# wasm-bindgen installs -- just rerun it; a partial dist yields an empty world.
cd client && npm ci && npm run build

# Server. BLAST_ROOT points at the blast-stress-solver tree to compile against.
BLAST_ROOT=/path/to/blast-stress-solver/blast \
  cargo build --release -p web-fps-server --features blast-core,cuda-stress
```

`cuda-stress` is **not** implied by `destruction`. Without it the overlay reads
`stress solver CPU`, and the CPU solver's iteration residual is reported as
stress -- it breaks bonds that are not actually overloaded. Confirm with
`strings target/release/web-fps-server | grep -c ExtStressGpuSolver`.

Launch with `setsid env ... ./target/release/web-fps-server &`. Required:
`BIND_ADDR`, `WT_BIND_ADDR`, `WT_PUBLIC_URL` (the **public** ip:port for the UDP
mapping), `WT_CERT_PEM`, `WT_KEY_PEM`, `VIBE_PHYSICS_BACKEND=physx_gpu`.

## Stopping only your own server

```bash
# NEVER: pkill -f "target/release/web-fps-server"
# It matches the shell wrapper too and has killed other trees' live servers.
pgrep -x web-fps-server | while read p; do
  if tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -q "BIND_ADDR=127.0.0.1:4005"; then
    kill $p
  fi
done
```

## Verifying without a human

**The container cannot reach its own public IP.** `curl https://<public-ip>:<port>`
returns 000 even when the mapping is fine -- a known-good instance fails
identically. Verify on `https://127.0.0.1:<container-port>` instead.

That means a headless browser cannot complete WebTransport either, because
`/session-config` advertises the public URL. Override it client-side:

```js
await page.route('**/session-config*', async route => {
  const r = await route.fetch(); const b = JSON.parse(await r.text());
  b.url = 'https://127.0.0.1:<WT_BIND_ADDR port>/game';
  await route.fulfill({ response: r, body: JSON.stringify(b),
    headers: { ...r.headers(), 'content-type': 'application/json' } });
});
```

Joining needs all three of: `?portal=true&match=city-default`, waiting for
`window.__VIBE_E2E__`, and a **click at the viewport centre** to dismiss the join
overlay. Without the click the page loads, renders nothing, and no match is ever
created on the server -- which looks exactly like a broken build.

Launch chromium with `--ignore-certificate-errors --enable-unsafe-swiftshader
--use-gl=swiftshader`. Then read `window.__VIBE_E2E__.snapshot()`.

To drive the player, mirror `client/e2e/helpers/city.ts` rather than reinventing
it -- in particular yaw is `Math.atan2(dx, dz)`. Inverting that sign walks the
player directly away from the target, which reads as "movement is broken".

## Reading the result

| symptom | meaning |
|---|---|
| `city: null`, `bonds cli 0`, `chunks drawn 0` | the manifest never loaded; the city layer failed to initialise |
| `broken bonds` climbing with nobody shooting | the structure is self-destructing -- see `city-physics-tuning` |
| `chunks drawn > 0`, `chunks unplaced 0` | geometry is genuinely rendering |
| `transport: websocket` | WebTransport failed; the city stream is datagram-only so the world will be empty |

An empty world is nearly always the bootstrap, not the network. Check
`bootstraps` and `bonds cli/srv` before suspecting transport: a healthy
connection with `bootstraps 0` means the client connected fine and never
ingested the manifest.


## WT_PUBLIC_URL is a BASE url — do not put `/game` on it

`/game` is appended downstream (`format!("{}/game", wt_base_url)`). Passing
`WT_PUBLIC_URL=https://IP:PORT/game` makes `/session-config` advertise
`https://IP:PORT/game/game`, the client dials a route that does not exist, and
the QUIC handshake never completes. The page loads, the world stays empty, and
it reads exactly like "WebTransport is broken" or "the UDP port is not
forwarded" — so it sends you hunting the port mapping instead of the string.

```bash
WT_PUBLIC_URL=https://209.121.195.117:40628      # correct
WT_PUBLIC_URL=https://209.121.195.117:40628/game # doubles to /game/game
```

Always read back what the server actually advertises before believing a launch:

```bash
curl -sk "https://127.0.0.1:<caddy-port>/session-config?match_id=city-default" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])"
# must end in exactly one /game
```

## Verify the PATH, not just the host

The `/session-config` override in the section above replaces the whole URL with
a hand-written one — which silently repairs the very field a doubled-path bug
lives in. A headless check written that way passes against a server no real
client can reach. Rewrite only host and port, and keep the advertised path:

```js
await page.route('**/session-config*', async route => {
  const r = await route.fetch(); const b = JSON.parse(await r.text());
  const u = new URL(b.url);            // keep u.pathname as the server sent it
  u.hostname = '127.0.0.1'; u.port = '<WT_BIND_ADDR port>';
  b.url = u.toString();
  await route.fulfill({ response: r, body: JSON.stringify(b),
    headers: { ...r.headers(), 'content-type': 'application/json' } });
});
```

## Proving the public ports really work

The container cannot reach its own public IP, so `curl` against it proves
nothing either way. Two checks that do work:

**TCP** — have something outside fetch it. Any server-side fetcher will do:

```bash
curl -s "https://r.jina.ai/https://<public-ip>:<caddy-public-port>/healthz"
```

A `/healthz` body coming back means the TCP mapping is live end to end.

**UDP** — do not try to synthesise it; read the server log. Every inbound
WebTransport attempt is logged with its peer address:

```bash
grep "WT connection attempt reached the listener" server.log
#  ... remote=142.169.16.183:3293 attempts=2
```

A **non-loopback, non-local** address there is proof that UDP traversed the
Vast NAT into the container. If every address is `127.0.0.1`, you have only
tested your own harness. `udp_verified: true` in `/healthz` is NOT proof of
external reachability — a loopback headless test sets it too.

## WebTransport certificate constraints

`serverCertificateHashes` (which is what lets a self-signed cert work at all)
requires **ECDSA P-256** and a validity span of **at most 14 days**. A normal
one-year self-signed cert is rejected by Chrome with no useful error. Check
before blaming the network:

```bash
openssl x509 -in .certs/page-cert.pem -noout -text | grep -E "NIST CURVE|IP Address"
openssl x509 -in .certs/page-cert.pem -noout -dates    # span <= 14 days
openssl x509 -in .certs/page-cert.pem -outform der | openssl dgst -sha256 -hex
```

The last line must equal `server_certificate_hash_hex` from `/session-config`,
and the SAN must contain the public IP clients dial. Because the span is capped
at 14 days, these certs expire constantly — regenerating is routine, not an
incident.

## Rebuild the client bundle, not just the server

`client/dist` is not rebuilt by the cargo build, and a stale bundle against a
new server is a silent version skew. The stats overlay prints
`build srv/cli <server> / <client>` — check both timestamps are current before
handing a URL over.

## Solver troubleshooting quick table

| symptom | first thing to check |
|---|---|
| page loads, world empty, `transport: connecting` forever | `/session-config` url — count the `/game` segments |
| page loads, `transport: websocket` | UDP never arrived; check the log for a non-loopback `WT connection attempt` |
| Chrome refuses the WT connection outright | cert span > 14 days, or not ECDSA P-256 |
| overlay says `stress solver CPU` | built without `cuda-stress`; `strings target/release/web-fps-server \| grep -c ExtStressGpuSolver` |
| solver change made with `BLAST_ROOT` has no effect | `.cu`-only edits relink the OLD kernel — `touch physx-bridge/src/lib.rs`, then confirm the `.o` mtime AND size moved |


## Driving a real player and measuring the solver: `e2e/drive-city-perf.mjs`

A headless trace can bombard a scene, but only a real client exercises the full
tick -- netcode, support-graph ingest, contact processing and readback -- while
the stress solver is under load. This connects over WebTransport, demolishes
the city, and records per-tick solver telemetry throughout.

```bash
cd client
node e2e/drive-city-perf.mjs --page https://127.0.0.1:8384 --wt-port 4435 \
     --rounds 8 --shots 10 --csv /tmp/city-perf.csv
```

Output is one row per sample: broken bonds, islands, awake bodies, `step_ms`,
`stress_solve_ms`, `gpu_stress_solve_ms`, `physx_step_ms`, plus the GPU host
work/blocked split. It exits non-zero if the transport is not WebTransport or
if no city appears on the server.

Four traps are handled inside it, all of which cost real time to find:

1. **Input goes through `window.__VIBE_DRIVE__`, not synthetic mouse events.**
   Headless Chromium cannot grant pointer lock, so `page.mouse.click()` reaches
   nothing and `shotsFired` stays 0 while every other indicator looks healthy.
   The one real click that IS required is the join gesture at the viewport
   centre -- gameplay input and the fire path both hang off it.
2. **`page.waitForFunction(fn, {timeout})` passes the options as the page
   function's ARGUMENT.** The signature is `(fn, arg, options)`, so the timeout
   is silently ignored and you get the 30 s default.
3. **Node's global `fetch` rejects the dev stack's self-signed certificate**, so
   every `/match-stats` call returns null -- which reads as "the server has no
   stats" rather than "TLS refused".
4. **Do not gate on the client's `snapshot().city`.** It publishes every ~30
   frames and headless swiftshader renders at ~1 fps, so that is a ~30 s
   interval. Poll the server's `/match-stats`, which is per-tick and is where
   the solver timings live anyway.

Reading the result: the GPU stress solve should be a small fraction of
`stress_solve_ms`. If it is not, profile the solver with `gpu_stress_suite`
(see the `gpu-stress-perf` skill in blast-stress-solver). If `stress_solve_ms`
is large while `gpu_stress_solve_ms` is small, the cost is in the work AROUND
the solve -- support ingest, contact processing, readback -- not in the solver.
