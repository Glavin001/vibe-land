# Full vehicle native stress failure: regression before correction

The new `authored_vehicle_native_registration_and_free_fall` test cooks and
registers complete authored models through the same Vehicle2 descriptor used by
live driving. It requires all six drivable base models, each with 30 converged
GPU steps, no broken bonds, real downward motion and intact hull ownership.
It currently **fails on the first buggy step**. This is not a passing vehicle
destruction qualification. The test is explicitly ignored unless a coherent
ABI 22 GPU SDK and prepared fixture manifest are provided.

The buggy has 190 chunks, 384 hulls and 626 measured bonds. With no terrain or
projectiles, the first free-fall step returns scene error 64 (stress hierarchy).
The original detailed stress error was 8. An isolated runtime diagnostic now
preserves the nested error instead of discarding it: `0x02100008` means the
motion-mode construction reported error 16 and did not initialize; the other
hierarchy error is zero. Error 16 is the motion forest's exact-sum rejection.

The six-chunk bridge regression `native_vehicle_accepts_small_authored_com_offsets`
reproduces the failure with an engine COM x-coordinate of `1e-18 m`. The existing
fixture with that coordinate exactly zero passed. The test intentionally does
not snap the COM to zero. Complete mesh integration can produce valid small
components near nominal symmetry planes; combining those with metre-scale
positions must not make an otherwise valid physical graph unrepresentable.

Both failures remain red pending an arithmetic correction. The diagnostics
do not change physics, solver tolerances, iteration limits, geometry, mass,
strengths or graph connectivity. The bridge only reads the detailed error on
failed frames; healthy frames add no readback. ABI 18 compilation still passes.

- [Full-model failure](full-model-red.log)
- [Nested native diagnostic](full-model-detail.log)
- [Minimal reproduction](minimal-red.log)
- [Machine-readable status and diagnostic library hashes](report.json)

Reproduce against the unchanged isolated SDK:

```sh
PHYSX_ROOT=/tmp/vehicle-fracture-sdk22 \
CARGO_TARGET_DIR=/tmp/vibe-vehicle-abi22-target \
CUMETAL_USE_METAL_DEVICE_ADDRESSES=1 CUMETAL_SYNC_EACH_LAUNCH=0 \
cargo test -p vibe-land-physx-bridge --features native-destruction \
  --test native_vehicle_fracture native_vehicle_accepts_small_authored_com_offsets \
  -- --ignored --nocapture --test-threads=1
```

For the complete model, use the server binary with filter
`authored_vehicle_native_registration_and_free_fall` and
`VIBE_VEHICLE_BUILD_FIXTURES=/tmp/vehicle-functional-build-fixtures.json`.
The native diagnostic libraries are separate from the frozen SDK at
`/tmp/vehicle-hierarchy-diagnostic-libs`; `DYLD_LIBRARY_PATH` selects that overlay.
The installed live SDK has not been changed. No remote CUDA run was performed.
