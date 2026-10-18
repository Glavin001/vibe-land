# Netcode rewrite notes

This branch rewires the project around a custom authoritative Rust server and a browser WebTransport client.

## Core model

- Rust server owns the simulation.
- Rapier is used for server-side world collision and authoritative kinematic FPS movement.
- Browser client uses local Rapier kinematic prediction for the local player only.
- Client sends bundled recent inputs every fixed step over WebTransport datagrams.
- Server snapshots players + projectiles at 20 Hz with `server_time_us` and per-client `ack_input_seq`.
- Client reconciles the local player from authoritative snapshots and replays unacked inputs.
- Remote players are interpolated from buffered snapshots.
- Hitscan uses server-side lag compensation / rewind.
- Rockets are server-authoritative projectiles and are interpolated on clients.
- Owner rockets are sampled closer to estimated server-present time so they feel less delayed than remote rockets.

## Server routes

- `GET /healthz`
- `GET /session-config?match_id=default`

The browser first fetches `/session-config`, then opens a WebTransport session to `/game` using the returned certificate hash.

## Environment

Server env vars:

- `BIND_ADDR` default `0.0.0.0:4001`
- `WT_BIND_ADDR` default `0.0.0.0:4002`
- `WT_HOST` default `localhost`
- `WT_PUBLIC_URL` optional override for the full externally visible WebTransport base URL used in `/session-config`

## Client controls

- WASD / arrows: move
- Mouse: look
- Space: jump
- Shift: sprint
- Ctrl or C: crouch
- Left click: hitscan
- Right click: rocket

## Important caveat

The browser client was build-checked in this environment with `npm run build`.
The Rust server was not cargo-build-checked here because the Rust toolchain is not installed in this environment.

## Safari: datagram receive without datagram send

Safari (and therefore every browser on iOS, including Chrome) implements
WebTransport with `datagrams.readable` but **no `datagrams.writable`**.
Confirmed on iOS 26.6 with `maxDatagramSize: 65535`:

```
datagrams property: present
datagrams.readable: present
datagrams.writable: MISSING
```

The client used to ask for a datagram writer immediately after `ready`, which
threw `TypeError: undefined is not an object (evaluating
'transport.datagrams.writable.getWriter')`. That exception was caught by the
transport fallback, so every iPhone session silently dropped to
WebSocket/TCP — the game worked, the stats overlay read `transport: websocket`,
and nothing else indicated a problem. On a destruction stream (~3.7 Mbps) that
trades UDP for head-of-line blocking, which is the entire reason WebTransport
was chosen.

The asymmetry only affects the client's uplink, which is trivial: input bundles
are 10 bytes per frame. So the session keeps its datagram downlink — 60 Hz
snapshots and city chunks — and sends input as length-prefixed frames on the
control stream, the same stream that carried the ClientHello. `webTransportClient`
picks the uplink by feature detection; the server reads both paths into the same
handler (`handle_wt_session`), so nothing downstream knows the difference.

Testing without an iOS device: `?uplink=stream` forces the Safari path in any
browser, and `scripts/verify-stream-uplink.mjs` asserts the server actually
applied the input (input sequence advanced and the player moved), because an
ignored uplink is indistinguishable from a working one at the client.

`client/public/wt-diag.html` probes these capabilities individually on a device
with no devtools — it is what found this.

## City manifest is pushed, not fetched

`PKT_CITY_MANIFEST` (123) carries the gzipped manifest down the reliable stream
immediately after Welcome, before the bootstrap that refers to it.

Clients used to fetch it from the game server over HTTP, which only works when
the page and the server share an origin. On a rented GPU box neither route
exists: the HTTP port is plain HTTP on a random high port (mixed content from an
HTTPS page) and the WebTransport origin is self-signed (an HTTPS fetch is
refused). The symptom was a match that connected, simulated, and streamed
correctly while rendering nothing — `chunks drawn: 0`, `rendered: NO` — because
`initCityClient` caught the failed fetch and quietly disabled the city.

The HTTP path remains as a fallback, so same-origin development and servers
built before this packet keep working; the client waits up to 4 s for a push
before falling back. Both paths run the same content-addressed verification,
since a manifest whose hash does not match the simulation would misname every
chunk that follows.

Related: the stats overlay used to poll `/match-stats/<id>` page-relative with
the URL-derived match id. On a matchmade session that reaches a *different*
server and a different match, so the overlay confidently displayed another
machine's body counts. It now follows the live session and reports
"not reachable from this page" rather than substituting numbers.
