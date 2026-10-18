# The draw call that was ten thousand draw calls

2026-08-25. Written after building a reproducible client render benchmark,
finding that `gl.render` was ~97% of the city's CPU frame for reasons no
existing counter could show, and splitting the chunk renderer on shape class.

**Headline: 2.6-4.4x frame rate on the destructible city, and a 13x cut to the
frame p95 at scale.** Same triangles, same resolution, same pixels.

## The measurement problem came first

Every previous client perf number was unusable for judging a change, for two
independent reasons.

**The desktop harness was vsync-capped.** `frameTotalMs` read 16.67 ms in every
run because that is what a 60 Hz swap costs, not what the frame costs. Under
that cap a 3x improvement and a 3x regression look identical. The netlab note
that desktop Chrome "runs 60-67 fps on this scene and cannot reproduce the
problem" was measuring the cap. Both new tools pass `--disable-gpu-vsync
--disable-frame-rate-limit`.

**The live `/city` is not reproducible.** Two runs at the same heading measured
**4 and 28 draw calls** — spawn position varies per session, the world keeps
settling, and the manifest is whatever the last demolition left behind. That
spread is larger than most optimizations worth making.

So `/renderbench` (`client/src/pages/RenderBench.tsx`) generates a seeded
synthetic city and runs a time-parameterised camera path. It reuses the real
policy modules — `chunkGeometry` for shapes, `renderScheduling` for cell
partitioning and distance striding, `renderStats` for the breakdown — so it
measures the shipping renderer rather than a model of it, and it scales past
what the physics server can simulate. Two runs at the same seed are pixel-equal.

One more trap worth recording: without `--use-angle=vulkan` Chromium silently
picks SwiftShader on this box and every number becomes software rasterisation.
`client/tools/glinfo.mjs` prints the unmasked renderer, so "is this real?" is
one command rather than an assumption.

## What the frame was actually doing

Uncapped, at 100k chunks:

```
frameP50 16.4 ms   cpu 16.2 ms   gl.render 15.7 ms   cityFrame 0.50 ms
draws 40           triangles 759,098
```

`gl.render` is 97% of the CPU frame. Three facts made the usual suspects
impossible:

- **Not fill.** 720p, 1080p and 1440p all measured 4.7 ms on the smaller scene.
  Flat against pixel count is not a rasterisation cost.
- **Not the write loop.** `cityFrame` is 0.5 ms with 3,000 live bodies and
  1.3 ms with 12,000. The comment in `renderScheduling.ts` calling the recompose
  "the client's dominant cost" has not been true for some time.
- **Not triangle count.** 250k chunks (32 draws, 599k triangles) rendered
  *faster* than 100k chunks (40 draws, 774k triangles), because a bigger city
  puts a smaller fraction of itself in frustum.

What it tracks is **instances in visible cells**. And that is the tell:
`THREE.BatchedMesh` draws through `WEBGL_multi_draw` and emits **one sub-draw
range per instance**. `info.render.calls` counts the whole multi-draw as 1. The
driver executed 100,352 ranges of roughly 8 triangles each.

The counter that would have shown this did not exist, so `buildMesh` now logs
`subDraws`, and the header comment says why that is the number to watch.

## The fix, and why the old reasoning failed

The original comment justified BatchedMesh like this: fractured chunks each have
their own convex hull, an InstancedMesh can only draw one shape, and hulls are
deduplicated anyway "because the city stamps one building pack sixteen times".

Checked against the actual manifest (`41f53e20…`, 24,105 chunks):

| | count |
|---|---:|
| box chunks | 16,945 |
| hull chunks | 7,160 |
| **distinct hull shapes** | **7,160** |

**Zero reuse.** Every hull is unique, so the dedupe premise does not hold. But
the 70% that are boxes all share one unit cube and carry their extents in the
instance matrix — those are exactly what instancing is for.

So each render cell now produces up to two objects:

- **boxes → one `InstancedMesh`** — one genuine instanced draw for the cell
- **hulls → one `BatchedMesh`** — still the right tool for one-shape-per-chunk

Live, downtown: **24,105 sub-draws → 7,182**, across 22 instanced cells and 22
hull batches.

## Results

Deterministic bench, 1280x720, shadows on, RTX 4090 through ANGLE/Vulkan:

| scene | before | after | |
|---|---:|---:|---|
| 24,105 chunks, static | 115.9 fps | **422.7 fps** | 3.6x |
| 24,105 chunks, 4k live bodies | 135.7 fps | **354.1 fps** | 2.6x |
| 250,000 chunks, 12k live bodies | 48.5 fps | **214.1 fps** | 4.4x |
| 250k, frame p95 | 79.4 ms | **6.1 ms** | 13x |

The p95 row is the one players feel. At 250k chunks the old path stuttered to
79 ms; the new one holds 6.

Shadows, for scale, are worth ~26% on top of this (15.5 → 11.5 ms at 100k) and
remain a toggle.

## Two things fixed on the way

**The stagger key.** The distance stride is staggered per upload unit, because a
unit re-sends everything it holds when any one instance in it moves. A cell now
has two of them, and keying the stagger on the renderable index gave a cell's
box bodies and its hull bodies different phases — rewriting both on frames where
neither used to move. Keyed on the **cell**, which restores the original
property.

**7,160 discarded convex hulls per city load.** `buildMesh`'s first pass built a
map of every distinct hull geometry and never read it; the per-cell loop
triangulates from the points again. Pure waste on every load, and pre-existing.

## Visual verification

The bench's fixed camera makes a pixel A/B possible where the live city cannot.
At 24,105 chunks, batched vs hybrid: **199 of 921,600 pixels differ by more than
2/255**, mean absolute difference 0.0116. Those are z-fighting pixels on
coincident faces, where the draw order changed. The images are otherwise
identical.

## Test status

`tsc`, 823 unit tests, and 5 of 7 city e2e specs pass — including
`city-drawn-matches-ledger`, which reads instance matrices back out of the mesh
and compares them to the ledger, and so is the spec that most directly exercises
this change; and `city-frame-profile`.

**Two specs fail, and both fail identically on the pre-change commit.** Verified
by stashing the change, rebuilding, and re-running:

- `city-destruction` / `city-destruction-v3` — `walkToward` gives up 75-90 m
  from its target, against a 30 m assertion. A movement/pathing failure with no
  rendering content.
- `city-fracture-continuity` — asserts `drawnOver === 0`, i.e. no chunk drawn
  more than 0.5 m from its ledger pose. But the renderer defers distant bodies
  by a stride of up to 8 frames *by design*, and debris is speed-clamped at
  12 m/s, so a legitimately-strided chunk is up to 1.6 m stale. `worstDrawnM`
  exceeded 0.5 m in **every run of both builds**:

  | build | broken bonds | framesDrawnOff | worstDrawnM |
  |---|---|---|---|
  | before | 1253 / 1367 / 992 | 5 / 4 / 168 | 0.69 / 0.74 / 1.52 |
  | after | 1290 / 1124 / 2106 | 10 / 175 / 226 | 1.75 / 1.43 / 1.49 |

  The metric is high-variance and not damage-monotonic — the lightest-damage run
  of either build (992 bonds, before) produced 168 frames off. At n=3 these two
  distributions are not distinguishable. The assertion needs a threshold that
  accounts for the stride the renderer deliberately applies; as written it is
  not a guard anything can pass.

## Next, in order

1. **Partial instance uploads.** A touched cell currently re-sends its whole
   matrix buffer. Unlike a BatchedMesh's data texture, a buffer attribute *has*
   a partial path (`addUpdateRange`), and the write loop already knows which
   instances it touched. Not needed for the numbers above — the write path is
   under 2 ms — but it is the obvious next lever if upload bandwidth becomes the
   ceiling.
2. **Merge settled hull chunks.** 20,508 of 24,105 chunks are settled and never
   move, and hulls are the entire remaining 7,182 sub-draws. A per-cell merged
   static geometry for settled hulls would collapse most of what is left, at the
   cost of a rebuild whenever a body settles.
3. **Re-measure on a phone.** Every number here is an RTX 4090 through
   ANGLE/Vulkan. Sub-draw overhead is a driver cost and should transfer in
   shape, but the ratios are what transfer, not the absolutes — and the tier
   split in `renderQuality.ts` exists precisely because the desktop rig could not
   reproduce the phone.

## Caveats

One machine, one GPU, one browser. The bench's synthetic city matches downtown's
shape mix (30% hulls) and chunk count but not its exact layout, so cell
occupancy differs; the live city's own sub-draw count (24,105 → 7,182) is
measured rather than modelled, and moves in the same direction by the same
factor. Hull diversity in the bench comes from a 32-shape pool rather than being
unique per chunk — that affects vertex budget and build time, not sub-draw
count, which is what the frame time tracks.

---

# Addendum: the fracture-pattern pool, measured and looked at

Same day. The remaining 7,182 sub-draws are all hulls, and hulls are only
un-instanceable because every shard is unique. So: what if they were not?

## It is worth a great deal

`/renderbench` gained two hull strategies. Per-cell instancing (`pooled`) and
city-wide per-pattern instancing (`pooled-global`), swept over library size at
100k chunks against the 204 fps the shipped build gets:

| patterns | `pooled` (per cell) | `pooled-global` |
|---:|---:|---:|
| 16 | 399 fps | **633 fps** |
| 32 | 197 fps | — |
| 64 | 116 fps | **679 fps** |
| 256 | 42 fps | **489 fps** |
| 512 | — | 350 fps |

Per-cell **inverts** past ~32 patterns: it costs `cells x patterns` REAL draw
calls, and a real draw call is dearer than a multi-draw sub-draw, so by 256 it
is worse than the all-batched code it replaced. City-wide is `O(patterns)`
regardless of city size and holds a wide plateau. It gives up frustum culling —
a pattern's mesh spans the map — and that trade measured strongly positive,
because what it buys back is vertex work on 30-vertex shards instead of
thousands of sub-draws.

`gl.render` falls to **0.35 ms**. At that point the renderer has stopped being
the bottleneck at all.

One measurement bug found and fixed on the way: the global meshes were still
having their bounding sphere recomputed every frame, a city-wide walk for a test
that never runs (`frustumCulled` is false). It was the largest line in the
frame. Skipping it moved `pooled-global` at 16 patterns from 310 to 633 fps.

## And it cannot be done at render time

`city/hullPool.ts` implements the runtime version — pick N shards out of the
manifest, assign each hull chunk one of them scaled to its own radius, instance
by pattern. It works, it is fast, and **it looks wrong**.

A wall's shards are a Voronoi partition *of that wall*. Each is cut to fit its
neighbours, and that mutual fit is the only reason an undamaged wall reads as
flat. Swap one shard for a stranger of the same size at the same centroid and
the fit is gone. Looked at (`tools/pool-compare.mjs`, pool 64 against exact, one
session, one viewpoint, toggled in place), an **intact** downtown comes out
looking demolished: every facade a mess of protruding spikes. This is not a seam
artifact to be tuned down with a bigger library — 16, 64 and 256 all destroy the
surface equally, because the defect is per-shard, not per-pool.

So the knob ships **off**, and is documented as an instrument rather than a
setting. `SHARDS: EXACT | POOL n` on the city panel, `?hullPool=N` on the URL,
persisted in localStorage; each change rebuilds the chunk meshes.

## What this actually argues for

Pool at the **panel** level, during authoring, not at the shard level, at
runtime. Precompute N fracture patterns for a wall panel; stamp a whole pattern
onto each panel. Then the shards that land together are the ones cut to fit
together, the jigsaw survives exactly, and every panel using pattern *k* shares
geometry with every other panel using pattern *k* — which is all instancing
needs.

The pack makes this tractable. Downtown's node types partition cleanly:

| node type | collider | count |
|---|---|---:|
| slab | cuboid | 9,116 |
| column | cuboid | 7,384 |
| foundation | cuboid | 445 |
| **wall** | **convex_hull** | **7,160** |

Every hull is a `wall` and every `wall` is a hull. There is exactly one element
type to build a pattern library for.

Secondary win, if it is done: hull points are **5.44 MB — 82% of all collider
bytes and 29% of the 18.5 MB pack** (median 30 points per hull). A pattern
library collapses that to N, shrinking the pack, the 19.6 MB manifest the client
downloads, and the load-time hull triangulation.

And the sweep above says the library can be **large**: 256 patterns still runs
2.4x the shipped build. Whatever variety the look needs, the renderer can
afford it.
