# Contact-heavy rollback restoration: attribution and held experiment

The city reports' expensive rollback restoration is reproducible. An isolated
20-second simulation (1,200 ticks, 200 adaptively aimed shots, grid 2 downtown)
reached 5,311 awake bodies and measured **32.68 ms median restoration on replay
ticks**. Across 495 large adapter restores, pose setters accounted for 13.334 s
of 14.398 s native restore time, **92.6%**. Velocity setters, force clears and
sleep handling were much smaller. This narrows the investigation to pose and
contact/query invalidation, rather than assuming force clears dominate.

The profiler-only trace used qualified game `2abb673` / solver `79b65482` and
executable `22cd7b6b448e7b58c4e1b21d2c9e93df95b83cdd137f3c35fa0ecd361429512b`.
The release game dependency now points consistently at its release solver
checkout; no held physical-solver changes were imported. This is simulation
attribution, without multiplayer traffic or a rendered client.

## CUDA context experiment: no demonstrated win

Solver `27fa6974` (release-branch cherry-pick `bd71ce1b`) adds an opt-in
`BLAST_RESIM_BATCH_CUDA_CONTEXT=1` scope around adapter restoration. It preserves
all pose/velocity/force/sleep setters, child reconstruction and contact-manager
refreshes, including their order. Release PhysX's nested CUDA acquisition uses
a thread-local reference count, so one outer acquisition can avoid repeated
driver context pushes and pops inside GPU contact refreshes. The flag defaults
off. No PhysX SDK or public deployment setting changed.

The same rebuilt trace executable was run once with each setting:

| Measurement | Disabled | Enabled |
|---|---:|---:|
| Replay ticks | 516 | 549 |
| Median restoration on replay ticks | 14.822 ms | 14.963 ms |
| Maximum awake bodies | 3,949 | 4,414 |
| Final broken bonds | 17,338 | 18,796 |
| Final target height retained | 72.1% | 70.3% |

These runs **do not establish a speedup or fidelity equivalence**. The earlier
32.68 ms case had a heavier collapse and a different binary. Comparing it with
the enabled run would falsely attribute workload variation to the scope.
Neither same-binary arm reproduced the required 5–6k-awake regime. Fine-grained
profiling also adds overhead, and one process per arm is below the repeated
release gate. Consequently the optimization remains disabled.

The recorder defaults to adaptive aiming: later shot origins/directions depend
on the current body set. The inputs were the same *aiming policy and schedule*,
not a verified identical shot sequence. The first discrete body/bond-count
mismatch between arms appears at tick 68. This does not identify its cause;
GPU/CPU numerical variation and adaptive targeting remain confounders. A recorded
shot-input replay is needed before the next qualification attempt. Turning off
adaptive aiming alone changes the workload and previously produced too little
destruction for this gate.

`sim` in the CSV is the simulation wall-time bracket. `cpu_ms` is process CPU
time accumulated across threads and may exceed wall time; it is not a full-tick
wall-time metric. Neither includes the real server's complete streaming work.

## Checks and unsuccessful tooling

Both settings pass CPU snapshot/provenance/phase-guard tests and the 65-body
CPU replay fixture. Both pass the Direct GPU fixture for all 6,001 actors over
12 cycles, checking restored poses/velocities and device-observed replay motion.
The GPU test rotates through no caller acquisition, a caller already holding
the scene context, and a foreign CUDA context. Restoration preserves the caller
context in every case. These are airborne compounds without runtime contacts;
they do not replace contact-heavy fidelity tests or resolve the previously
recorded high-coordinate replay error.

A five-second Nsight capture incorrectly followed the Python launcher and
contained no CUDA data. With `--kill=none`, it returned while its descendants
remained; the wrapper restored the city, so that attempt also briefly overlapped
the deployment. Both owned descendants were stopped after detection. The entire
attempt is discarded. The corrected direct-native invocation stalled during
initialization before any simulation metrics; its owned target was stopped,
Nsight exited 143, and the wrapper restored the city. Neither attempt supplies
performance evidence. Future invocations must ensure no profiler descendants
remain before restoring the deployment. CPU sampling (`perf_event_open`) and
GDB attachment are unavailable in this container.

## Deployment and next work

The public city remains the qualified executable
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`
(game `ed9c2ad`, solver `646a0f41`). Direct GPU remains enabled. Neither the
profiler nor context experiment is deployed. No force, velocity, fracture,
contact, body-count or bond limit was introduced.

Next work is to record and replay exact shot inputs, attribute the remaining
pose/contact invalidation cost without the stalled profiler, and continue the
report-driven reliable-queue and below-ground geometry investigations. A new
public build still requires a demonstrated improvement plus fidelity and
browser checks.

[Measurements, scripts and provenance](../bench-results/simulation-frontier/restore-context/summary.json)
include a verifier that explicitly rejects interpreting this as a city release
pass. The preceding [contact-free profile](restore-profile-2026-09-06.md) and
[player-report analysis](city-player-reports-2026-09-06.md) remain separate evidence.

After restoring the existing executable, the deployment helper passed GPU and
HTTP/manifest/certificate checks, local WebTransport browser bootstrap/render
(96,420 chunks, zero repairs/hash mismatches/JavaScript errors), and public HTTPS.
The local browser does not prove external UDP reachability. The user's human
reports remain the public WebTransport evidence for this unchanged artifact.
