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

## Choosing what the city serves

`VIBE_CITY_SCENE` picks the pack, `VIBE_CITY_GRID` how many copies (1-16, the
grid edge). A scene of only the structures that pass their own stability audit:

```bash
VIBE_CITY_SCENE=skyline-stable.json VIBE_CITY_GRID=1 ./scripts/run-city-server.sh
```

Prefer `skyline-stable` over `skyline` for anything a person will look at:
`skyline` is EVERY authored structure, which makes it every authored failure
too, and nobody can tell a bug from a feature in a recording of a building that
falls down on its own.

Confirm what a running server actually loaded — the env, not your intent:

```bash
tr '\0' '\n' < /proc/$(pgrep -x web-fps-server | head -1)/environ | grep VIBE_CITY
```

## Verify the manifest wire format — 30 seconds, no browser

The highest-value check available, and the one that catches an empty world
without launching anything. A silent merge once turned `to_bytes()` into
`to_json_bytes()`, producing 60 MB of JSON that the client could not ingest;
the symptom was `bonds cli/srv 0 / 283` and a black world, and it cost a whole
round of transport debugging.

```bash
# The match is created LAZILY -- /match-stats 404s until a player joins, but
# /session-config creates enough to hand out the manifest hash.
H=$(curl -sk "https://127.0.0.1:<port>/session-config?match_id=city-default" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['city_manifest_hash'])")

curl -sk "https://127.0.0.1:<port>/city-manifest/$H" -o /tmp/m.bin \
  -w "http=%{http_code} bytes=%{size_download}\n"

python3 -c "
d=open('/tmp/m.bin','rb').read(8)
print('BINARY VLCM' if d[:4]==b'VLCM' else 'JSON -- the empty-world bug' if d[:1] in (b'{',b'[') else d[:8].hex())"
```

Expect `VLCM` and single-digit megabytes. Tens of megabytes, or a leading `{`,
means JSON on the wire and a world that will render nothing.

Note the route is `/city-manifest/<hash>`, not `/city-manifest/<match>`; the
match-shaped URL 404s and reads as "the endpoint is broken".

**Verify by manifest hash, not HTTP status.** A 200 from a page proves Caddy is
up, nothing more. Four deployments were once reported working on the strength of
a 200 while every one of their servers had failed to start.

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
