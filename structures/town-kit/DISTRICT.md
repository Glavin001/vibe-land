# Bayline District

An independent ScenePack v2 town: **24 furnished buildings, 132 rooms, four connected neighborhoods**, a central square, pedestrian paths, crossings and open picket gates. It covers **208 × 144 m**, four times the first six-building scene's area and building count.

## Contents

- Four single-storey bungalows: full verandas or compact entry porches, paired or wide front windows, mirrored layouts.
- Eight two-storey porch houses: classic or paired-window façades, open garden gates and connected stairs.
- Four café/apartment buildings: two with two storeys and two with three.
- Four corner shops: Grocer, Bakery, Books and Market signs, varied brick and joinery finishes, furnished apartments above.
- Four workshops: Works, Studio, Garage and Depot signs, different siding, usable offices and storage lofts.
- Six paint palettes: sage, blue, ochre, cream, rose and slate.

Street surfacing, paving, signs, fencing, furniture and above-ground construction have physical mass and destruction bonds. Only buried foundation/subgrade pieces remain fixed. Loose square furniture rests on paving. There are no bonds joining separate buildings.

## Files and reuse

- `src/bayline-district.mjs`: lot manifest, neighborhoods, square and composition.
- `src/bungalow.mjs`: new reusable one-storey home.
- `src/parts/`: shared walls, openings, floors, stairs, roofing and physical lettering.
- `out/bayline-district.json`: standard runtime ScenePack v2.
- `out/bayline-district.meta.json`: separate room labels, entrances, routes, saved cameras, instance ranges and source hashes.
- `out/district-template-*.json.gz`: compressed reusable furnished templates.
- `out/reviews/bayline-district-visual/`: individual images, contact sheet and capture report.

The generator caches identical template options and reuses the existing composition function. Materials and convex shapes are deduplicated across instances; the initial expanded export has 82,325 pieces but only 278 distinct convex shapes (cuboids share the box geometry). The source remains compositional; the export follows the existing flat runtime format without introducing new APIs or network formats.

The earlier `bayline-town` scene remains available separately.

## Build and inspect

From this directory:

```sh
node scripts/build-district.mjs
node --test tests/bayline-district.test.mjs tests/bayline-town.test.mjs tests/town-buildings.test.mjs
node scripts/preview.mjs
```

Open `http://127.0.0.1:6174/?asset=bayline-district`. The camera menu includes neighborhood views, street views, every building's interior cameras and the central square. The review preview uses the saved fine material preset. The existing preview process can load the new scene without a restart.

```sh
TOWN_KIT_CAMERAS=hero,aerial,reverse,central-square,market-street,garden-street,willow-street,foundry-street,old-market,garden-lanes,willow-crossing,foundry-square node scripts/screenshots.mjs bayline-district
```

## Native review

Run GPU reviews and browser capture sequentially:

```sh
node scripts/review-district-templates.mjs
node scripts/review.mjs bayline-district stability traverse
```

The full route has 2,311 authored points and visits every furnished room and all stairs. A route's presence is not proof of a completed controller traversal: read the actual native report.

`out/reviews/district-template-status.json` records completed template cases. Full-assembly reports belong in `out/reviews/bayline-district-{stability,traverse}/`. Every case preserves its exact asset, metadata, native binary/SDK hashes and observed poses. The runner restores compressed inputs only while needed, then removes that temporary uncompressed copy. Small intact cases reserve 128 MiB; large assemblies and all damage cases reserve 512 MiB.

**This is an experimental scene, not a full destruction acceptance claim.** The six-building predecessor passed intact gravity and all 658 native walking checkpoints. Its assembled workshop breach broke 633 bonds, settled and left other buildings intact, but the capsule could not pass the rubble. That case remains failed. Earlier severe-collapse failures also remain open. These results are not silently transferred to the larger scene.

## Separate playable launch

`scripts/scene-server.py` prepares a private copy of an existing built server and client. It never rebuilds the core application, changes Fractured Town, or stops another process. The default scene is `bayline-district`; `--scene bayline-town` selects the smaller predecessor.

```sh
python3 scripts/scene-server.py start
python3 scripts/scene-server.py status
python3 scripts/scene-server.py stop
```

Default local ports: API 6175, HTTPS page 6176, WebTransport 6177. The copied client uses the existing public texture-tuning hook for the reviewed finish. Certificates, binary, client snapshot, bounded logs and ownership records stay in `out/bayline-runtime/`. An already occupied port is an error, never a reason to stop another service. For a remote launch, explicitly provide a host and free mapped web/UDP ports. No larger-scene service has been launched yet.
