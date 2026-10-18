# Telemetry initialization and contact-audit coverage, 2026-09-06

The release candidate now initializes eleven previously indeterminate timing
accumulators in `ExtStressPhysXTelemetry`. Each was read with `+=` during the
first solve, but had neither an in-class initializer nor a constructor-list
initializer. Heap reuse could therefore seed the totals with arbitrary values.
The existing raw trace demonstrates the failure: its first tick reports
3,586,338,077,683.712 ms for host node stress and 13,624,690,639.4805 ms for GPU
host blocked time. Those are invalid measurements, not expensive physics.

The eleven fields cover GPU host work/blocked time, impulse copy, graph solve,
host walk-in/reset/bond stress/node stress, drain, initialization and error
calculation. They now start at zero. No field layout, solver equation, physical
parameter, contact payload/order, fracture decision or replay policy changed.
This is a measurement correctness fix, not a claimed simulation speedup.

The constructor regression uses the production C++ constructor over storage
filled with four byte patterns and checks all 77 fields. It creates no physics
scene or CUDA context. The old executable fails on
`gpuStressHostWorkMilliseconds` with poison 0xa5; the fixed executable passes
**308 checks**. The native CMake/CTest target
`blast_stress_physx_telemetry_initialization` also passes. The first Make call
could not see the newly added target; regenerating CMake resolved that build
setup issue before the successful build/test.

The constructor fix is committed in solver `7c09837e` and release solver
`491a2d41`. Both game checkouts carry the audit validator and this evidence.
The raw historical trace is retained unchanged. Discarding only its first
sample is not a general repair: subtracting large corrupt cumulative totals can
also lose precision in later differences. Independent direct-contact clocks and
the initialized GPU kernel timer are separate from these fields.

The compact-contact audit now uses
`scripts/perf/verify_compact_contact_audit.py`. In addition to complete contacts
and zero mismatch totals, it requires the exact 96,420-chunk manifest, 1,200
consecutive ticks at 60 Hz, unchanged bytes for all 200 recorded shot inputs,
verification of every initial and replay contact batch, at least 20 ticks with
5,000+ awake bodies, and measured restore/replay in that workload. These are
coverage requirements for the test. They do not cap or suppress simulation work.

Six CPU validator tests pass, including rejection of the wrong manifest,
missing/duplicate tick coverage, missing audit totals, empty or unverified
batches, contact mismatches, a light workload, a single heavy spike, no heavy
replay and changed shot inputs. The prepared exclusive-GPU runner calls this
validator before writing a passing summary. The validator itself only reads
artifacts and never starts a GPU process.

No GPU qualification or public backend restart occurred in this work. The
compact-contact candidate remains opt-in and undeployed. Direct GPU physics,
CUDA stress and the diagnostic client remain enabled in the existing city.
Full-city audit, repeated matched-work performance runs, settling/scenario and
multiplayer checks are still required before promoting the rebuilt candidate.
The connected player's session is preserved.

[Regression, build and audit-validator evidence](../bench-results/simulation-frontier/telemetry-initialization/summary.json)
records the actual candidate binary hashes separately from the live executable.

The exclusive GPU audit was attempted, and its admission guard refused before starting a test because one player remained connected. The existing server PID stayed 166548 and no audit output directory was created. This is an admission refusal, not a failing GPU equivalence result.
