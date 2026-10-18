# Exact shot inputs for city simulation comparisons

The recorder now captures and replays each external shot command at its original
simulation tick. Previously, the default adaptive aim chose a target from the
current body positions. A small difference in collapse changed subsequent shot
origins and directions, so equal shot counts and cadence did not establish equal
inputs between two optimization runs.

`--shot-tape-out <new.json>` records every attempted shot, including misses.
`--shot-tape-in <json>` bypasses adaptive and authored aiming and dispatches every
recorded command before that tick's physics step, in its original order. Multiple
shots on one tick are preserved. Positions and directions are serialized as f32
bit patterns, preserving signed zero and avoiding decimal conversion changes.
Replay does not normalize the stored direction again. Generated directions are
normalized once at the firing boundary, matching the server's unit-ray convention.

The tape checks its version, manifest hash, tick rate, duration in ticks, gravity,
and six resolved weapon settings before creating a GPU world or trace output.
Invalid, nonfinite, unordered, or out-of-run commands are rejected. Explicit shot
generation flags cannot accompany an input tape. Other simulation settings are
intentionally recorded separately in run provenance: an optimization comparison
may vary them, and the tape does not certify their equivalence.

Completed output tapes use create-new semantics and cannot replace prior runs.
Preflight checks reject tape paths that alias recorder outputs or the input scene,
including symlinks and hard links. Packet dump directories cannot contain a tape.
A replay checks at completion that all inputs were consumed unchanged. Metrics are
explicitly flushed before a completed tape is written.

Several recorder discrepancies are fixed alongside replay. Its raycast range was
200 m while the city uses 400 m; it now uses the shared shot profile's range.
Raycast, wake, and blast errors now fail the run instead of becoming misses or
silently omitted work. `--hz` now rejects values other than 60 because the bridge's
`World::step` integrates a fixed 1/60 second even when the old recorder advertised
a different rate. With `--output /dev/null`, the small sidecar follows the metrics
file, when present, instead of writing `/dev/null.sidecar.json`.

The initial record/replay check exposed another mismatch: the recorder ignored
`VIBE_CITY_VARIED_HEIGHTS=0`, building 86,966 chunks instead of the live city's
96,420. The server and recorder now share this setting through `city_varied_heights`.
The first test's raw evidence is retained separately as
[initial varied-height results](../bench-results/simulation-frontier/shot-input-replay-initial-varied-heights/summary.json);
it proves exact input replay within that scene, not a match to the live city.
The earlier restore-context traces also used that smaller scene, as their native
logs confirm. They cannot be presented as exact live-geometry measurements.

This changes recorder behavior and shares the server's existing setting logic. The city server, client, forces, contact
processing, fracture decisions, and same-tick rollback/replay are unchanged. A
200-shot qualification script specifies test inputs; it imposes no runtime
interaction limit. Earlier recorder results are not an identical-input baseline
for this version because the range and firing boundary have been corrected.

## Validation

Nine release recorder tests pass with the qualified CUDA dependencies. They cover
exact bit serialization, same-tick dispatch, metadata mismatch, invalid commands,
quiet runs, overwrite refusal, path aliases, conflicting command options, and
misleading tick rates. The release executable builds successfully.

The corrected release recorder is game `ceb0d98` (main implementation
`13dafb4`), solver `bd71ce1b`, executable SHA-256
`0565e30a1f9aeb2d0ea6087b2a1f671c4958230047981ab77a0830cd1b9b0593`.
The GPU runs used the live simulation settings, with profiling and the context
experiment disabled. Builds finished first; each test group ran exclusively on
the GPU while the public server was idle. The wrapper restored its original
immutable executable and environment after each group.

A quiet one-tick check and both 1,200-tick destruction runs matched the serving
manifest hash `1172d302f5598a5f366d8149b3772f8a9642788f42b753f00e8c3607fbe09c50`
and all 96,420 chunks. The record/replay command tapes match byte for byte.

| Observed result | Record | Replay |
| --- | ---: | ---: |
| Attempted shots | 200 | 200 |
| Hits / misses | 200 / 0 | 82 / 118 |
| Peak awake bodies | 5,566 | 7,754 |
| Ticks with a replay pass | 614 | 707 |
| Final broken bonds | 24,641 | 32,707 |
| Membership-count mismatch ticks | 0 | 0 |

The first discrete body/awake/bond-count difference appears at tick 80. Later
raycasts therefore encounter different geometry: identical shot inputs do not
imply identical hits, damage, or computational work. This is one process in each
mode, with adaptive targeting only during recording. It establishes neither
deterministic physics nor a performance comparison. Repeat optimization arms
using replay, measure their variation, and retain per-step fidelity checks;
large end-state differences alone cannot be attributed to an optimization.

A separate GPU fixture applies two commands on tick 60 and one on the final
tick, preserving a signed-zero direction component and two deliberate misses.
All three inputs return unchanged. Weapon, duration, and old-scene metadata
mismatches fail before creating the requested output files. All runs have zero
membership-count mismatches; that is not a claim of complete pose equivalence.

The [retained evidence and verifier](../bench-results/simulation-frontier/shot-input-replay/summary.json)
include commands, bit-exact tapes, source/binary/library hashes, compressed raw
metrics/logs, negative cases, and the restored live state. The old template's
unused revision fields are explicitly distinguished from actual run provenance.

No new live simulation optimization was enabled by this increment. At 04:38 UTC
the restored public server still matched SHA-256
`7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee`
and the same live manifest. The deployed streaming fix and known below-ground
geometry issue remain documented in
[outbound-stream-isolation-2026-09-06.md](outbound-stream-isolation-2026-09-06.md).
The next performance comparison can use the corrected full-height scene and a
fixed input tape to investigate the report's contact and rollback costs. Real
multiplayer streaming coverage remains a separate release requirement.
