# Native vehicle operator revisions and exact-zero regression

Local CuMetal functional evidence, 2026-09-26. Both focused GPU targets pass.
This is a prerequisite for moving suspension geometry, not completed live
vehicle destruction. No installed SDK, garage/city service, or previous
qualified runtime overlay was replaced. No Vast/CUDA run was performed.

## Changes

PhysX `0d3d14ae` keys geometry-dependent solver caches to the existing operator
rebuild counter. Physical fracture connectivity retains its own generation.
This allows a future geometry update to rebuild calculations without inventing
a fracture or resetting broken-bond health. No public structure layout changed.

The expanded checks exposed a pre-existing exact-zero bug: Metal's float
comparison treats stored subnormals as zero. PhysX `8d82c580` checks the IEEE
bits, masking the sign of zero, so a nonzero load cannot use the zero-load
shortcut. It preserves forces, strengths and convergence criteria.

## Evidence

| Check | Result |
| --- | --- |
| Status/cache revision readiness | 6 GPU cases pass with deliberately different physical/operator IDs |
| Inverse cache lifetime | 6 cold/unknown/stale/cut/repeated-cut cases pass |
| Rigid inverse oracle | 771 blocks pass; maximum scaled error 4.4408921e-15 |
| Exact-zero input classification | 72 cases pass across all six wrench components, including subnormals, signed zero and nonfinite values |
| Warm retirement | All 18 block/cooperative cases pass |
| Solver integration | 12-node/9-bond analytic column and two 64-node/62-bond fixtures pass |

The integration checks cover skipped connectivity generations 17/41/90,
repeat-update no-ops, zero forces on removed bonds, changed loads, preserved
unaffected components, bit-exact settled reuse, one-ULP/settings/cold-state
invalidation, partial splits, and refusal to cache unconverged results. The
analytic column relative error is 5.29819e-7. The deliberately iteration-limited
nonconvergence cases in the log are expected negative controls.

[Final direct checks](focused-after-zero-fix.log),
[final integration checks](integration-after-zero-fix.log),
[successful build](build-after-zero-fix.log), and
[CTest registration](ctest-inventory.log) preserve the results. Both processes
exited 0. [Environment and artifact hashes](environment.json) records the exact
local configuration and hashes captured after the runs.

The [original failure](focused-before-zero-fix.log),
[pre-fix integration pass](integration-before-zero-fix.log), and independent
[six-value GPU probe](float-zero-probe.log) remain recorded. The probe
[source](float-zero-probe.cu) demonstrates that the input bits survived while
the floating comparison returned zero.

## Reproduction and limits

With the isolated package build configured using the options in environment.json:

```sh
cmake --build /Users/glavin/Development/PhysX/out/build/garage-multihull/package \
  --target gpu_resident_stress_test gpu_resident_operator_epoch_test -j4
CUMETAL_USE_METAL_DEVICE_ADDRESSES=1 CUMETAL_SYNC_EACH_LAUNCH=0 \
  ctest --test-dir /Users/glavin/Development/PhysX/out/build/garage-multihull/package \
  -R operator_epoch --output-on-failure -j1
```

GPU tests ran sequentially. Initial integration startup spent minutes compiling
Metal pipelines; that wait is not physical solve time or performance evidence.
The full motion-mode suite remains unqualified on CuMetal because a legacy
dense-reference helper fails pointer lowering; its
[build failure](full-motion-suite-build-failure.log) is retained. The new focused
target preserves all assertions on the changed production paths. Its triangular
oracle runs independently from mutable cache updates.

Still outstanding: native moving geometry/mass/momentum updates; full-model
normal-road endurance; rerunning complete fracture qualification against a
rebuilt runtime; frozen penetration and performance; fragment streaming/reset;
and garage bombardment plus city/browser integration. Earlier nominal wheel
shot failures on buggy/sprint are not resolved or waived by this change.

Goal audit: progress. This turn added and verified a geometry-cache prerequisite
and corrected a GPU-discovered exact-zero defect. The overall vehicle-destruction
goal remains active; this report is not a completion claim.
