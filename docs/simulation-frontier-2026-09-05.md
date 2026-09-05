# Simulation frontier: GPU integration and trustworthy tick budgets

The best direction is a persistent GPU simulation transaction: contact wrenches feed stress directly, stress feeds damage and connectivity, and the CPU receives compact topology decisions plus the final state needed by gameplay and streaming. Bulk contact, node-load and bond-impulse round trips are architectural overhead. Moving those boundaries is more promising than repeatedly optimizing the host loops that service them.

This change establishes and tests the first device pipeline in the dependency and fixes the measurement gates in the game. **It does not enable Direct GPU mode for `/city`, replace the city fracture adapter, or claim a measured city speedup.** Existing physics, materials, solver tolerances, iteration counts, same-tick replay and streaming behavior are preserved. New branches in both repositories are `codex/simulation-frontier`. The dependency implementation is commit `598787fd`.

## What the source audit changed

1. The engine actually linked on this machine is **PhysX 5.10.0** at `/root/PhysX/physx`, not the dependency repository's bundled 5.6.1. The GPU source is present locally, including the solver and narrow phase. An upgrade from the bundled version is not needed to access the current engine's capabilities.
2. The stress adapter already supplies PhysX's CUDA context to the stress solver. A second context was not the primary transfer barrier. Host-only node-load submission, eager impulse readback and CPU ownership of topology are the relevant boundaries.
3. The existing Direct GPU motion prototype did not restore its GPU checkpoint correctly, and its contact prototype returned zero-valued payloads. Those paths needed correctness repair before their timings could guide an architecture.
4. The Direct GPU API has device force/torque operations. It also changes CPU motion/query validity and requires sleeping disabled in this engine configuration. Enabling its scene flag globally would therefore change gameplay and sleep semantics. A production migration needs either complete replacement of the affected consumers or a narrowly reviewed engine extension preserving those contracts.
5. Full-scene replay currently captures destruction-owned bodies through the manager. Ordinary dynamics and vehicles sharing that scene need explicit checkpoint/force-journal coverage too. Some gameplay observers run before city replay. These are outstanding integration requirements; the new motion buffer does not solve them merely by making copies faster.

## Implemented in the dependency

The detailed interface and test documentation is in `demos/blast-stress-demo/GPU_PIPELINE.md` in `blast-stress-solver-2`.

- Persistent GPU motion checkpoints restore device poses and linear/angular velocities without replacing them with stale CPU state. Capture failure invalidates the old checkpoint, actor removal is rejected, and every component transfer must succeed.
- A CUDA contact decoder emits actual normal and friction impulses, their individual application points, actor identifiers and shape transform-cache identifiers. Keeping those points preserves couples even when the resultant force is zero. Capacity overflow invalidates the result instead of silently dropping loads.
- A device view with a completion event allows another CUDA stage to consume those contacts without host readback. The wrapper also guards a PhysX 5.10 empty-contact path that otherwise leaves stale counts and completion events.
- `solveDevice` accepts loads and a producer event from the shared context. Loads are copied only device-to-device into persistent graph storage. GPU comparison preserves the existing converged-only settled-island skip. The current scheduler still reads a small per-island dirty mask and solve status; it is not yet an entirely asynchronous scheduler.
- A real impact test chains PhysX contact output, a GPU load producer and the GPU stress solver. Production compound-shape/node mapping and complete fracture replay are subsequent work.

No CG recurrence, material strength, damage formula or iteration policy was weakened to obtain these results.

## Implemented in the game

`dist.py` previously interpreted `--warmup 600` as a boolean option plus a filename, while its advertised syntax used a separate value. It now accepts both conventional option forms and rejects invalid combinations. Flat reports, A/B reports, spike ranking and the tree now share the measured `sim` wall time as their total. Older traces fall back to available disjoint brackets. A/B also supports `--by none` and empty arms.

Two independent replay attribution defects were fixed. The trace recorder now captures PhysX statistics before destruction can overwrite them with a replay. The destruction runtime preserves first-pass stress timers on split ticks while taking body/state counters after the final pass. The additional statistics work is included in the timing budget. The existing timing-closure benchmark now actually calls pre-step capture and requires replay ticks; previously it could pass without exercising replay.

The successful `fetchResults` call includes contact callbacks. The report now subtracts callbacks when deriving `result_copy`, so they are not counted twice under fetch. Sampled values remain marked as sampled. The startup log also reports the configured iteration budget instead of claiming that every GPU solve converges and recommending weaker materials.

## Measured validation

Hardware/toolchain: RTX 4090, driver 595.71.05, CUDA 12.8.93, PhysX 5.10.0, Rust 1.97.1. GPU validation ran exclusively with the idle, checkout-owned public server paused. The original binary and environment were restored afterward.

| Check | Result |
|---|---|
| Direct GPU checkpoint, contact pipeline, device-input and existing CPU/GPU stress equivalence CTests | 4/4 passed |
| Compute Sanitizer memcheck: contact pipeline and device inputs | 0 errors in both |
| Delayed producer; cold/warm loads; island skipping; host/device transitions; bond removal | Maximum observed host/device impulse difference: 0 |
| Sliding impact, normal and friction impulses compared with momentum change | Maximum error 9.53674e-7 kg·m/s across 18 GPU contact-to-stress submissions |
| Zero-resultant contact couple | Nonzero torque preserved |
| Contact overflow and live-contact → empty-scene transition | Rejected truncation; no stale contact reuse |
| Motion checkpoint at 5,000 bodies, 100 repetitions | Capture 0.0402 ms; restore 0.0422 ms mean |
| Report regressions | 9 passed |
| Existing 2,400-tick timing-closure benchmark, now with replay | Passed; 190 replay ticks; post-step unaccounted time 0.01% |

The checkpoint figures are isolated motion-copy timings. They exclude fracture membership/provenance work and do not establish a matched speedup over the production checkpoint.

A separate 720-tick city trace used grid 1, freezing disabled, 16 shots across 4 targets, 120 settling ticks and the existing 32-iteration/material settings. It produced 313 replay ticks, 9,857 broken bonds, peak 2,538 bodies, peak 2,460 awake bodies, and zero membership mismatches. Across replay ticks:

| Budget | Minimum / mean / maximum unaccounted time, ms |
|---|---|
| First PhysX step versus simulate + fetch + deferred drain | 0.000581 / 0.035375 / 0.083375 |
| First stress pass versus its native child phases | 0.000340 / 0.000425 / 0.000772 |
| First native stress pass versus its Rust FFI bracket | 0.000250 / 0.000427 / 0.001564 |
| Full simulation versus top-level brackets | 0.004090 / 0.005973 / 0.011486 |

This run validates attribution and replay coverage. It is one arm, not a performance acceptance experiment. For example, the 1,500–3,000 awake-body bucket still averaged 23.83 ms with approximately 45.79 ms p99. It is not a 60 Hz scale frontier.

Local artifacts are under `bench-results/simulation-frontier/`. The CSV SHA-256 is `f55fb4e2ae7395e38cad9d89a8970f9b946c2937cd2ddecd63f42d15abb66366`.

Reproduction:

```sh
cargo build --release -p web-fps-server --bin record-city-trace --features cuda-stress,blast-core
source scripts/physics-env.sh
export VIBE_CITY_FREEZE=0 VIBE_PHYSX_PROFILE_FETCH=1
./target/release/record-city-trace --grid 1 --seconds 12 --settle-ticks 120 \
  --shots 16 --targets 4 --shot-interval-ticks 14 \
  --output bench-results/simulation-frontier/attribution.towertrace \
  --metrics-out bench-results/simulation-frontier/attribution.csv \
  --summary-out bench-results/simulation-frontier/attribution-summary.json
python3 scripts/perf/dist.py bench-results/simulation-frontier/attribution.csv \
  --tree --warmup 120 --by awake
python3 -m unittest discover -s scripts/perf -p test_dist.py
```

## The production architecture to pursue

Treat a tick as a transaction with a versioned body/shape/node mapping and one committed observer state. Snapshot every shared-world dynamic that can participate in replay, including vehicles and free props. Journal commands and accumulated forces so replay neither loses a force nor applies an explosion twice. Preserve fracture provenance when a parent's checkpoint is transformed into child states. Do not publish provisional transforms, collision outcomes or topology epochs before the configured replay policy completes.

On the GPU, retain body motion, contact wrenches, load vectors, warm starts, stress, health and ownership labels across ticks. Route contacts using stable shape ownership, preserving torque and local-frame transforms. Consume actual GPU contact payloads before the next simulate invalidates them. Keep the current CPU actor/shape edits as an initial compact commit boundary; move connectivity and membership to the GPU once their output can be validated against that boundary. Metadata and commands will still cross interfaces—eliminating bulk round trips is the objective, not pretending that a simulation can have no data movement.

For solver work, optimize by connected-component size and graph structure. Small components can complete in one cooperative block; medium components benefit from stable compact lists and per-island reductions; large buildings need an effective coarse correction/preconditioner. Launch fusion must respect global reduction dependencies and neighbor reads. Warm starts need topology-aware validation, especially with column compliance scaling. The existing whole-reset switch remains in place until the incremental topology path's spontaneous-fracture defect is resolved.

An additional algorithmic candidate is static condensation of intact structure interiors, with shared operators or factorizations for repeated instances of the same asset. Preserve boundary/contact degrees of freedom and recover internal bond stresses from the condensed solution; update affected regions when topology changes. Common gravity and rigid-motion contributions can be reused where the material model permits it. This could reduce the system that must be solved each tick, rather than only accelerate the existing iteration. Fill-in, fracture downdates, free-body null modes and contact localization can erase the gain, so it needs a measured prototype and independent load-path checks before adoption. A monolithic contact/structural constraint formulation is another candidate, but representing every intact chunk as a separate unconstrained rigid body would give back the current clustering benefit.

Numerical acceptance needs known-load columns and cantilevers, anchored reactions, free-fall rigid modes, momentum/energy checks and a strong CPU/double-precision reference. The existing large-pack equilibrium metric fits its own scale from the answer; by itself that cannot reject a uniformly scaled answer, and its zero-load edge case is not a sufficient gate. Broken-bond counts are outcome checks, not proof of convergence. Fix that reference before using it to approve a new recurrence, iteration reduction or multilevel solve.

After those semantics hold, measure the complete awake-body frontier with matched workloads, at least three runs per arm, first-pass/replay separation, transferred bytes, tail latency and backlog. Preserve fidelity criteria before accepting a speed result. Only then redesign sleeping/freezing and streaming: final-state GPU pose compaction, topology epochs, reliable ownership changes, per-client relevance, and explicit resynchronization when a client misses topology. Those layers should exploit the committed simulation state without changing which structures were actually simulated.
