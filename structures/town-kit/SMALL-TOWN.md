# Bayline Small Town — 64 buildings

The live Fractured Town contains 63 buildings and 49,070 pieces. This new scene is separate, built from the higher-detail town kit, and does not replace that live deployment.

The layout is 280 × 218 m, with four east–west streets, four avenues, covered shopping promenades, garden paths and a neighborhood square. All buildings are at most three storeys.

| Area | Buildings | Character |
| --- | ---: | --- |
| Garden streets | 24 | Single-storey bungalows and two-storey porch houses; six palettes, varied front windows, porches and open picket gates |
| High Street | 12 | Two six-unit outdoor shopping rows; adjoining walkways and independent storefronts |
| Civic center | 8 | Two- and three-storey cafés with furnished apartments, real stairs and rear courtyards |
| Village market | 8 | Two-storey neighborhood shops with apartments, different brick finishes and signs |
| Foundry district | 12 | Wider workshops, open vehicle bays, offices, real loft stairs and forecourts |

The shop rows share walking space, not structural bonds. Each unit is a separate structural assembly with its own foundations, actual shop and delivery entrances, furnished interiors and breakable sign/awning. Neighboring buildings likewise have no cross-instance bonds. This prevents a single town-wide structural chain, but is **not** a claim of zero idle computation: assembled native stability and performance still need measurement.

## Build and preview

From `structures/town-kit/`:

```sh
node scripts/build-small-town.mjs
node scripts/preview.mjs
```

Open `http://127.0.0.1:6174/?asset=bayline-small-town`. The existing private preview can load this asset without a restart. Saved views cover the whole town, both shopping rows, the center, houses, workshops, village market and furnished interiors.

- Generator and editable lot manifest: `src/bayline-small-town.mjs`
- New reusable shop module: `src/strip-shop.mjs`
- ScenePack v2: `out/bayline-small-town.json.gz`
- Separate rooms, entrances, walking routes, instance ranges, hashes and cameras: `out/bayline-small-town.meta.json`
- Multi-angle images: `out/reviews/bayline-small-town-visual/`

The pack is gzip-compressed to preserve space on the shared drive; its contents are standard ScenePack v2 JSON. The preview and native review runner read compressed inputs automatically. The native runner temporarily materializes a plain JSON copy while a case runs, then removes it if unchanged.

## Validation and limits

```sh
node --test tests/small-town.test.mjs
node scripts/review-small-town-templates.mjs
TOWN_KIT_COMPACT_GPU=1 node scripts/review.mjs strip-shop stability traverse
TOWN_KIT_COMPACT_GPU=1 node scripts/review.mjs strip-cafe stability traverse
node scripts/review.mjs bayline-small-town stability traverse
```

Run native GPU cases and browser captures sequentially. Large-scene reviews require at least 512 MiB free disk space. Small prefab intact/walking cases reserve 128 MiB and may use the explicitly recorded compact GPU buffer budget; solver settings, gravity and rejection of degraded/unobserved steps do not change.

The earlier six-building scene passed intact stability and its complete capsule route. Those results do not qualify this 64-building assembly. That earlier scene's workshop breach settled and protected its neighbors, but a capsule could not cross the rubble; the case remains failed. Severe-collapse qualification also remains open. Read the new scene's actual reports before claiming stability, complete traversal, demolition readiness or idle performance.

Only buried foundations/subgrade remain fixed. Road and walkway surfacing, buildings, furniture, fencing, signs and awnings carry mass and destruction bonds. Loose furniture rests through contact. No freezing, removed gravity or suppressed destruction is used to obtain a pass.

All authoring, generated outputs, review artifacts, caches and process ownership stay under the town kit. No existing application source, live scene, branch or service is changed.

## Current measured review

The exported 64-building scene has **182,964 chunks, 392,268 bonds, 304 rooms,
39 unique building templates and 278 reused convex shapes**. Geometry validation
found zero unintended overlaps. The reproducibility, per-instance bond isolation,
route metadata coverage, buried-anchor and mirrored-shop tests pass.
Sixteen saved exterior/interior views rendered without browser errors and were
visually inspected. The raw ScenePack SHA-256 is
`08689f6743635dba4ac2a53c7631a67fc6da819717cf35f0d171689f75366167`.

Both new shop interior families (`strip-shop`, `strip-cafe`) passed native intact
stability and complete capsule traversal, including 30 simulated idle seconds,
zero spontaneous broken bonds and zero crushing. The corrected full-porch
bungalow (`district-template-0`) also passed traversal and intact observation.
Those prefab results are not a substitute for the full 39-template matrix or
assembled 64-building review. Mirrored shops have passed geometry checks but
still require their own native observations.

The full-town native command was attempted; its working-space preflight rejected
the run before simulation because available shared disk space was below 512 MiB.
See `out/reviews/small-town-native-preflight.log`. No full-town native pass,
destruction pass, performance result or live deployment is claimed.

The template runner writes compressed, individually reusable template exports
and runs native cases sequentially. Set `TOWN_KIT_TEMPLATE_START=N` to continue
from an index after resolving a failure, or `TOWN_KIT_TEMPLATE_ONLY=1,4` for
specific indices. A subset result never marks the whole matrix complete.

The isolated runtime launcher accepts `--scene bayline-small-town`, decompresses
its own snapshot, and verifies the asset hash. It has not been launched. Finish
the native acceptance work before preparing it for later `/city` use.
