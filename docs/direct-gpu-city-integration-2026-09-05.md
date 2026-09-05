# Direct GPU city integration checkpoint, 2026-09-05

The city bridge now has an opt-in Direct GPU path that retains native sleeping,
accepts CPU gameplay commands, publishes explicit CPU motion/query observations,
and routes GPU contact records into the existing destruction/support processing.
The live `/city` remains on ordinary GPU. This checkpoint does not complete the
full-tick plan or establish an end-to-end city performance improvement.

## Implementation

The isolated SDK pins NVIDIA PhysX 5.10 base
`3ca45ad36e9755f7c8c5bea9f7c57d308d9f0c54`. The dependency packages the exact
source patch and builder; CPU/GPU libraries use a distinct GPU module name and
are recorded in the artifact manifest. The dependency checkpoint is commit
`86aac8baf0bf6c2ab3655f060f694ca6089c3cb2` on `codex/simulation-frontier`. `VIBE_PHYSX_DIRECT_GPU=1` additionally
requires CUDA stress, the host-access SDK, deferred contact processing and
persistent support contacts. Defaults are unchanged.

CPU pose/velocity writes mark only explicitly changed fields. Native force modes
accumulate velocity deltas applied after those motion writes. Explicit host
observation uses reusable device/pinned buffers and one host wait, then updates
native CPU getters and scene queries without waking or re-uploading bodies.
Kinematic final poses update GPU bounds. Skipping a redundant stale CPU bounds
publication fixes bodies falling through ground near an unrelated moving actor.

Contact records retain normals, separation, original scalar normal impulses,
per-pair point ordering and friction anchors. Reporting thresholds sum normal
impulses across all shapes in a body pair, including the shared static world
body; applying thresholds per shape drops distributed support loads. The bridge
sorts records before accumulation and validates every actor/shape association.

Chunk colliders are exclusive to their current actor. The adapter retains a
reference while a collider is detached and reattached during fracture, so its
identity survives. An explicit SDK contact-transform lookup fixes a second
routing issue: `PxShape::getGPUIndex()` returns a geometry index, whereas GPU
contacts carry transform-cache indices from a different allocator. The two
can diverge after topology changes and neither is a persistent identity.

## Tests and observed failures

Initial city smoke tests found the moving-kinematic bounds regression, then
missing CPU contact callbacks under Direct GPU. Adding the GPU contact bridge
and native threshold aggregation fixed them. Destruction testing then exposed
shared-shape index lookup and post-fracture confusion between the two index
spaces. The current implementation fixes all four failures; tests were rerun
with identical settings under ordinary and Direct GPU modes.

The current run passes five GPU CTests (activity/native equivalence, device
motion checkpoint, contact-to-stress, device stress inputs and CUDA stress
equivalence). Each city mode passes 21 bridge tests: four GPU smoke, three
destruction smoke, nine freeze/wake, four settling and one timing-consistency
test. Three existing manual settling probes remain ignored in each mode.
The extended activity suite passes CUDA Compute Sanitizer memcheck with zero
errors. Its additional 392 sampled host-command/landing positions match ordinary
GPU exactly; the earlier 221 activity samples retain a maximum position error of
`3.58129e-7 m`. The game also compiles against the stock SDK. The exact patch
applies to the pinned index, and the isolated builder verifies the packaged
patch and hashes.

Raw results and the SDK manifest are in
`bench-results/simulation-frontier/city-direct-gpu-integration/`. GPU tests ran
exclusively after pausing only the healthy player-free checkout-owned server;
the runner restored its original executable/environment and verified health.

## Performance and remaining work

The earlier [sleeping prototype report](gpu-activity-prototype-2026-09-05.md)
measured a 9.2% moving-step improvement against ordinary GPU native sleeping
and 3.73 times cheaper resting steps than stock Direct GPU, in a controlled
4,096-body fixture. Those results refer to its earlier patch and ownership path.
They are not performance results for this city integration.

The current city path observes every dynamic body and rebuilds live shape
routing when contacts exist; it reads contact records back to the CPU. This
restores functionality but forfeits much of the intended data-transfer saving.
The device contact-to-stress path is proven in an isolated test and is not yet
the city's production load route. Friction/contact accumulation and complete
fracture outcomes still need native-versus-device fidelity qualification.

Remaining gates include GPU ownership/load routing and motion-to-node inputs,
selective awake observation with generation-aware identity, complete same-tick
rollback across forces/activity/contact caches/topology, commit-only streaming,
solver numerical qualification, the at-rest/scenario/full-resimulation suites,
and at least three matched saturated-awake city benchmarks including whole-tick
p99 and backlog. Motion checkpoint success is not full destruction replay proof.
Only after these gates should the Direct GPU path be deployed for human review.

A subsequent [GPU impulse-observation checkpoint](gpu-lazy-readback-2026-09-05.md)
adds lazy host readback, deterministic reduction audits and a scenario-harness
replay fix. It retains the deployment and full-replay qualification boundary above.

The subsequent [Direct GPU city qualification](direct-gpu-city-qualification-2026-09-05.md)
rebuilds this mode with the latest arithmetic fixes, runs the full city replay
audit and broader destruction coverage, and records the retirement/performance
issues that still prevent promotion. It prioritizes a first playable Direct GPU
increment before completing every GPU migration.
