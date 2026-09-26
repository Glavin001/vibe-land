# Bayline town kit

The [outdoor destruction kit](OUTDOOR-KIT.md) adds trees, street props, collapsible
structures, three racing/combat encounters and a separate dressed Bayline scene.
Use `npm run build:outdoor` and open `?asset=outdoor-gallery` in the independent preview.

An independent Victorian corner café, furnished apartments and reusable town props. This directory owns its generated assets, native Cargo workspace, preview service and review recordings. The playable `/town-kit` route reuses `/city`'s client, server, WebTransport and native stress destruction.

## Walk and shoot: live playground

From the repository root:

```sh
npm --prefix structures/town-kit run play
```

Open **http://127.0.0.1:6180/town-kit?portal=true**. Click the scene, use WASD to
walk, drag/move the mouse to aim, and click to fire. Aim above the rooted stump
to fracture the trunk. N switches to the existing fly camera. Escape releases
the mouse; **Reset playground** rebuilds every exhibit.

The current playground has **24 labelled exhibits**: native-stable shade,
street and ornamental trees, all 20 outdoor props, and a furnished Juniper
porch house. The other 12 tree variants remain available in the authoring
viewer but are excluded here because their native stress topology fails at
startup. This is a live test range, not a release qualification for every impact.

Cannonballs use the real server's 500 kg, 25 m/s physical projectile. Fracture
comes from contact loads and the native stress solver; foliage follows the
authoritative chunk transforms, including separated branches and reset poses.
The visuals endpoint verifies the exact physics-pack SHA and manifest before
serving the attachment data.

Outdoor mortar, timber seams, welds and mounting joints are calibrated for
this cannon. Bulk chunk strength, mass and stiffness are preserved; the damage
still comes from the native stress solver. Shoot solid brickwork or a panel,
or knock out a structure's supports. The street tree and house wall can need
three hits; firing through a gap does not damage the surrounding structure.

To repeat the cannon qualification, stop the playground, rebuild the native
review harness for the installed SDK, then run `npm run check:playground:cannon`
from this directory. It checks all 24 exhibits with the same weapon and stress
settings as the live launcher. Every case must remain intact before firing,
break at least one bond, and move a fractured chunk by more than 10 cm, without
native errors or invalid chunk ownership. Recordings and a complete pass/fail
matrix are written to `out/cannon-qualification/current/`. The final measured
run for this change is in `out/cannon-qualification/final/`.

This command builds the server with `native-destruction` into
`target/town-kit-live`, then runs under the shared GPU lock. It requires the
same PhysX SDK and prebuilt client WASM as local `/city`; see
[`run-locally`](../../.claude/skills/run-locally/SKILL.md). It uses dedicated
ports **6180 / 6181 / 6182** and refuses occupied ports. `TOWN_KIT_PORT` changes
the client port; HTTP and WebTransport use the next two. Ctrl-C stops only this
instance. Logs and owned process IDs are under `out/playground/`. Use
`TOWN_KIT_LIVE_RELOAD=1` to opt into client hot reload while developing; it is
off for the playable review so unrelated saves do not restart your session.
Restart the launcher to pick up edits with live reload disabled. Use
`npm --prefix structures/town-kit run play -- --no-build` only while the SDK and
server sources are unchanged.

**Release status:** work in review; see [measured blockers](REVIEW-NOTES.md). A generated pack is not an accepted asset. See `out/reviews/matrix.json`, each native `report.json`, and the visual contact sheets. Failed, stale or missing reviews must not be treated as passes. Assets are staged for later import only after every acceptance gate passes.

## Author and preview

Run from this directory, using the existing client dependencies and local physx-2 SDK:

```sh
npm run build
npm run build -- --props
npm run preview
npm run screenshots -- victorian-corner
```

The independent preview listens on **http://127.0.0.1:6174**. Set `TOWN_KIT_PORT` to change it; it fails if that port is occupied. It never stops another service. Its own PID and port are recorded in `out/preview-service.json`. Drag to orbit, use saved room/exterior cameras, or choose a native recording and scrub its timeline. “Frame fragments” locates displaced debris; “Track fragments” follows its mass centre while preserving your camera angle. Prop damage captures automatically frame the settled fragments, and prop videos follow their motion. Screenshots wait for the application's material textures and fail on browser errors. Individual images are 1600 × 1000; each capture produces a contact sheet.

```js
import {buildVictorianCorner, buildTable, buildCounter, composeScene} from './src/index.mjs';
const {pack, metadata} = buildVictorianCorner({
  storeys: 3, mirrored: false, palette: 'sage', furnished: true, fence: true,
});
const sink = buildCounter({variant: 'sink'}); // counter, sink or hob
const scene = composeScene([
  {pack, position: [0,0,0], yaw: 0},
  {pack, position: [30,0,0], yaw: 90},
]);
```

`buildProp(type, options)` also builds `table`, `chair`, `counter`, `sink`, `hob`, `cabinet`, `shelf`, `refrigerator`, `bed`, `sofa`, `toilet`, `bathtub`, `fence`, and `gate`. Named builders are exported for common pieces. Builders return `{pack, metadata}`. `composeScene` returns a standard ScenePack v2, remapping materials, shape references, pieces, nodes and bonds. Quarter turns are 0/90/180/270 degrees; `mirror: true` reflects local X before rotation. Placement offsets use metres. Authoring room labels, routes, cameras and shot plans remain in the separate metadata file.

```sh
npm run build -- --storeys 2 --mirror --palette blue --name victorian-blue
npm run build -- --empty --no-fence --name shell
npm test
node scripts/matrix.mjs --geometry-only
```

Palettes are sage, blue, ochre, cream, rose and slate. Table legs split in two and tabletops into four. Door leaves and courtyard gates are open. Only buried foundations have zero mass. Freestanding furniture rests through contact; fitted counters, cabinets and shelving bond to real touching construction faces. Finish panels, glass, roofs, rails and furnishings are physical chunks. There are no hidden intact collision sheets, artificial anchors above ground or cosmetic-only architectural meshes. Counters and bathtubs use equivalent eight-corner convex colliders following native contact tests; other assets retain their reviewed box/prism representation. The comparison snapshots are in `repros/collider-contact/`.

The ~12 × 16 m building has a café, preparation room and store, then one apartment per upper floor. Each apartment has living/dining, bedroom, kitchen and bathroom spaces. Stairs are 1.25 m wide with 1.35 m clear turning landings. The return flight stops ahead of the landing, and each floor has a real opening. The route begins outside, visits rooms, climbs every flight and returns to the street.

## Native review

```sh
npm run review -- victorian-corner stability
npm run review -- victorian-corner traverse glazing wall furniture fence collapse
node scripts/matrix.mjs
npm run screenshots -- victorian-corner wall
node scripts/record.mjs victorian-corner traverse
node scripts/record.mjs victorian-corner collapse
# Inspect an explicitly failed diagnostic without presenting it as accepted:
node scripts/record.mjs victorian-corner collapse --diagnostic
```

GPU reviews run sequentially. The review command owns `out/native-review.lock`; do not launch direct harness cases alongside it. A terminated process can leave a stale lock; inspect its PID before removing that kit-local file. The harness uses its own `native/target/` and reads the existing bridge and SDK. Locked Cargo package sources and their index entries are copied from the existing cache into `out/cargo-home`; builds run offline using only that kit-owned cache. `PHYSX_DESTRUCTION_SDK` and `TOWN_KIT_AUTHORING_ROOT` override their discovered sibling paths. CUDA defaults to `/usr/local/cuda-12.8`.

The default stress budget is the application's current **16 iterations**, tolerance 1e-5, warm start, damage rate 2, fibre bending and bend gain 3. `TOWN_KIT_ITERATIONS` is recorded when explicitly changed. Larger budgets have caused divergent free-prop solves in this SDK; diagnostic runs are retained, not relabelled as successful. No solver code is changed by this kit.

The intact gate requires observed native steps at 9.81 m/s², zero spontaneous breaks/crushing, solver convergence, physical sleep and 30 further simulated seconds of equilibrium. A separate pose audit rejects furniture that tips over or drifts instead of remaining near its authored placement. Run `node scripts/audit-rest.mjs` after refreshing stability recordings; the matrix command also runs it. Nonconverged startup ticks cannot count toward equilibrium; an interrupted, rejected, degraded or timed-out run fails. The actual game capsule follows the route with grounded gravity, no jumping or teleporting; upward raycasts additionally check 2.1 m headroom. Damage starts from a passing intact state, records transient solver work, then must reach observed convergence and physical rest. Local target bonds must break. Collapse must lower upper construction and upper-floor furniture.

Each run records the asset SHA-256, dependency revisions and content hashes, SDK revision/library hashes, GPU/driver snapshot, solver settings, counts and timings. This is a shared GPU: timing results explicitly say `exclusiveGpu: false`. Browser captures and native recordings reject asset-hash mismatches. Native recordings are streamed directly to lossless `recording.json.gz` files; completed historical recordings can additionally use lossless Brotli (`.json.br`). The preview and review tools read all three representations, including older uncompressed JSON. Acceptance hashes always cover the decompressed JSON bytes. Recordings retain chunk-to-body membership, body poses and velocities, bond breaks, island events and actual player positions. Videos are derived from those recordings, not animation substitutes.

## Visual acceptance and import

Review the actual contact sheet and full images after changes. Check front/rear/both street elevations, corners, roof, bays, every furnished room and every landing. Then inspect the intact, locally damaged and collapsed recordings from movable cameras. A contact sheet alone does not establish destructibility or walkability.

Run `node scripts/gallery.mjs` and open `http://127.0.0.1:6174/?asset=props-gallery` to inspect the reusable prop collection.

`out/` contains generated review output; prior native runs and intact screenshot passes are archived under `out/reviews/history/`. Native recordings and review/revision asset snapshots are stored losslessly as `.json.gz` or `.json.br`; the preview serves them transparently. Current reusable exports in `out/*.json` remain standard uncompressed ScenePack v2 files. Run `npm run stage` to populate `staged/` with accepted assets and their acceptance manifest. This command refuses failed, stale or absent evidence. Import into Fractured Town is a later task; nothing here registers a scene or changes runtime/network formats.

The supplied `bayline-source.zip` provided San Francisco/Victorian palette and town-layout inspiration. Its low-fidelity application is not executed or installed. Geometry/contact helpers, material texture rendering and physx-2 APIs are reused read-only from the existing workspace.

## Storage and local processes

Native review checks for at least 512 MiB free before building or starting a case. This is a snapshot, not a reservation against concurrent work. Completed review recordings are retained as evidence. A `.json.gz.tmp` file from an interrupted recording is incomplete; after confirming that its review process has exited and its report is marked interrupted, it can be removed. Do not delete completed reports or recordings to make a failing gate disappear.

The September 20 storage audit measured the entire kit at approximately 1.2 GiB: reviews 874 MiB (including history 479 MiB), native build outputs 124 MiB, private Cargo cache 58 MiB, and revision snapshots 32 MiB. Values grow with subsequent reviews. The only persistent kit process at that audit was its local preview, PID 2280882 on port 6174. It uses existing client dependencies; no external hosted session was created. The ownership file is a historical record, so verify the PID's working directory and command before stopping it.

Contact diagnostics are opt-in: `TOWN_KIT_CONTACT_ITERATIONS=16,4` sets the rigid-body position/velocity iteration counts through the harness-owned public PhysX scene before its first step. This is separate from the 16-iteration native stress budget. `TOWN_KIT_CONTACT_OFFSET=0.005` changes contact generation distance, not rest offsets or rendered/collision surfaces. Each setting is recorded in provenance; neither changes shared runtime code, sleep settings or gravity. Local wall damage passes with higher contact iterations, but full-collapse acceptance remains unresolved. These diagnostic passes do not certify the default asset for import.

## Additional town buildings

Three separate builders now share foundations, stairs, landings, guardrails, roofs, opening-aware walls and props without changing the café or registering a `/city` scene:

- `buildPorchHouse(options)`: 10 × 12 m, two storeys, covered veranda, picket garden fence, living/dining room, kitchen, study, bedroom and bathroom.
- `buildCornerGrocery(options)`: 12 × 10 m brick shop, striped awning, stockroom and rear delivery door, separate street stair entrance, furnished flat with living, bedroom, kitchen and bathroom.
- `buildWorkshop(options)`: 14 × 12 m workshop with an open vehicle bay, office, rear workbench and supported partial loft with storage and a work table.

All export from `src/index.mjs`, return `{pack, metadata}`, and accept `furnished`, `mirrored` and `palette` options. The house additionally accepts `fence`. These are fixed two-storey layouts with distinct circulation and roof silhouettes, not resized café copies.

```sh
node scripts/build-town.mjs
node scripts/build-town.mjs porch-house --mirror
node scripts/review-town.mjs stability traverse glazing wall furniture collapse
node scripts/screenshots.mjs porch-house
node scripts/screenshots.mjs corner-grocery
node scripts/screenshots.mjs workshop
```

`out/{porch-house,corner-grocery,workshop}.json` are independent standard ScenePack v2 exports; corresponding `.meta.json` files hold room labels, actual capsule routes, open entrances and saved cameras. Select a building with the preview URL `/?asset=porch-house` (or its own name). Review scripts run GPU cases sequentially and retain failed outcomes. The separate `out/reviews/town-review.json` reports only the modes requested in that invocation and does not grant staging or visual approval. These assets remain review candidates until their own full acceptance gates pass.


For the expanded kit, use `npm run build:town:variants` for mirrored and repeated
quarter-turn candidates, `npm run audit:town` for upright pose checks,
`npm run status:town` for a current-hash native gate inventory, and
`npm run stage:town` for the complete import gate. An older numerical wall-impact
pass does not certify a breach: new town wall cases now require 30 unobstructed
native rays through a 1 m wide, 2.1 m high opening. Visual inspection remains
required. Severe destruction is still under review; the new buildings are not
approved for `/city` integration.

`npm run capture:town` records all saved views of each new building and its
mirror, then local damage/collapse screenshots, capsule walkthrough videos,
and destruction videos. It runs sequentially after native review; failed
physics recordings remain visibly marked as diagnostics. Use
`npm run capture:town -- --intact-only` for a shorter visual iteration.

The `passed` field in `town-captures.json` means capture jobs completed without
rendering errors, not that the filmed physics passed. The native inventory and
staging gate remain the acceptance authorities.

Run `npm run audit:town:captures` after capture to verify current asset,
metadata, recording, and video hashes; completeness of saved intact cameras;
and matching native PASS/FAIL labels. It validates diagnostic evidence without
turning failed physics into acceptance.


### Breach and finish review follow-up

Wall review now records the 1 m rectangular ray grid as a diagnostic and drives
the real gameplay capsule through the damaged wall. It requires normal gravity,
no jumping or teleporting, at least 2.1 m overhead clearance, no new structural
damage from walking, and a return to converged physical rest. Low loose rubble
can be stepped over; a ray touching it alone does not prove the opening unusable.
The workshop's six repeated impacts pass this test on the base and rotated
reuse scenes. `node scripts/record.mjs workshop wall` shows both the impact and
the resulting capsule walk.

The private preview now uses the reviewed `fine` finish preset from
`preview/finishes.ts`: finer texture scale and gentler normal/large-scale texture
variation, through the existing city material API. The asset physics and shared
renderer source are unchanged. `?finish=city` restores the previous appearance;
`?finish=town` selects the intermediate comparison. The comparison is reproduced
by `node scripts/finish-review.mjs`; its images and provenance are under
`out/reviews/finish-study/`. Screenshots and videos record the preset. Applying
this renderer preset in the main city remains part of later integration.

## Composed town scenes

See [DISTRICT.md](DISTRICT.md) for the new 24-building Bayline District (four times the initial scene area), its reusable variants, preview, native reviews and isolated launch workflow. The earlier six-building `bayline-town` remains separate.

The expanded target is now the [64-building small town](SMALL-TOWN.md), with separate residential, shopping, civic and workshop areas and a maximum of three storeys. Earlier 6- and 24-building exports remain available independently.

## Civic buildings

The [civic additions](CIVIC-BUILDINGS.md) provide a columned neighborhood library,
an Art Deco cinema with upholstered seats, and a two-storey brick fire station,
plus reusable loose book stacks and cinema chairs. Each has its own builder,
compressed ScenePack, mirrored variant, furnished rooms and review workflow.
They remain independent candidates while native acceptance is pending.


## Binary town export

Use `npm run build:binary` to generate the reusable-template `.vlsp` server asset
directly from the town recipe, without a flattened JSON intermediate.
`npm run test:binary` checks JavaScript/Rust equivalence and load measurements.
See [BINARY-SCENES.md](BINARY-SCENES.md).
