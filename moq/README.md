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

`moq/scripts/cf-relay.sh` wraps the relay API so token secrets go straight from
the API into the process that needs them.

```sh
export CF_ACCOUNT_ID=...   # Cloudflare dashboard sidebar
export CF_API_TOKEN=...    # API token with MoQ edit permission
```

### 1. Provision a relay

```sh
./moq/scripts/cf-relay.sh create vibe-land-demo
# created relay <relay-uid> (vibe-land-demo)
```

The dashboard equivalent is **Media → Realtime → MoQ Relay → Create relay**.

### 2. Run the hosted demo workaround

```sh
./moq/scripts/cf-relay.sh hosted-demo <relay-uid>
```

Cloudflare's hosted relay currently isolates sessions that use different token
secrets, even when both tokens belong to the same provisioned relay. The
workaround mints one short-lived publish+subscribe token, starts both the Rust
publisher and Vite with it, and revokes it when the command exits. Full evidence
and a support-ready reproduction are in
[`CLOUDFLARE_HOSTED_RELAY_FINDINGS.md`](CLOUDFLARE_HOSTED_RELAY_FINDINGS.md).

Open the Vite URL at `/moq` and click **Connect**. Press Ctrl-C when finished;
both processes stop and the shared token is revoked.

The browser temporarily receives publish permission. Use this only for
controlled testing, never for an untrusted production browser.

Publisher throughput lands on stderr every five seconds:

```
region-0 10.0/s 1.1 kB/s  |  region-1 5.0/s 0.9 kB/s  |  region-2 2.0/s 0.8 kB/s
  |  region-3 1.0/s 0.8 kB/s  |  meta 0.5/s 0.0 kB/s   total_kb_per_second=3.6
```

### Intended least-privilege flow

```sh
./moq/scripts/cf-relay.sh publish <relay-uid>

# In another terminal:
./moq/scripts/cf-relay.sh env <relay-uid> >> .env
cd client && npm run dev
```

`publish` mints an ephemeral publish-only token. `env` independently mints a
subscribe-only token and prints the three `VITE_MOQ_*` lines the page reads at
build time. This is the production design: a browser must not receive publish
permission because `VITE_` variables are compiled into its bundle.

The hosted relay's cross-token scope bug currently blocks this split-token flow.
Keep it as the target configuration and switch back to it after Cloudflare fixes
the relay.

Open `/moq`. Every field is also overridable by query string (`?relay=`,
`?token=`, `?ns=`, `?certhash=`), so a deployed build can be pointed at a
different relay without a rebuild. With no token configured, paste one into the
page.

### Token handling

Relay tokens go in the **URL path**, so they land in server access logs. They are
also returned by the API exactly once, at mint time — there is no way to read a
secret back later, only to mint a new token or revoke an existing one:

```sh
./moq/scripts/cf-relay.sh tokens <relay-uid>          # metadata, no secrets
./moq/scripts/cf-relay.sh mint <relay-uid> subscribe  # print a fresh URL
./moq/scripts/cf-relay.sh mint <relay-uid> publish+subscribe
./moq/scripts/cf-relay.sh revoke <relay-uid> <jti>
```

Outside the temporary `hosted-demo` workaround, mint one token per consumer so
you can revoke them independently.

`tokens` reads are eventually consistent — a listing taken immediately after a
mint or revoke can still show the old set. Give it a few seconds before
concluding anything from it.

## Dual-transport rigid-body lab

The `/bodies` React route consumes the same RBWT payload either from a direct
WebTransport `/bodies` session or from MoQ datagram tracks `bodies-0..N`. Query
parameters are:

- `transport=direct|moq`, `bodies`, `hz`, `duration`, `mbps`, and `shards`;
- `motion=wave|formation|collapse` selects the shared deterministic motion
  source (`wave` is the default visual synchronization test);
- `direct` plus `wthash` for direct WebTransport and the optional `/clock`
  side channel;
- `relay`, `token`, `ns`, and `certhash` for MoQ;
- `autostart=1`, `pause=1`, and `norender=1` for automation/receiver-only runs.

Start the hosted publisher and Vite with a short-lived shared token:

```bash
MOQ_BODY_NAMESPACE=vibe-land/bodies \
./moq/scripts/cf-relay.sh hosted-bodies <relay-uid> \
  --bodies 5000 --hz 20 --duration 120 --payload 900 --mbps 10 --shards 8
```

Open `http://localhost:5555/bodies?transport=moq&autostart=1`. Publisher-owned
body/rate values in the page must match the launch arguments.

The Motion control changes the publisher-owned mode for every connected viewer
and restarts its phase at zero. Traveling wave gives each body a predictable
diagonal phase offset, rigid formation moves the whole lattice as one object,
and high collapse is the intentionally chaotic fall. A viewer showing a
different wave crest or formation orientation is therefore visibly out of sync.

For a multi-viewer proof, set `BODY_BENCH_VIEWERS` on the same command. This
starts independent browser pages, compares frame IDs and sampled RBWT hashes,
measures receive skew, checks every body becomes visible, and exits non-zero
when the default delivery/timeline/skew criteria fail:

```bash
BODY_BENCH_VIEWERS=16 \
BODY_BENCH_BODIES=5000 BODY_BENCH_HZ=20 \
BODY_BENCH_SHARDS=8 BODY_BENCH_MBPS=10 \
BODY_BENCH_WARMUP_MS=2000 BODY_BENCH_DURATION_MS=5000 \
./moq/scripts/cf-relay.sh hosted-bodies <relay-uid> \
  --bodies 5000 --hz 20 --duration 60 --payload 900 --mbps 10 --shards 8
```

The standalone runner is `node moq/bench/run-bodies.mjs`. Set
`BODY_BENCH_TRANSPORT=direct` with `BODY_DIRECT_URL` and
`BODY_DIRECT_CERT_HASH`, or set `MOQ_RELAY_URL` for MoQ. By default it disables
the Three.js canvas so fan-out measures receiver plus relay capacity; set
`BODY_BENCH_RENDER=1` for a rendered smoke test. `BODY_BENCH_OUTPUT` or
`--output` writes the JSON report.

For same-host runs, `publisherToLastViewerP50Ms/P95Ms/P99Ms` measure from the
publisher's actual send timestamp to the last viewer receiving that frame.
`interViewerSkewP*Ms` only measures the spread between first and last viewer;
do not describe skew as network latency.

The interactive UI's corrected one-way latency is reported only when the
optional direct `/clock` side channel is reachable. Frame agreement, receive
skew, and the runner's same-host publisher-to-viewer measurement do not require
it.
Same-host viewer tests include one machine receiving and decoding every stream;
they are not a Cloudflare relay-wide viewer limit.

## Hosted throughput benchmark

The staged benchmark uses the real Rust publisher, Cloudflare relay, browser
`MoqClient`, and one or more headless Chrome viewers. It ramps bytes/sec,
viewer fan-out, track count, and object cadence while recording delivery ratio
and publisher-to-browser latency percentiles. It supports both reliable subgroup
streams and true unreliable MoQ object datagrams.

```sh
# Short calibration
./moq/scripts/cf-relay.sh benchmark <relay-uid> --quick

# Full default matrix
./moq/scripts/cf-relay.sh benchmark <relay-uid>

# Physics-delta path: unreliable 900-byte datagrams
MOQ_BENCH_TRANSPORT=datagram \
MOQ_BENCH_DATAGRAM_PAYLOAD_BYTES=900 \
MOQ_BENCH_RAMP_MBPS=5,10,15,20,30 \
./moq/scripts/cf-relay.sh benchmark <relay-uid>
```

Raw JSON is written under `moq/bench/results/`. The first measured report and
its engineering recommendations are in
[`bench/RESULTS-2026-08-09.md`](bench/RESULTS-2026-08-09.md).

The helper uses the same short-lived shared-token workaround as `hosted-demo`,
waits for token propagation and namespace acknowledgment, then revokes the token
on exit.

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
