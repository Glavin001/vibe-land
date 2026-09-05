# Playable city increment: lazy GPU impulses and matching host stress arithmetic

Rollout status: deployed and browser-verified at
[the existing city URL](https://209.121.195.117:40617/city). The running server has
lazy GPU impulse readback enabled. Browser WebTransport rendered 96,420 chunks,
with no JavaScript errors, orphaned chunks or ledger hash mismatches. One
structure repair was reported. Public HTTPS passed; external UDP was not verified.

The city candidate uses solver `bdd35671` and game simulation source `05c2319`
on `codex/simulation-frontier`. It enables `BLAST_GPU_IMPULSE_READBACK=0` on the
ordinary PhysX GPU backend, with Direct GPU and deterministic reduction audit
mode disabled. The grid-2 downtown, material multiplier 0.45, 32 iterations,
9.81 gravity, shot profile, sleeping/freezing and one full same-tick fracture
replay remain configured as before. The library's global default stays eager.

## What is being promoted

The stress solver keeps impulses on the GPU until a CPU consumer actually needs
them. Convergence/retirement observations, CPU walks, backend switches, topology
rebuilds and diagnostics explicitly refresh the host mirror. The earlier
checkpoint also repairs trailing impulse-array compaction and the empty-graph
fallback after complete shattering.

Promotion checks exposed differences in the CPU observer's arithmetic. Those
are now corrected: weighted vector accumulation and normal/distance preparation
use the GPU's fixed rounding sequence; physical impulse conversion uses the
same multiplication association; the shared final torsional shear accumulation
uses explicit fused multiply-add. The old impulse-mirror audit compared two
copies produced by the same CPU conversion, so it could not detect disagreement
between that conversion and the actual GPU stress kernel.

A new skewed-graph test compares actual CPU and GPU stress/health outputs exactly
through 53 updates, tail removals, island cuts, complete shattering, backend
switches, convergence and retirement. It initially failed and now passes. The
CG reduction audit mode isolates that comparison from atomic reduction order;
it is not enabled on the city deployment.

## Evidence and its limits

The final grid-2 audit captured all 900 ticks and performed 351 full fracture
replays, with no capture errors or chunk membership mismatches. Reported
threshold/count, removal-order, node-mask, compact-set, host-impulse and cached
payload audits show zero mismatches. Small stress bit differences remain at
near-zero values (reported error below 1e-15); no differences exceed the existing
1e-5 diagnostic threshold. This is not a claim of bitwise equality for every
stress sample in the city or of deterministic PhysX trajectories.

The final scenario suite passes its 11 checks, including bounded single-shot
damage, falling/spreading collapse, debris retirement, containment, buffer
headroom, the performance guard and 90 seconds at rest. The grid-1 idle case
breaks one bond. The final CUDA memory check of the skewed CPU/GPU fixture
reports zero errors. The final destruction suite passes 153 tests (17 existing ignored); the bridge
passes 22 (10 ignored). The numerical residual gate and the bond-space/Jacobi
variants of the exact CPU/GPU comparison also pass. Test totals and deployment
verification are recorded in `bench-results/simulation-frontier/lazy-readback-promotion/`.

The broader native suite remains 26/29: `load_path`,
`reference_building_load_path` and `destruction_quality` still fail. The added
grid-2 idle check also fails its tail-rate condition: four bonds break during
the final third, against a limit of three. The eager control, lazy control and
final candidate all show four late breaks. Those baseline issues remain open;
no threshold was relaxed to call them passes. This is an incremental playtest
rollout and does not complete the full-plan qualification gates.

An initial authored-fixture run mistakenly inherited the downtown strength and
excess-force overrides. Those are different from the fixtures' authored
materials/code defaults. Its failures are retained in the evidence. The corrected
run uses the ordinary fixture configuration while exercising CUDA stress, GPU
bond walking, lazy readback and fracture replay. City scenarios always use the
actual downtown launch configuration. A numerical-suite launch with the wrong
working directory is likewise retained separately from the corrected run.

Earlier three-pair city measurements found roughly 61% less solver host work,
13% less destruction time and 6% lower mean simulation time in the matched
4,500–5,000-awake comparison. Those measurements precede the arithmetic correction;
see [the measurement report](gpu-lazy-readback-2026-09-05.md). They do not establish
a consistent p99 improvement or multiplayer streaming throughput. The phase
brackets overlap and must not be added.

## Incremental deployment workflow

Each candidate is built and tested before replacing the running city. GPU test
windows check that the match is empty, stop only the checkout-owned deployment,
and restore its exact executable/environment afterward. Promotion builds from the tested source with the intended feature flag, checks
the running process against the deployment build's binary hash and settings, and
verifies browser WebTransport/bootstrap plus public HTTPS. In this rollout the
helper rebuilt the server with explicit BLAST_ROOT, so its binary differs from
the predeployment server artifact; both hashes and the tested trace hash are
recorded. The deployed server itself passed browser verification. The deployment helper retains the prior executable for rollback.

Use `scripts/vast-city.py` for deployment and verification. The archived test
runners reproduce this host's audit setup; they are not replacement deployment
infrastructure. Local browser verification bypasses NAT hairpin and does not
prove external UDP reachability.

Direct GPU motion/contact integration, GPU sleeping experiments, complete GPU
fracture replay, device-owned load assembly and full streaming optimization are
still separate work. This rollout makes the validated readback improvement
playable while that larger implementation continues.
