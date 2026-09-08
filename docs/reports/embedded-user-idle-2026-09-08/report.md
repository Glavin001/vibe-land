# Submitted embedded-city reports

These are live user-session observations, not isolated benchmark runs. Each report preserves a rolling server tick history plus a later client snapshot. Server/client snapshots and smoothed GPU-wait counters are not aligned enough to sum into a phase breakdown.

| Report | Chunks / bonds | Ordinary dynamic bodies | Fragments / awake | Broken bonds | Server rolling avg / peak ms | Client GPU ms |
|---|---:|---:|---:|---:|---:|---:|
| report-1788885497-city-default-tick121260 | 24,105 / 74,543 | 8 | 5 / 1 | 91 | 50.021 / 734.120 | 2.024 |
| report-1788885516-city-default-tick121440 | 24,105 / 74,543 | 12 | 22 / 5 | 342 | 87.671 / 978.840 | 2.041 |

## What the evidence establishes

- Client GPU rendering is much cheaper than the server simulation. Moving fewer render instances is not the principal fix for these reports.
- Both reports were submitted after firing. Their zero-awake-fragment rows do not prove that ordinary bodies were asleep, or that the entire world was intact.
- Total chunks must come from native telemetry/client manifest. The historical top-level `chunk_count` field is zero here and is not the destruction size.
- The physics fetch interval includes native stress and other required GPU/CPU work. A smoothed `physics_gpu_wait_ms` value must not be subtracted from a different current-step value.

## Zero-awake-fragment observations

- report-1788885497-city-default-tick121260: 204 of 300 recorded ticks have zero awake fragments; total tick min / median / max = 38.738 / 38.944 / 42.919 ms.
- report-1788885516-city-default-tick121440: 34 of 300 recorded ticks have zero awake fragments; total tick min / median / max = 21.927 / 40.111 / 42.919 ms.

Overlapping tick histories are reported separately, not counted as independent repeats.

## Source-confirmed work to remove

1. `StressResidentAPI.inl::solveDeviceAsync` rejects the old settled-island skipping flags. Native warm starts reuse a guess, then re-run the solve. Sleeping rigid bodies do not currently certify that a structural solve can be reused.
2. Components above 1,024 nodes use the cooperative multilevel path. Downtown includes several such components; the 444-chunk building benchmark does not.
3. The deployed cooperative loop enters its preconditioner after all components have converged. A candidate now exits at that already-verified boundary and preserves final status/scratch writes. The focused two-CTA GPU boundary test and memcheck pass (zero errors); it is not deployed or timed yet.
4. Exact unchanged-input reuse still needs an operator/load/convergence certificate, with support, contact, topology and damage invalidation. This must preserve the material evaluation and never reuse an unconverged output.

These findings identify unnecessary work; the submitted reports do not quantify each item's milliseconds. Attribute that with a separate internal phase capture before claiming a speedup.

Raw report paths and content hashes, timing scopes and retained ring rows are in [summary.json](summary.json).

## Clean idle reproduction prepared

The existing native game-consumer benchmark now accepts an explicit authored scene with zero projectile waves, while preserving the original bombardment command tape by default:

```bash
PHYSX_DESTRUCTION_SDK=/root/workspace/physx-2 \
CARGO_TARGET_DIR=/root/workspace/physx-2/out/vibe-native \
cargo build --release -p vibe-land-destruction --features embedded-destruction --example embedded_city_bench
/root/workspace/physx-2/out/vibe-native/release/examples/embedded_city_bench /tmp/fresh-downtown-idle 1 600 0 fractured-downtown.json
```

This benchmark is compiled, not yet run. It records the scene manifest hash, actual authored component count, physical settings and every complete-step sample. Run phase profiling separately; do not contend with the user's live demo or call overlapping runs isolated. The fixed benchmark settings are an explicit diagnostic recipe, not a replay of the user's controller/network session.
