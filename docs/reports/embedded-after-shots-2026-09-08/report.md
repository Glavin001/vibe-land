# Submitted embedded-city reports

These are live user-session observations, not isolated benchmark runs. Each report preserves a rolling server tick history plus a later client snapshot. Server/client snapshots and smoothed GPU-wait counters are not aligned enough to sum into a phase breakdown.

| Report | Chunks / bonds | Ordinary dynamic bodies | Fragments / awake | Broken bonds | Server rolling avg / peak ms | Stress iterations / correction passes | Client GPU ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| report-1788890123-city-default-tick64020 | 24,105 / 74,543 | 12 | 67 / 43 | 903 | 31.747 / 659.606 | 449 / 0 | 2.024 |
| report-1788890126-city-default-tick64080 | 24,105 / 74,543 | 12 | 86 / 43 | 1335 | 56.492 / 722.533 | 426 / 0 | 1.755 |

## What the evidence establishes

- Client GPU rendering is much cheaper than the server simulation. Moving fewer render instances is not the principal fix for these reports.
- Both reports were submitted after firing. Their zero-awake-fragment rows do not prove that ordinary bodies were asleep, or that the entire world was intact.
- Total chunks must come from native telemetry/client manifest. The historical top-level `chunk_count` field is zero here and is not the destruction size.
- The physics fetch interval includes native stress and other required GPU/CPU work. A smoothed `physics_gpu_wait_ms` value must not be subtracted from a different current-step value.

## Zero-awake-fragment observations

- report-1788890123-city-default-tick64020: 229 of 300 recorded ticks have zero awake fragments; total tick min / median / max = 4.402 / 4.829 / 5.876 ms.
- report-1788890126-city-default-tick64080: 169 of 300 recorded ticks have zero awake fragments; total tick min / median / max = 4.468 / 5.014 / 5.876 ms.

Overlapping tick histories are reported separately, not counted as independent repeats.

Phase attribution requires a separate capture of the matching runtime. Current stress iteration and correction counters are shown above; a rolling peak may belong to an earlier fracture step.

Raw report paths and content hashes, timing scopes and retained ring rows are in [summary.json](summary.json).
