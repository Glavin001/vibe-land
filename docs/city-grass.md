# Client-side city grass

Grass is enabled automatically when `/city` or `/cityreplay` has a city manifest.
`/grass` is a standalone preview/editor using the same field, terrain and lighting,
with wind, quality, driving, falling-rubble and painting controls. It needs no
server. Add `?grass=off` to the city/replay URL
to disable the blade renderer for comparisons. The green ground cover remains
visible beyond the blade draw distance. Authored tall stands and crop/fern families also retain a distant canopy.

## Rendering

- Original, asset-free blade implementation for the existing Three.js WebGL2
  renderer. No extra packages or per-plant physics bodies. Only authored layout metadata is shared by the server.
- Circular-arc leaves with length-preserving deformation and analytic bent normals, variation in height, width,
  lean and color, rounded leaf lighting and shadow-aware sun transmission.
- World-space gusts sample the city's existing procedural noise texture; a
  faster wave adds tip flutter. Weather wind speed and compass direction drive
  the effect. Zero wind produces still leaves.
- Nearby local-player displacement supplements a shared ground-contact texture.
  Footsteps, tyre tracks and debris compression recover gradually after departure.
- Opaque tapered geometry, depth writing and double-sided single-pass rendering.
  Grass receives building shadows but does not cast thousands of tiny shadows.
  The beauty pass supplies its actual deformed depth to the existing AO pipeline.
- 8 m patches, conservative wind/interaction bounds and frustum culling. Three
  blade topologies share one small vertex/index buffer: **7, 3 and 1 triangle**.
  LOD changes only the draw range, with hysteresis at segment boundaries.
- Short meadow grass uses instance-count reduction to submit fewer blades at distance.
  Randomly ordered deterministic placement keeps every prefix spread throughout
  the patch. Per-blade growth transitions hide density and range changes; newly
  streamed patches grow in over 0.35 s. Roots never follow the camera.
- A single worker generates one patch at a time and transfers typed buffers.
  At most one result is installed per frame. CSP/worker failures use a synchronous
  fallback capped at two builds and a soft 2 ms budget (one build may exceed it). Only uniforms, visibility,
  draw ranges and instance counts change in steady state.
- Instance data uses **31 bytes per plant**: float root/height/yaw, normalized
  16-bit width/lean/variation/rank, normalized 8-bit linear RGB, and four trait bytes. A camera-local cache evicts distant patches and
  releases geometry/material resources on teardown and quality changes.

| Grass profile | Maximum candidates/m² | Geometry distances | Blade range |
| --- | ---: | --- | ---: |
| PRETTY | 150 | 16 m / 30 m | 48 m |
| FAST | 30 | 9 m / 18 m | 28 m |

Distances use the closest point on each patch, including camera altitude.
Density ramps down before topology changes, reaching about 16% of the nearby
value before the final fade. These limits apply to short meadow blades; tall grass and other foliage hand off to a persistent canopy instead.

### Canopy-preserving LOD

Grass at least 0.75 m tall, reeds, wheat, corn and ferns keep their height and
instance density until a screen-door crossfade into distant clumps. PRETTY hands
off over **22–36 m**, FAST over **12–22 m**. The two passes use complementary
dither thresholds and write real depth; there is no transparent sorting. Corn
leaves retain at least two segments, so their middle width survives the cheapest
geometry LOD. Mixed short/tall grass is batched separately.

Distant clumps use **8 triangles, 32 instance bytes, at most one clump/m²**.
Three intersecting side cutouts and an overhead cutout retain the field silhouette
and top coverage. An original generated atlas covers five families and both views.
Colors, maturity, density and building exclusions come from the authored paint.
These are approximate clusters, not one-to-one replacements for individual plants
or planting rows. Fine geometry still handles close views.

The full authored 512 m world is represented in 32 m batches with frustum culling
and **no camera-distance cutoff**. Both quality tiers use the same distant layout.
Only edited neighborhoods rebuild, at one coarse batch per frame; a batch scans
at most 1,024 samples. Worst case is 256 batches / 262,144 clumps across a fully
authored world, before frustum culling. Wind, building shadows and the existing
interpolated contact field also affect the clumps. Contact deformation remains
limited to the active 64 m field; this does not expand interaction/history range.
No new body queries, collision simulations or per-clump frame updates are added.
The preview reports distant clumps and includes their draws in its draw count.

## Placement and integration

`scene/CityGrass.tsx` owns the city lifecycle. `scene/grass/GrassField.ts` is also
usable outside React, as in the smoke benchmark. `grassPlacement.ts` contains
the deterministic placement, budget profiles and manifest exclusion math.

The city is a flat 512 m terrain. Grass roots use y = 0.006 m and stay inside that
terrain. Original manifest chunks produce conservative world-space building
footprints, including rotation and a 0.65 m bare margin. They remain excluded
after demolition. Explicit road/path rectangles can be passed to `GrassField`
as additional exclusions; no road layout is inferred from arbitrary buildings.
The system is intentionally city-specific; uneven or painted practice worlds
need height/material sampling before using it there.

The city's dry photographed grass ground texture samples a density/colour map
matching the living canopy, retaining the original texture detail and dirt blend. This is opt-in
through `WorldTerrain.grassCover`; practice and builder terrain retain their
existing appearance. Ground tint is present at all distances, avoiding a brown
ring where individual grass blades disappear.

## Contact and recovery

`GrassInteraction` owns a scrolling **128×128 RGBA8 texture over 64×64 m**.
R stores elastic compression, GB store bend direction, A stores lasting creases. The shader interpolates current/previous field samples at render frequency
(two cached taps); each plant’s curve flattens towards the ground and bends away from the
contact. There are no blade physics objects or per-blade CPU updates.

The field ticks at at most 20 Hz, decays exponentially over about 1.8 seconds
after a contact-specific hold, and retains existing world-space tracks as it
scrolls in 8 m steps. Tyres sweep between previous/current positions; teleports
over 12 m do not draw a trail. Resting objects refresh their holds. Frame work
is capped at 192 footprint stamps and 32,768 cell visits; a dirty tick uploads
two 64 KiB textures. The field fades out near its edges. It is an approximate visual effect,
not authoritative destruction. Creases decay over 180 seconds; a bounded 256 KiB
cache retains them across camera travel within the session. Healthy plants show
less lasting deformation than dry plants. History is not synchronized or saved
to disk and clears when the field is disposed.

`GrassBodyContacts` reads existing client poses:

- Local and remote walking players, excluding dead/seated players and high jumps.
- Four wheel footprints per car, including custom wheelbase/track/radius and
  available grounded flags. The driver's car uses its local presentation pose.
- Dynamic objects using their rendered poses and conservative ground bounds.
- Promoted city chunks, including **settled/sleeping rubble**. Chunk transforms
  come from the topology ledger; the reader never drains events or steps physics.
  Slabs use box footprints so grass stays down beneath their corners.

The rubble reader resumes a bounded scan (up to 512 chunk poses / 1,024 body
entries per tick) and retains pressure for four seconds between visits.
Extreme debris counts can delay new contacts. Footprint radii are capped at
8 m; interaction is limited to the camera-local field. Original building
foundations remain excluded after demolition. The field is reused for other
foliage families, including reeds, wheat, corn and ferns.

The two nearest canopy bodies additionally part plants taller than their lower
bounds, without flattening short plants underneath airborne objects. Falling
objects crossing ground level can launch at most two 1.6-second radial wind
waves. These use presented poses and a bounded recent-body cache. The editor's
falling slab exercises both paths. Contact texture changes interpolate over
50 ms, avoiding visible 20 Hz stepping; camera scroll and clear operations reset
both samples to prevent ghost trails.

## Painting

Open `/grass` → **Paint grass**. Drag on the ground using Meadow, Lawn, Tall,
Person height, Vehicle height, Dry or Bare presets, or adjust density, maximum blade height (up to 4 m), leaf
colour and brush radius independently. Finish painting to orbit again. On a
small screen, open **Grass controls** to reveal the controls.

Person height uses a 2.8 m blade-length ceiling and Vehicle height uses 4 m.
Tall stands have a tighter height distribution, broader leaves and less initial
lean; actual upright tips are lower than blade length because the leaves curve.
Tall stands hand off to a cheaper persistent canopy at distance. Taller
leaves also cover more pixels, so their GPU cost is higher than a short lawn.
**Plant tall test patch** paints an 18 m radius patch around the demo car path;
use **Paint grass → Undo** to restore the previous layout. To place the demo
at a city location, open `/grass?x=0&z=55`, then plant the patch. Opening the
link alone does not alter existing paint; coordinates are shown beside the button.

Grounded vehicles also sweep a broad box through authored grass taller than
1.5 m, holding it down for six seconds before normal recovery. Parked vehicles
refresh that hold. Short grass keeps separate tyre tracks. This is a cheap
canopy approximation from ground footprints, not stalk collisions.

Tall grass provides local visual concealment, including beyond the near geometry
range. Distant coverage is identical across quality tiers, but this is still a
client-side approximation rather than an authoritative multiplayer stealth
mechanic. It does not block bullets or AI visibility; those require gameplay rules.

Paint uses sparse 8 m tiles with 0.5 m cells. Bilinear interpolation and a soft
brush edge make tile boundaries continuous. Blades keep deterministic positions
when only their height/colour changes. Painting replaces only affected resident
patches through the existing build budget, and updates the distant ground tint.
Zero density produces zero blades in fully painted regions. Density is a
fraction of the selected profile's maximum, not a world-space blade count.

Edits are private drafts saved to local storage. Undo retains the last eight
edits. Export and Import layout transfer versioned JSON; invalid imports leave
the current layout intact. Version 3 adds species, health, dryness, maturity, row spacing/angle and stiffness.
Version 2 encodes 0–4 m height; version 1 imports
retain their 0–2 m scale (within byte quantization). Existing local drafts migrate
on load. Storage-quota failures leave edits visible and offer export.

### Foliage families

The sample buttons plant an 18 m patch at the selected world coordinates. The
paint panel offers family, health, dryness, maturity, stiffness and planting-row
controls in addition to density, height and color. Appearance-only painting
changes color/health/dryness without moving or replacing existing plants. Zero row spacing means wild
placement. Rows use world coordinates, so they continue across patch boundaries.

| Family | PRETTY candidates accepted/m² before authored density/rows | Shape |
| --- | ---: | --- |
| Grass | 150 | Curved ribbon |
| Reeds | 28 | Stem and crossed seed head |
| Wheat | 55 | Stem and serrated golden head |
| Corn | 3 | Stalk and six broad leaves |
| Ferns | 5 | Six radial fronds |

Plants share wind, contact, recovery and lighting, with species stiffness and
independent leaf flutter. Dryness reduces transmission and browns tips; maturity
changes size without moving roots. Each occupied family uses one instanced draw
per patch. Mixed boundaries can add draws, but no per-plant objects are created.
Crop roots are identical across quality tiers. Tall/crop geometry keeps its
instances until the canopy crossfade described above. The 7/3/1 triangle figures
apply to grass only; corn leaves use at least two segments at every LOD.

Version 3 needs the updated grass service and client. Old v1/v2 drafts migrate
on import; the server continues to read existing v2 layouts. Older clients cannot
read v3, so deploy clients and service together. The existing 24 MiB request cap
still applies; very large fully painted layouts may require smaller authored areas.

### Sharing a city layout

The editor's **Shared city layout** panel loads the current server revision
without overwriting your draft. Enter the server's grass editor key and choose
**Publish to city** to share the whole draft. **Load shared** replaces the draft
with the latest shared layout and adds an Undo entry. A concurrent publisher
causes a conflict; your draft is preserved and must be reconciled before retrying.
Use `?match=city-example` in both the editor and city to target another match.
The editor uses the configured multiplayer HTTP origin, just like the game.

`/city` ignores browser-local drafts, fetches the shared layout on entry, and
polls every two seconds with `If-None-Match`. Unchanged layouts return 304 and
cause no patch rebuilding. New layouts compare tile bytes and invalidate only
changed neighborhoods before budgeted rebuilding.
A small status label shows the shared content revision, or an explicit offline
message. An outage keeps the last shared layout; an initial failure shows the
default meadow. It never silently treats private paint as shared data.
Blades, wind, contact stamping and recovery remain entirely client-side.

The Rust API is `GET` / `PUT /match-stats/:match_id/grass`. Reads are public;
writes require `Authorization: Bearer <VIBE_GRASS_EDIT_TOKEN>` and an `If-Match`
revision. Without that environment variable publishing is disabled. Layouts are
strictly validated (version, byte channels, tile bounds, duplicates, body size),
written through a synced temporary file and atomic rename, and persist across
server restarts. The default directory is `.data/grass/` in this checkout;
`VIBE_GRASS_LAYOUT_DIR` overrides it. Back it up as authored world data. Only one
process may own writes to a directory; route all grass requests to that process.
The API caches at most eight match layouts.

The game server mounts these routes automatically on its next build/restart.
For local development without interrupting a running physics server:

```sh
scripts/run-grass-layout-server.sh
# In .env.local for the Vite preview:
# GRASS_SERVER_HOST=127.0.0.1
# GRASS_SERVER_PORT=4183
```

This runs the same routes as a content-only process, bound to loopback by default.
The script creates a private `.env.grass.local` containing the editor key; it is
ignored by Git and is not a `VITE_` variable or part of the browser bundle. The
editor holds a pasted key only in memory. Vite proxies only the grass route to
this process; game traffic stays on its existing server. On deployment, use the
integrated game-server routes or proxy this route to one supervised grass service,
configure the directory/key on the host, and deploy the updated client as well.
These are per-match decorative layouts, not yet part of the gallery WorldDocument
publishing protocol. `/cityreplay` still uses the local draft; grass revisions
are not yet recorded in tapes. Control-plane sessions with no reachable HTTP
origin report unavailable rather than fetching from the wrong server.
The editor's sample buildings are for previewing grass, not the actual city
manifest; paint coordinates are city world X/Z metres.

For authored environments, use the same API (no renderer required):

```ts
import { cityGrassPaint, GRASS_BRUSHES, saveCityGrassPaint } from './scene/grass/GrassPaint';

cityGrassPaint.paint(20, -12, 7, GRASS_BRUSHES.tall); // An overgrown lawn.
cityGrassPaint.paint(24, -10, 3, GRASS_BRUSHES.dry);
cityGrassPaint.paint(17, -15, 2, GRASS_BRUSHES.bare); // An empty patch.
saveCityGrassPaint(); // Save draft; use Publish to city to share it.
const layout = cityGrassPaint.export();
```

An independent `GrassPaint` can be supplied as the third `GrassField` constructor
argument. Its `cover` texture is available for custom terrain integration.

## Verification

Shared-layout checks:

```sh
cargo test -p web-fps-server --bin grass-layout-server
cd client && npx vitest run src/scene/grass/GrassLayoutSync.test.ts
```

These cover two independent clients, revision polling, stale-editor conflicts,
authorization, malformed layouts, match isolation, persistence after reopening
the store, offline retention, and aborted requests after leaving a match.

From `client/`:

```sh
npm run lint
npx vitest run src/scene/grass src/world/cityWorld.test.ts
```

From the repository root, with Vite already running:

```sh
node scripts/grass-smoke.mjs http://127.0.0.1:5197 /tmp/vibe-grass
# Optional 1080p render-cost measurement:
GRASS_BENCH_WIDTH=1920 node scripts/grass-smoke.mjs http://127.0.0.1:5197 /tmp/vibe-grass-1080
```

The smoke check captures near, city-edge, FAST, off, aerial, mobile, tyre-track,
resting-rubble and painted views. It checks contact area, painting, undo, import,
reload persistence, browser/shader errors, aerial culling and geometry disposal.
It writes `report.json` and measures the production field at 1280×720 (default),
DPR 1, MSAA, in an isolated scene using GPU timer queries. On/off draws are paired
within each frame with alternating order. Numbers measure the extra grass pass,
not multiplayer FPS. Unsupported timer queries are reported as null. Mobile
viewport screenshots are layout checks, not measurements of phone hardware.

The preview's frame interval is whole-frame wall time and includes display
pacing; it must not be interpreted as grass GPU time.

Local validation (2026-09-26): TypeScript, 39 foliage/city-world tests, three
server layout tests, and the Vite production bundle passed. The bundle reused
existing WASM and skipped unrelated scene packs. Browser checks exercised all
plant families, mobile controls, painting/undo/import, driving and falling rubble
with no browser or shader errors. Every profile culled all plants from 100 m
altitude and returned geometry counts to zero on disposal.

[Recorded benchmark](benchmarks/foliage-m3max-2026-09-26.json): Chrome/ANGLE Metal,
Apple M3 Max, 1920×1080, DPR 1, MSAA. Patch streaming completed before measurement;
two canopy contacts and two impact waves exercised the bounded interaction path.

| Preset | Paired median GPU increment | Moving update CPU p95 |
| --- | ---: | ---: |
| PRETTY meadow | 0.64 ms | 0.40 ms |
| FAST meadow | 0.08 ms | 0.20 ms |
| Wheat | 0.73 ms | 0.30 ms |
| Corn | 0.48 ms | 0.30 ms |
| Ferns | 0.83 ms | 0.20 ms |
| Four-metre grass | 1.40 ms | 0.20 ms |

Steady field-update CPU p95 was 0.1–0.2 ms. Saturating the contact budget took
0.3–0.4 ms median / 0.4–0.5 ms p95 at 20 Hz. Measured moving-update maxima were
0.3–0.7 ms. The optional `GRASS_BENCH_GPU_BUDGET_MS` asserts the paired median
increment; it is not a bound on individual frames. GPU p95 deltas ranged from
0.88 to 2.98 ms in this run, with substantial background/ANGLE timing noise.

These measurements are not a phone or live-city FPS guarantee. **120 Hz requires
the entire city frame to fit within 8.33 ms**. This harness isolates additional
foliage cost; test full-city destruction and target hardware before certifying
120 Hz. The lab's frame interval includes display pacing (headless Chrome here
runs at about 60 Hz). Shared layouts are supported; trample history remains
local, temporary cosmetic state. Permanent networked vegetation destruction,
AI concealment, harvest/growth simulation and foliage audio are not implemented.

## References

The architecture was informed by the segmented blades and patch LODs in
[SimonDev / Quick_Grass](https://github.com/simondevyoutube/Quick_Grass), and the
wind/interaction discussion in
[boona13 / threejs-grass-water-shaders](https://github.com/boona13/threejs-grass-water-shaders).
No source files or assets from those projects were copied. Both identify their
code as MIT. The implementation stays on the project's existing WebGL renderer.

### Canopy LOD benchmark

With Vite running, open `/benchmarks/foliage-lod.html` and click **Run benchmark**.
This isolated harness creates private in-memory paint and never touches the editor
draft or server layout. It measures paired grass-on/off GPU timer queries at
1920×1080, CPU submission/update cost, all three ranges (12/35/110 m), both
quality tiers, and tall grass/corn/wheat. Pixel readback measures a red target
behind each stand; a separate contact check flattens the tall field. Renderer
resource counts are checked after disposal. This measures the grass pass, not
full-city frame rate, and the 120 Hz total budget remains 8.33 ms.

Recorded results: [`foliage-lod-m3max-2026-09-26.json`](benchmarks/foliage-lod-m3max-2026-09-26.json).
On an M3 Max, the isolated grass pass measured **0.12–1.90 ms GPU** across
18 cases (48 valid pairs each). Both tiers hid the test target at 35 and 110 m
in tall grass and corn. A flattened corridor revealed 670/840 and 673/840
target pixels at 35 m; standing foliage hid all 840. All 18 cases drained
their build queues; disposal left zero renderer geometries. The test scene
does not include city geometry, shadow maps, physics or destruction.

### Lighting across LODs

Both near blades and distant clumps use the same rough Standard material,
scene sky environment, shadow-aware transmission and root occlusion code in
`foliageLighting.ts`. Previously the Lambert canopy ignored the sky environment,
while sampling RGB from transparent-black silhouette mips also darkened it.
The atlas now supplies **coverage only**; authored linear leaf color stays
independent of alpha and mip level. Coarse normals approximate visible leaves
rather than lighting all cards as horizontal ground, and cluster transmission
uses the average leaf height rather than treating the whole cluster as tips.
Dryness is packed with the species ID, keeping 32 bytes per clump and the same
geometry, draw counts, atlas taps and interaction work. Standard sky shading
adds GPU lighting work, so it is included in the performance check below.

`/benchmarks/foliage-lighting.html` compares forced near/far representations with
identical camera, paint and light. Five families cover sky, direct-only and
backlit conditions; it fails if mean displayed canopy luminance differs by more
than 15% with sky lighting or 20% in the other conditions. Black gaps are excluded
from a fixed central image region; this tests average appearance, not identical
individual leaves. The private fixture includes tall dry grass and never edits
the user's draft. `/benchmarks/foliage-lod.html?sky` additionally prices sky IBL
in the existing 1080p GPU, coverage and compaction benchmark.

The recorded [lighting comparison](benchmarks/foliage-lighting-m3max-2026-09-26.json)
shows sky-lit corn/tall grass going from about half brightness at distance to
within 2% of the nearby representation. All five families are within 10% with
sky lighting and 17% across the full lighting fixture. For isolated timing,
append `&timingOnly` to the sky benchmark URL to omit pixel readbacks.
Keep the benchmark canvas visible while measuring; the report is placed below
it so growing results do not push the measured surface out of view. The normal run still verifies
concealment and compaction separately. Invalid/disjoint timings remain null,
not zero-cost samples.

With the corrected materials and sky environment enabled, the isolated 1080p
grass pass measured **0.12–3.13 ms GPU** across 18 cases (48 valid pairs each)
on M3 Max. This includes sky shading absent from the earlier timing fixture;
it is not a before/after cost comparison or a full-city frame-rate claim.
