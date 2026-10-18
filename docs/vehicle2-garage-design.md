# Vehicle workshop: handling, appearance and damage

## Implemented experience (2026-09-26)

Build offers twelve configurations on seven existing chassis generators. Five
editions combine distinct finishes with driving setups: Trail explorer, Desert
runner, Mountain rally, Drift club and Circuit special. Eleven are drivable;
the semi remains a preview until its trailer and hitch are simulated.

Style separates frame, body, accents, wheels and seat colors, plus matte, satin
and gloss paint. Drive offers personalities first, then three primary controls
and optional fine tuning. Applying a personality preserves geometry and colors.
Inspect articulates suspension and steering without pretending to simulate
loads. Test drive uses the existing authoritative server and heightmap.

Configuration v2 stores appearance and driving settings. Version 1 imports
migrate automatically. Geometry keys retain their old format: paint and tuning
reuse the collision audit and cached solids. The server worker derives physical
parameters from the same functions as the browser, using the prepared mass.
Both private drives and city publication consume that prepared setup.

## Live driving iteration (2026-09-26)

In a private test drive, **Tune driving → Apply & save** updates the existing
Vehicle2. The drawer reuses `DrivingControls` from the workshop and supports
discarding drafts and undoing the last applied setup. Successful updates save
the configuration back into the garage; sending that configuration to the city
uses the updated tune. This endpoint does not modify cars already in the city.

`POST /vehicle-assets/session/:id/tuning` accepts only `expectedAssetHash` and
`driving`. A persistent scalar-only worker runs the same JavaScript validation
and mass-dependent setup math as preparation. It does not build geometry, run
contact audits, cook hulls, read assets or start a process per update. A stale
asset hash is rejected again in the simulation event loop before mutation.

The native wrapper's `setTuning` validates the complete update and blends tire,
spring, damping, steering-lock and drivetrain parameters over 0.2 seconds before
Vehicle2 steps. It preserves the actor, shapes, pose, velocity, wheel state,
constraints and driver. The bridge rejects changes during an in-flight physics
step. The authoritative configuration is broadcast to existing clients and
retained for late joiners; renderers reuse meshes when the geometry hash matches.
Geometry changes remain on the preparation path. Automatic live application and
in-city tuning are not enabled in this first implementation.

Native wrapper changes live in the sibling PhysX repository's
`destruction/vehicle/PxNativeVehicle.{h,cpp}`. The local packaged wrapper was
updated too, since `physx-bridge/build.rs` compiles the packaged copy. Other
machines must package those wrapper changes before rebuilding the server;
this change does not require rebuilding the core PhysX libraries.

Local evidence: the browser applied a Circuit special → Trail explorer tune in
79 ms and restored it with Undo in 8 ms, while remaining player 1 in the same
vehicle and session. The persistent scalar worker took about 2.6 ms warm.
The native regression verifies exact snapshot preservation at apply time,
retained driver ownership, rejection of invalid tuning, handbraking, and a
changed response curve (11.37 m/s tuned; 28.76 m/s restored). Client tests verify
that a new tuning identity retains existing draw batches. HTTP checks reject
stale hashes (409), structural fields (422) and non-garage sessions (404).
These are local measurements, not a network-latency guarantee or CUDA validation.

## Capability mapping

The NVIDIA [Vehicle2 guide](https://nvidia-omniverse.github.io/PhysX/physx/5.6.0/docs/Vehicles.html)
describes a component-based pipeline covering road queries, suspension, tires,
drivetrain and rigid-body integration. It supports both direct-drive and
engine-drive implementations. Capability in the SDK does not imply it is wired
into this application.

The current native wrapper is `PhysX/destruction/vehicle/PxNativeVehicle.cpp`.
Its actual bindings determine the controls below:

| User control | Implemented physical effect |
| --- | --- |
| Acceleration | Per-driven-wheel torque from vehicle mass, tire radius and requested acceleration |
| AWD / FWD / RWD | Four driven wheels, front pair or rear pair; drive force capped by driven-wheel static grip |
| Top speed | Direct-drive torque falls toward zero at the configured speed; not a velocity clamp |
| Tire grip | Tire/road friction coefficient; also informs acceleration and steering assistance |
| Spring firmness | Quarter-mass spring support scaled within authored suspension travel |
| Shock damping | Damping ratio converted to force coefficient using sprung mass and spring rate |
| Brake strength | Mass-scaled brake torque and handbrake torque |
| Steering response | Input slew rate |
| Steering lock | Maximum angle within generated linkage limits; native Ackermann steering remains active |
| Dimensions | Shared geometry, colliders, wheel placement, suspension travel and steering limits |

Initial drive force is limited to 80% of the driven wheels' estimated static
friction budget. Steering assistance reduces requested lateral acceleration at
speed. Neither rule overrides the resulting physical motion. Weight transfer,
surface contact, hills and impacts can still cause slip, rollover or lower speed.
Equal quarter-mass sprung loads, a fixed lowered center of mass and box-derived
chassis inertia remain approximations. The UI does not expose engine RPM,
gears, clutch, differential locking, brake bias or anti-roll bars: those require
additional native bindings and validation before becoming meaningful controls.

## Destruction and functional damage contract — not yet active

Vehicle assemblies currently remain rigid. Authored parts, measured interfaces
and strength profiles exist, but fracture ownership, moving rig bindings and
Vehicle2 constraint remapping are incomplete. The following is the required
integration behavior, not a claim about today's runtime.

1. **Separate visuals from physics.** Keep the Simple collision recipe. A road
   wheel's 149 visual meshes share one cylinder-shaped convex; tread blocks do
   not become individual actors. Cosmetic details follow their owning chunk.
   Panels, frame members and mount assemblies provide meaningful fracture units.
2. **Use physical interfaces.** Preserve measured bond area and orientation.
   Material and connection type determine finite strength; paint does not.
   Normal suspension, tire, braking and inertial loads must enter the stress
   solve. Validate idle, bumps, full acceleration, speed, turns and braking before
   tuning impact behavior. Do not inflate measured areas or protect arbitrary
   bonds to keep the vehicle together.
3. **Resolve functions from connectivity.** Track each corner's wheel/hub,
   suspension mounts and drive connection to the surviving chassis component.
   Cosmetic trim loss must not disable a healthy wheel. Losing the required
   structural connection must disable that corner before the next Vehicle2
   update: road query, tire force, spring force, drive/brake torque and sticky
   constraints. A detached wheel becomes an independent physical fragment.
4. **Keep the remaining vehicle physical.** Recompute fragment mass, center of
   mass and inertia, conserve momentum, and remap surviving shapes/constraints.
   Do not silently give surviving wheels the missing wheel's torque or grip.
   The car can pull, bottom out, spin or remain partially drivable according to
   its surviving support and drivetrain. Define engine/driveline disconnection
   explicitly rather than disabling the whole car for every broken panel.
5. **Stream the outcome.** Publish stable chunk IDs, component ownership,
   fragment poses and functional corner state. Client rendering must hide or
   detach the corresponding complete visual assembly and stop its rig animation.
   Late joiners must receive the same topology as current players.

Cannonball qualification should measure localized breakage near panels, frame
and mounts, including a wheel-off driving case. Meteor qualification should
produce major structural failure while retaining connected subassemblies where
loads permit. Use real projectile mass, velocity and contact location, not
projectile-name damage branches. Tune effective material limits against measured
operating loads and impacts; current strength numbers are not qualified values.
Soft-body dents and continuous sheet-metal deformation are not implemented by
this rigid-chunk fracture approach.

## Evidence and limits

`client/scripts/verify-vehicle-builds.mjs` prepares all eleven drivable builds
through the production asset worker and checks shared setup math and Simple
colliders. The native `prepared_garage_builds_drive_turn_and_brake` test loads
their actual prepared geometry, drives each for 1,200 ticks through the city's
split physics dispatch path, and checks finite motion, suspension bounds,
upright flat-ground turns, acceleration and W+Space stopping. All eleven passed
locally on 2026-09-26; observed peak speeds were 15.3–34.1 m/s and final speed
was approximately zero. This does not qualify every tuning combination, rough
terrain maneuver, stress bond or CUDA deployment.

Configuration tests cover migration, strict validation, independent paint,
cache identity, force budgets and suspension support. Browser verification
checks personalities, styling, articulated preview and authoritative joining.
The required impact/performance evidence remains in
[vehicle-garage-validation.md](vehicle-garage-validation.md).

### Front-wheel drive

The Driven wheels selector supports AWD, FWD and RWD in both the workshop and
live tuning drawer. FWD applies drive torque only to wheel indices 0/1; RWD
only to 2/3. Steering remains on the front axle and handbraking on the rear.
Both two-wheel modes use the same static grip budget and per-driven-wheel
force calculation. The actual tire model determines grip under load transfer
and combined acceleration/steering. Live axle changes blend over 0.2 seconds.
Older prepared metadata defaults the new frontWheelDrive flag to false.

Verified locally: native airborne wheel rotation test distinguishes front-only,
rear-only and restored front-only torque, rejects conflicting axle flags, and
checks snapshot continuity on apply. Shared configuration and server worker
tests cover FWD serialization, unchanged geometry, force budgets and identity.
Browser: prepared an FWD sprint car, entered it, applied RWD (65 ms) then FWD
(8 ms) without leaving the vehicle or reconnecting. TypeScript check and server
build passed. No Vast/CUDA validation was run.

Bombardment, the functional corner API, impact diagnostic and the remaining native
fracture blocker are recorded in [vehicle-destruction-implementation.md](vehicle-destruction-implementation.md).
Vehicle fracture remains inactive.
