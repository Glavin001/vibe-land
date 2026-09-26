# Wheel colliders on fixed stress geometry

Design, as agreed on 2026-09-26:
- Chunks are rigid, and the stress solver keeps its rest-pose chunk frames and bonds.
- Only the wheel and hub collision hulls follow the suspension, so hits match the rendered wheel.
- A part that breaks off starts from its visible pose.

## Step 1: trim the moving-stress-geometry layer

**Branches**
- Archived state: vibe-land `vehicle/posed-geometry-archive` (`8aef12a9`), PhysX `vehicle/moving-stress-geometry-archive` (`534a1e3b`).
- Work continues on `vehicle/wheel-colliders` in both repos.

**PhysX**
- Removed `ExtStressGpuUpdateDeviceGeometry`. The solver is byte-identical to the state before `d82b4da7`.
- Kept the angular-convention finding as a standalone `blast_stress_gpu_angular_convention` test.
- The operator-epoch suites and the new test pass on local CuMetal FP64 (`physx-revert-gpu.log`). A direct run of the epoch integration binary reproduces its documented analytic column error, 5.29819e-7.

**vibe-land, removed**
- `transformMassProperties`
- `posed.rs`: posed chunk mass and bonds, and `rebase_momentum`
- the per-solid `visuals` asset export
- the six-model posed-mass test

**vibe-land, changed**
- Every rig motion is now rigid. The coil-over rides with its damper about the top mount, and the drive shaft is carried rigidly and spun, so its CV plunge is not modelled: a detached shaft can start up to 182 mm from its rendered position.
- The rig golden now records pose deltas only and no longer needs prepared assets.

**Checks**
- Recipe `vehicle-physics-rig-7`: all 11 builds prepare (`build-verification.log`).
- Against the previously qualified `posed-6` assets, every part (excluding `visuals`), every bond, the rig, the mass and the driving setup are identical on all 11 builds. The anchored-graph impact re-qualification therefore still applies.
- 86 client vehicle tests pass, TypeScript compiles, and 15 Rust `vehicle_assets` tests pass, including the authored-fixture layout check.
