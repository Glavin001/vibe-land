# Native restore attribution, 2026-09-06

The latest public report measured 30.21 ms in adapter rollback restoration.
An isolated Direct GPU fixture now restores 6,001 awake bodies / 12,000 shapes
in **1.48 ms median without profiling** (one process, 12 trials, first two
excluded). The same binary with detailed profiling enabled measures 2.28 ms.
This establishes a useful contact-free reference, not a city speedup or a lower
bound for every scene. It does not reproduce the expensive gameplay state.

Solver commit `c3b743af` adds opt-in `BLAST_RESIM_PROFILE=1` attribution in the
native adapter. It records preparation, captured-body restoration and child
reconstruction, with nested pose/velocity/force-clear/sleep timings. Counters
include restored/skipped/rederived bodies, restored shapes and cleared bodies.
It adds no GPU readback or synchronization and changes no force, motion, fracture
or sleep operation selection/order. The public telemetry ABI is unchanged.
The flag defaults off; fine-grained clock calls perturb timings, and stderr
logging is outside the native timer but inside its caller's wall time.

The benchmark is separate from the server. It creates airborne compounds,
fractures one weak setup bond to expose initially disconnected components, then
checks all scene actors after every capture → physics → restore → replay cycle.
One setup compound becomes two smaller pieces, hence 6,001 actors for 6,000
requested compounds. GPU checks occur after completed host observation, so they
check the device-applied restore, not just CPU getter cache values. No stress
solve, inter-body contact, new fracture child or sleeping transition occurs in
the timed cycles. Material crushing is disabled in the fixture; the existing
resistance setting remains true, so every restored body's force/torque clears
still run.

Nested phase medians from the profiled large case are:

| Phase | Host time |
|---|---:|
| Captured-body loop, including profiling overhead | 2.25 ms |
| Pose setters, inside that loop | 0.657 ms |
| COM velocity calculation and velocity setters | 0.301 ms |
| Four force/torque clears per body | 0.265 ms |
| Sleep/wake-counter handling | 0.225 ms |

Do not sum the loop and its child timers. These phases are not separately
measured in an unprofiled run, so their medians must not be presented as exact
unprofiled costs. One process per arm is attribution evidence only; it does not
meet the plan's repeated full-city performance gate.

This result argues against assuming thousands of API calls, or zero-force
clears alone, explain the report's 30 ms restore. It motivates profiling the
same adapter in a representative contact-heavy city state. Contact-related
transform invalidation, sleep transitions and fracture-child work remain
candidates, not established causes. Direct GPU host setters queue metadata for
the next simulation; batching them must preserve CPU query state, COM frames,
force accumulators, wake state and child identity.

## Checks and numerical limitation

- Existing CPU `resim_snapshot_test` passes with profiling enabled and disabled:
  mixed kinematic/dynamic snapshot restoration, fracture-child provenance,
  phase guards, and one-effective-step motion of a non-adapter body.
- The final small CPU benchmark passes 12 complete cycles for 65 bodies.
- Both final large Direct GPU arms pass 12 complete cycles for all 6,001 actors.
- A smaller translated Direct GPU case also passes 12 cycles; that supporting
  capture predates the final explicit scene-actor-count assertion and is not
  used in the same-binary timing comparison.
- The high-coordinate case (65 bodies, shape/mass coordinates around Y=1,000 m)
  fails the unchanged 0.2 mm replay-position threshold by **0.488 mm**. Replayed
  linear and angular velocities match exactly; absolute quaternion dot prints
  1. Lower-coordinate fixtures pass. This supports coordinate sensitivity as
  the explanation but does not establish the exact floating-point operation
  responsible. Keep this numerical issue open; it is not evidence that the
  reported −3 m chunk readings have the same cause.

The early fixture attempts omitted required material/bond descriptors and then
left touching setup fragments. Those were fixture errors: valid descriptors
and separated geometry were required before isolating restore. No production
validation or contact interaction was bypassed. The replay position/velocity
thresholds were not relaxed to turn the coordinate failure into a pass.

The initial large multi-case run was rejected by automatic approval review
because it could not verify the wrapper's restoration/resource safeguards; it
did not execute. After reading the wrapper and helper's ownership/identity
checks, verifying the restorable executable and zero players, smaller scoped
cases proceeded with explicit 30/45-second timeouts. Each run restored the
captured executable and environment. All builds completed before GPU testing;
no public simulation ran alongside a GPU benchmark.

## Deployment and next step

The public city remains game `ed9c2ad`, solver `646a0f41`, executable SHA-256
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`.
The restore profiler and experimental solver are not deployed. Direct GPU
remains enabled, and no interaction limit or physics setting changed.

After the isolated tests, the helper passed GPU/HTTP/manifest/certificate checks,
a local WebTransport browser bootstrap/render check, and public HTTPS.
The local browser does not prove external UDP reachability; the user's three
new gameplay reports are the public WebTransport evidence for this artifact.

Next, apply the profiler to an isolated build using the qualified release
physics, reproduce contact-heavy fracture replay, and attribute the 30 ms
restore there. In parallel with that objective, the report's reliable-queue
overflow and missing below-ground provenance need dedicated reproductions.
Do not flip a simulation optimization on the basis of the airborne benchmark.

[Raw measurements and provenance](../bench-results/simulation-frontier/restore-profile/summary.json)
include the failing case. The neighboring verifier checks the source hashes,
complete trial/body counts, nested-timer consistency and unchanged live artifact;
it explicitly reports that this is **not a city release pass**.
