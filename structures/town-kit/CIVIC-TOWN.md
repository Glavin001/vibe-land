# Bayline civic town

An independent 67-building, 280 × 218 m scene that combines all nine building families: 16 porch houses, eight bungalows, eight Victorian cafés/apartments, eight corner groceries, 12 strip shops, 12 workshops, a library, a cinema, and a fire station. The civic buildings face the southern sidewalk of the street at z = 56, filling three vacant lots rather than replacing the existing neighborhoods.

There are 22 one-storey, 41 two-storey, and four three-storey buildings; 316 rooms; 42 reused templates; and six palettes. The scene contains 188,922 chunks and 405,404 bonds. Furniture and construction retain their authoring masses, colliders, and fragmentation. Building bond graphs are independent; this is not a measurement of runtime idle cost.

## Binary build

The preferred server artifact is now `out/bayline-civic-town.vlsp`. Generate it
with `npm run build:binary` from the kit directory. The recipe, parameters and
seed remain the single source of truth; JSON export is retained for compatibility.
See [BINARY-SCENES.md](BINARY-SCENES.md) for the format, cache, load settings and
cross-language validation. No live deployment has been changed.

## Preview

With the isolated kit preview running on port 6174, open:

http://127.0.0.1:6174/?asset=bayline-civic-town

Saved cameras include `hero`, `aerial`, `civic-promenade`, `library-and-cinema`, `fire-station-street`, `civic-neighborhood`, and the existing residential, shopping, and workshop views. Each building also retains transformed interior and exterior camera presets. The scene saves fog distances of 560–850 m so the full map stays visible in its overview cameras; older scenes retain their existing atmosphere.

Rebuild with `node scripts/build-civic-town.mjs`. This writes only `out/bayline-civic-town.json.gz` and `out/bayline-civic-town.meta.json`. The metadata records source revisions, content hashes, placement identities, rooms, entrances, routes, cameras, and geometry validation.

Capture the overview with:

```sh
TMPDIR=/dev/shm TOWN_KIT_IMAGE_FORMAT=jpeg TOWN_KIT_CAMERAS=hero,aerial,civic-promenade,library-and-cinema,fire-station-street,civic-neighborhood,shopping-row,garden-homes,workshop-district node scripts/screenshots.mjs bayline-civic-town
```

Images and their review report are saved under `out/reviews/bayline-civic-town-visual/`. Earlier captures are automatically archived. Screenshots are actual ScenePack renders.

## Validation and limits

The full composed geometry passes with zero overlaps. `node --test tests/civic-town.test.mjs` checks exported identity, nine families, placement ownership, independent bonds, room-route coverage, and the large-scene piece-remapping regression. Route metadata coverage does not establish capsule traversal of the complete town.

Whole-town native stability, traversal, and destruction acceptance have not passed. The individual civic buildings have the outstanding demolition/mirrored-library issues documented in `CIVIC-BUILDINGS.md`; this composition uses the unmirrored library. Placement rotations and additional paving still require native assembly review. The scene remains a visual preview, not a physics-qualified release, and does not modify or deploy the live `/city` scene.
