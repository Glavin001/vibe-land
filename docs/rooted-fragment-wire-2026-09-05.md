# Rooted fragment wire repair

The six player reports from 18:51–18:54 UTC recorded 46 structure repairs,
41 involving structure 2. They had no recorded sequence gaps, hash mismatches
or rejected settle poses. See `city-player-reports-2026-09-05.md` for the full
measurement analysis. The reports alone do not identify every offending packet.

A production GPU regression reproduces a concrete cause: the adapter assigns
real island serials to rooted fragments, and chunk migrations name those IDs,
but the bridge previously emitted creation events only for dynamic fragments.
The original code fails at tick zero: chunk 0 migrates to unannounced island 2.
A structure bootstrap cannot repair an island absent from the server ledger.

The bridge now announces rooted fragment creation separately from dynamic
promotion. The runtime publishes it using the existing reliable promotion and
settle records, without enrolling the anchored body in dynamic freeze trackers
or reporting a false supporter death. Rooted fragments that lose their final
anchor keep their serial and receive the normal dynamic promotion.

Membership changes can shift a rooted body's center-of-mass frame. Dirty roots
receive their final cached rest pose when events are drained, after every
same-tick replay. Released or retired roots receive no stale rest event. This
uses existing body/shape observations; it adds no device readback. An unused
per-body hash-map construction was also removed from event collection.

The first runtime test exposed a second bug: bootstrap generation preferred a
never-populated stream track over the reliable rest pose. Settled islands now
bootstrap from the ledger's authoritative rest record. Full and scoped repair
bootstraps switch to live motion after wake. Moving v3 bootstrap tracks remain
a separate open issue: topology-only ingest skips track-state updates. This
release does not claim that moving bootstrap case is fixed.

The server log now calls structure requests resync requests. Their wire format
carries structure IDs, not a reason, so calling every request a hash mismatch
was misleading.

## Qualification

- Original bridge regression fails on an unannounced destination (negative
  control); corrected bridge passes.
- Main-candidate production runtime test passes three runs with same-tick
  replay. Every anchor remains at the expected non-origin rest pose and all
  chunks have complete, unique bootstrap membership.
- Captured real reliable packets pass client decoder/topology/presentation
  tests, including late join and server/client hash agreement. Removing rooted
  creation records from the capture reproduces missing destinations and resync.
- Anchor-loss fixture checks serial continuity and absence of stale retire/rest
  events. Initial fixture attempts broke anchors prematurely; separating its
  test material strengths exercises the intended two-stage transition. No
  production settings changed.

## Release isolation

The release is based on game `66a7257` and solver `646a0f41`, the existing live
physics implementation, in `codex/city-rooted-wire` worktrees. The main
`codex/simulation-frontier` branches retain the experimental contact-wrench and
multilevel solver work. Those physical changes are not part of this release.
No force, velocity, contact, body, fracture or bond cap was added. Direct GPU,
CUDA stress, sleep/freeze behavior and same-tick replay remain enabled as before.

This is a correctness repair, not a measured large-scale tick speedup. The
reports' 22.54 ms CPU contact sample and expensive replay remain priorities.

The pinned release suite passed **180 tests, zero failed, 27 existing ignored**.
All four authored-building scenarios and all 11 freeze/wake tests passed.
Some authored convex shapes log the existing CPU collision fallback warning;
these tests do not establish GPU collision coverage for every authored hull.
The release capture also passed all **42** focused client tests. Evidence is in
`bench-results/simulation-frontier/rooted-wire/`.

The server was built from release game `ed9c2ad` with `cuda-stress`, omitting
the unused opt-in `blast-core` backend so it cannot link experimental sources.
Live `VIBE_CITY_BLAST_CORE` was not enabled. Frontend production source is
unchanged from `66a7257`; only client tests/fixtures were added, so the existing
compatible frontend bundle remains in use.

The deployment retains the previous binary at
`.certs/vast-city/web-fps-server-before-rooted-wire`. The new binary SHA-256 is
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`.
Comparison of all VIBE/BLAST settings (excluding new release provenance fields)
found no changes. `VIBE_RELEASE_GAME_REVISION`, `VIBE_RELEASE_SOLVER_REVISION`,
and `VIBE_RELEASE_BINARY_SHA256` identify the actual artifact in report env.
The legacy `fingerprint.git` field describes the serving working directory,
not necessarily the build checkout; use the release fields and binary hash.

The deployment smoke test passed public HTTPS, manifest decoding, certificate
checks, and a local WebTransport browser connection. It rendered all 96,420
chunks with zero repairs, sequence gaps, hash mismatches, settle rejects,
orphans or JavaScript errors. This new local test does not establish public
UDP reachability; the user's earlier public-session reports are separate
evidence for that path.

The first browser firing attempt is **inconclusive for destruction**: three
shots reached server routing but none hit the city, and the periodic client
city snapshot did not refresh during that short attempt. Its harness returned
success because it only required shots plus zero error counters. The saved
`browser-first-shots-inconclusive.json` is retained as failed coverage, not
destruction qualification. The targeted successor requires a real facade aim,
new broken bonds at the client, and a newer hash-check counter.

The corrected targeted browser check passed after 41 seconds: four shots
fired, 1,517 broken bonds visible to the client, 642 received motion datagrams,
and fresh periodic telemetry (19 hash checks). It reported zero repairs,
sequence gaps, hash mismatches, settle rejects, or orphaned chunks. The saved
server routing lines confirm actual city hits. It also reported **16 stale
drawn chunks during motion**; retain this as an open rendering/streaming
concern. This is functional destruction coverage, not a visual-quality claim
or a 5–6k-awake full-tick performance benchmark.

The fixture shipped with the client regression now contains the actual
release-solver capture. Commits remain local; no new push was attempted while
the previously reported automatic approval rejection of private-source upload
remains unresolved.

Next work: qualify the measured contact-processing and replay bottlenecks at
the player reports' heavy load, and reproduce moving-body bootstrap/state
freshness without reintroducing the discarded v2 classifier hot path. The
native multilevel solver remains experimental and is not deployed.
