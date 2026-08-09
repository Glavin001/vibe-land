# Streaming world state over MoQ

A working proof of concept for carrying **game world state** — not media — over
[Media over QUIC](https://developers.cloudflare.com/moq/) relays.

A Rust publisher runs a destruction simulation and pushes it to a relay as one
MoQ track per world region, each at its own rate. A web page subscribes to
whichever tracks it wants and renders them. Toggle a region off and its quadrant
freezes while the relay stops sending you those bytes.

| Piece | Path | What it is |
| --- | --- | --- |
| Publisher | `moq/publisher/` | Rust binary, sim + MoQ publisher, built on Cloudflare's `moq-transport` |
| Browser client | `client/src/moq/` | ~1,100 lines of dependency-free draft-16 MoQ subscriber |
| Demo page | `client/src/pages/MoqDemo.tsx` | The `/moq` route |
| End-to-end check | `moq/e2e/` | Boots a real relay + publisher + headless Chromium and asserts bytes arrive |

## Does MoQ actually fit game state?

Short answer: yes for the tier of state that tolerates sub-second latency, and
that is a larger share of a destruction game than it first appears. The parts
worth knowing before committing:

**It is genuinely media-agnostic.** MoQ Transport moves opaque objects. Nothing
in the protocol knows or cares that the payload here is a packed struct of chunk
IDs, positions and states. Cloudflare's own `moq-clock-ietf` example publishes
timestamps, and their relay forwards objects without parsing them.

**Per-track subscription is the real win.** A track is the unit of subscription,
so splitting the world by region gives each client a dial: subscribe to the
blocks it can see, skip the rest. The relay fans one upstream publish out to
every subscriber, so the publisher's cost does not grow with player count the
way a per-client snapshot loop does.

**Groups give you keyframes for free.** Each group here opens with a full
snapshot of its region and then carries deltas. A client that joins mid-match,
or re-subscribes to a region it had dropped, is renderable as soon as the next
group starts — no "please resend me the world" round trip, and no per-subscriber
state on the publisher.

**Priorities are per-track.** Region 0 publishes at priority 0 and the meta track
at priority 8, so under congestion the relay sheds distant scenery before the
block the player is standing in.

**What it is not.** MoQ is not a replacement for your existing WebTransport
datagram path. Player positions, hit registration and input reconciliation want
tens of milliseconds and unreliable delivery; MoQ relays add a hop and are built
around reliable, cacheable objects. The split this demo argues for is:

- **Datagrams direct to your authoritative server** — players, projectiles, the
  chunk you are standing on. Milliseconds matter, staleness is worthless.
- **MoQ tracks via the relay** — everything else. Buildings collapsing across the
  map, scoreboard, round state, streamed-in region contents. Sub-second is fine,
  and the fan-out is free.

The remaining caveat is that Cloudflare's MoQ is in tech preview, free during
beta, with pricing signalled at ~5¢/GB egress at GA. That is worth modelling
before making it load-bearing.

## Track layout

```
vibe-land/demo
  region-0    10 Hz   priority 0    the block underfoot
  region-1     5 Hz   priority 1
  region-2     2 Hz   priority 2
  region-3     1 Hz   priority 3    scenery on the horizon
  meta       0.5 Hz   priority 8    round, headline, destroyed %
```

The world is a 2x2 grid of regions, each an 8x8 block of destructible chunks.
Rates are `--region-hz`, so the fan-out is a flag, not a rewrite.

Each object is a packed little-endian struct: a 14-byte header (version, kind,
tick, publisher timestamp) plus 12 bytes per chunk (id, state, hp, x/y/z in
centimetres, yaw in milliradians). A full 64-chunk keyframe is 785 bytes; a delta
touching four chunks is 65. The encoder is `moq/publisher/src/wire.rs` and the
decoder is `client/src/moq/payload.ts`; both have golden-vector tests over the
same bytes, so they cannot drift apart silently.

## Running it against Cloudflare

### 1. Provision a relay

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/moq/relays" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "vibe-land-demo"}'
```

The response carries the relay ID and two tokens: one that can publish and
subscribe, one that can only subscribe. The dashboard equivalent is
**Media → Realtime → MoQ Relay → Create relay**.

Tokens go in the URL path, which means they land in server access logs. Give the
publisher the publish token and the browser the subscribe-only token, and set an
expiry on both.

### 2. Publish

```sh
cd moq/publisher
cargo run -- "https://draft-16.cloudflare.mediaoverquic.com/<publish-token>"
```

It prints a throughput summary every five seconds:

```
region-0 10.0/s 1.1 kB/s  |  region-1 5.0/s 0.9 kB/s  |  region-2 2.0/s 0.8 kB/s
  |  region-3 1.0/s 0.8 kB/s  |  meta 0.5/s 0.0 kB/s   total_kb_per_second=3.6
```

### 3. Subscribe

Set the subscribe-only token where the client build can see it — it is read at
build time and never committed:

```sh
# .env at the repo root
VITE_MOQ_RELAY_URL=https://draft-16.cloudflare.mediaoverquic.com
VITE_MOQ_SUBSCRIBE_TOKEN=<subscribe-only-token>
VITE_MOQ_NAMESPACE=vibe-land/demo
```

```sh
cd client && npm run dev
```

Open `/moq`. Every field on the page is also overridable by query string
(`?relay=`, `?token=`, `?ns=`, `?certhash=`), so a deployed build can be pointed
at a different relay without a rebuild. If no token is configured, paste one into
the page.

## Running it against a local relay

Useful for iterating without touching Cloudflare, and it is what the end-to-end
check uses. The relay is Cloudflare's, just self-hosted:

```sh
git clone https://github.com/cloudflare/moq-rs
cd moq-rs && cargo build --bin moq-relay-ietf
```

Then, from this repo:

```sh
make moq-e2e MOQ_RELAY_BIN=/path/to/moq-rs/target/debug/moq-relay-ietf
```

That generates a short-lived ECDSA certificate, starts the relay and publisher,
bundles the browser client, drives headless Chromium, and asserts that world
state actually arrives and decodes on every track — then that unsubscribing stops
it. It runs the real `/moq` page component in a second pass, so the check covers
the deliverable and not just the library.

Sample output:

```
  track      objects  bytes   keyframes  deltas  groups
  region-0        41    4537          5      36       5
  region-1        16    3344          4      12       4
  region-2         7    3443          4       3       4
  region-3         4    3140          4       0       4
  meta             2      62          0       0       2

  region-0 objects after UNSUBSCRIBE: +0
  page status: connected, canvas painted: true
```

To drive a local relay by hand instead, the demo page needs the certificate
pinned, since a self-signed certificate has nothing to chain to:

```sh
openssl x509 -in cert.pem -outform der | openssl dgst -sha256
# open /moq?relay=https://127.0.0.1:4443&certhash=<the hex digest>
```

Chrome only honours pinned hashes for ECDSA P-256 certificates valid 14 days or
less.

## Protocol notes

The browser client implements draft-ietf-moq-transport-16 directly rather than
depending on a MoQ media library, because every published JS option is built
around WebCodecs and a media catalog — machinery this use case has no need for.
The subscribe path is small: a control stream carrying `CLIENT_SETUP`,
`SUBSCRIBE` and `SUBSCRIBE_OK`, then unidirectional subgroup streams carrying
objects.

Wire details were taken from Cloudflare's
[`moq-rs`](https://github.com/cloudflare/moq-rs) `moq-transport` crate, which is
what their relay speaks, and `client/src/moq/protocol.test.ts` asserts the
encoders against byte vectors lifted from that crate's own tests.

Two draft-16 details worth flagging if you extend this:

- The MoQ version is no longer negotiated inside `CLIENT_SETUP`. It comes from
  ALPN for raw QUIC, and for WebTransport from which relay hostname you connect
  to — hence `draft-16.cloudflare.mediaoverquic.com`.
- Object IDs on a subgroup stream are delta-encoded, and the first object's ID
  *is* its delta while every later one is `previous + delta + 1`. Getting this
  wrong silently offsets every object index by one.

The publisher pins `moq-transport` to a specific `moq-rs` commit. The draft is
still moving; pin, and re-test when you bump.

## Layout

```
moq/
  publisher/
    src/main.rs      track plan, session setup, publish loops
    src/world.rs     destruction sim, versioned chunks for cheap deltas
    src/wire.rs      payload encoder + golden vectors
    src/cli.rs       flags
  e2e/
    verify-local.mjs orchestrates relay + publisher + Chromium
    harness.ts       drives the MoQ client library directly
    page-entry.tsx   mounts the real /moq page for the second pass

client/src/moq/
  coding.ts          QUIC varints, buffered stream reader
  protocol.ts        draft-16 control messages and subgroup streams
  client.ts          the subscriber
  payload.ts         world-state decoder
  config.ts          relay URL, token and namespace resolution
```

The publisher is a standalone Cargo workspace on purpose: its QUIC dependency
tree is large and it is not part of the game build, so `make check` at the repo
root stays fast. Build it with `make moq-publisher`.
