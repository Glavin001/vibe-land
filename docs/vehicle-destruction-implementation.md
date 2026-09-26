# Vehicle destruction work in progress — 2026-09-26

Full garage/city vehicle fracture is **not integrated or qualified**. The garage UI says so.
The isolated native bridge can fracture a controlled Vehicle2 fixture and disable
a severed corner, but that result must not be generalized to complete models.
The new bombardment mode is an impact test against the existing rigid vehicle.
No hit-point damage, arbitrary detachments or invisible-wheel substitutions were
introduced to make this look complete.

## Implemented

- Eight elevated cannon mounts around the proving ground, authored in the same
  world document used for server collision and client rendering.
- Start/stop bombardment, off by default, scoped to a private garage session.
  It fires a 30 kg, 0.20 m radius physical sphere every 150 ticks, after a
  120-tick grace period. No driver means no shots. Aim leads current velocity
  once, with deterministic scatter; projectiles do not home. The existing
  bounded cannonball pool and snapshot stream are reused. Radius metadata is
  selected per match, preserving the city's separate projectile configuration.
- `set_vehicle_functional_state`: native Vehicle2 corner mask and driveline
  connectivity. Disabled corners are removed from the axle iteration, with
  their stored tire/suspension/constraint state cleared. Drive torque cannot
  return through live tuning. This consumes a connectivity verdict; it does
  not discover broken bonds, split shapes, transfer momentum, or repair a car.
- A repeatable targeted impact probe loads an actual prepared garage model,
  settles it, launches a ball toward an optional authored part, and records
  contact impulses, per-tick vehicle/wheel state, and complete-step times.

## Current evidence

Local CuMetal GPU functional-state test passed: disabling one wheel leaves the
other three driven; disabling all four removes road support and bottoms the
chassis out; a disconnected driveline prevents powered wheel rotation; explicit
restoration enables it again. Invalid masks leave state unchanged.

The prepared buggy contact probe produced 12 projectile/car contact reports.
Its [raw report](reports/vehicle-impact-2026-09-26/contact-probe.json) explicitly
records no attached native destruction graph and `fractureQualified: false`.
It contains 180 intact-idle and 240 impact/aftermath complete-step samples. These
are diagnostics from a shared local GPU, not isolated performance qualification.
No bond-strength, fragment-ownership or CUDA qualification is implied.

Browser verification on the local proving ground confirmed Start/Stop bombardment,
mounted towers and streamed physical projectiles while remaining in the vehicle.
A temporary no-HMR page was used because concurrent development reloads repeatedly
closed sessions in the normal development page. Bombardment was stopped afterward.

Scheduler tests cover opt-in, cadence, repeated requests, immediate stop,
no-driver grace, and ballistic aim. Client type checking and server build pass.

## Repeatable commands

Prepare fixtures using `client/scripts/verify-vehicle-builds.mjs`, then run:

```sh
python3 scripts/verify-vehicle-impact.py \
  --fixtures /tmp/vehicle-build-fixtures.json \
  --report /tmp/vehicle-impact.json
```

**This gate currently fails**, as required: physical contact without an active
native graph and broken bonds cannot qualify vehicle destruction. Use
`--contact-only` solely to verify projectile delivery. `--build N` chooses a
prepared fixture; `--part ID` aims at an authored collider-group position.
A hit may intercept another part, so aim location is not proof of which part
received the impulse. Per-part contact identities remain part of native binding.

The separate functional-state test is:

```sh
cargo test -p vibe-land-physx-bridge --features native-destruction \
  --test gpu_smoke disabled_corners_have_no_drive_suspension_or_sticky_constraints -- --nocapture
```

## Native integration still required

Server preparation now retains and validates the authored mass/COM/inertia,
visual-to-collider grouping, individual bond interfaces and material strengths.
It checks that the combined chunk mass properties match the assembly, retains
parallel bonds, rejects missing graph endpoints/disconnected initial parts, and
maps wheel groups by actor-space position (source left/right names are reflected).
The ownership-to-wheel-mask helper consumes committed chunk owner IDs; it does
not infer impact damage. It is not yet connected to live vehicle fragmentation.

All 11 prepared driving fixtures passed this validation, alongside corruption,
grouping and partial-owner regression cases. See the
[validation log](reports/vehicle-fracture-data-2026-09-26/validation.log) and
[input hashes](reports/vehicle-fracture-data-2026-09-26/inputs.json). Run with:

```sh
VIBE_VEHICLE_BUILD_FIXTURES=/tmp/vehicle-build-fixtures.json \
cargo test -p web-fps-server --bin web-fps-server --features native-destruction \
  vehicle_assets::fracture::tests -- --include-ignored --nocapture
```

## Current native foundation and remaining gates

The user authorized the sibling PhysX work. The isolated ABI 22 build now
supports multiple hulls per chunk, apportioned Vehicle2 loads, fracture-time
constraint remapping, functional connectivity and mass-frame adaptation. The
[bridge proof](reports/vehicle-bridge-fracture-2026-09-26/README.md) uses a
six-chunk fixture and a 300 kg projectile, with a stronger-material control.
It does not qualify the garage's 30 kg cannon or full suspension geometry.

All six complete model graphs now register and complete free fall without
solver errors, damage or lost hull ownership after an
[exact-arithmetic correction](reports/vehicle-native-precision-2026-09-26/correction/README.md).
The source models keep their authored values, measured mass tensors and all
individual bond interfaces. Wheel visual groups remain coherent.

The full-model test uses actual 30 kg, 0.20 m cannonballs at 55 m/s,
positive initial gaps and ray-verified target wheels. An independent force-balance
regression exposed incorrect equalized mass weighting in the native equations.
The [authored-mass correction and evidence](reports/vehicle-authored-impact-2026-09-26/authored-mass/README.md)
now reproduce analytical loads and pass all 14 bridge regressions with an
isolated double-precision runtime. All six full models converge through 120
impact-aftermath steps; trophy/rally/monster/derby break 9/6/8/2 bonds, while
buggy and sprint break none. No targeted wheel detaches. The impact gate remains
red. Single precision still fails convergence. A separate
[convergence transaction fix](reports/vehicle-authored-impact-2026-09-26/convergence-gate/README.md)
now rejects unconverged damage and passes 15 bridge regressions plus direct GPU
material-state inspection. The candidates are not installed or performance-qualified.

A [narrower mixed-precision experiment](reports/vehicle-authored-impact-2026-09-26/wide-solution/README.md)
passed the analytical loads and initial impact for every model, but only rally
completed the full aftermath. It was reverted with its patch and evidence saved.
The same report records a mechanical attachment concern: the buggy wheel has
measured bonds directly to control arms, shock eye and axle as well as its
upright. Those interfaces need review before tuning wheel separation.

The subsequent [open-wheel correction and impact run](reports/vehicle-authored-impact-2026-09-26/open-wheel/README.md)
keeps calipers and uprights out of the rotating wheel collision group. All seven
base-model geometry audits and all 11 driving builds pass. Full-model nominal
impacts now break 0/10/6/8/2/0 bonds; a separate 300 kg, 120 m/s wheel-loss probe
breaks 31/52/63/40/45/34. Every impact aftermath converges, but no target wheel
detaches. Both physical impact gates remain red. The wheel's geometric contact
graph still includes mechanically questionable direct attachments, and needs
review before strength tuning. The shared verification command now supports
`--authored-fixtures` and checks complete impact evidence as well as test exit codes.

The [mechanical graph and axle-connectivity update](reports/vehicle-authored-impact-2026-09-26/mechanical-drive/README.md)
removes incidental rotating/stationary contacts while retaining the measured
mounts and unchanged geometry, masses and material strengths. A real GPU
projectile regression now proves that a detached axle cuts only its wheel's
drive torque, preserving the attached wheel's inertia and brake. All 16 bridge
regressions pass. This uses the derived `/tmp/vehicle-drive-mask-sdk22` wrapper
with per-wheel drive connectivity; the preceding frozen wrapper does not expose
that capability. The full-model run converges but fails impact qualification:
nominal shots do not break buggy/sprint bonds, and heavy shots do not detach
the targeted wheel on any of the six models.

The [separate hub update](reports/vehicle-authored-impact-2026-09-26/separate-hubs/README.md)
keeps each tire/rim separate from its rotating hub/rotor, exposing the measured
wheel mount. It preserves collision geometry and aggregate mass properties;
49 client tests and all 11 builds' server layout checks pass. Severe GPU impacts
now detach the targeted wheel on all six models and keep it disabled for 119
further steps under throttle; free-fall controls also pass. The full gate still
fails nominal wheel hits on buggy and sprint, whose mounts remain below their
material limits. The impact inspector reports each
target interface's peak load relative to its material limits without changing
the acceptance gate.

The full-model tests share fixture loading, registration and configuration in
`server/src/physx_runtime/vehicle_fracture_tests.rs`. Run them serially against
the explicit isolated runtime. `VIBE_VEHICLE_FRACTURE_REPORT` records per-model
impact evidence; `VIBE_VEHICLE_CAPTURE_DIR` selects unique scenario/model
equation-capture paths when using the separate diagnostic SDK module.

Remaining requirements:

1. Converged stress under nominal cannon and severe impacts on the full models;
   localized damage, strong-interface controls and a retained wreck after large
   impacts. Do not treat a non-converged material verdict as qualification.
2. A native contract for moving suspension geometry and chunk mass frames.
   The stress graph currently assumes fixed chunk geometry. Merely moving
   wheel visuals or leaving rest-pose wheel colliders fixed is insufficient.
3. Actual full-model wheel/engine separation with correct fragment pose and
   momentum, disabled disconnected functions, and changed surviving handling.
4. Server registration and append/reset lifecycle that preserve existing city
   damage; streamed committed membership, fragment poses and late-join state.
5. Garage bombardment/reset and city integration verified in the browser,
   no-impact operating-load tests, and complete-step idle/impact performance.

The installed live SDK remains ABI 18 and has not been replaced. All new native
qualification is isolated. CUDA/Vast validation remains deferred at the user's
request; the exact-coordinate correction currently affects the CuMetal path.
