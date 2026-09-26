# Native constraint load routing — local functional evidence

Checkpoints before this work: Vibeland `352f9221`, PhysX `ab88dd85`.
The isolated `PhysX/out/build/garage-multihull` engine is being extended; the
installed ABI-18 engine and running garage have not been upgraded by this work.

## Tests that exposed bugs

`native_constraint_loads_test` holds two one-kilogram chunks with one locked
world joint. Both attachment sides, two actor orientations and PGS/TGS are
covered (eight cases). It checks native GPU writeback routing, unloaded
neighbors, force/torque expiry when rows disappear, malformed registrations,
and an independent static weight and moment balance across the connecting bond.

The first independent moment oracle failed by 19.62 N m because standard
joints report torque about the anchor, while Vehicle2 reports about the COM.
The descriptor now specifies this origin. The bond-force oracle then caught
the stress operator's angular convention: its null mode uses `r cross angular`,
so physical torque needs negation for the solver's angular input. Surface
wrenches and rigid-body command replay remain in ordinary physical coordinates.
The same conversion also fixes explicitly apportioned chunk torque commands.
Raw failing and passing logs are kept beside this report.

All eight routing cases pass. Existing multi-hull fracture, localized command
apportionment (including rotated/moving bodies and intentional mismatch
rejection), parallel bond strength, post-correction support, and four CPU/GPU
Vehicle2 corner accounting cases also pass. The command mismatch case is an
intentional rejected input, not a passing physics advance.

## Native constraint fracture results

PhysX commit `7b59b7d8` contains the implementation and tests.
The matching public ABI-22 / private V15 engine passes the eleven targets in
[the final report](final/report.json); [verbose results](final/native-tests.log)
include individual cases. The runtime remains isolated and is not installed
into the garage server.

`native_constraint_fracture_test` uses the existing Vehicle2 suspension shader.
Sixteen cases cover PGS/TGS, both carrier pieces (including migration to a new
actor), two orientations and retained/disconnected attachment states. The
same corrected step must produce the independently expected fragment momentum,
zero angular velocity after COM rebasing, and zero constraint force for a
separated attachment. Eight subsequent ticks deliberately keep its input shader
active: native disconnection must remain authoritative. Cleanup restores links
before fragment actors are released. An unregistered constraint still blocks a
split; built-in anchor-based GPU joints are excluded from world-row replay.

Two additional physical cannonball cases run 60 intact idle and 90 impact
steps with three chunks, two bonds and one sphere projectile. Each breaks only
the weaker targeted interface, preserves its stronger neighbor, disables the
separated suspension constraint in the impact step, and retains support from
the connected corner. These are small engine fixtures, not a full garage car.
Torque-only cases verify that rotational commands go to the loaded fragment,
including a rotated source; they are not copied onto its unloaded neighbor.

The GPU selects carrier ownership and connectivity. The existing CPU scene
registry observes only target body IDs and enabled bits. Corrected Jacobians
are recentered from their recorded original COM to the GPU fragment COM during
solver preparation. Public mutation guards remain intact. Registration is for
fixed world-space CPU shaders with no second actor and no independent break
force; general joints, articulations and changing shader inputs are not covered.
The stress solver's angular coordinates have opposite sign to physical angular
acceleration. Surface wrenches and rigid motion retain physical conventions.

Reproduce from Vibeland using an already configured isolated build:

```sh
python3 scripts/verify-vehicle-native-fracture.py \
  --physx-root ../PhysX \
  --build-root ../PhysX/out/build/garage-multihull \
  --output /tmp/vehicle-native-fracture-review
```

The tool rejects missing tests, failed commands and binaries changed during the
run. It saves exact commands, test inventory, logs and executable/runtime hashes.
An existing output directory is rejected rather than overwritten.

## Remaining integration and qualification

The garage still uses the installed ABI-18 SDK and its intact compound car.
Full vehicle adoption, moving wheel collision groups, mass/COM/inertia updates
in the driving model, engine/drive connectivity, detached visual streaming and
reset are not implemented by this change. The full-vehicle impact gate remains
strict and must not be replaced with these smaller passing tests.

No CUDA/Vast or isolated performance qualification is claimed. The frozen RTX
wall-penetration audit is deferred with remote validation; its current harness
requires Linux `/proc` and `.so` module capture. The local correction and driving
regressions pass, but they do not substitute for that audit. Real asset bond
strengths still require normal-driving and targeted-impact calibration.
