# Custom vehicle qualification

## Customization update (2026-09-26)

The garage now offers twelve builds on seven chassis, including five additional
appearance/handling editions. Eleven builds are drivable. Configuration v2 adds
independent paint channels and validated Vehicle2 driving settings; old imports
migrate and geometry caches remain reusable. See
[the capability and functional-damage design](vehicle2-garage-design.md).

All eleven drivable builds passed a local native test using their actual
prepared Simple geometry: idle, full acceleration, sustained flat-ground turns,
suspension bounds and W+Space stopping. This supersedes the earlier statement
below that no native operating cases have been checked. It does not qualify
stress bonds, impact destruction, every tuning combination or Vast/CUDA.

Reproduce preparation with `cd client && node scripts/verify-vehicle-builds.mjs
/tmp/vibe-vehicle-assets /tmp/vehicle-build-fixtures.json`, then from the root:

```sh
VIBE_VEHICLE_BUILD_FIXTURES=/tmp/vehicle-build-fixtures.json cargo test \
  -p web-fps-server --features native-destruction --bin web-fps-server \
  prepared_garage_builds_drive_turn_and_brake -- --ignored --nocapture
```

## Original geometry and integration qualification

The garage is an in-progress integration. Preview and server preparation do
not certify Vehicle2 driving or native stress destruction. Strength values in
`strength-profile.mjs` are initial joint tuning inputs, not measured results.

Implemented: seven source model generators, shared live renderer, `/garage`
configuration preview, strict versioned JSON import/export, a server-side asset
worker/cache, measured positive-area joints, and initial joint material tables.
Private test drives reuse the multiplayer match, WebTransport, Vehicle2 inputs,
terrain and renderer. Six models can be entered and driven; the semi remains
preview-only until its physical trailer/hitch is implemented. Garage vehicles
can now be added to the shared city alongside its existing cars. Native vehicle
destruction and automatic replacement of the existing city cars are not enabled.

Simple asset builds verified on 2026-09-25:

| Model | Visual parts | Collision groups | Shapes | Measured joints |
| --- | ---: | ---: | ---: | ---: |
| buggy | 927 | 194 | 384 | 638 |
| trophy | 1,069 | 336 | 674 | 1,084 |
| rally | 1,064 | 331 | 664 | 1,114 |
| monster | 1,069 | 328 | 622 | 1,039 |
| derby | 1,063 | 330 | 639 | 1,028 |
| sprint | 959 | 226 | 461 | 766 |
| semi | 1,192 | 391 | 865 | 1,227 |
| custom-buggy | 927 | 194 | 391 | 647 |

These are the source's **Simple** collision groups. Every visual ID maps exactly
once; group mass and inertia are combined from the detailed solid geometry.
Each road wheel combines 149 visual meshes into one cylinder-shaped convex.
PhysX GPU cylinders use 32 sides/64 vertices (maximum radial error 0.482%).
Boxes retain eight vertices; other pieces use the source's clipped simple convex
shapes. No individual tire-tread collider is passed to the solver.

The source's Rapier primitive contact audit runs only during offline asset
preparation, with fixed bodies. It is not the driving or destruction backend.
The source uses SAT for convex contacts and native queries for primitives;
separate convex-query diagnostics remain visible in metadata. The Balanced
recipe runs only during authoring to measure original individual joint surfaces.
Those joints retain their location, area, normal, and constituent-material
strength after mapping into Simple groups; internal group interfaces disappear.
The Balanced shapes are never installed in the simulation.

Reproduce all seven defaults and a custom 2.8 m buggy with:
`cd client && node scripts/verify-vehicle-assets.mjs /tmp/vibe-vehicle-assets`.
The garage shows the collision group and shape counts after preparation.
A local in-app-browser smoke check prepared, joined, entered and returned from
a Simple buggy private WebTransport session. The detailed visuals were retained.
Chassis-mounted parts use the prepared shapes. Moving rig parts are still pending
native shape bindings; tire/road interaction currently uses Vehicle2's cylinder
sweep queries. Prepared wheel hulls are not yet destructible wheel actors.

On 2026-09-25, Chromium drove buggy, trophy, rally, monster, derby and sprint
through private local PhysX GPU sessions without page errors. The buggy used
a customized 2.8 m wheelbase and gold finish. Every case checked server-returned
configuration, rendered asset identity, driver ownership, movement over 2 m,
and return to the garage. Reproduce with `client/e2e/garage-smoke.mjs`.
These short straight-line tests do not qualify handling or strength.

These counts are asset validation only. None of the native operating or impact
cases below have been qualified. The renderer and configuration controls were
checked in Chromium across all seven models with no page errors.

## Required behavior

### Garage heightmap

Private drives now use a 256 m square, 257 × 257 sampled proving ground with
a level 12 m radius starting pad, rolling hills, a banked rise, and a staggered
seven-metre-wave suspension lane ahead of the vehicle. Visible perimeter
barriers sit inside the heightfield boundary. There is one ground collision
surface, with no coincident flat slab. The server returns the same world document
used to create the PhysX heightfield for the existing client terrain renderer.

Local checks (2026-09-25): two document/geometry tests pass, including serialized
surface versus collision raycasts; the installed CuMetal PhysX Vehicle2 test
drives through the lane with suspension travel ranging from 0 to 0.2 m and no
vehicle below the terrain. PhysX raycasts match within its 1 cm height
quantization. A separate preview at `http://127.0.0.1:5563/garage` was also joined
over WebTransport and the source buggy entered/rendered on the hills; the prior
4171/5561 services were left running. This is local functional evidence, not CUDA qualification or a
strength test. Run `cargo test -p web-fps-server --bin web-fps-server garage_heightmap`
and add `--features native-destruction` to include the local GPU drive test.

Every model, including the semi with its trailer, must retain its assembly
under its own weight at idle and during acceleration, maximum-speed driving,
braking, and turns in both directions. Test stock configurations and supported
dimension extremes. No spontaneous failed bonds, detached parts, or accumulated
elastic-limit damage is acceptable in these normal operating cases.

Cannonballs should cause damage near the impact, with the distant chassis
remaining connected. Test several impact locations, including panels, frame,
and wheel mounts, using the city's actual projectile mass and speed.

A meteor should leave a substantially wrecked vehicle: major structural breaks
and loss of driving capability, while retaining some connected assemblies where
the loads permit. Complete disintegration is not the desired normal result.
Do not enforce this by protecting arbitrary bonds, clamping impact impulses,
discarding debris, limiting fracture counts, or branching on projectile type.

## Evidence required before enabling city replacement

- Native GPU stress traces with convergence status, maximum stress/elastic-limit
  ratios, accumulated damage, failed bond IDs, and connected-component masses.
- Timestamped vehicle inputs and wheel loads for idle and maneuvering; include
  gravity, suspension/tire loads, braking torque, and rotational inertia.
- Impact position, projectile mass, velocity, and resulting component graph.
  Record damage distance from impact and retained chassis mass for localization.
- Before/after rendered captures that use the actual streamed topology.
- Four simultaneously active vehicles with separate idle and peak-destruction
  whole-step timings against the 8 ms target and 16.67 ms frame budget.

Tune effective joint limits by material and connection type after measuring
the operating envelope. Keep bond area as measured geometry in square metres.
Stronger frame load paths and weaker glazing/trim provide differentiated damage;
all finite-strength joints must remain able to break. Zero-area edge contacts
are not structural bonds. Do not silently enlarge contact areas to pass tests.

## Current native integration prerequisites

The installed SDK fixes destruction topology at scene configuration, binds one
collision shape to each stress chunk, and rejects constraints on
destruction-owned actors. The separate PhysX source now supports additional
hulls per chunk, with local GPU impact/ownership tests passing; it has not replaced
the installed SDK. A Vehicle2 load observer passed linear/angular conservation
checks and produced the identical 540-frame trajectory as the original wrapper.
The isolated ABI 20 engine now accepts explicitly apportioned per-chunk command
impulses, verifies them against the real body inputs, and conserves them through
one corrected fracture. Local force/rotated-source/input-expiration and parallel
interface checks pass, along with existing correction, checkpoint, publication
and sleep regressions (nine focused native/vehicle checks total). Those APIs are not yet wired to garage Vehicle2s.
Individually authored vehicle parts have multiple
convex shapes, and Vehicle2 uses suspension/sticky constraints. Moving rig
bindings and vehicle loads must participate in the native stress/correction
stage. These require engine integration before the above tests can pass;
removing those guards is not a substitute for implementing ownership, load
mapping, and constraint remapping after fracture.

### Automatic configuration feedback (2026-09-25)

The garage now runs the server's collision, primitive-contact, GPU-shape and measured-joint connectivity checks in a cancellable browser worker after a 250 ms pause in dimension edits. The preview remains interactive. This is an asynchronous physical audit (the Sprint preset took approximately 19–23 seconds locally), not an instantaneous range-only check. Preparation and driving remain disabled while checking or invalid. Color changes reuse results; obsolete workers are terminated and completed geometry results are bounded to 24 cached entries.

`validation.mjs` is shared by that worker and server preparation. Preparation validates geometry before expensive visual solid generation. Diagnostics distinguish disconnected assemblies, collider failures and invalid dimensions, include exact preset recovery values, and identify preset failures as generation issues. The server relays structured worker diagnostics while retaining stack traces only in logs, and logs failed configurations for reproducibility. Unknown process failures no longer blame dimensions.

Verification: the Sprint preset passed the full shared audit and a fresh uncached server preparation (226 groups, 461 shapes, 766 joints). Browser slider edits automatically disabled/re-enabled preparation; the current preset displays “Physical connections checked.” The live 5563 backend returned a specific track-width error with HTTP 422 for an invalid request and successfully prepared the preset. Three shared validation tests, eleven related configuration/shape/strength tests, two server asset tests and TypeScript checking passed.

### Garage → shared city (2026-09-25)

Choose **Send to city**, then **Open city beside your vehicle**, join, and press
**E**. `POST /vehicle-assets/city` reuses the private-drive preparation helper
and adds a real Vehicle2 through the `city-default` simulation event loop.
The six drivable models use the same Simple colliders, authoritative inputs,
asset metadata, wheel-rig packets, and detailed client renderer as private
sessions. Existing clients receive the new asset; later joins receive every
custom vehicle's metadata before snapshots. No separate city vehicle renderer
or physics recipe is introduced.

The city accepts up to eight custom configurations in checked parking spaces
outside its spawn ring. Repeating an identical configuration returns its existing
car and current position. Vehicles last for the city process lifetime. The
arrival link includes the server-returned parking position so a distant car
outside snapshot interest can be reached before its first snapshot. Once visible,
the live car position takes precedence. Arrival reuses the city's validated
camera-drop command. `VIBE_CITY_VEHICLES=0` disables publication too.

Local verification on port 5563: the browser prepared/published the default buggy,
joined the actual city over WebTransport, arrived facing its detailed model, and
entered/exited the server-confirmed vehicle. A fresh join received its asset
metadata. Two identical HTTP publications reused vehicle 20000 and preserved the
configuration. Three stream tests, two garage server tests, server check/build,
TypeScript checking, and the local GPU handbrake regression passed. The latter
now also creates a 2,500 kg prepared vehicle after simulation has started and
uses the city's split dispatch/fetch path: it accelerated to 15.4 m/s, stopped
with W+Space, and accelerated again after release. Browser key taps verified
entry/exit; sustained driving was covered by the native regression. No Vast/CUDA
validation was run. Vehicles remain rigid while native destruction integration
is incomplete; this handoff does not qualify their stress bonds.
