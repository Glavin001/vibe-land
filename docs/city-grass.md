# Client-side city grass

Grass is enabled automatically when `/city` or `/cityreplay` has a city manifest.
`/grass` is a standalone preview/editor using the same field, terrain and lighting,
with wind, quality, driving, falling-rubble and painting controls. It needs no
server. Add `?grass=off` to the city/replay URL
to disable the blade renderer for comparisons. The green ground cover remains
visible beyond the blade draw distance.

## Rendering

- Original, asset-free blade implementation for the existing Three.js WebGL2
  renderer. No packages, server changes, network messages or physics bodies.
- Cubic Bezier leaves with analytic bent normals, variation in height, width,
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
- Instance-count reduction submits progressively fewer blades at distance.
  Randomly ordered deterministic placement keeps every prefix spread throughout
  the patch. Per-blade growth transitions hide density and range changes; newly
  streamed patches grow in over 0.35 s. Roots never follow the camera.
- Patch creation is limited to two patches per frame, stopping after a 2 ms
  budget (an individual patch build is synchronous). Only uniforms, visibility,
  draw ranges and instance counts change in steady state.
- Instance data uses **27 bytes per blade**: float root/height/yaw, normalized
  16-bit width/lean/variation/rank, and normalized 8-bit linear RGB. A camera-local cache evicts distant patches and
  releases geometry/material resources on teardown and quality changes.

| Grass profile | Maximum candidates/m² | Geometry distances | Blade range |
| --- | ---: | --- | ---: |
| PRETTY | 150 | 16 m / 30 m | 48 m |
| FAST | 30 | 9 m / 18 m | 28 m |

Distances use the closest point on each patch, including camera altitude.
Density ramps down before topology changes, reaching about 16% of the nearby
value before the final fade. Rendering stops entirely above the range.

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
R stores compression, GB store bend direction. Blades sample it once in the
vertex shader; their curve flattens towards the ground and bends away from the
contact. There are no blade physics objects or per-blade CPU updates.

The field ticks at at most 20 Hz, decays exponentially over about 1.8 seconds
after a contact-specific hold, and retains existing world-space tracks as it
scrolls in 8 m steps. Tyres sweep between previous/current positions; teleports
over 12 m do not draw a trail. Resting objects refresh their holds. Frame work
is capped at 192 footprint stamps and 32,768 cell visits; a dirty tick uploads
64 KiB. The field fades out near its edges. It is an approximate visual effect,
not authoritative destruction or persistent environmental damage.

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
foundations remain excluded after demolition. The field can be reused for other
foliage materials; this change animates grass only.

## Painting

Open `/grass` → **Paint grass**. Drag on the ground using Meadow, Lawn, Tall,
Dry or Bare presets, or adjust density, maximum blade height (up to 2 m), leaf
colour and brush radius independently. Finish painting to orbit again. On a
small screen, open **Grass controls** to reveal the controls.

Paint uses sparse 8 m tiles with 0.5 m cells. Bilinear interpolation and a soft
brush edge make tile boundaries continuous. Blades keep deterministic positions
when only their height/colour changes. Painting replaces only affected resident
patches through the existing build budget, and updates the distant ground tint.
Zero density produces zero blades in fully painted regions. Density is a
fraction of the selected profile's maximum, not a world-space blade count.

Edits save to local storage and apply to `/city` and `/cityreplay` on the **same
origin**, including other open tabs. Undo retains the last eight edits. Export
and Import layout transfer versioned JSON; invalid imports leave the current
layout intact. Storage-quota failures leave edits visible and offer export.
These are local decorative layouts, not networked world state or part of the
world-publishing protocol. The standalone editor's sample buildings are for
previewing grass; paint coordinates are city world X/Z metres.

For authored environments, use the same API (no renderer required):

```ts
import { cityGrassPaint, GRASS_BRUSHES, saveCityGrassPaint } from './scene/grass/GrassPaint';

cityGrassPaint.paint(20, -12, 7, GRASS_BRUSHES.tall); // An overgrown lawn.
cityGrassPaint.paint(24, -10, 3, GRASS_BRUSHES.dry);
cityGrassPaint.paint(17, -15, 2, GRASS_BRUSHES.bare); // An empty patch.
saveCityGrassPaint();
const layout = cityGrassPaint.export();
```

An independent `GrassPaint` can be supplied as the third `GrassField` constructor
argument. Its `cover` texture is available for custom terrain integration.

## Verification

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

Local validation (2026-09-25): TypeScript and the Vite production bundle passed;
21 tests passed, including swept contacts, recovery, scrolling, settled topology
poses, local vehicle presentation, paint continuity, import validation and patch
invalidation. Chrome/ANGLE Metal on an Apple M3 Max reported no browser or shader
errors. The isolated camera submitted 136,792 blades in 45 draws on PRETTY
(28.1 MB resident instance data), and 16,251 blades in 23 draws on FAST (2.45 MB).
Both submitted zero blades from 100 m altitude and
returned renderer geometry counts to zero on disposal.

At 720p, paired median grass GPU increments varied from 0.91–2.64 ms PRETTY and
0.09–0.23 ms FAST on this shared machine. Saturating the contact budget measured
0.3 ms median / 0.5 ms p95 CPU per contact tick (at 20 Hz); steady-state field
updates measured 0.1–0.2 ms p95 per frame. A subsequent 1920×1080 run with active
contacts measured paired GPU increments of 0.77 ms PRETTY / 0.06 ms FAST; its
report and screenshots were saved to `/tmp/vibe-grass-1080`. GPU timer results on ANGLE Metal
are indicative and can vary with other work. They are not a phone or live-city
FPS guarantee. **120 Hz requires the entire city frame to fit within 8.33 ms**;
this harness isolates the additional grass cost. Re-run it on the target
hardware and profile the full city before making that claim. The production
bundle check reused existing WASM and skipped the unrelated large scene packs;
no Rust/WASM or live deployment changes were required for this client feature.

## References

The architecture was informed by the segmented blades and patch LODs in
[SimonDev / Quick_Grass](https://github.com/simondevyoutube/Quick_Grass), and the
wind/interaction discussion in
[boona13 / threejs-grass-water-shaders](https://github.com/boona13/threejs-grass-water-shaders).
No source files or assets from those projects were copied. Both identify their
code as MIT. The implementation stays on the project's existing WebGL renderer.
