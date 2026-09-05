# Lazy-readback city rollout evidence

The deployed runtime is recorded in `deployed-runtime.json`; functional browser
and public HTTPS checks are in `deployed-verification.json`. The city URL is
https://209.121.195.117:40617/city. Solver source: `bdd35671`; game simulation
source: `05c2319`, on `codex/simulation-frontier`.

Final checks: 11 city scenario checks passed; destruction 153 passed / 17 ignored;
bridge 22 passed / 10 ignored; native CTest 26/29, with the same three known CPU
quality failures. CUDA memcheck reports zero errors. The numerical suite passes
its existing GPU residual <= 2x CPU gate. The skewed CPU/GPU stress comparison
passes in node-space, bond-space and Jacobi modes.

The added grid-2 idle check remains failed: four bonds break late, versus a tail
limit of three. Eager, lazy and the final candidate all show four late breaks;
`idle-baseline-comparison.json` preserves their different event ticks. Neither
that condition nor the three native failures has been waived or fixed. This
rollout is an incremental playtest, not completion of the full-plan gates.

`before-normal-prep-*` records the earlier candidate/control evidence. The
`lazy-destruction-city-overrides` run incorrectly applied the downtown material
and excess-force overrides to authored fixtures; the corrected final full run
is `lazy-destruction.log`. `lazy-numerical-wrong-cwd` is an invalid launch, not a
numerical failure; the corrected numerical run is recorded separately.
`normal-prep-before-scale-fix.log` preserves a failing new CPU/GPU preparation
fixture before the arithmetic corrections were complete.

The gameplay and numeric tests use their recorded trace/test executables. The
deployment helper rebuilt the server from the same source with explicit
BLAST_ROOT; its binary differs from the predeployment server artifact. Both
hashes are recorded. The running server matches the deployment build and passed
browser verification. Do not describe the two server binaries as byte-identical.

Logs and CSV files are committed as deterministic gzip archives (append `.gz`
to the raw log names used above). For CSVs, their hashes and the
hashes of their decompressed content are in `csv-sha256.json`. Uncompressed CSVs
and a hard link to the tested trace executable are retained only on this host.
Log archive hashes are in `log-sha256.json`. The archived runners use this host's paths. They require an empty healthy match,
stop only its owned deployment for exclusive GPU use, and restore it afterward.
Use the live `scripts/vast-city.py` helper for deployment rather than treating
these historical audit scripts as deployment infrastructure.

The raw phase/performance CSVs are not multiplayer transport measurements. Local
browser WebTransport verification bypasses NAT hairpin and does not prove
external public UDP reachability.
