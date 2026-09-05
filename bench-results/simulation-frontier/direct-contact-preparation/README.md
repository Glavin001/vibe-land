# Direct GPU observation campaign

Read `docs/direct-gpu-observation-2026-09-05.md` in the game repository for the
current result, physical constraints, failed intermediate candidates and rollout.

- `baseline-1..3`: game parent `2c29f76` plus `instrumentation.patch`; SDK patch
  from solver parent `f5d20298`. Its trace binary remains locally at
  `/tmp/record-city-contact-baseline`. The run manifests record its hash.
- `candidate-1..3`: exact-pose-only optimization. **Rejected** after
  `query-kinematic.log.gz` exposed stale bounds after a kinematic target.
  `sdk-preliminary.patch` matches `candidate-sdk-manifest.json` exactly.
- `final-1..3`: active-kinematic exception (solver `4f9e5a31`). **Rejected** after
  `query-stationary.log.gz` exposed stale bounds when a previously moved
  dynamic body stayed stationary during later fetches.
  `sdk-active-kinematic.patch` matches `final-sdk-manifest.json` exactly.
- `qualified-1..3`: only exactly unchanged inactive bodies omit query updates.
  Solver source is `646a0f41`, game instrumentation/diagnostics is `66a7257`.
  `qualified-candidate.json` identifies the executables and SDK;
  `qualified-sdk-manifest.json` lists the library hashes.
- `qualification-preliminary` and `qualification-active-kinematic`: broad
  checks on the rejected stages. `qualification` is the final rerun. The final
  native output is `native-fixtures-qualified.log.gz` and includes the added
  stationary-to-sleeping and kinematic query regressions.
- `facade-repeats` and `authored-order-control`: investigate the rejected
  active-kinematic build's one settling assertion failure. All repeated tests
  passed, but the original failed full-suite run remains recorded.
  `build-query-baseline-sdk.py` reconstructed the original observation function
  and verified every baseline SDK library hash exactly. It operates in its own
  temporary directory and does not modify the running SDK.

`summary.json` compares independent trial means and population bands. Use only
`baseline` and `qualified` for the final performance comparison. The summarizer
reads raw streams or the committed `.gz` counterparts:

```sh
python3 bench-results/simulation-frontier/direct-contact-preparation/summarize.py
```

Compressed-only reconstruction is checked against the raw-stream result.
`artifacts.json` records compressed and uncompressed hashes. Run manifests
record commands, selected physics environment, binary hashes, source
parents/diff hashes, exit status and elapsed time. Source hashes can include
documentation/test edits; executable hashes identify the simulation used.

`profile.py <label> <trace-binary>` runs the grid-2 workload. Build the custom SDK
as described in the dependency's `patches/physx/README.md`. Run benchmarks with
the GPU available for that process. Archived scoped test and deployment wrappers
use this checkout's existing `scripts/vast-city.py` helper to refuse connected
players, stop only the owned deployment, and restore the exact prior binary and
settings. They are not standalone service installers. Orchestration retains
its original `/tmp` helper paths; copy the corresponding archived helpers there
when reproducing that orchestration. The `qualify-qualified-*` scripts describe
the final stage; the earlier orchestration scripts describe rejected stages.

These captures exclude encoder/transport work. The optimization preserves velocity
publication cadence and imposes no contact/fracture limits. Scenario body/bond
ranges are fixture assertions, never runtime budgets.
