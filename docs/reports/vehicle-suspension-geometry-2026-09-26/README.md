# Suspension-to-destruction mapping (CPU reference)

Vehicle2 wheel state now maps to the posed actor-frame geometry of every
fracture chunk: hull transform, mass/COM/full inertia tensor, scalar stress-node
inertia, and bond centroid/normal. This is CPU reference data for the native
geometry revision. **No GPU run, native change or live-runtime replacement is
part of this checkpoint.**

## What was built

- `transformMassProperties` (`client/src/vehicles/mass-properties.mjs`) and its
  Rust twin `AssetMassProperties::transformed`. Both map mass properties through
  any affine `x' = Lx + t` while preserving mass. They go through the second
  moment `C = ½tr(I)·1 − I → L C Lᵀ`.
- `dune/pose-deltas.mjs` gives the physical motion of each suspension role,
  derived from the visual rig's kinematic state:
  - Arms rotate about their pivot lines.
  - The upright and caliper follow the steered knuckle.
  - Hub and wheel spin.
  - The damper turns about its top mount, and the piston rides the shock eye.
  - The tie rod follows its rack end.
  - The coil spring compresses axially.
  - The plunging CV shaft telescopes, and its rubber boot ribs telescope with it.
  - The visual beams are not used for physics. They stretch a unit tube and choose an arbitrary twist, which is fine for rendering axisymmetric parts but not for rigid chunks.
- `server/src/vehicle_assets/rig.rs` ports these maps to Rust, including
  `solveCorner`. It also maps Vehicle2 wheels to source corners (`fr, fl, rr,
  rl`, spin negated) the same way `VehicleVisual` does.
- `server/src/vehicle_assets/posed.rs` computes posed chunk geometry and
  `rebase_momentum`. The latter re-expresses a body on a new mass frame while
  conserving linear momentum and angular momentum about a fixed point.
- Preparation (recipe `vehicle-physics-posed-6`) now exports:
  - the rig with every solid's binding and its own actor-frame mass
  - joint names and measured centroids for anchored bonds

  It also rejects any chunk whose solids cannot share one motion. The one allowed exception is the coil-over group, whose damper and seats move rigidly inside the compressing coil.
- `origin_height` is now `f64` on the server. As `f32` it put about 1e-8 m of error into every rotated chunk (found by the golden test).

## Joint anchoring (changes the stress graph)

Measuring bonds across the pose sweep showed 181–196 of about 210 moving bonds per model separating by more than 5 mm, up to 35 cm. They were rest-pose contacts between relatively moving parts: CV boots against uprights, the shaft against the piston, the coil against the upper arm, and the steering column. Suspension travel alone would have torn them apart.

`anchorRigJoints` (`mechanical-joints.mjs`) now handles every bond between
differently moving chunks:
- It keeps the bond only if it lies within `JOINT_NEIGHBOURHOOD_M = 0.08`
  of one of these joints, then moves its centroid onto that joint:
  - pivot lines
  - ball joints
  - shock eye
  - top mount
  - spring seat
  - tie-rod end
  - rack
  - bearing axis
  - outer/inner CV
  - column axis
- Otherwise it excludes the bond.
- Area, normal and strength stay measured, and `measuredCentroid` is kept.

The 11 builds lose 73–83 contacts each and all stay connected. Anchored joints
move a median 20–35 mm, at most 79 mm. See `joint-anchoring.json`.

**Consequence:** earlier full-model impact results (break counts, wheel loss)
were measured on the old graph. They must be re-run before any claim is made
about these assets.

## Evidence

| Check | Result |
| --- | --- |
| Tensor map vs integration of moved real solids (rigid, axial, shear) | ≤1e-9 (client test) |
| Every chunk of 6 models × 19 poses: map vs integrated final solids | centre ≤2.1e-14 m, tensor ≤5.6e-14 |
| Rust vs JS pose deltas | ≤6.3e-15 per element |
| Rust posed chunk mass vs JS integrated solids | centre ≤2.1e-14 m, tensor ≤5.6e-14 |
| Neutral pose vs authored rest assembly | ≤2.3e-15 |
| Anchored joints (11 kinds, 6 models, 19 poses) | endpoint gap ≤1.2e-15 m |
| Spring affine model vs regenerated visual coil | 1.08% tensor, 0 mm COM |
| Hub rise rate vs bump rate; wheel ω vs spin rate | ≤1e-3 (bisection-limited), ≤1e-6 |
| Momentum rebase | p and L conserved to 1e-9 |
| Builds prepared and connected | 11/11 |

Logs: `client-vehicle-tests.log` (92 passing), `server-rig-tests.log`,
`golden-export.log`, `build-verification.log`, `posed-geometry.json`.

Measured limits:
- `solveCorner` bisects 22 times, so travel resolution is about 1e-7 m (the visual rig has the same limit).
- Visual beams differ from physical motion by up to 162 mm. That comes from twist and from the visual piston stretching.
- The drive shaft plunges by up to 182 mm.

Reproduce:
```sh
node client/scripts/verify-vehicle-builds.mjs /tmp/vibe-vehicle-assets /tmp/vehicle-posed-fixtures.json
node client/scripts/export-rig-golden.mjs /tmp/vehicle-posed-fixtures.json /tmp/rig-golden server/src/vehicle_assets/testdata/rig-golden-buggy.json
VIBE_RIG_GOLDEN=/tmp/rig-golden/manifest.json cargo test -p web-fps-server --bin web-fps-server \
  --features native-destruction six_model_posed -- --include-ignored --nocapture
```

## Not done here

- Committing posed geometry natively: stress nodes and bonds, material geometry, `cMassLocalPose` plus inertia, collider poses and mesh scale.
- GPU execution of PhysX `d82b4da7`.
- Re-running impact qualification on the anchored graph.
- Live garage destruction, fragment streaming and performance.
- Trailer kinematics. The semi passes through unchanged and is not fracturable.
