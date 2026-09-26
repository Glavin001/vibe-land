# Mechanical interfaces and independent axle connectivity

Vibeland checkpoints `1417ef86` and `ed9bdbd3`; PhysX vehicle-wrapper checkpoint
`7a70e957`. These are foundations for vehicle destruction, not a completed live
garage or city integration.

## Mechanical graph

The shared geometry author now labels hubs, rotors and calipers. Structural
interfaces retain wheel-internal connections, hub/upright bearings, hub/axle
drive connections and caliper/upright mounts. Incidental wheel/arm, wheel/caliper,
rotor/upright and caliper/arm contacts are excluded from the bond graph. The
filter never creates a replacement joint across a gap. The remaining measured
interfaces must still connect the complete assembly.

All seven models pass clearance and mechanical topology checks (31 tests), and
all 11 driving builds prepare. The server's eight layout/conversion tests pass,
including reflected source-corner names and invalid/missing axle bindings.
TypeScript compilation and the 13 existing validation, exploded-view, grouping,
material and simple-physics regressions pass.

`graph-comparison.json` verifies that collision shapes, positions, mass tensors
and total assembly mass are identical to the preceding open-wheel assets.
Retained bond areas, centroids, normals and strengths are also identical. Only
attachment selection changes: the six base graphs lose 40/40/68/36/40/40 false
interfaces. Cache recipe `vehicle-physics-functional-3` prevents stale graphs
from being reused. This classification does not implement articulated bearing
compliance or moving chunk mass frames.

## Physical axle-loss proof

Vehicle2 now has an independent per-corner drive connection mask. Losing a shaft
removes that corner's throttle torque, while a surviving wheel retains rotation,
road queries, suspension, steering and braking. Physical wheel removal and
global engine disconnection remain separate gates. Live tuning applies before
the connectivity mask, so ordinary throttle multipliers cannot overwrite a
missing power path. That ordering is implemented; live tuning after axle loss
has not yet received its own physical regression.

The native bridge binds authored axle chunks to physical wheel indices and
derives drive connectivity from committed actor ownership. A new seven-chunk,
six-bond GPU fixture uses a real 300 kg projectile at 30 m/s, a positive initial
gap and a ray-verified shaft target. With the weaker attachment, exactly one
bond breaks. For 119 subsequent steps the wheel stays attached and coasts under
continued throttle, while another wheel continues accelerating. Applying the
brake then stops the shaftless wheel. A stronger-material control keeps the
shaft attached with no broken bonds. This is free fall, not a road-handling or
full-model qualification.

All **16 GPU bridge regressions pass**, with source and artifact integrity
checks: 13 native gameplay tests and three vehicle tests. The prior driving /
wheel-loss case and its stronger-material control still pass. See
`bridge-report.json` and `bridge-tests.log`. No complete-step performance,
frozen penetration, CUDA/Vast or browser qualification is claimed.

## Isolated SDK and full-model follow-up

The wrapper and matching native vehicle archive are in the derived SDK
`/tmp/vehicle-drive-mask-sdk22`. Its manifest records the wrapper source hashes;
the core ABI remains 22. GPU execution still selects the saved full-double,
authored-mass, convergence-rejection overlay. The original frozen SDK and live
ABI 18 install remain separate. Consumers are rebuilt for the added vehicle
state field and virtual method; the exact native patch is retained here.

The verifier now checks `PX_NATIVE_VEHICLE_DRIVE_MASK_VERSION 1` and hashes
packaged wrapper/snippet sources as well as libraries. Reproduce the bridge gate:

```sh
python3 scripts/verify-vehicle-bridge-fracture.py \
  --sdk /tmp/vehicle-drive-mask-sdk22 \
  --target-dir /tmp/vibe-vehicle-drive-mask-target \
  --runtime-overlay /tmp/vehicle-convergence-gate-libs \
  --output /tmp/new-drive-connectivity-verification
```

The complete authored-vehicle run uses the same command with
`--authored-fixtures /tmp/vehicle-mechanical-fixtures.json` and a new output
directory. The completed run is `/tmp/vehicle-mechanical-authored-verification`.
Its integrity checks pass, but the full-model qualification fails. Nominal shots
break 0/7/6/8/2/0 bonds on buggy/trophy/rally/monster/derby/sprint; heavy shots
break 29/49/59/39/43/34. Every impact completes 120 converged steps, yet none
detaches the targeted wheel. All six 30-step free-fall controls pass without
fracture. See `authored-report.json` and `authored-tests.log`; full per-frame raw
reports are retained locally with hashes in `authored-raw-evidence.json`.

The next attachment review is the distinction between a removable rim/tire
assembly and its rotating hub/rotor. The current coherent wheel combines all
of those, so wheel removal requires destroying the bearing/shaft connections.
Changing that grouping must preserve mass, collision geometry and visual
ownership, and must be verified with actual impacts rather than weakened
material constants. Full-model wheel loss, moving suspension, surviving road
handling, reset/append lifecycle, fragment streaming and garage/city gameplay
remain incomplete.
