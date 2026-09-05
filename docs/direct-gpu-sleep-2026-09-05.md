# Direct GPU and sleeping: measured decision, 2026-09-05

Direct GPU is a promising foundation, and replacing or extending sleeping is within the authorized scope. The target is to retain motion, contacts, structural loads and solver state on the GPU while making inactive bodies cheap. Stock Direct GPU alone does not deliver both properties. The evidence below supports pursuing GPU integration **with activity management**, not enabling the scene flag as a completed optimization.

The installed engine is PhysX **5.10.0**, on an RTX 4090 with driver 595.71.05 and CUDA 12.8.93. The dependency's bundled PhysX source is 5.6.1. The installed engine was not patched, and `/city` keeps its current native sleeping and freeze behavior.

## What the engine actually does

[NVIDIA's scene-flag documentation](https://nvidia-omniverse.github.io/PhysX/physx/latest/_api_build/structPxSceneFlag.html) requires `eDISABLE_SLEEPING` for `eENABLE_DIRECT_GPU_API`. Direct GPU suppresses ordinary motion readback; CPU actor motion getters cannot supply current state. The public device-write enum provides pose, velocity, force and torque operations, but no sleep/wake or kinematic-transition operation.

The source audit finds existing GPU sleep-energy/counter calculations, followed by CPU island bookkeeping. These are useful pieces to extend:

- `source/gpusolver/src/CUDA/integration.cuh`: `updateWakeCounter` computes sleep eligibility and emits flags/counters.
- `source/gpusolver/src/PxgSolverCore.cpp`: `gpuMemDMAbackSolverBodies` reads back motion and sleep data in ordinary mode; Direct GPU skips these copies.
- `source/gpusolver/src/PxgContext.cpp`: `PxgPostSolveWorkerTask` installs that data in CPU bodies; `doPostSolveTask` skips this path in Direct GPU. The GPU solve's body count comes from the CPU accurate island manager.
- `source/simulationcontroller/src/ScScene.cpp`: post-integration tasks propagate activation/deactivation into the CPU island manager. `ScSleep.cpp` and `ScPipeline.cpp` retire bodies and interactions.

Paths above are relative to the actual engine at `/root/PhysX/physx`, not the bundled source. Simply removing the scene-flag guard would leave stale CPU state and incomplete sleep transitions.

The benchmark also reproduced a **stock ordinary-GPU inconsistency**: `eDISABLE_SLEEPING` alone leaves resting bodies with `isSleeping() == false` but zero active rigid-body island nodes. The GPU sleep update still emits deactivation; the ordinary readback path can still deactivate island nodes. This is not an all-awake reference. The benchmark keeps it as a fourth diagnostic arm and uses a long wake counter for the actual awake control. That counter must be set after insertion because the disabled-sleep scene resets it when adding the actor. Direct GPU stayed fully active in this fixture and responded to device velocity writes after settling.

## Controlled activity comparison

Dependency commit `6913b92a` adds `demos/blast-stress-demo/tests/gpu_activity_bench.cpp`, an opt-in benchmark, without changing existing scene-helper defaults. It runs four configurations in rotated order, three trials each, with 4,096 independent unit cubes, identical masses/inertias, zero aerodynamic damping, TGS, stabilization, and a 1/60-second step. The existing scene filter requests normal contact reports; no application callback or contact decoder is measured.

Each trial creates fresh airborne and floor scenes. Airborne bodies warm up for 120 ticks, then measure 300 ticks in free fall. Floor bodies settle for 360 ticks, then measure 300 resting ticks. All floor bodies then receive an identical upward velocity of 10 m/s; 60 additional steps measure the mass wake. Every body's motion is validated after each interval. Ordinary scenes use CPU reads; Direct GPU uses device reads. Native rest must have all bodies sleeping and zero active dynamics; the awake control and Direct GPU must retain all 4,096 active dynamics. The flag-only diagnostic reports its actual count. Every body must lift after the wake command. This is a commanded mass wake, not collision-triggered wake propagation.

Timing covers synchronous `simulate` + `fetchResults`, with no logging, statistics reads or extra application copies between measured steps. Wake-command submission is timed separately and included when reporting the first wake tick below. Initialization and validation readback are excluded. The control uses a 3,600-second wake counter; the finite fixture lasts at most 12 seconds. No production threshold changes follow from that control.

| Configuration | Moving, mean / p99 ms | Resting, mean / p99 ms | 60-step wake interval, mean / p99 ms |
|---|---:|---:|---:|
| Ordinary GPU, native sleeping | 0.449 / 0.546 | 0.103 / 0.153 | 0.542 / 1.811 |
| Ordinary GPU, verified awake control | 0.450 / 0.537 | 0.439 / 0.587 | 0.503 / 1.557 |
| Direct GPU, all bodies active | 0.380 / 0.453 | 0.382 / 0.436 | 0.426 / 1.344 |
| Ordinary GPU, disable-sleep flag only (diagnostic) | 0.449 / 0.536 | 0.308 / 0.444 | 0.488 / 1.437 |

The three native-sleep first wake ticks cost **2.280, 2.185, 2.445 ms**, including command submission. Direct GPU cost **0.424, 0.417, 0.424 ms**, starting from bodies already active. These three events are not a tail-latency distribution. The table uses pooled nearest-rank p99: 900 moving/resting samples and 180 wake samples per arm. Trial means and raw frames are retained.

Direct GPU saved approximately **15.5%** of mean moving-step time against the verified awake control. Native sleeping made the resting step approximately **3.7 times cheaper** than stock Direct GPU. These differences include all behavior changed by the modes; they are not an isolated PCIe bandwidth measurement. Independent cubes do not establish a destruction, dense-pile, vehicle, or whole-city frontier. Stress, fracture, replay, gameplay queries and streaming are absent. No city-wide speedup is claimed.

Local artifacts: `bench-results/simulation-frontier/gpu-activity.csv`, `gpu-activity.log`, and `gpu-activity-summary.json`. CSV SHA-256: `cdab2487a5cb0e51fb7f0f72136bb9ea252bb943b3e63f70894291e37ad747fe`. Run exclusively on the GPU; this campaign paused only the healthy, idle, checkout-owned deployment and restored the same binary/environment afterward.

From the dependency checkout, using the existing PhysX 5.10 CMake configuration:

```sh
cmake --build demos/blast-stress-demo/build --target gpu_activity_bench -j8
./demos/blast-stress-demo/build/gpu_activity_bench 4096 3 > gpu-activity.csv 2> gpu-activity.log
```

## The implementation choice to test next

Start with a narrow engine extension that decouples bulk state readback from activity transitions. The GPU already computes sleep candidates; retain poses, velocities, contact wrenches and stress inputs on device, and export compact activity transitions to the existing CPU island manager where necessary. Read current motion only for transitions or CPU consumers that actually require it. This preserves more existing wake/contact behavior while testing the value of avoiding bulk transfers. Its design must cover commands on sleeping bodies and metadata updates that could otherwise upload stale CPU poses. It is a candidate, not an implemented or measured engine patch.

Compare that with fully GPU-owned activity: device activity flags and compact active-body/contact lists, GPU propagation through contact and support dependencies, and a sparse CPU topology boundary. Moving the low-speed test to a CUDA kernel alone will not save the expensive work. Dormant bodies must leave the solver and unnecessary contact processing, while keeping collision/query coverage so moving objects can discover and wake them. GPU candidate detection already exists; active-list ownership and correct wake propagation are the substantial missing parts.

For both designs, acceptance requires:

1. Quiet motion, stable support/load state and adequately converged stress before dormancy. Low speed at an apex or an unconverged stressed structure is insufficient. Sleeping dynamics must not erase gravity loads, bond damage or support dependencies. Keep physics activity, structural dirtiness and network dirtiness as distinct states with explicit transitions; one asleep bit cannot mean all three.
2. Wake on impact, force, player/vehicle interaction, joint changes, support removal and fracture, with dependency propagation. Wake before the contact solve, or use a validated same-tick replay that covers the event under the existing replay policy. A collider must not deliver an infinite-mass impact and then receive an unrelated delayed impulse as a substitute.
3. Checkpoint/rollback coverage for activity, stable identity/generation, support relationships and command ownership, including bodies created or removed by fracture. Observers and network output see the committed state only. CPU consumers must never silently read stale motion.
4. Separate sleeping, collision/query presence, structural dirty state and streaming relevance. A body outside one player's view is still authoritative physics if it can affect the world. Sleeping contacts need persistent support evidence even when they stop generating per-tick reports.
5. Matched full-city awake, mostly resting, dense-pile and mass-wake benchmarks, plus support-removal cascades, fast projectiles, vehicles, wake/rest cycles, and collision momentum checks. Compare whole-tick p99, backlog, active bodies/contacts, transfer bytes and physical outcomes at the same material/solver settings.

The existing game freeze path converts bodies to kinematic and uses CPU body snapshots plus native sleeping queries; its contact release applies a deferred impulse on a following tick. Those mechanisms need an explicit replacement or repair in a Direct GPU migration. Keeping colliders queryable and preserving finite-mass wake response are part of that work. Long-term freezing can remain an additional optimization if it satisfies the same support and wake contracts.

## Corrected GPU validation fixtures

The activity benchmark's first resting check caught a constructor mistake also present in the earlier checkpoint/contact tests: `PxBoxGeometry(x)` sets only the x half-extent; the other dimensions default to zero. All three fixtures now construct `PxBoxGeometry(PxVec3(x))` and require valid geometry. The previous degenerate-fixture figures are superseded.

Both corrected checkpoint/contact CTests pass. The corrected contact test performs **27** GPU contact-to-stress submissions with maximum momentum discrepancy **2.68247e-7 kg m/s**; Compute Sanitizer memcheck reports **zero errors**. The 5,000-body motion checkpoint averages **0.0413 ms capture / 0.0444 ms restore** over 100 repetitions. These remain interface/motion-copy checks, not complete fracture rollback or whole-city performance results.
