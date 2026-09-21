# Binary scenes: scripts are the source of truth

The building scripts, town placement recipe, options and seed are the source.
`out/bayline-civic-town.vlsp` is a disposable, **uncompressed** build artifact.
Do not hand-edit either this file or a debug JSON export.

## Generate and load

From this directory:

```sh
npm run build:binary
# Optional authoring parameters:
node scripts/build-binary.mjs --seed 20260920 --no-furniture --out out/unfurnished.vlsp
# Optional full JSON for debugging (not part of the normal build):
node scripts/build-binary.mjs --json
# Reassemble from cached templates, even if the final artifact is unchanged:
node scripts/build-binary.mjs --force
```

The default recipe preserves the 67-building town, its authored transforms,
188,922 chunks and 405,404 bonds. There are 69 placement records: the 67 buildings
and two ground/paving assemblies. The bundle stores 35 distinct geometry
schemas, containing 81,504 chunk definitions and 179,114 bond definitions.
Materials are referenced through per-instance remap tables, so palette changes
can share geometry. Built-in attachments and loose-prop bond boundaries remain
as authored. Runtime instances have separate node, bond and piece identities.

Generation calls the same recipe as the legacy JSON exporter, with assembly
left as template references. It does not first build/write the 95.7 MB flattened
JSON. A source-content fingerprint, seed and options are embedded in the bundle.
The seed is forwarded to builders; it is not a promise that every hand-authored
part changes shape for every seed. Generator/dependency versions also matter.

`out/binary-cache/` caches validated templates by options and the content hashes
of their transitive authoring dependencies. These are private, disposable binary
files. A placement-recipe edit need not rebuild unchanged building templates.
The final bundle is replaced atomically. An unchanged build verifies its checksum
and skips writes. Deleting the private cache only makes the next build cold.
JSON remains available for compatibility and debugging.

The existing Rust `load_scene_pack_file` recognizes `VLSP` by its magic bytes;
otherwise it follows the existing JSON path. Once the server is rebuilt with
this loader, its settings can point directly at:

```sh
VIBE_CITY_SCENE=/root/workspace/vibe-land-4/structures/town-kit/out/bayline-civic-town.vlsp
VIBE_CITY_GRID=1
VIBE_CITY_VARIED_HEIGHTS=0
VIBE_CITY_DESTRUCTION=native
```

The server recognizes a binary town as an already composed scene, with no floor
truncation or additional grid replication (`VIBE_CITY_GRID=1`). Native chunks have
16-bit local indices, so complete placements are grouped into bounded structures
without cutting buildings or introducing bonds between placements. The current
town uses three structures: 65,502 / 64,105 / 59,315 chunks. Material, collider,
piece and bond data remain exact; structure-local endpoints are remapped and all
network IDs remain distinct. A placement exceeding the per-structure limits is
rejected. The existing VLCM network format remains unchanged.

Binary generation itself does not deploy anything or qualify the town's outstanding
physics failures. The loader expands templates into the existing ScenePack API;
it is not a zero-copy physics engine and does not make intact buildings share
mutable simulation state.

## Cross-language review

```sh
npm run test:binary
```

The review uses `binary-review/` as a separate Cargo workspace and
`out/binary-target/` as its build directory. It copies only locked dependencies
from the local Cargo registry into `out/binary-cargo-home/` for offline builds;
those dependencies must already be available locally. It does not build the
application or run GPU physics.

The workflow checks deterministic JavaScript round trips, mirrored quarter-turn
placements, palette-only sharing, independent identities, invalid inputs,
checksums, and Rust rejection of malformed files. It creates a temporary JSON
baseline through the **legacy assembly path**, compares every runtime field
against the binary-loaded scene, then removes that temporary JSON. It also
checks a no-write warm build and byte-identical cache-backed rebuild. Existing
saved JSON, if present, is an additional JavaScript regression baseline.

Results are retained in `out/reviews/binary-scene-review.json`.
Observed on this shared machine (one process per load; OS cache not flushed):

| Measurement | JSON | VLSP |
| --- | ---: | ---: |
| Uncompressed file bytes | 95,727,119 | 22,663,512 |
| Rust read + decode | 333 ms | 117 ms |
| Process peak resident memory during load | 156,552 KiB | 65,820 KiB |

Cold generation took about 10.8 s; forced reassembly with 43 cached assets took
1.1 s; an unchanged-build check took 53 ms, without rewriting the output.
Generation timers exclude Node startup/module loading. These are CPU loading
measurements, not GPU/runtime simulation benchmarks. The existing gzipped JSON
is still smaller on disk (5.66 MB); VLSP's measurements are for an immediately
loadable, uncompressed artifact.

## VLSP v1 contract

All integers are little-endian u32. Numeric geometry is little-endian IEEE f64;
this retains authoring precision until placement and six-decimal rounding, then
Rust converts to the same f32 values as its existing JSON parser. Quantizing
local coordinates to f32 before placement can change final world coordinates,
so this version deliberately does not do that.

The file is a 64-byte prefix, UTF-8 JSON descriptor, zero padding to an 8-byte
boundary, then numeric sections. The descriptor carries small tables, template
ranges, instances, review metadata and provenance; it does **not** carry per-node
or per-bond numeric objects. It is not the network `VLCM` manifest.

| Prefix offset | Field |
| ---: | --- |
| 0 | ASCII `VLSP` |
| 4 | Format version: 1 |
| 8 | Descriptor byte length, excluding padding |
| 12 | Node record stride: 112 |
| 16 | Bond record stride: 72 |
| 20 | Numeric payload byte length |
| 24 | Expanded node count |
| 28 | Expanded bond count |
| 32 | SHA-256 of all bytes after the prefix (32 bytes) |

Descriptor `sections` contains `nodes`, `bonds`, `shapes`, each with a byte
`offset` relative to the numeric payload and `bytes`. Sections are contiguous.
`templates` contain `nodeStart`, `nodeCount`, `bondStart`, `bondCount`, `pieceSpan`
and `materialSlots`. Starts count records, not bytes. Definitions are contiguous.
`instances` contain `template`, `position`, quarter-turn `yaw`, boolean `mirror`,
`materials` (local-slot to global-material indices), `groupSuffix`, and nullable
`group` override. Mirroring reflects local X before yaw; translation follows.
Shape records hold `{offset,count}` into the f64 shape section, counting scalar
coordinates in triples. Shape IDs and string IDs are zero-based.

Node record offsets: position xyz f64 at 0; mass f64 at 24; volume f64 at 32;
visual size xyz f64 at 40; cuboid half-extents xyz f64 at 64; local material u32
at 88; local piece ID at 92; role string ID at 96; group string ID at 100;
shape ID at 104; collider kind at 108 (0 cuboid, 1 convex hull). Cuboids use
`0xffffffff` for their unused shape ID. Hulls use zeroed unused half-extents.

Bond record offsets: centroid xyz f64 at 0; normal xyz f64 at 24; area f64 at 48;
local endpoint IDs at 56 and 60; local material slot at 64; reserved zero at 68.
Bonds never reference a different instance. Each instance offsets its endpoints
and piece IDs independently; reused shapes and materials are immutable.

The readers reject unsupported versions, inconsistent lengths, checksum errors,
invalid references and non-finite geometry. Rust additionally validates material
rules through the existing ScenePack material parser. Limits are 16 MiB for the
JSON descriptor, 2 million expanded nodes and 8 million expanded bonds. Both
coordinate transforms and material remaps are verified against JSON-generated
runtime data. New layouts require a new format version.

V1 reuse is at complete-template granularity. Furniture inside two different
building templates is still baked into each definition. A future hierarchical
component format could remove more duplication, without changing these authoring
recipes; that optimization is not claimed here.
