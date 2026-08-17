# Best of both: what the combined system actually costs

2026-08-17. Two lines of work merged into one repo -- vibe-land's stress-solver
simulation (correct fracture, real sleep) and the destruction-codec's streaming
research (per-body fitting, artifact gates, island streaming). This measures the
result against both parents in the units each of them used.

## The floor, apples to apples

The destruction-codec's headline number was the **world-wide floor every viewer
must hold**: the coarse tier no subscription strategy is allowed to shed. It was
declared physical -- set by how many bodies collide at once, immune to
precision, cadence and stride.

Re-run with the identical strategy configuration (`PS2` grid split, `SS5`
coarse-only subscribe, 90 m cells, 2 s far flush, stride ≤ 240, 128 mm grid,
`--coarse-min-radius-m 0` so nothing is thinned) over a 5 s active window:

| content | bodies / chunks | world floor | coverage miss |
|---|---:|---:|---:|
| D6 joints, 9 buildings (2026-08-17) | 55,063 | **6.60 Mbps** | 0.00% |
| Blast, 9 buildings localized | 6,138 | 0.192 Mbps | 0.00% |
| Blast, 9 buildings 60 s barrage | 6,138 | 0.319 Mbps | 0.00% |
| Blast, 25 buildings all attacked | 17,400 | 0.598 Mbps | 0.00% |
| **Blast, 64 buildings, scale-matched** | **43,998** | **2.685 Mbps** | 0.00% |

The last row is the fair comparison: 43,998 chunks against 55,063 bodies,
43,928 bonds broken, peak 9,137 rigid bodies. **6.60 -> 2.685 Mbps, a 2.46x
reduction at 80% of the body count** -- so roughly **2x better per body**, with
coverage still perfect.

The floor was never physical in the sense claimed. It was physical *for content
that never stops moving*. D6-welded buildings sway forever (59 rests out of
55,063 bodies in 5 s); a stress-solver structure is one kinematic body until
something breaks it, and its debris genuinely settles.

**Caveat that keeps this honest:** the tracks layer does not yet use island
streaming (`debris-tracks` still encodes per chunk). So the whole 2.46x above
comes from the *simulation*. The codec's own 1.2x, and the 1.39x measured on the
coarse tier, are still on the table.

## Against vibe-land's own production wire

vibe-land measured itself in `client/netlab/FINDINGS-city-stress-2026-08-16.md`
on a grid-4 city. Different measurement -- actual client-observed totals, not a
world floor -- so this is an order-of-magnitude comparison, not a like-for-like:

| | chunks | islands | measured |
|---|---:|---:|---|
| vibe-land wire v2 | 16,512 | 12,643 | **5.65 Mbps** client total (2.47 governed pose + ~3.2 reliable) |
| this work, scale-matched | 43,998 | 9,201 | **2.685 Mbps** floor / 3.819 Mbps whole world un-subsetted |

Per chunk: **0.342 kbps** (vibe-land) against **0.061 kbps** (here) -- about
5.6x, on 2.7x more chunks.

### The transferable finding: the reliable channel

vibe-land's Finding 3 is that **topology churn costs more than the pose stream it
supports** -- ~3.2 Mbps of reliable traffic against 2.47 Mbps of poses, which is
what pushes the client past its own 4.0 Mbps burst ceiling.

The same information, on the same scale of event (43,928 broken bonds, 13,959
chunk migrations, 9,201 islands):

| | reliable topology cost |
|---|---:|
| vibe-land wire v2 | ~3.2 Mbps |
| island-stream topology track | **0.026 Mbps** (48,146 bytes total) |

Two orders of magnitude, and it is not a trick: the topology track carries the
same facts (which bonds broke, which chunk belongs to which island) as sorted
varint deltas -- bond ids against their predecessor, and each chunk's island root
coded against the chunk's own index, which is near-zero because a root is
usually close by in index order. vibe-land sends explicit chunk-id lists per
promotion plus periodic full baselines.

This is the single most directly portable result in this document. It needs no
simulation change and no new codec: it is a re-encoding of a packet vibe-land
already sends, on the channel its own measurements name as the bottleneck.

## How to tell whether we are doing well

Three questions, in the order they should be asked:

1. **Does it fit the budget?** vibe-land's per-client ceiling is 2.50 Mbps and
   its burst ceiling 4.0 Mbps. The scale-matched floor is 2.685 Mbps -- over the
   pose ceiling, under the burst one, and that is before island streaming
   reaches the tracks layer. The 25-building city at 0.598 Mbps and localized
   destruction at 0.192 Mbps are comfortably inside.
2. **Is it perceptually free?** The artifact gates (freeze, reversal,
   excess-step) are the fidelity contract, not error percentiles. Every scene
   here passes. A viewer should NOT be able to pick the reconstruction from the
   simulation at the 0.5 cm bound -- if they can, something regressed.
3. **kbps per moving body** is the metric that survives scene changes. Body
   count and destruction level swamp everything else, so a raw Mbps number is
   only meaningful beside them:
   - D6 codec: 0.120 kbps/body
   - vibe-land wire v2: 0.342 kbps/chunk
   - **this work: 0.061 kbps/chunk**

## What is left

1. **Island streaming into the tracks layer.** The floor above is per-chunk
   encoding; the coarse tier's loose bound is exactly where island derivation
   measured 1.39x. This is the largest remaining codec lever and needs no wire
   change.
2. **Port the topology track to vibe-land's wire.** Highest value per unit of
   work in this document, and it targets a bottleneck vibe-land has already
   measured and named.
3. **A live client.** Everything here is still an offline harness reading trace
   files: no loss, no RTT, scripted cameras. Nothing in this document has been
   measured end to end in a match.
