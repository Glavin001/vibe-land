# Cloudflare hosted MoQ relay: cross-token scope isolation

## Executive summary

Cloudflare's hosted draft-16 MoQ relay accepts multiple valid tokens issued for
the same provisioned relay, but sessions authenticated with different token
secrets do not share published namespaces or tracks.

The failure is reproducible using Cloudflare's own `moq-rs` publisher,
subscriber, and interoperability test client:

- Publisher and subscriber using the **same** publish+subscribe token:
  `SUBSCRIBE_OK` is received and media streams.
- Publisher and subscriber using **different** publish+subscribe tokens whose
  JWTs have the same relay UID in `sub`: the subscriber receives
  `REQUEST_ERROR` code `0x0` (`Internal error`) and no data.
- The workflow documented by Cloudflare — publish+subscribe token for the
  broadcaster and a separate subscribe-only token for the viewer — fails the
  same way.

This strongly indicates that the hosted coordinator is isolating sessions by
the raw token/path (or token JTI) instead of resolving all tokens for a relay to
the relay's common scope ID.

There is a usable testing workaround: give both sessions the same short-lived
publish+subscribe token. This is not production-safe for a browser because it
also grants publish permission.

## Environment

- Test date: 2026-08-09
- Cloudflare account ID: `90c3121e975593a8872830a0100a1e92`
- Relay name: `vibe-land-demo`
- Relay UID / JWT `sub`: `fe7f7e5531254434e92df14e262bc131`
- Endpoint: `https://draft-16.cloudflare.mediaoverquic.com`
- Relay API status during testing: `connected`
- `moq-rs` revision:
  [`933a443d98b65bc536f0b6753e51a17b5eeaba15`](https://github.com/cloudflare/moq-rs/commit/933a443d98b65bc536f0b6753e51a17b5eeaba15)
- `moq-transport`: `0.16.1`
- `moq-pub`: `0.9.3`
- `moq-relay-ietf`: `0.7.25`
- Application PR:
  [`Glavin001/vibe-land#117`](https://github.com/Glavin001/vibe-land/pull/117)

All temporary audit tokens were revoked after testing. Only the two default
relay tokens remained. No token secrets or API credentials are included in this
document.

## Expected behavior

Cloudflare's [MoQ overview](https://developers.cloudflare.com/moq/) documents
this draft-16 workflow:

1. A broadcaster connects with the relay's publish+subscribe token.
2. The broadcaster sends `PUBLISH_NAMESPACE`.
3. A viewer connects with the relay's separate subscribe-only token.
4. The viewer sends `SUBSCRIBE` for a track in that namespace.
5. The relay routes the subscription to the broadcaster and returns
   `SUBSCRIBE_OK`.

The [relay provisioning announcement](https://blog.cloudflare.com/moq-relays/)
also says to give the broadcaster the publish+subscribe token and viewers the
subscribe-only token.

The JWTs minted for this test had:

- the same audience: `moq.cloudflare.com`;
- the same subject: relay UID `fe7f7e5531254434e92df14e262bc131`;
- different `jti` values;
- valid, unexpired signatures;
- either `["publish", "subscribe"]` or `["subscribe"]` operations.

Different credentials for the same relay should therefore resolve to one
isolated relay scope while retaining their respective permissions.

## Actual behavior

### Control case: same token succeeds

One publish+subscribe token was used by both `moq-pub` and `moq-sub`.

Result:

- publisher received `REQUEST_OK` for `PUBLISH_NAMESPACE`;
- subscriber received `SUBSCRIBE_OK` for both initialization and media tracks;
- subscriber received `44,854` bytes during the six-second sample;
- the output was a valid live fMP4 stream.

Relevant subscriber connection ID:

```text
dfc18397c4b46c6605ff2b9fd37a342b
```

Relevant control messages:

```text
recv SERVER_SETUP
sent SUBSCRIBE subscribe_id=0
recv SUBSCRIBE_OK subscribe_id=0 track_alias=0
sent SUBSCRIBE subscribe_id=2
recv SUBSCRIBE_OK subscribe_id=2 track_alias=2
```

Cloudflare's own `moq-test-client` also passed the
`publish-namespace-subscribe` scenario when its two sessions used the same URL
and token. The relay forwarded `SUBSCRIBE` to the publisher and returned
`SUBSCRIBE_OK` to the subscriber.

### Failure case: distinct tokens with identical permissions

Token A and token B were both minted with:

```json
{
  "operations": ["publish", "subscribe"],
  "sub": "fe7f7e5531254434e92df14e262bc131"
}
```

The publisher used token A and the subscriber used token B.

Result:

- both sessions completed `CLIENT_SETUP` / `SERVER_SETUP`;
- the publisher's namespace was accepted;
- the subscriber sent the same namespace and track names as the successful
  control;
- the subscriber received `REQUEST_ERROR`, code `0x0`;
- zero media bytes were delivered.

Subscriber connection ID:

```text
32223e5dcb0f8503b5e51fa887347666
```

Cloudflare correlation ID:

```text
90f0773a-4b97-4cfc-9750-e6b23eab407c
```

Error at `2026-08-09T09:05:38.979Z`:

```text
recv REQUEST_ERROR request_id=0 error_code=0 retry_interval=0
reason=internal error: Internal error
[error:90f0773a-4b97-4cfc-9750-e6b23eab407c]
```

The only changed variable from the successful control was token B's identity.
Its permissions and relay `sub` were the same as token A.

### Failure case: Cloudflare's documented token split

The exact documented tool flow was tested:

- `moq-pub` used a publish+subscribe token;
- `moq-sub` used a different subscribe-only token;
- publisher namespace: `audit-media`;
- publisher used the default pull-style `PUBLISH_NAMESPACE` path, without
  explicit `PUBLISH`.

The publisher succeeded:

```text
publisher CID: f6d733abb6ab698d39239f18781f3f35
sent PUBLISH_NAMESPACE request_id=0 namespace=/audit-media
recv REQUEST_OK request_id=0
```

The subscriber completed setup, then failed:

```text
subscriber CID: 0b8876f9368e6d8d42501e908b1980d7
sent SUBSCRIBE request_id=0 namespace=/audit-media track_name=0.mp4
recv REQUEST_ERROR request_id=0 error_code=0 retry_interval=0
```

Cloudflare correlation ID:

```text
42264302-6df7-4758-afaa-4f31b400310c
```

Error at `2026-08-09T08:59:53.264Z`:

```text
reason=internal error: Internal error
[error:42264302-6df7-4758-afaa-4f31b400310c]
```

No output bytes were received.

### Application confirmation with the workaround

The original namespace-only `vibe-land` publisher and the real `/moq` React
page were tested through Cloudflare using one shared, short-lived
publish+subscribe token.

All tracks subscribed and decoded:

```text
track      objects  bytes  subscribed  observed lag
region-0        37   2453  true        2 ms
region-1        19   1859  true        2 ms
region-2         4    836  true        2 ms
region-3         2    802  true        3 ms
meta             1     31  true        2 ms
```

The publisher and browser ran on the same clock, so these lag values are useful
for this controlled test. They are not a general Internet latency benchmark.

This confirms that:

- opaque non-media world-state payloads work through the hosted relay;
- namespace tuple `["vibe-land", "demo"]` is accepted;
- track names are correct;
- the browser's draft-16 framing and subgroup decoding work;
- QUIC and WebTransport connectivity are functional;
- the blocker is credential-to-scope routing across different sessions.

## Minimal reproduction with Cloudflare's tools

Build the current Cloudflare tools:

```bash
git clone https://github.com/cloudflare/moq-rs
cd moq-rs
git checkout 933a443d98b65bc536f0b6753e51a17b5eeaba15
cargo build --release -p moq-pub -p moq-sub
```

Mint two different publish+subscribe tokens for the same relay. Call their
secrets `TOKEN_A` and `TOKEN_B`. Confirm both JWT payloads contain:

```json
{
  "aud": "moq.cloudflare.com",
  "sub": "fe7f7e5531254434e92df14e262bc131",
  "operations": ["publish", "subscribe"]
}
```

Start a publisher with token A:

```bash
ffmpeg -hide_banner -loglevel error \
  -re -f lavfi -i 'testsrc=size=96x54:rate=10' \
  -an -c:v libx264 -preset ultrafast -tune zerolatency -g 10 \
  -f mp4 \
  -movflags empty_moov+frag_every_frame+separate_moof+omit_tfhd_offset - \
  | RUST_LOG=info,moq_transport=debug \
    target/release/moq-pub \
      --name cf-token-scope-repro \
      "https://draft-16.cloudflare.mediaoverquic.com/TOKEN_A"
```

In a second terminal, subscribe using token A:

```bash
RUST_LOG=info,moq_transport=debug \
  timeout 6 target/release/moq-sub \
    --name cf-token-scope-repro \
    "https://draft-16.cloudflare.mediaoverquic.com/TOKEN_A" \
    > same-token.mp4
```

Expected and observed: `SUBSCRIBE_OK`; `same-token.mp4` receives data.

Restart the publisher under a fresh namespace using token A. Subscribe using
token B:

```bash
RUST_LOG=info,moq_transport=debug \
  timeout 6 target/release/moq-sub \
    --name cf-token-scope-repro-2 \
    "https://draft-16.cloudflare.mediaoverquic.com/TOKEN_B" \
    > distinct-token.mp4
```

Expected: `SUBSCRIBE_OK`, because both tokens belong to the same relay.

Observed: `REQUEST_ERROR 0x0 Internal error`; output remains empty.

The same failure occurs when token B is subscribe-only, matching the documented
broadcaster/viewer token split.

Do not send either token secret to support. Revoke the reproduction tokens after
the test.

## Why this is unlikely to be application code

The following hypotheses were tested or eliminated:

1. **Invalid Cloudflare API credential:** eliminated. The API token verified as
   active and successfully listed the relay, minted tokens, and revoked tokens.
2. **UDP or QUIC blocked:** eliminated. QUIC handshakes completed to the hosted
   MoQ endpoint and other public QUIC endpoints.
3. **Wrong draft:** eliminated. Both sides used the draft-16 endpoint and
   `moq-transport 0.16.1`.
4. **Incorrect namespace encoding:** eliminated. The same exact namespace
   succeeds with token A and fails with token B.
5. **Track or payload format:** eliminated. Cloudflare's own fMP4 tools reproduce
   the failure before application payload handling.
6. **Missing explicit `PUBLISH`:** eliminated. Cloudflare's documented
   namespace-only workflow succeeds with one token. Explicit `PUBLISH` is an
   optional push path, not a requirement for pull-style namespace publishing.
7. **Permission difference:** eliminated by the A/B test where both tokens had
   identical publish+subscribe operations.
8. **Propagation delay:** unlikely. Both tokens were accepted for setup, the
   publisher had already received `REQUEST_OK`, and same-token routing completed
   immediately under the same conditions.

## Likely failure area

This is an inference from black-box behavior; only Cloudflare can identify the
exact server-side defect.

The public relay coordinator contract says the connection path should resolve
to a `scope_id`, intentionally allowing multiple paths to map to the same scope.
All namespace registration and lookup operations then use that scope.

The observed behavior is consistent with the hosted resolver using the raw
token path, JTI, or another token-specific value as the namespace scope key
instead of the common relay UID. Consequently:

- token A registers a namespace in scope A;
- token A can subscribe within scope A;
- token B looks in scope B and cannot resolve token A's namespace;
- the backend returns an internal error instead of a useful not-found or
  authorization response.

The public source's permission model also has `ReadWrite` and `ReadOnly`, but no
write-only state, while the API permits minting publish-only tokens. That may be
a related control-plane/deployed-relay version mismatch.

## Separate application issues found

These issues were found in `vibe-land`, but they do not explain the same-token
versus distinct-token result. The branch now contains the mitigations described
below.

### Duplicate subscription race

`MoqDemo.tsx` sets the page state to `connected` before its initial subscription
loop completes. A reconciliation effect sees `connected` and starts the same
subscriptions concurrently.

Symptoms:

```text
duplicate subscription: duplicate subscription
```

The first subscription still succeeds, which is why the shared-token
application test received all tracks. The connect path now delegates all initial
subscriptions to the guarded reconciliation effect, and the local end-to-end
test rejects any future duplicate-subscription log.

### Relay helper uses the failing token pattern

`cf-relay.sh publish` currently mints a publish-only token, while
`cf-relay.sh env` independently mints a subscribe-only token. That is the
least-privilege design the hosted relay should support, but it triggers the
cross-token failure.

For hosted testing, `cf-relay.sh hosted-demo <relay-uid>` now:

1. mints one short-lived publish+subscribe token;
2. supplies the same token to the publisher and browser;
3. warns that the browser temporarily has publish permission;
4. revokes the token when the test ends.

### Explicit `PUBLISH` workaround is not appropriate

Commit `175629b` added explicit per-track `PUBLISH` as a proposed workaround.
Further testing showed that the original namespace-only publisher works through
Cloudflare with a shared token, while the combined explicit-`PUBLISH` session
can be closed by the hosted relay.

The branch reverts that publisher change and uses the namespace-only workflow
with the token-scope workaround instead.

## Production impact

The shared-token workaround is suitable only for a controlled test:

- it proves the application and hosted relay data path;
- it enables latency and throughput measurement;
- it avoids waiting for a Cloudflare fix.

It is not acceptable for an untrusted production browser because the token
grants publish permission. Production requires Cloudflare's documented
least-privilege split: publish+subscribe for the broadcaster and subscribe-only
for each viewer.

## Copy/paste Cloudflare support ticket

### Subject

```text
Hosted draft-16 MoQ relay isolates sessions by token instead of relay scope
```

### Message

```text
We are testing a provisioned Cloudflare draft-16 MoQ relay and have isolated a
cross-token namespace-routing failure using Cloudflare's own moq-rs tools.

Account ID:
90c3121e975593a8872830a0100a1e92

Relay:
name: vibe-land-demo
uid: fe7f7e5531254434e92df14e262bc131
endpoint: https://draft-16.cloudflare.mediaoverquic.com

Client revision:
cloudflare/moq-rs 933a443d98b65bc536f0b6753e51a17b5eeaba15
moq-transport 0.16.1
moq-pub 0.9.3

Expected behavior:
Per the Cloudflare MoQ documentation, a broadcaster using the relay's
publish+subscribe token should be able to publish a namespace that a viewer
using a separate subscribe-only token can subscribe to.

Observed behavior:
1. If moq-pub and moq-sub use the same publish+subscribe token, the subscriber
   receives SUBSCRIBE_OK and media streams normally.
2. If the publisher uses token A and the subscriber uses a different token B,
   the subscriber receives REQUEST_ERROR code 0 (Internal error) and no data.
3. This also fails when token A and token B both have identical
   ["publish","subscribe"] operations and the same relay UID in the JWT `sub`.
4. CLIENT_SETUP/SERVER_SETUP succeeds for every token, and the publisher
   receives REQUEST_OK for PUBLISH_NAMESPACE.

Same-token successful subscriber CID:
dfc18397c4b46c6605ff2b9fd37a342b

Distinct-token failing subscriber CID:
32223e5dcb0f8503b5e51fa887347666

Distinct publish+subscribe token failure:
2026-08-09T09:05:38.979Z
correlation ID: 90f0773a-4b97-4cfc-9750-e6b23eab407c

Documented publish+subscribe / subscribe-only split failure:
publisher CID: f6d733abb6ab698d39239f18781f3f35
subscriber CID: 0b8876f9368e6d8d42501e908b1980d7
2026-08-09T08:59:53.264Z
correlation ID: 42264302-6df7-4758-afaa-4f31b400310c

The only changed variable in the A/B test is token identity. Both A and B were
valid, unexpired, accepted by the relay, carried the same
sub=fe7f7e5531254434e92df14e262bc131, and had identical operations.

This suggests that namespace registration/lookup may be scoped by raw token
path or JTI rather than by the provisioned relay UID.

Could you please:
1. look up the two correlation IDs above;
2. confirm whether separate tokens for one relay are expected to share
   namespaces and tracks;
3. confirm the deployed draft-16 relay/coordinator version;
4. investigate whether token paths are resolving to token-specific scope IDs;
5. advise whether there is a least-privilege workaround that does not expose a
   publish-capable token to viewers?

We can provide fully redacted control logs and a minimal moq-pub/moq-sub
reproduction. We will not send token secrets or the account API token.
```

## Recommended attachments

Send these with the ticket:

1. This document.
2. Redacted `moq-pub` log showing `PUBLISH_NAMESPACE` and `REQUEST_OK`.
3. Redacted same-token `moq-sub` log showing `SUBSCRIBE_OK`.
4. Redacted distinct-token `moq-sub` log showing correlation ID
   `90f0773a-4b97-4cfc-9750-e6b23eab407c`.
5. Redacted documented-split log showing correlation ID
   `42264302-6df7-4758-afaa-4f31b400310c`.

Before sending, verify that every JWT, relay token secret, and API token has
been redacted. The relay UID, connection IDs, correlation IDs, account ID, and
public endpoint are appropriate for an authenticated Cloudflare support case.
