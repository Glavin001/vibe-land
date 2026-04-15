# Vehicle Netcode Handoff - 2026-04-15

## Executive Summary

The current branch is `fix/vehicle-netcode-clean`. The WIP is **not ready for player QA**. The multiplayer `/play` vehicle still fails automated QA and still matches the user-visible symptom: local driver vehicle jitter/rubber-banding while driving straight on the default terrain.

The strongest current conclusion is:

- `/practice` feels good because it is effectively a single-authority/local path for the local vehicle.
- `/play` is bad because the local driver uses prediction, server snapshots, ack/reconcile, and a smoothed render pose. Any disagreement or abrupt contact change is amplified into visible correction/jitter.
- The remaining issue is not proven to be purely Rapier raycast instability. It is more likely the multiplayer prediction/reconciliation/render loop failing to stay coherent under vehicle contact churn.
- The current WIP also contains one gameplay-feel regression: a new vehicle speed limiter. That likely explains the user report that the car is slower and no longer jumps ramps as before. This should probably be reverted or raised substantially.

This document is intended as a handoff for the next engineer. It includes exact data, targets, changed files, what worked, what failed, and recommended next steps.

## Current WIP Scope

`git diff --stat` currently reports:

```text
32 files changed, 4110 insertions(+), 223 deletions(-)
```

Main changed areas:

```text
client/benchmark.ts
client/src/App.tsx
client/src/benchmark/contracts.ts
client/src/benchmark/defaultSuite.ts
client/src/benchmark/vehicleAccumulator.ts
client/src/benchmark/worldPresets.ts
client/src/loadtest/scenario.ts
client/src/net/netcodeClient.ts
client/src/net/webTransportClient.ts
client/src/physics/usePrediction.ts
client/src/physics/vehiclePredictionManager.ts
client/src/scene/GameWorld.tsx
client/src/scene/vehicleLocalMeshPose.ts
client/src/scene/vehicleVisualGeometry.ts
client/src/ui/DebugOverlay.tsx
client/src/ui/useDebugStats.ts
client/src/wasm/sharedPhysics.ts
client/src/world/worldDocument.ts
netcode/src/sim_world.rs
server/src/demo_world.rs
server/src/main.rs
server/src/movement.rs
shared/src/local_arena.rs
shared/src/local_session.rs
shared/src/movement.rs
shared/src/vehicle.rs
shared/src/wasm_api.rs
shared/src/world_document.rs
```

New untracked test/support files:

```text
client/src/benchmark/defaultSuite.test.ts
client/src/benchmark/vehicleAccumulator.test.ts
client/src/benchmark/vehicleAccumulator.ts
client/src/benchmark/worldPresets.test.ts
client/src/benchmark/worldPresets.ts
client/src/world/worldDocument.test.ts
logs/
```

## User-Observed Failure Data

The key user-provided latest log was:

```text
logs/driving-april15-4:44.md
```

Important metrics from that log:

```text
path: /play
fps: 53
vehicle_pending_inputs: 4
vehicle_ack_backlog_ms: 66.67
vehicle_replay_error_m: 0.001
vehicle_pos_error_m: 0.846
vehicle_current_auth_delta_m: 0.632
vehicle_current_auth_unexplained_delta_m: 0.214
vehicle_expected_lead_m: 0.846
vehicle_straight_jitter_rms_5s_m: 0.031
vehicle_raw_heave_delta_rms_5s_m: 0.060
vehicle_raw_planar_delta_rms_5s_m: 0.389
vehicle_residual_planar_delta_rms_5s_m: 0.218
vehicle_residual_heave_delta_rms_5s_m: 0.037
vehicle_wheel_contact_bit_changes_5s: 13
vehicle_grounded_transitions_5s: 13
vehicle_suspension_force_delta_rms_5s_n: 3452.0
vehicle_wheel_contact_normal_delta_rms_5s_rad: 0.045
vehicle_local_speed_ms: 12.652
vehicle_server_speed_ms: 12.694
```

Interpretation:

- Server/client speed agreement was good in this sample: `12.652` vs `12.694 m/s`.
- Input backlog was not catastrophic: `4` inputs, `66.67ms`.
- The visible issue still had measurable contributors: residual planar motion `0.218m RMS`, raw planar motion `0.389m RMS`, and `13` wheel/contact transitions in 5 seconds.

Earlier user logs showed more severe backlog/rubber-banding before catch-up changes:

```text
vehicle_pending_inputs: 100
vehicle_ack_seq: 1546
vehicle_replay_error_m: 0.250
vehicle_pos_error_m: 0.979
vehicle_rot_error_rad: 0.483
vehicle_current_auth_delta_m: about 1m in later diagnostics
```

And earlier severe `/play` examples included:

```text
vehicle_pending_inputs: 28
vehicle_replay_error_m: 0.565
vehicle_pos_error_m: 3.891
vehicle_vel_error_ms: 11.602
vehicle_rot_error_rad: 0.526
vehicle_corr_peak_5s_m: 3.277
vehicle_local_speed_ms: 3.397
vehicle_server_speed_ms: 14.364
```

The backlog issue improved, but the local-driver visual jitter did not fully resolve.

## Automated QA Targets

These thresholds were added to `client/benchmark.ts` for vehicle play workers. They are intentionally strict so the benchmark catches what the user can see.

| Metric | Warn | Fail | Meaning |
| --- | ---: | ---: | --- |
| `vehicleBenchmarkSamples` | 8 | 1 | Enough post-settle samples must exist |
| `vehicleMaxSpeedMs` | 8 m/s | 4 m/s | Vehicle benchmark must actually drive |
| `vehicleCurrentAuthDeltaM` | 0.10 m | 0.20 m | Predicted current pose vs current auth |
| `vehicleMeshCurrentAuthDeltaM` | 0.08 m | 0.15 m | Render mesh vs current auth |
| `vehicleCurrentAuthUnexplainedDeltaM` | 0.20 m | 0.35 m | Delta remaining after expected network lead |
| `vehicleRestJitterRms5sM` | 0.02 m | 0.03 m | Visual jitter while near rest |
| `vehicleStraightJitterRms5sM` | 0.05 m | 0.08 m | Local vehicle mesh offset while straight driving |
| `vehicleRawHeaveDeltaRms5sM` | 0.02 m | 0.03 m | Frame-to-frame vertical body movement |
| `vehicleRawPitchDeltaRms5sRad` | 0.02 rad | 0.04 rad | Raw pitch jitter |
| `vehicleRawRollDeltaRms5sRad` | 0.02 rad | 0.04 rad | Raw roll jitter |
| `vehicleResidualPlanarDeltaRms5sM` | 0.08 m | 0.14 m | Motion unexplained by velocity integration |
| `vehicleResidualHeaveDeltaRms5sM` | 0.05 m | 0.09 m | Vertical motion unexplained by velocity integration |
| `vehicleResidualYawDeltaRms5sRad` | 0.02 rad | 0.04 rad | Yaw motion unexplained by angular velocity |
| `vehicleWheelContactBitChanges5s` | 10 | 16 | Wheel contact bit churn |
| `vehicleGroundedTransitions5s` | 8 | 12 | Grounded wheel count churn |
| `vehicleSuspensionLengthDeltaRms5sM` | 0.02 m | 0.04 m | Suspension length churn |
| `vehicleSuspensionForceDeltaRms5sN` | 2500 N | 5000 N | Suspension force churn |
| `vehicleWheelContactNormalDeltaRms5sRad` | 0.04 rad | 0.08 rad | Contact normal flicker |
| `vehicleWheelGroundObjectSwitches5s` | 1 | 3 | Raycasts switching ground object |
| `vehicleAckBacklogMs` | 100 ms | 150 ms | Local vehicle unacked replay backlog |
| `vehiclePendingInputs` | 6 | 8 | Client local vehicle pending inputs |

Important: some current benchmark metrics are imperfect:

- `vehicleExpectedLeadM` in the final JSON currently records the final debug value, not the accumulated peak/representative value. This makes final reports understate expected lead in some runs.
- `vehicleMeshFrameDeltaRms5sM` and `vehicleCameraFrameDeltaRms5sM` include legitimate forward motion, so they are useful trend metrics but not direct fail criteria.
- The isolated flat/bumps scenarios currently do not drive correctly, so they cannot yet validate actual vehicle motion.

## Benchmark Results

### 2026-04-15T21:43:13 - Flat Scenario Before World Preset Fix

File:

```text
client/benchmark-results/2026-04-15T21-43-13-705Z-vehicle-qa.json
```

This run was invalid as a driving QA gate because world/client alignment was still wrong and max speed was low:

```text
scenario: flat_vehicle_straight_fast_1
verdict: fail
vehicleMaxSpeedMs: 3.959
vehiclePendingInputs: 12
vehicleAckBacklogMs: 200.000
vehicleCurrentAuthDeltaM: 0.402
vehicleCurrentAuthUnexplainedDeltaM: 0.402
vehicleRawHeaveDeltaRms5sM: 0.091
vehicleResidualHeaveDeltaRms5sM: 0.197
vehicleWheelContactBitChanges5s: 0
vehicleGroundedTransitions5s: 0
```

### 2026-04-15T21:51:36 - Flat Scenario After World Preset Fix

File:

```text
client/benchmark-results/2026-04-15T21-51-36-562Z-vehicle-qa.json
```

This run showed the flat scenario was stable but not driving:

```text
scenario: flat_vehicle_straight_fast_1
verdict: fail
vehicleMaxSpeedMs: 0.000000053
vehiclePendingInputs: 8
vehicleAckBacklogMs: 133.333
vehicleCurrentAuthDeltaM: 0.000354
vehicleCurrentAuthUnexplainedDeltaM: 0.000354
vehicleRawHeaveDeltaRms5sM: 0.000001
vehicleResidualPlanarDeltaRms5sM: 0.000001
vehicleWheelContactBitChanges5s: 0
vehicleGroundedTransitions5s: 0
```

Conclusion: the isolated flat benchmark is not currently useful because it fails to accelerate. Fixing this is a high-priority QA harness task.

### 2026-04-15T21:52:41 - Default Terrain Baseline Before Duplicate Vehicle Strip

File:

```text
client/benchmark-results/2026-04-15T21-52-41-119Z-vehicle-qa.json
```

```text
scenario: terrain_vehicle_straight_1
verdict: fail
vehicleMaxSpeedMs: 20.400
vehiclePendingInputs: 10
vehicleAckBacklogMs: 166.667
vehicleCurrentAuthDeltaM: 2.715
vehicleMeshCurrentAuthDeltaM: 2.715
vehicleCurrentAuthUnexplainedDeltaM: 0.687
vehicleStraightJitterRms5sM: 0.228
vehicleRawHeaveDeltaRms5sM: 0.365
vehicleRawPlanarDeltaRms5sM: 1.129
vehicleResidualPlanarDeltaRms5sM: 0.563
vehicleResidualHeaveDeltaRms5sM: 0.190
vehicleWheelContactBitChanges5s: 15
vehicleGroundedTransitions5s: 13
vehicleSuspensionForceDeltaRms5sN: 9296.892
vehicleWheelContactNormalDeltaRms5sRad: 0.117
```

This reproduces the jitter class. Targets missed:

```text
vehicleCurrentAuthDeltaM target <= 0.20, actual 2.715
vehicleCurrentAuthUnexplainedDeltaM target <= 0.35, actual 0.687
vehicleStraightJitterRms5sM target <= 0.08, actual 0.228
vehicleResidualPlanarDeltaRms5sM target <= 0.14, actual 0.563
vehicleSuspensionForceDeltaRms5sN target <= 5000, actual 9296.892
```

### 2026-04-15T21:55:52 - After Multiplayer Prediction World Vehicle Stripping

File:

```text
client/benchmark-results/2026-04-15T21-55-52-293Z-vehicle-qa.json
```

```text
scenario: terrain_vehicle_straight_1
verdict: fail
vehicleMaxSpeedMs: 19.822
vehiclePendingInputs: 12
vehicleAckBacklogMs: 200.000
vehicleCurrentAuthDeltaM: 3.177
vehicleMeshCurrentAuthDeltaM: 2.796
vehicleCurrentAuthUnexplainedDeltaM: 0.934
vehicleStraightJitterRms5sM: 0.170
vehicleRawHeaveDeltaRms5sM: 0.354
vehicleRawPlanarDeltaRms5sM: 0.945
vehicleResidualPlanarDeltaRms5sM: 0.500
vehicleResidualHeaveDeltaRms5sM: 0.195
vehicleWheelContactBitChanges5s: 33
vehicleGroundedTransitions5s: 33
vehicleSuspensionForceDeltaRms5sN: 6080.113
vehicleWheelContactNormalDeltaRms5sRad: 0.153
```

The duplicate authored-vehicle strip did not fix the issue. It may still be conceptually correct because server snapshots use runtime vehicle IDs and authored vehicle IDs can create ghost colliders in the client prediction world. However, this change alone did not reduce jitter.

### 2026-04-15T22:01:02 - After Client Backlog Collapse

File:

```text
client/benchmark-results/2026-04-15T22-01-02-613Z-vehicle-qa.json
```

```text
scenario: terrain_vehicle_straight_1
verdict: fail
vehicleMaxSpeedMs: 19.831
vehiclePendingInputs: 8
vehicleAckBacklogMs: 133.333
vehicleCurrentAuthDeltaM: 2.765
vehicleMeshCurrentAuthDeltaM: 2.612
vehicleCurrentAuthUnexplainedDeltaM: 0.881
vehicleStraightJitterRms5sM: 0.224
vehicleRawHeaveDeltaRms5sM: 0.508
vehicleRawPlanarDeltaRms5sM: 1.325
vehicleResidualPlanarDeltaRms5sM: 0.848
vehicleResidualHeaveDeltaRms5sM: 0.382
vehicleWheelContactBitChanges5s: 18
vehicleGroundedTransitions5s: 18
vehicleSuspensionForceDeltaRms5sN: 13042.825
vehicleWheelContactNormalDeltaRms5sRad: 0.130
```

This confirmed the backlog was bounded but the visible vehicle problem remained. The failure was not simply old queued inputs.

### 2026-04-15T22:05:24 - Bumps Scenario

File:

```text
client/benchmark-results/2026-04-15T22-05-24-469Z-vehicle-qa.json
```

This scenario was invalid because the vehicle did not drive:

```text
scenario: bumps_vehicle_straight_fast_1
verdict: fail
vehicleMaxSpeedMs: 0.000000073
vehiclePendingInputs: 7
vehicleAckBacklogMs: 116.667
vehicleCurrentAuthDeltaM: 0.000355
vehicleCurrentAuthUnexplainedDeltaM: 0.000355
vehicleWheelContactBitChanges5s: 0
vehicleGroundedTransitions5s: 0
```

Conclusion: fix isolated benchmark driving before using this as a physics-only proof.

### 2026-04-15T22:09:11 - Solver Iterations 2 to 6

File:

```text
client/benchmark-results/2026-04-15T22-09-11-914Z-vehicle-qa.json
```

Code change:

```text
netcode/src/sim_world.rs
num_solver_iterations: 2 -> 6
```

Result:

```text
scenario: terrain_vehicle_straight_1
verdict: fail
vehicleMaxSpeedMs: 20.549
vehiclePendingInputs: 8
vehicleAckBacklogMs: 133.333
vehicleCurrentAuthDeltaM: 2.565
vehicleMeshCurrentAuthDeltaM: 2.546
vehicleCurrentAuthUnexplainedDeltaM: 0.719
vehicleStraightJitterRms5sM: 0.217
vehicleRawHeaveDeltaRms5sM: 0.454
vehicleRawPlanarDeltaRms5sM: 1.435
vehicleResidualPlanarDeltaRms5sM: 0.943
vehicleResidualHeaveDeltaRms5sM: 0.309
vehicleWheelContactBitChanges5s: 32
vehicleGroundedTransitions5s: 32
vehicleSuspensionForceDeltaRms5sN: 7489.038
vehicleWheelContactNormalDeltaRms5sRad: 0.106
```

What improved:

```text
vehicleSuspensionForceDeltaRms5sN: 13042.825 -> 7489.038
vehicleCurrentAuthUnexplainedDeltaM: 0.881 -> 0.719
```

What got worse:

```text
vehicleWheelContactBitChanges5s: 18 -> 32
vehicleGroundedTransitions5s: 18 -> 32
vehicleResidualPlanarDeltaRms5sM: 0.848 -> 0.943
```

Conclusion: solver iterations alone are not the fix. They may still be worth keeping if profiling is acceptable, but this should not be considered solved.

### 2026-04-15T22:13:39 - Solver 6 plus Suspension 0.42/0.32

File:

```text
client/benchmark-results/2026-04-15T22-13-39-881Z-vehicle-qa.json
```

Code changes:

```text
VEHICLE_SUSPENSION_REST_LENGTH: 0.30 -> 0.42
VEHICLE_SUSPENSION_TRAVEL: 0.20 -> 0.32
client visual wheel rest length: 0.30 -> 0.42
```

Result:

```text
scenario: terrain_vehicle_straight_1
verdict: fail
vehicleMaxSpeedMs: 21.920
vehiclePendingInputs: 8
vehicleAckBacklogMs: 133.333
vehicleCurrentAuthDeltaM: 2.818
vehicleMeshCurrentAuthDeltaM: 2.570
vehicleCurrentAuthUnexplainedDeltaM: 0.595
vehicleStraightJitterRms5sM: 0.245
vehicleRawHeaveDeltaRms5sM: 0.438
vehicleRawPlanarDeltaRms5sM: 1.343
vehicleResidualPlanarDeltaRms5sM: 0.901
vehicleResidualHeaveDeltaRms5sM: 0.279
vehicleWheelContactBitChanges5s: 14
vehicleGroundedTransitions5s: 12
vehicleSuspensionForceDeltaRms5sN: 5526.416
vehicleWheelContactNormalDeltaRms5sRad: 0.315
```

What improved compared with `22:01:02`:

```text
vehicleCurrentAuthUnexplainedDeltaM: 0.881 -> 0.595
vehicleRawHeaveDeltaRms5sM: 0.508 -> 0.438
vehicleResidualHeaveDeltaRms5sM: 0.382 -> 0.279
vehicleWheelContactBitChanges5s: 18 -> 14
vehicleGroundedTransitions5s: 18 -> 12
vehicleSuspensionForceDeltaRms5sN: 13042.825 -> 5526.416
```

What is still failing:

```text
vehicleCurrentAuthDeltaM target <= 0.20, actual 2.818
vehicleMeshCurrentAuthDeltaM target <= 0.15, actual 2.570
vehicleCurrentAuthUnexplainedDeltaM target <= 0.35, actual 0.595
vehicleStraightJitterRms5sM target <= 0.08, actual 0.245
vehicleRawHeaveDeltaRms5sM target <= 0.03, actual 0.438
vehicleResidualPlanarDeltaRms5sM target <= 0.14, actual 0.901
vehicleResidualHeaveDeltaRms5sM target <= 0.09, actual 0.279
vehicleSuspensionForceDeltaRms5sN target <= 5000, actual 5526.416
vehicleWheelContactNormalDeltaRms5sRad target <= 0.08, actual 0.315
```

Conclusion: suspension 0.42/0.32 reduced some contact churn and force spikes but did not solve multiplayer jitter. It also changed visual wheel position and should be treated as experimental.

## Native Rust Guardrail Results

The important Rust guardrail is:

```text
cargo test -p vibe-land-shared world_document::tests::demo_world_straight_vehicle_drive_has_stable_contacts -- --nocapture
```

Before latest solver/suspension experiments, this test passed.

With solver iterations at `6` and suspension still `0.30/0.20`, it passed.

After changing suspension to `0.42/0.32`, it failed:

```text
straight drive lost contact on authored terrain:
max_speed=17.547m/s
min_grounded=1
grounded_transitions=12
contact_bit_changes=12
residual_planar_rms=0.001m
residual_heave_rms=0.001m
suspension_force_delta_rms=2623.9N
```

After trying suspension `0.55/0.45`, it failed worse:

```text
straight drive lost contact on authored terrain:
max_speed=17.321m/s
min_grounded=0
grounded_transitions=16
contact_bit_changes=16
residual_planar_rms=0.001m
residual_heave_rms=0.002m
suspension_force_delta_rms=2523.6N
```

Interpretation:

- Native-only residual motion was tiny (`0.001m` to `0.002m`), so native server-side vehicle motion itself was not producing large residual jumps in this test.
- Wheel contact retention was still poor after longer suspension.
- This points away from "pure server physics is exploding" and toward "multiplayer prediction/reconciliation/render path is amplifying or mismeasuring corrections."

## Changes Made and Recommended Disposition

### Keep or Likely Keep

#### Add vehicle observability in debug overlay

Files:

```text
client/src/scene/GameWorld.tsx
client/src/ui/useDebugStats.ts
client/src/ui/DebugOverlay.tsx
client/src/benchmark/contracts.ts
```

What was added:

```text
vehicle_predicted_frame_delta_m
vehicle_predicted_planar_delta_m
vehicle_predicted_heave_delta_m
vehicle_predicted_yaw_delta_rad
vehicle_predicted_pitch_delta_rad
vehicle_predicted_roll_delta_rad
vehicle_predicted_residual_planar_delta_m
vehicle_predicted_residual_heave_delta_m
vehicle_mesh_frame_delta_m
vehicle_camera_frame_delta_m
vehicle_wheel_contact_bits
vehicle_wheel_contact_bit_changes_5s
vehicle_wheel_contact_normals
vehicle_wheel_contact_normal_delta_rms_5s_rad
vehicle_wheel_ground_object_ids
vehicle_wheel_ground_object_switches_5s
vehicle_suspension_lengths_m
vehicle_suspension_forces_n
vehicle_suspension_length_delta_rms_5s_m
vehicle_suspension_force_delta_rms_5s_n
vehicle_grounded_transitions_5s
deep capture 10s table
```

Disposition: keep. This is the most useful part of the WIP. It made the bug measurable and should stay, though it may need performance gating if enabled constantly.

#### Add vehicle QA benchmark suite and accumulator

Files:

```text
client/src/benchmark/defaultSuite.ts
client/src/benchmark/vehicleAccumulator.ts
client/benchmark.ts
client/src/benchmark/defaultSuite.test.ts
client/src/benchmark/vehicleAccumulator.test.ts
```

Disposition: keep, but fix invalid isolated scenarios.

The terrain scenario reproduces the bug. The flat and bumps scenarios currently do not actually drive:

```text
flat max speed after preset fix: 0.000000053m/s
bumps max speed: 0.000000073m/s
target fail floor: 4.0m/s
```

This must be fixed before using flat/bumps as isolated proofs.

#### Add benchmark world presets

Files:

```text
client/src/benchmark/worldPresets.ts
server/src/demo_world.rs
```

Disposition: keep but fix why the browser vehicle does not accelerate in those scenarios.

#### Enable Rapier internal-edge flags

File:

```text
netcode/src/sim_world.rs
```

Changes:

```text
ColliderBuilder::heightfield_with_flags(..., HeightFieldFlags::FIX_INTERNAL_EDGES)
ColliderBuilder::trimesh_with_flags(..., TriMeshFlags::FIX_INTERNAL_EDGES)
```

Disposition: keep. This is a known Rapier/Parry stability flag and is opt-in. It did not solve the full issue alone, but it is likely correct.

#### Add shared vehicle debug snapshot from Rust/WASM

Files:

```text
shared/src/vehicle.rs
shared/src/wasm_api.rs
client/src/wasm/sharedPhysics.ts
```

Disposition: keep. This enables measuring suspension force, contact bits, normals, and ground object IDs from the same Rust/WASM vehicle controller state.

#### WebTransport latest-input datagram queue

File:

```text
client/src/net/webTransportClient.ts
```

Change:

```text
Added inputDatagramWriteInFlight
Added queuedInputDatagram
sendInputBundle now writes latest datagram only while a prior input datagram write is in flight
```

Disposition: likely keep. This prevents unbounded stale input datagram writes.

#### Server vehicle input catch-up

File:

```text
server/src/main.rs
```

Change:

```text
VEHICLE_INPUT_CATCHUP_THRESHOLD = 4
take_input_for_tick_with_vehicle_catchup(...)
clear_runtime_inputs_for_vehicle_entry(...)
```

Disposition: likely keep. This addressed the earlier severe backlog case where `vehicle_pending_inputs` could reach `100`. It does not solve the remaining jitter, but it prevents a known bad failure mode.

#### Client vehicle backlog collapse

Files:

```text
client/src/physics/vehiclePredictionManager.ts
shared/src/wasm_api.rs
client/src/wasm/sharedPhysics.ts
```

Change:

```text
VEHICLE_CLIENT_CATCHUP_THRESHOLD = 8
VEHICLE_CLIENT_CATCHUP_KEEP = 4
pruneVehiclePendingInputsThrough(ack_seq)
```

Disposition: likely keep, but verify carefully. It reduced the backlog to around:

```text
vehiclePendingInputs: 8
vehicleAckBacklogMs: 133.333
```

It did not solve jitter, so do not over-focus here.

#### Multiplayer prediction world strips authored vehicle entities

Files:

```text
client/src/world/worldDocument.ts
client/src/scene/GameWorld.tsx
client/src/world/worldDocument.test.ts
```

Change:

```text
removeVehicleEntitiesFromWorldDocument(...)
practice: load full world
multiplayer prediction: load terrain/props but strip authored vehicles before network-spawned vehicles are added
```

Disposition: likely keep, but confirm with a targeted test. The rationale is that server snapshots use runtime vehicle handles while authored world vehicles can otherwise create duplicate ghost vehicle colliders in client WASM.

### Experimental or Likely Revert

#### Vehicle speed limiter

Files:

```text
shared/src/movement.rs
shared/src/vehicle.rs
```

Change:

```text
VEHICLE_MAX_FORWARD_SPEED_MS = 18.0
VEHICLE_MAX_REVERSE_SPEED_MS = 9.0
VEHICLE_SPEED_LIMIT_SOFT_ZONE_MS = 4.0
limit_vehicle_engine_force(...)
```

Disposition: likely revert or raise substantially.

Reason:

- This directly changes vehicle gameplay feel.
- User reported the car is now slower and no longer jumps ramps like before.
- Earlier logs showed intended/observed speeds around `28-34m/s`.
- Current limiter cuts sustained engine force near `18m/s`.

Concrete evidence:

```text
Earlier user log: vehicle_local_speed_ms: 34.089, vehicle_server_speed_ms: 34.116
Current limiter: max forward speed constant: 18.0m/s
```

This is masking the bug by reducing speed/energy instead of solving coherence. It should not remain unless product explicitly wants slower vehicles.

#### Suspension constants 0.42/0.32

Files:

```text
shared/src/movement.rs
client/src/scene/vehicleVisualGeometry.ts
```

Change:

```text
VEHICLE_SUSPENSION_REST_LENGTH: 0.30 -> 0.42
VEHICLE_SUSPENSION_TRAVEL: 0.20 -> 0.32
visual wheel rest length: 0.30 -> 0.42
```

Disposition: experimental. Consider reverting to `0.30/0.20` until there is a better physics proof.

Pros:

```text
vehicleSuspensionForceDeltaRms5sN improved: 13042.825 -> 5526.416
vehicleWheelContactBitChanges5s improved: 18 -> 14
vehicleGroundedTransitions5s improved: 18 -> 12
```

Cons:

```text
Native guardrail failed at 0.42/0.32:
min_grounded=1
grounded_transitions=12
contact_bit_changes=12
```

It changes vehicle ride height/feel and did not solve `/play`.

#### Solver iterations 2 to 6

File:

```text
netcode/src/sim_world.rs
```

Disposition: investigate. It is plausible to keep, but not proven.

Pros:

```text
vehicleSuspensionForceDeltaRms5sN improved in one comparison: 13042.825 -> 7489.038
```

Cons:

```text
vehicleWheelContactBitChanges5s worsened: 18 -> 32
vehicleGroundedTransitions5s worsened: 18 -> 32
vehicleResidualPlanarDeltaRms5sM worsened: 0.848 -> 0.943
```

Also increases CPU cost. Current tick p95 stayed low:

```text
tickP95Ms: 1.198 before solver change
tickP95Ms: 1.596 after solver 6
fail threshold: 16.67
```

Performance is not currently a blocker, but behavior is not solved.

#### Local vehicle mesh smoothing/capping

File:

```text
client/src/scene/vehicleLocalMeshPose.ts
```

Changes:

```text
Removed snap solely due to groundedWheels < 2
Added multiplayer planar single-frame outlier cap
Added damped yaw/tilt/heave handling
```

Disposition: maybe keep, but do not rely on it as the fix. It is a visual mitigation, not root-cause correction. It should only stay if the underlying predicted/auth pose is within acceptable bounds.

Current evidence after smoothing:

```text
vehicleMeshCurrentAuthDeltaM still around 2.570m in latest failing terrain benchmark
target <= 0.15m
```

So smoothing is not sufficient.

## What Worked

### Reproducing the issue without manual QA

The `terrain_vehicle_straight_1` benchmark reliably fails with the same general symptom class.

Current latest failing run:

```text
client/benchmark-results/2026-04-15T22-13-39-881Z-vehicle-qa.json
```

Key values:

```text
vehicleMaxSpeedMs: 21.920
vehicleCurrentAuthDeltaM: 2.818
vehicleCurrentAuthUnexplainedDeltaM: 0.595
vehicleStraightJitterRms5sM: 0.245
vehicleRawHeaveDeltaRms5sM: 0.438
vehicleResidualPlanarDeltaRms5sM: 0.901
vehicleResidualHeaveDeltaRms5sM: 0.279
vehicleWheelContactBitChanges5s: 14
vehicleGroundedTransitions5s: 12
vehicleSuspensionForceDeltaRms5sN: 5526.416
```

This means the next engineer can iterate locally without asking the user to drive manually.

### Backlog catch-up reduced the old catastrophic pending-input failure

Earlier bad case:

```text
vehicle_pending_inputs: 100
```

Current benchmark after catch-up:

```text
vehiclePendingInputs: 8
vehicleAckBacklogMs: 133.333
```

This is still above warning thresholds, but it is no longer the primary catastrophic issue.

### Instrumentation now separates several contributors

The current debug data can differentiate:

```text
Input/replay backlog:
vehicle_pending_inputs
vehicle_ack_backlog_ms
vehicle_replay_error_m

Predicted/auth disagreement:
vehicle_current_auth_delta_m
vehicle_current_auth_unexplained_delta_m
vehicle_predicted_auth_delta_rms_5s_m

Physics/contact instability:
vehicle_wheel_contact_bit_changes_5s
vehicle_grounded_transitions_5s
vehicle_suspension_force_delta_rms_5s_n
vehicle_wheel_contact_normal_delta_rms_5s_rad

Visual smoothing:
vehicle_mesh_delta_m
vehicle_mesh_current_auth_delta_m
vehicle_straight_jitter_rms_5s_m
vehicle_mesh_frame_delta_rms_5s_m
```

## What Did Not Work

### Pure physics tuning did not solve `/play`

Solver 6 plus suspension 0.42/0.32 still failed:

```text
vehicleCurrentAuthDeltaM: 2.818, target <= 0.20
vehicleMeshCurrentAuthDeltaM: 2.570, target <= 0.15
vehicleCurrentAuthUnexplainedDeltaM: 0.595, target <= 0.35
vehicleResidualPlanarDeltaRms5sM: 0.901, target <= 0.14
```

### Isolated flat/bumps benchmark scenarios are not yet valid

They do not accelerate:

```text
flat max speed: 0.000000053m/s
bumps max speed: 0.000000073m/s
fail threshold: 4.0m/s
```

Until fixed, they cannot prove terrain-only or no-dynamic-body behavior.

### Slowing the vehicle is not an acceptable fix

The speed limiter likely reduced ramp/jump feel. It should be treated as a regression unless explicitly desired.

## Current Best Hypothesis

The remaining `/play` jitter is likely a coherence issue between:

```text
client predicted vehicle pose
server authoritative vehicle pose
client rollback/replay from acked snapshots
render mesh smoothing
camera smoothing
```

The shared physics can still diverge if:

```text
the client and server do not apply the exact same input at the exact same simulation tick
the client replays a different pending-input window than the server used
the client has different dynamic body/contact state around the vehicle
the authoritative snapshot is sampled/interpolated at a different pose time than the prediction assumes
the debug metric includes correction-frame movement as raw physics jitter
```

The fact that `/practice` feels good is important:

- It suggests the vehicle simulation is acceptable in a single-authority loop.
- It does not prove multiplayer prediction is coherent.
- `/practice` does not have server snapshots pulling the vehicle back 30 times/sec.

## Specific Gaps to Fix Next

### 1. Revert or disable speed limiter before further vehicle-feel testing

Suggested action:

```text
Remove limit_vehicle_engine_force(...)
Remove VEHICLE_MAX_FORWARD_SPEED_MS / VEHICLE_MAX_REVERSE_SPEED_MS / VEHICLE_SPEED_LIMIT_SOFT_ZONE_MS
or raise forward cap well above previous observed gameplay speed, e.g. > 35m/s
```

Reason:

```text
User observed car is slower.
Earlier logs showed 34m/s.
Current cap is 18m/s.
```

### 2. Fix flat and bumps benchmark driving

Required outcome:

```text
flat_vehicle_straight_fast_1 vehicleMaxSpeedMs >= 8m/s after settle
bumps_vehicle_straight_fast_1 vehicleMaxSpeedMs >= 8m/s after settle
```

Current:

```text
flat: 0.000000053m/s
bumps: 0.000000073m/s
```

This is probably benchmark enter/driver/vehicle ID setup, not physics, because default terrain benchmark does drive.

### 3. Add a deterministic multiplayer replay test

Need a test that simulates:

```text
server vehicle sim at 60Hz
client vehicle prediction at render cadence
snapshot cadence at 30Hz
ack delay around 2-8 frames
constant forward input
reconcileVehicle(...)
render mesh smoothing
```

It should output:

```text
max predicted-auth delta
max unexplained auth delta
correction count
correction reason: position, rotation, linear velocity, angular velocity
pending replay count at each correction
residual planar/heave during correction frames vs free-prediction frames
```

This is the missing proof. Native server-only tests are too optimistic.

### 4. Improve correction attribution

Add metrics:

```text
vehicle_correction_count_5s
vehicle_correction_reason_pos_count_5s
vehicle_correction_reason_rot_count_5s
vehicle_correction_reason_vel_count_5s
vehicle_correction_reason_angvel_count_5s
vehicle_replayed_inputs_on_last_reconcile
vehicle_replayed_inputs_peak_5s
vehicle_fixed_steps_this_frame
vehicle_render_frame_delta_ms
vehicle_residual_during_correction_rms_5s_m
vehicle_residual_without_correction_rms_5s_m
```

These would answer whether the "jitter" is:

```text
physics contact churn
server/client prediction disagreement
visual smoothing lag
camera follow lag
metric artifact from correction frames
```

### 5. Check player-in-vehicle KCC/collider interactions

In `/play`, while driving, the player snapshot follows the chassis and the player collider/prediction is mostly skipped. Need to verify:

```text
local player collider is not accidentally colliding with vehicle
server player collider is not affecting vehicle while driving
client prediction world does not retain stale player/vehicle collision state
enter/exit clears stale input and stale vehicle state
```

### 6. Check dynamic body divergence near vehicle

Default terrain benchmark includes many dynamic bodies:

```text
snapshot dynamic bodies per client p95: 50
snapshot bytes/client p95: 1095
```

Even though suspension raycasts filter to static terrain, chassis contacts can hit dynamic bodies. Need a metric for:

```text
vehicle_dynamic_contacts_count_5s
vehicle_dynamic_contact_impulse_rms_5s
vehicle_near_dynamic_body_count
```

If the default terrain benchmark is colliding with dynamic balls, client/server dynamic divergence could explain some corrections.

## Suggested Immediate Order for Next Engineer

1. Revert or neutralize the speed limiter.
2. Decide whether to revert suspension 0.42/0.32 to 0.30/0.20 while investigating. Current 0.42 improved some metrics but failed native contact guardrail.
3. Keep observability and benchmark infrastructure.
4. Fix flat/bumps benchmark so they actually drive.
5. Add deterministic multiplayer replay/reconcile test.
6. Only then tune physics or render smoothing, with before/after numbers.

## Useful Commands

Run the reproducing benchmark:

```bash
cd client
BENCHMARK_CLIENT_URL=http://127.0.0.1:3301 BENCHMARK_SERVER_HOST=127.0.0.1:4301 npm run benchmark -- --suite vehicle-qa --scenario terrain_vehicle_straight_1 --environment local --iterations 1 --headless
```

Run the native authored-terrain vehicle guardrail:

```bash
cargo test -p vibe-land-shared world_document::tests::demo_world_straight_vehicle_drive_has_stable_contacts -- --nocapture
```

Run focused client tests:

```bash
cd client
npx vitest run src/physics/vehiclePredictionManager.test.ts src/world/worldDocument.test.ts src/scene/vehicleLocalMeshPose.test.ts src/scene/vehicleVisualGeometry.test.ts src/benchmark/worldPresets.test.ts src/net/netcodeClient.test.ts src/benchmark/vehicleAccumulator.test.ts
```

Rebuild WASM after shared Rust changes:

```bash
cd client
npm run build:wasm
```

## Final State at Handoff

The WIP currently contains useful infrastructure and some risky experimental tuning. The most likely keepers are:

```text
debug/observability metrics
vehicle QA benchmark harness
HeightFieldFlags::FIX_INTERNAL_EDGES / TriMeshFlags::FIX_INTERNAL_EDGES
server/client backlog catch-up
local input datagram latest-only write queue
world stripping to avoid duplicate authored vehicles in multiplayer prediction
```

The most likely reverts or rework are:

```text
vehicle speed limiter at 18m/s
suspension rest/travel 0.42/0.32 unless proven
possibly solver iterations 6 if not useful after deterministic replay test
visual smoothing caps if they hide rather than fix divergence
```

Do not send this to human QA yet. The automated terrain vehicle scenario still fails with:

```text
vehicleCurrentAuthDeltaM: 2.818m, target <= 0.20m
vehicleCurrentAuthUnexplainedDeltaM: 0.595m, target <= 0.35m
vehicleStraightJitterRms5sM: 0.245m, target <= 0.08m
vehicleResidualPlanarDeltaRms5sM: 0.901m, target <= 0.14m
vehicleSuspensionForceDeltaRms5sN: 5526N, target <= 5000N
```

