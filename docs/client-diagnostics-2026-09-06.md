# Client diagnostic coverage and pose reuse, 2026-09-06

**Deployed to `/city` at 07:54:18 UTC without restarting the server.** Reloading
loads this client update. Existing tabs retain their original content-addressed
assets and keep their session until they choose to reload. No server binary,
physics setting, interaction limit, collision geometry, sleeping, freezing,
fracture, or rollback behavior changed in this deployment.

## Changes

The ground-depth count and deepest-chunk provenance now share the same
−0.25 m threshold. Previously, reports counted −2 m chunks but withheld their
composition inputs until −5 m. Provenance now includes world position, body
position and rotation, local position and rotation, structure/node/body identity,
settled state, topology sequence and whether pose-source tracking was active.
Arrays are copied so later presentation updates cannot mutate the captured
report. Client body poses may be interpolated; they are not a synchronized
sample of the server's physical shapes.

Each report identifies whether the diagnostic sweep ran, its wall/monotonic
capture time, valid/unresolved pose counts, stale-draw probe installation and
how many drawn poses were actually compared. Disabled or unavailable checks
can now be distinguished from a checked zero. Missing body-local poses no
longer masquerade as world positions in the ground/floating diagnostics.

The recorder's drawn-versus-ledger comparison reuses the sweep's float32 world
positions instead of walking the ledger and allocating a second composed pose
for every chunk. This eliminates that repeated work. It is diagnostic work,
not a change to rendering or simulation. Float32 sampling can affect a
comparison exactly at the diagnostic distance threshold; these measurements
are not bitwise assertions about world state. No client FPS speedup is claimed.

## Validation and deployment

49 client tests passed, including the new rotated-body regression where a body
origin at +1 m produces a chunk centroid at −2 m, shallow-penetration evidence,
immutable report snapshots, disabled source tracking, missing owners and actual
drawn-pose coverage. TypeScript checking and the production Vite build passed.
The existing generated WASM assets were reused; their content did not change.

The staged client passed a local WebTransport browser check before publication.
Only two new hashed JavaScript files were added; the HTML entry point was then
replaced atomically. All previous asset files were retained. The old index is
saved for rollback under `.certs/vast-city/client-index-before-diagnostics.html`.
The served HTML hash and isolation headers were checked after publication.

A bootstrap check on the served files passed. A stronger follow-up waited for
actual motion traffic and a ledger-hash comparison: **262 city datagrams,
1 hash check, 0 hash mismatches, 0 topology gaps, 0 orphaned chunks and 0
JavaScript errors**, rendering all **96,420 chunks**. All chunk poses were
resolved and compared by the diagnostic sweep. The 480×270 FAST/software browser
did not fire shots or change public settings. This proves local functional
streaming, not public UDP reachability, visual perfection or a frame-rate result.

Client source is game `4f62f24` (release branch `62e7a23`). The server remains
PID 166548, source `a4685b3`, SHA-256
`7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee`.
Direct GPU/CUDA stress remain enabled. The compact host-contact candidate is
still disabled and awaits exclusive full-city qualification.

## Findings and limits

The live-stream capture reports **four below-ground chunks and one stale-draw
comparison**. Those observations are retained, not converted into a clean
geometry claim. The deepest chunk is structure 1, node 22622, island 1359,
at approximately **(2469.03, −40.46, 512.89) m**. It has one member, zero local
position offset and the same body Y. A wrong body-local offset composition
does not explain this particular sample. The same pose appears in independent
fresh browser bootstraps, and the client reports it as unsettled.

The existing server log records one kill-floor parking operation, with the
preceding timestamp **04:51:24.420759 UTC**. Later server stats record one parked
escapee but `min_body_y` near −0.077 m. Source inspection explains a blind spot:
`post_step` parks escapees directly through `freeze_chunk_bodies`, while minimum
height excludes kinematic snapshots and instead uses the regular freeze
tracker's height census. The kill-floor path does not register that parking in
the regular tracker or produce the ordinary settle event there. The evidence
is consistent with that path; it is not a matched native shape-pose inspection
of this specific entity, and it does not explain all shallow chunks in the
human reports.

The inherited −40 m parking intervention remains unchanged, along with the
underlying escape/ground behavior. It needs a proper physics/stream-state fix;
this diagnostic update is not a fix for penetration and adds no clamp. The
other shallow chunks and the stale-draw observation still need synchronized
body/shape and presentation evidence.

[Evidence and verifier](../bench-results/simulation-frontier/client-diagnostics/summary.json)
retain the failed geometry observations alongside the passing functional checks.
