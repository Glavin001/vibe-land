# District corruption: chunk-id overflow (2026-08-17)

Reported symptom: shooting any building in the district scene made it "look corrupted" --
flat panels materialising in a shell around an intact tower, large slabs rotating in
implausible ways, and an overlay warning `below ground 94 @ -74.0 m`.

Fixed in `1f28cc0`. Two dead ends preceded it and are recorded here because both were
plausible and both cost a full measurement cycle.

## Root cause

`destruction/src/ids.rs` packed chunk ids as `(structure_id << 12) | node_index`, capping a
structure at **4096 nodes**. A structure is one *scene-pack instance*, not one building. The
district pack is a single instance with **15,918 nodes**, so every node index ≥ 4096 -- 74%
of the pack -- overflowed its field, carried into the structure id, and came back out of
`chunk_id_parts` masked to `node_index % 4096`.

Island membership is carried as chunk ids (`wire.rs:468-472` maps them back through
`chunk_id_parts`), so a promoted island named chunks that had nothing to do with it. Measured:
15 distinct two-member islands pairing chunks up to **157 m apart**. Those chunks drew at the
aliased body's pose and orientation. That is the shell of debris and the impossible rotations.

The bound was a `debug_assert!`. The server ships release, so it never fired -- the pack
loaded cleanly and corrupted quietly for the whole match. It is now a hard `assert!`: node
counts are fixed when a pack loads, so a violation is an authoring error that should fail at
startup rather than survive as invisible corruption.

Widened to 16 bits. Costs ≤3 LEB128 bytes rather than ≤2 for a gap crossing structures,
which island membership never does.

### Why the single tower never showed it
`fractured-highrise-10f.json` has 1,096 nodes. Every pack before the district fit inside
4096, so the ceiling had never been touched. This is the general shape of the bug class:
**a limit sized against "one building" met an asset that is a whole city block.** The same
assumption also produced the batching defect below, independently.

## Verification

`city-district-demo` at a matched workload (6,966 broken bonds / 1,870 bodies, against
HEAD's 6,773 / 1,811):

| metric | HEAD | fixed |
|---|---|---|
| corrupt island bodies (`diagnoseFrames`) | 15 (770 events) | **0** |
| membership violations | 23 | **0** |
| chunk teleports/min | 1,002 (worst 287 m) | **0** |
| chunks below ground | 65 | **0** |
| correction snaps/min | 276 | **0** |

Regression tests in `ids.rs`: `district_sized_structures_round_trip` (round-trips 4095, 4096,
15_917 and the field maximum, and checks the node index never leaks into the structure field)
and `node_index_past_the_field_is_loud` (should_panic). Both fail against the old packing.

## Dead end 1: the stagger key (partly real, wrong culprit)

`CityChunksLayer.tsx` staggered deferred transform writes by `structureId`, and at `GRID=1`
every body has `structureId 0` -- so the whole map deferred and resumed in lockstep instead
of spreading across the stride window. Real defect, fixed in `77b7d0a` by batching and
staggering on spatial cells.

But it **cannot** have caused the reported symptom, and the reasoning is worth keeping:
staggering changes *which frame* a chunk is written on, never *how often*. At stride 8 a
chunk is redrawn every 8 frames whether phases are aligned or spread, so the instantaneous
population of stale chunks is unchanged by construction -- only its distribution across
frames moves. The measurement agreed: stale chunks per body were 0.96 before and 1.04 after.

The tell that should have been caught earlier: the user's screenshots were taken standing
*next to* the struck building, and everything within 40 m runs at stride 1 -- no deferral at
all. A deferral bug cannot explain corruption in chunks that are never deferred.

`77b7d0a` is still worth having on its own merits: one structure meant one 15,918-instance
batch, which also killed frustum culling (a 289 m mesh always intersects). 23 batches now,
`cityChunkUpdateP95MaxMs` 23.8 -> 15.9-17.5 ms.

## Dead end 2: comparing two single runs

The first before/after pair showed the fix making everything worse -- 8 failures against 2.
It was an artefact: the "after" run happened to do **2.08x the demolition** (10,012 broken
bonds vs 4,823), and every count-based client metric scales with that.

What exposed it: **SERVER also degraded** (58.1 Hz vs 60, 21 over-budget seconds), and the
change was client-only. A client-only change cannot slow the server, so the workloads could
not have been comparable. Always sanity-check that a layer you did not touch stayed put.

`city-district-demo` is stochastic -- the GPU physics is not deterministic and the amount of
damage varies ~2x run to run. Rules that followed:
- Report workload (`broken_bonds`, `chunk_bodies`) alongside every client metric.
- Normalise counts by workload before comparing, or match workloads before concluding.
- To attribute a change, run the *unmodified* code at a comparable workload. Save the working
  tree aside and `git checkout HEAD -- <files>`; do **not** use `git stash` (see
  `[[git-stash-pop-hazard]]`).

## Still open

- `cityClockRollbacksPerMin` ~30,000/min (gate 300). Pre-existing and not district-specific:
  the single tower fails it at 1,608/min. `presentation.ts:307-317` discards an in-flight
  smoothing correction whenever the render clock rewinds sub-tick, popping the pose to the
  raw path (max abandoned correction 0.21 m). Next target.
- `cityChunkUpdateP95MaxMs` still fails, but it is a non-decaying accumulator pinned by the
  bootstrap paint; it measures the join spike, not steady state (60 fps, city stream idle).
- The reported `below ground 94 @ -74.0 m` never reproduced directly, but below-ground chunks
  went 65 -> 0 with this fix, so it was plausibly the same overflow. Worth confirming.
