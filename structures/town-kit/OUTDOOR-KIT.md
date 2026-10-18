# Bayline outdoor destruction kit

An isolated authoring and review collection for racing shortcuts, destructible
cover and support-driven collapses. It does not replace the deployed `/city`.

## Open it

From `structures/town-kit`:

```sh
npm run build:outdoor
npm run preview
```

- [Outdoor gallery](http://127.0.0.1:6174/?asset=outdoor-gallery)
- [Residential shortcut](http://127.0.0.1:6174/?asset=outdoor-residential-run)
- [Market encounter](http://127.0.0.1:6174/?asset=outdoor-market-encounter)
- [Service yard](http://127.0.0.1:6174/?asset=outdoor-service-yard)
- [Dressed Bayline](http://127.0.0.1:6174/?asset=bayline-outdoor-town&camera=garden-dressing)
- [Recorded shade-tree collapse](http://127.0.0.1:6174/?asset=tree-shade-0&recording=collapse)

The Asset menu is populated from built files, rather than a static list of
unbuilt examples. Missing artifacts return JSON 404s. Failed, absent and stale
recordings cannot be selected as current passing reviews.

Choose individual assets in the Asset menu, then a native recording. Playback
uses recorded chunk/body poses; the preview does not substitute animation for
physics. Damage recordings open just before the first impact. Frame fragments
fits the remaining debris. Native reports and visual captures live in `out/reviews`.

The existing sibling authoring checkout is used first. On macOS the kit also
discovers `../PhysX/blast/blast-stress-solver/structures`; an explicit
`TOWN_KIT_AUTHORING_ROOT` always wins. Install the application's existing client
dependencies before building. There is no runtime tree-generation dependency.

## Collection

Five tree families have three baked seeds each: shade, narrow street, conifer,
ornamental and sapling. Mature trees use 20–32 physical chunks; saplings use eight.
Trunks and major limbs are closed convex pieces with measured volume, buried
root support, and explicit bonds across mating faces. A trunk cut releases the
connected crown; a limb cut releases its remaining connected wood and foliage.

Twenty outdoor props: mailbox, wheelie bin, dumpster, bench, planter, streetlight,
street sign, bike rack, hydrant, pallet, crate, sandwich board, low wall, bollard,
road barrier, bus shelter, market stall, carport, scaffold and billboard.
Manufactured parts have weaker pull-out/shear connections than solid material.
Loose props rest through contact; installed structures have buried footings.
Review shots are severe qualification impacts, not calibrated player weapons.

The three encounters preserve a continuous five-metre lane. They arrange
breakable garden boundaries, progressively removable street cover and elevated
construction loads beside that lane. The dressed town uses existing lot context
and rejects placements that overlap geometry or obstruct existing walking routes.
All added instances retain independent bond graphs.

The dressed layout is regenerated with the current tree geometry; its exact
placement and chunk counts are recorded in `out/bayline-outdoor-town.meta.json`. It uses one baked seed per tree family for structural
geometry reuse; all fifteen seeds remain in the gallery and 100-tree fixture.

## Rendering and formats

`buildTree(options)` and `buildOutdoorProp(type, options)` return the existing
`{pack, metadata}` shape. Trees also return `visuals`. Public exports are in
`src/index.mjs`; composition helpers are in `src/outdoor-scenes.mjs`.

Physics remains ScenePack v2. An optional version-1 visual sidecar contains:

- Shared mesh buffers and materials, indexed by stable template names.
- An owning node index and a node-local matrix for each attachment.
- Three visual detail levels at 0, 35 and 85 metres.
- The physics SHA-256; metadata also checksums the sidecar itself.

`composeVisuals` follows the node ordering and rotations of `composeScene`,
including mirroring and nested composition. Binary metadata can carry the
sidecar reference without changing physics record strides or multiplayer wire
formats. The exported sidecar is bound to its corresponding expanded physics
pack; callers must compose both from the same placements before serialization.

The preview batches shared meshes and compacts active instances when a pose or
detail level changes. Distant detail is removed from draw counts, not hidden
with zero scale. Fine branches and leaves have no colliders or individual bodies;
their aggregate mass is included in their owning wood chunk. Leaf wind is visual.
A 256-particle pool emits short-lived leaf flecks from recorded bond breaks.
Physical hulls also share exact geometry across quarter-turn placements. The
instance transform restores their authored orientation before applying recorded
motion. Chunk batch bounds update with poses so off-camera geometry can be culled.

The preview and live playground now share the same canopy renderer. Fine twigs
and leaves bend together in spatially varying gusts, with extra leaf-tip flutter
and the same deformation in directional and point-light shadows. Graft bases
stay attached to their physical limbs. The foliage receives subtle instance
color variation; rotated twig grafts and a gentler upward growth force give the
reused templates broader, less repetitive crowns without changing physics.

Visual batches are partitioned into 32-metre cells while sharing geometry and
materials. Their bounds include wind movement and are refitted when chunks
move, including after fracture, so a flying branch does not vanish when it
leaves its original cell. Three distance levels reduce actual instance/triangle
counts. Wind updates shader time, not vertex buffers or server bodies. Live
server-reported island splits also emit a bounded pool of cosmetic leaf flecks.
This is rendering infrastructure for map-scale reuse, not a measured large-map
frame-rate guarantee; the live playground still includes only the three tree
variants that passed native stability qualification.

EZ-Tree's offline skeleton and meshing routines and two leaf textures are pinned
to `dcf309bd86bd521083d9c70f01f2de45fdc7c457`. The adaptation retains branch/leaf
ownership, excludes the application and trellis code, and carries the MIT license
in `vendor/ez-tree`. The generator is used for the fine branching grafted to the
structural limbs; physical segmentation is authored by Bayline.

## Verification and limits

```sh
npm run test:outdoor
npm run check:preview
npm run review:outdoor
npm run capture:outdoor
npm run benchmark:outdoor
```

Native reviews run sequentially under the kit's existing review lock. The review
script supports Linux/NVIDIA and the installed macOS/CuMetal SDK; it preserves
the normal solver budget, convergence rules and physical-rest requirements.
Matching native results are reused. Use `npm run review:outdoor -- --retry-failed`
after addressing failures, or `--fresh` after changing the SDK or solver.
Screenshots require Pillow; select a suitable interpreter with `TOWN_KIT_PYTHON`.

Unit checks cover overlap, support connectivity, seeded variation, branch/crown
separation, visual ownership, transform composition, binary metadata, lane
clearance, detail-level draw counts and bounded leaf effects. They do not replace
native simulation. The 100-tree fixture uses the same fifteen templates.

The native matrix is `out/outdoor-native-matrix.json`. Every entry records its
exact physics hash and outcome. Failed topology updates, failure to reach rest,
and impacts that break nothing remain failures. A successful static gallery does
not qualify an asset for production. The whole dressed town is not certified by
the smaller encounter tests.

The performance report compares the dressed scene against the same undressed
baseline at three fixed cameras, with warmup and measured frame intervals. It
also measures the 100-tree fixture. The provisional p95 overhead target is 15%;
results are explicitly labelled as measurements on a shared GPU. A failure stays
visible in the report and is not converted into a production acceptance claim.

### Initial review — 2026-09-25 (superseded for tree physics)

- All 11 outdoor unit/rendering checks and the preview type check pass. The
  broader authoring/collider/binary regression run passed 17 checks with one
  existing skip before the final renderer optimization.
- Native matrix: **48/76 pass**, **28 fail**. Seventeen cases fail with
  `PhysX fetchResults failed`; eleven fail because the qualification impact
  breaks no bonds. The collection is **not production-qualified**.
- The shade-0 tree passes stability, limb impact and trunk-collapse reviews.
  Recorded poses drive both the wood and its attached crown. All three encounter
  stability and traversal reviews pass. The full town has not had native review.
- At 1280×800 on the shared macOS GPU, p95 frame intervals were 9.05 / 9.00 /
  9.06 ms for dressed hero / garden / shopping cameras, against 9.19 / 9.06 /
  9.22 ms for the same undressed cameras. All meet the provisional 15% gate.
  These frame intervals include display scheduling; they are not isolated GPU
  timings or a guarantee for multiplayer gameplay.
- The 100-tree fixture measured 9.06 ms p95 and 1,235 draw calls across the
  complete render pipeline, down from 25.36 ms and 4,223 before hull reuse.

Reproduce results with the commands above. The matrix preserves each failed case
by name and exact asset hash. Address SDK topology failures and impact response
before promoting the affected assets into the live game; rendering screenshots
and passing encounter traversal do not waive those checks.

### Tree-fracture and asset-menu revision

The original collapse fired a 53-tonne, 15 m/s test sphere. That caused a bottom
trunk block to eject and the crown to flip as one piece. It was also recorded at
10 Hz. The revised tree has four trunk sections and three sections per mature
limb, with stronger root connections and separate effective trunk/branch failure
thresholds. These are gameplay calibration values, not engineering wood strengths.

Physical projectile contacts feed the native stress solver. It selects the bonds
that fracture; the preview consumes the recorded poses and break events. A limb
review now fails if it also fractures the trunk, and either review fails if roots
break. The reports classify trunk, branch and root fractures, record each native
fracture tick and solver break count, and retain per-bond peak utilisation. Tree
motion records at 60 Hz for the first 15 seconds after impact. Playback skips the
30-second stability warmup and its timer starts immediately before the impact.

`node scripts/capture-tree-fracture.mjs` captures the actual before/impact/fall/rest
sequence for both cases; sheets and HTML are in each review's `motion/` directory.
`node scripts/check-preview-assets.mjs` checks every menu asset in the browser.
`node --test tests/preview-output.test.mjs` guards JSON 404s, compressed artifacts
and stale-recording detection.

The local SDK's vehicle source currently requires an inline method absent from
its installed header. Review builds used an isolated copy of the installed
headers at `out/tree-sdk-headers`, with only `PxVehicleComponentSequence.h` taken
from matching source. Its `header-provenance.json` records the source/hash. The
installed native libraries and shared SDK were unchanged. While that SDK mismatch
exists, set `PHYSX_ROOT` to the absolute path of this header copy when running
native reviews. This is a build compatibility workaround, not a solver change.

Current native results after recalibration: **48/76 pass**. Shade-0 and street-0
pass stability, local branch fracture and trunk fracture; all three encounter
scenes pass stability and traversal. Shade-0's branch test breaks two branch
bonds and no trunk/root bonds. Its heavier impact breaks two trunk bonds and
16 branch bonds, including secondary breaks during the fall, with no root breaks.
The remaining 28 failures are 18 native topology/runtime errors and 10 prop
impacts that break nothing. Other tree variants remain unqualified.

The rebuilt dressed town has 121 placements and 191,165 physical chunks. All 42
available asset selections loaded in the browser; missing asset, metadata and
recording endpoints returned JSON 404s. The 13 outdoor/rendering/API regression
checks and preview type check pass.

The refreshed 1280×800 browser benchmark measured dressed-town p95 frame
intervals of 9.05–9.20 ms across three cameras, within 1.8% of the baseline;
the 100-tree reuse scene measured 9.00 ms. All provisional comparison checks
passed with no WebGL errors. These are shared-GPU, vsync-paced browser frame
intervals, not isolated GPU timings or multiplayer performance measurements.

### Interactive cannon range

Open `http://127.0.0.1:6174/?asset=tree-shade-0`. **Aim shot** restores the
intact tree; click visible wood to choose an impact point, orbit to choose the
approach direction, then **Fire ball**. Weight presets and launch speed control
a solid iron sphere (7,850 kg/m³). The default is 500 kg at 25 m/s. Small balls
have lower maximum speeds so their diameter is sampled by the 60 Hz collision
steps; lower-speed shots launch from closer range. Aim compensates for gravity.

Each press starts a fresh native GPU simulation, then automatically plays its
result. This is an on-demand local simulation, not a realtime multiplayer
weapon. The launch, collision, bounce, branch and trunk poses are recorded from
actual native bodies at 60 Hz; no raycast damage or scripted fracture is applied.
Pause, scrub and Reset replay the shot; Aim shot starts another intact-tree test.
A harmless miss or a hit below the fracture threshold is a successful result.

`POST /api/cannon/jobs` accepts a bounded tree/target/mass/speed request;
`GET /api/cannon/jobs/<id>` reports its state. The local origin is required for
writes, requests are size-limited, and the existing native review lock serializes
GPU work. Each run stores its exact pack, input, binary hash, native log, report
and compressed recording under `out/cannon/<id>/`. The harness must be built
before firing; the preview does not silently rebuild shared native dependencies.

The cannon sandbox retains one second of measured intact rest after equilibrium,
then records 15–20 seconds after the launch. It does not replace the strict
30-second stability and converged-rest asset qualification tests. In local
checks, the default front-on shot fractured two trunk and 18 branch bonds;
a 10 kg ball at 5 m/s broke one branch bond with the trunk/root intact; a miss
broke none. Native calculation took approximately 3–8 seconds. Browser rendering
and actual ball position capture are checked separately from fracture counts.
Run `npm run test:cannon` for request, ballistic aim and mass/radius checks.
