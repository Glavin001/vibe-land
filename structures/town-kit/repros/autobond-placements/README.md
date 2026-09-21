# Native auto-bond placement comparison — 2026-09-21

This experiment compares the current furnished three-storey Victorian café and
workshop with NvBlast's C++ EXACT bond generator, called through its existing WASM
wrapper. Nothing is promoted into the live town. No engine files are modified.

## Source comparison

The auto-bond postprocessor, three.js wrapper, verification script, and C++
`NvBlastExtAuthoringBondGeneratorImpl.cpp` have identical content across the local
`blast-stress-solver`, `blast-stress-solver-2`, `physx-2`, `physx-2-deployed`, and
`physx-2-vehicle` checkouts. These are the latest **available local versions**;
no remote branches were fetched. Revisions and content hashes are in results.json.
The test uses physx-2's built WASM module; its bytes are also hashed.

The older `applyAutoBonds` postprocessor is not applied wholesale: it rewrites
areas, adds contacts, and assigns materials using another material table. Those
changes would confound the placement experiment and could glue loose props down.

## Controlled candidates

- `baseline`: unchanged authored asset.
- `centroids`: replace only the centroid of each matched node pair with the native
  centroid. Keep unmatched authored bonds. Keep bond count, area, normal, material,
  all strengths/stiffnesses, geometry, mass, anchors, and solver settings.
- `matched-topology`: additionally omit authored pairs not found by native EXACT.
  This is a diagnostic intersection, **not** a complete native-generated graph.
  Native-only contacts are reported rather than assigned guessed material values.

All six candidates pass the existing geometry gate and native intact gate:
9.81 m/s², observed/converged equilibrium, physical sleep, then 30 simulated
seconds of idle observation, with zero spontaneous broken bonds or crushed nodes.
The existing native harness records poses, membership and events. It uses its
explicit compact GPU capacity option; gravity, strength and sleep remain unchanged.
Runs are sequential, on a shared GPU alongside other services. Timings are
observations, not isolated performance certification.

| Building / candidate | Bonds | Equilibrium tick | Last solve iterations | Median step ms |
|---|---:|---:|---:|---:|
| Café baseline | 15,125 | 99 | 4 | 14.41 |
| Café centroids | 15,125 | 99 | 4 | 14.44 |
| Café matched topology | 15,094 | 99 | 4 | 14.43 |
| Workshop baseline | 6,568 | 108 | 4 | 11.44 |
| Workshop centroids | 6,568 | 110 | 4 | 11.41 |
| Workshop matched topology | 6,529 | 107 | 2 | 10.18 |

There is no demonstrated idle improvement from changing positions alone.
Dropping 39 native-unmatched workshop bonds shows a modest difference in this run;
that does not establish that these load paths are physically wrong or dispensable.
This does not explain or resolve the complete town's persistent nonconvergence.

## What differs

Café: 6,911 chunks; 15,094 matched pairs, 31 authored-only pairs, 154 native-only
pairs. 150 of those extra pairs cross authoring groups, including chair/table legs
resting on floors. Four other candidates are roof/ridge-beam contacts. Most missing
pairs are stair/baluster or roof contacts. Native generation is not an unconditional
reduction in the number of connections.

7,827 café bond centroids move over 1 mm; median displacement is 6 mm, p95 185 mm,
maximum 542 mm. Workshop: 3,103 chunks; 6,529 matched pairs, 39 authored-only pairs,
23 native-only pairs (all cross-group); 2,695 centroid shifts exceed 1 mm, maximum
371 mm. Native area ratios were measured but **never applied**.

## Native centroid is not a ground-truth oracle

The analytic fixture uses two unit cubes: the second touches the first at x=0.5
and is shifted along y. At y offset 0.5, the common face is a rectangle centered
at (0.5, 0.25, 0). Native EXACT returns z=-0.142857 for one triangulation and
z=+0.142857 for another, despite identical solid geometry and correct contact area.
Mixed diagonal choices return z=0. At offset 0.25, the error is ±0.035714 m.
All four fully aligned cases pass; four of eight partial-face cases fail the
10-micrometre centroid tolerance.

The C++ implementation around lines 866–898 accumulates intersection polygon
vertices and divides by vertex count. It does not calculate an area-weighted
contact centroid, so redundant vertices and triangulation affect the answer.
This is why large position differences cannot simply be interpreted as kit errors.
The implementation and the emitted WASM both support this finding.

No candidate was promoted. No damage/performance claim is made for a rebuilt town.
Before wider adoption, validate/fix centroid weighting, retain explicit joint and
loose-prop rules, inspect native-only/missing structural contacts, and run local
and support-loss destruction comparisons before replacing templates.

## Reproduce

Run from `structures/town-kit`:

```sh
node repros/autobond-placements/compare.mjs victorian
node repros/autobond-placements/compare.mjs workshop
node repros/autobond-placements/sanity.mjs
# sanity intentionally exits nonzero while the recorded native discrepancy exists.
node repros/autobond-placements/review.mjs \
  victorian:baseline victorian:centroids victorian:matched-topology \
  workshop:baseline workshop:centroids workshop:matched-topology
```

Override `TOWN_KIT_AUTOBOND_ROOT` only to compare a different installed authoring
runtime. Fresh candidate JSON/metadata goes to `out/lab-autobond-*`; full native
reports/recordings go to `out/reviews/lab-autobond-*-stability`. Native-only and
missing-pair lists are in `out/reviews/autobond-placements/<asset>/differences.json`.
The small checked-in results.json preserves this run's measurements and hashes.
