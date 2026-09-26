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

## Step 2: moving wheel colliders on a road (local CuMetal FP64; isolated SDK and overlay)

**Test.** `authored_vehicle_wheel_colliders_follow_suspension`:
- Each of the six models is spawned 15 cm above a road.
- It settles for 60 ticks, then drives with throttle and steering for 240 ticks.
- The wheel and hub hulls are posed each step from the previous step's Vehicle2 wheels, through the Rust rig (`native_pose_vehicle_parts`).
- Variants: `rest` (fixed hulls, as today), `posed+road`, and `posed-road` (posed hulls excluded from terrain only).

**Findings (`experiment-1-road-mask.*`)**
- **Rest hulls fight Vehicle2.** On buggy and sprint, the fixed tyre hulls stand on the road (7,678 destructible contacts). Mean jounce is 0.046 against a neutral 0.074 on buggy, and 0.037 against 0.065 on sprint: the hulls carry part of the car's weight.
- **Posed hulls touching the road are worse.** They reach down at full droop and take the landing rigidly. Buggy broke a frame bond at tick 3; sprint broke three bonds at tick 4.
- **Posed hulls excluded from the road are correct for driving.** Buggy and sprint drive 300 ticks with zero damage and zero wheel-to-road contacts. Jounce matches neutral (0.07377 against 0.07371, 0.06518 against 0.06515).
- **The exclusion must cover terrain only.** Excluding Vehicle2's whole road mask also let the test cannonball, a dynamic body, pass through the wheel. Scene-query rays still hit, because they ignore simulation filters. With terrain-only exclusion (`experiment-2-terrain-only.json`), the severe shot detaches the targeted wheel on tick 0 on both models.
- **Most models can't sit on a road.** Trophy, rally, monster and derby break 2–10 body-panel/frame bonds within their first 0–8 ticks of settling, in every variant, including road-excluded hulls. So it's Vehicle2's suspension/road loads, not the colliders. Monster breaks on tick 0. Every full-model test until now ran in the air, so this operating-load durability failure was never exercised.

**Separation (`experiment-3-separation.*`)**
- The severed tyre is a one-chunk fragment.
- Buggy's loose tyre stays above the road (minimum height 0.14 m).
- Sprint's dipped to −0.06 m and then ended 47 m up after 10 s. The likely cause is one step of terrain exclusion after migration, followed by a depenetration launch: the filter is currently restored at the next `prepare_vehicles`, not at migration.
- Separation pop and the fragment's mass-frame offset are **not yet measured validly**. The chunk-aim point is the chunk's first convex piece, not the wheel centre, and the violent shot's in-tick impulse dominates the velocity estimate.

**Launch pitfall found.** `DYLD_LIBRARY_PATH` set in front of `scripts/perf/gpu-run.sh` is stripped by macOS SIP when `/bin/bash` starts. The tests then load the SDK's default single-precision runtime and fail on tick 0 (hierarchy error 8, non-converged). Pass it inside the wrapper (`gpu-run.sh label env DYLD_LIBRARY_PATH=... cargo ...`), as the Python verifier does. This cost a bisection: the archived commit failed identically when launched the same way.
