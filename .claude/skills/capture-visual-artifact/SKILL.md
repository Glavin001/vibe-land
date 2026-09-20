---
name: capture-visual-artifact
description: Reproduce a reported visual artefact on video with per-frame pose data beside it, and localise it to the one term that moved. Covers the single-tower capture harness, the pose trace and its writer attribution, and the sampling traps that hide a between-frames jump. Use when someone reports debris teleporting, buildings jumping, or chunks appearing and disappearing.
---

# Catching a visual artefact in data

A video shows that a collapse *looks* wrong. It cannot say which chunk went
where, or when, or which of the six writers moved it. Record both.

## The capture

```bash
scripts/netlab/tower-capture.sh --out /tmp/tower -- --seconds 22
```

Starts a private server on its own ports (a live deployment is untouched),
wedge-cuts the footing of **one 10-floor building on an empty ground plane**,
and leaves:

| file | what it is |
|---|---|
| `collapse.webm` | what a player saw |
| `frames.csv` / `poses.json` | where 400 chunks were DRAWN, every frame, with the tick |
| `report.json` | the full client audit, as SEND REPORT would post it |

**One unobstructed building, not the downtown.** Captures made on
`fractured-downtown` are useless to watch: the tower being felled stands behind
three others and most of the collapse happens out of shot.

**A fresh process per capture is the reset.** `POST /city-reset` does rebuild
the tower and the server process then dies a few seconds later, with the reset
itself logging success immediately beforehand. A capture that skips the restart
opens on the rubble of the last one — one run began with 3,249 bonds already
broken and then reported "28 bonds broken" as though nothing had happened.

## Record the composition's INPUTS, not just its result

`chunk_world = body_pose ∘ (rest_local − island_com)`. A composed pose that
jumps says only that something upstream moved. The trace records, per tracked
chunk per frame:

- the drawn world position
- the **body pose** and the **local offset** — the two terms
- the **body key** — a chunk changing hands explains a jump neither term does
- the **writer**: which of `raw | presented | settle | promote | reoffset |
  bootstrap` last set that body's pose

That last column is what turns "a slab jumped" into one code path to read. Both
root causes found this way were found by it:

```
frame 10: 393 of 400 tracked chunks moved 2.27 m by one identical vector
   body key      0x80000000 -> 0x80000000        unchanged
   local offset  [-6.75, 0.32, -4.67] -> same    unchanged
   body position [0, 0, 0] -> [2.25, 0.32, 0]    this moved
```

## Coherence separates a collapse from a bug

For each frame, take every tracked chunk that moved more than 0.5 m and compute
`|mean displacement| / mean |displacement|`. Near 1.0 means they all moved the
*same way* — a rigid translation of a whole body, which physics does not do
mid-collapse. Near 0 means they scattered, which is a collapse.

393 chunks at coherence **1.00**, with the exact inverse vector applied
hundreds of frames later, is a building stepping sideways and back. That is the
signal to chase; per-chunk noise is not.

Exclude bodies that have left the world first (|x|,|y|,|z| > 80 m for a single
tower). One escapee flying at 3,300 m/s is drawn, and it will be the worst
single-frame mover in every run while telling you nothing about the artefact.

## Sampling traps

**The diagnostic sweep is not per-frame.** `sweepChunkPositions` in
`CityChunksLayer` rides the 2 Hz telemetry block (`frameCounterRef.current % 30`). A trace
placed there samples **40 frames in 20 seconds** while claiming to be
per-frame — which is exactly the rate at which a jump between consecutive
frames is invisible. The pose trace runs in the render path and composes only
the traced slots: 1,318 frames in 22 seconds, which is 60 Hz.

**NaN is not the origin.** A slot whose body cannot be resolved must be
recorded as NaN, not `(0,0,0)`, or every frame its body is missing reads on a
plot as a teleport to the map centre.

**Trim the lead-in.** The first capture spent fourteen of its twenty-two
seconds walking into position, so the collapse — the only part anyone wants to
watch — began two thirds of the way through.

## Two artefacts found this way, for reference

**The whole building steps sideways.** Body `0x80000000` is islandSerial 0, the
static anchored remnant, whose pose must never change. Settle and wake events
were being pushed *before* the `snap.kinematic` guard in `post_step`, so every
sleep edge of that kinematic remnant published a settle record carrying the
actor's centre of mass — which wanders as the structure sheds chunks.

**A 110-chunk slab drawn 15 m from itself on consecutive frames.**
`seedPromotions` skipped any promotion whose body key it already held, as
"serial reuse". It is not: the server *republishes* a body whose membership
changed, because that moves the centre of mass its wire pose is expressed in.
The skipped case was the one that most needed anchoring. Worst single-frame
move fell from **32.4 m to 2.0 m**.

## Before claiming a fix

Re-capture and compare the same numbers: rigid slab jumps, frames containing a
>1 m single-frame jump, worst single-frame move, and the report's
`adoptionJumpMaxM`. A fix that moves none of them is not a fix — a
stale-frame gate built on a well-argued theory dropped **zero** records across
a full capture and was removed rather than shipped.
