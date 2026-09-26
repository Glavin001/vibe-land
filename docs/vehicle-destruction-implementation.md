# Vehicle destruction work in progress — 2026-09-26

Vehicle fracture is **not implemented or qualified**. The garage UI says so.
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

The isolated native per-corner constraint tests also pass on local CPU/GPU PGS
and TGS. Their [review notes](reports/vehicle-constraints-2026-09-26/README.md)
record the still-pending authorization for broader native constraint routing
and fracture-time remapping. The rejected cross-module edit has not been applied.

The installed SDK uses destruction scene ABI 18. The isolated ABI 20 work in
`PhysX/out/build/garage-multihull` provides multiple hulls per authored chunk and
apportioned external loads, but explicitly does not support destruction-owned
Vehicle2 constraints. Both versions retain the
`eCONSTRAINT_ON_DESTRUCTION_BODY` correction blocker in
`Sc::Scene::computeDestructionCorrectionBlockers`. It must not be bypassed.

1. Register each suspension/sticky constraint row's chunk ownership and route
   its actual solved impulse into stress; remap/disable rows before corrected
   collision resolution, including changed COM/inertia and actor ownership.
2. Bind measured compound mass properties, all simple hulls and individually
   measured bond interfaces to the vehicle actor. Keep rig transforms and
   collision identities synchronized without adding wheel-tread stress nodes.
3. Feed the actual Vehicle2 substep force observations into the engine's
   apportioned per-chunk inputs; retain the aggregate-conservation rejection.
4. Consume committed connectivity to select the surviving chassis/engine and
   call the functional-state API. Transfer detached wheel/chunk mass and
   momentum to real fragments, then stream ownership and poses to clients.
5. Reconstruct damage state on reset and late join. Run targeted weak/strong
   interface, wheel-off, engine-off, severe-impact and no-impact operating-load
   campaigns before declaring bond strengths or destruction ready.

The new API is in the sibling PhysX wrapper and its local packaged copy; those
sources must accompany bridge builds elsewhere. Core SDK libraries and the
experimental ABI 20 package were not replaced by this work.
