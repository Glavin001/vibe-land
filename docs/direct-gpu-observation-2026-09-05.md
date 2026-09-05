# Direct GPU observation: unchanged inactive bodies, 2026-09-05

The city bridge was scheduling scene-query updates for every observed body and
shape after every physics step, including untouched buildings. This increment
omits that work only when a body is inactive and its observed pose is exactly
unchanged. It introduces no force, velocity, contact, fracture or body-count
budget and changes no material, sleeping or freezing settings.

## Implementation

The SDK still validates the complete observation batch and publishes poses and
both velocities. It compares mass-frame transforms using exact component
equality, with no movement tolerance. Pending host-pose and local-shape commands
retain their own query updates.

All active bodies retain query scheduling. Native fetch synchronizes active
query shapes from CPU caches that can be stale in Direct GPU mode, even if a
dynamic body's GPU pose is unchanged. Kinematic integration also advances the
CPU pose before observation. Checking pose equality alone, or exempting only
active kinematics, is insufficient. New regression tests caught both cases
before either candidate was deployed.

This removes redundant CPU work. Motion/contact readback and CPU contact routing
remain. The game now exposes separate wall-time spans for motion observation,
contact copying, ownership lookup, validation, sorting, body-pair reduction and
routing. `record-city-trace --timings-out <jsonl>` records these and the existing
named spans without requiring an encoder/packet capture. Its command line
rejects combining that option with `--packets-out`.

## Measured performance

Three baseline and three corrected runs used the same grid-2 scene, 600 ticks,
100 scheduled shots, 27 targets and four-tick shot spacing. Both used Direct
GPU, native sleeping, speculative CCD, 32 stress iterations, same-tick replay,
existing freeze settings and lazy stress-impulse observation. Run manifests
record the complete selected physics environment and executable hashes.

| Median of three trial means | Baseline | Corrected |
|---|---:|---:|
| Motion publication, all ticks | 6.28 ms | 0.48 ms |
| Motion publication, 2,000–4,000 awake bodies | 6.37 ms | 0.55 ms |
| Motion publication, 30,000–60,000 contacts | 6.30 ms | 0.59 ms |
| Complete simulation, all ticks | 59.77 ms | 43.33 ms |

Motion publication took about 92% less time. The whole-simulation row is an
observation, not a same-state causal speedup: fracture trajectories differ,
and neither population band makes the states identical. Final broken bonds
were 14,083/14,668/13,532 in the baseline and 16,735/12,231/12,745 in the corrected
runs. All computed fracture output was permitted; no damage budget was added.
These captures exclude encoder/transport work and do not demonstrate a 60 Hz
full multiplayer tick. The named spans describe the first completed physics
step; `sim` additionally includes destruction and replay.

The GPU module is byte-identical across these SDK builds; only
`libPhysX_static_64.a` changes. A diagnostic SDK reconstructed the original
observation function and reproduced every baseline library hash exactly.

## Qualification

The corrected SDK passed six native tests: velocity fidelity in CPU/ordinary
GPU/Direct GPU, Direct GPU replay, native sleep/wake activity and device contact
decoding. Query coverage includes stationary publication, pending local-shape
movement, changed velocity, one-ULP device motion, moved-to-stationary and
stationary-to-sleeping transitions, and kinematic targets. A further query test
passed with local-shape edits on an unchanged sleeping body. The complete game
integration suite passed 176 tests (zero failures, 27 ignored). The grid-2 audit
completed 900 captures and 327 replay passes, with zero capture errors, membership
mismatches, threshold mismatches or large stress mismatches. Tiny reported stress
differences remain (maximum reported error 1.253e-16); this is not bit-identical
GPU/CPU stress arithmetic or a full device topology checkpoint proof.

The city scenario passed its shot/collapse, idle, retirement, escape, contact
buffer and performance checks. Its awake-tail ratio failed: 15.1% versus the
fixture's 10% expectation. The single-trial physics-plus-stress p95 in the
3,000–6,000 awake-body band was 36.6 ms; it excludes streaming. The grid-1 idle
check recorded one broken bond over 90 simulated seconds.

Three additional 60-second collapse controls per build used the identical shot
schedule and the scenario's five-second tail median. The baseline ratios at
40 seconds were 20.3%, 0%, and 9.9%; at 60 seconds they were 0%, 0%, and 14.1%.
All three corrected runs had zero awake bodies in both tail windows and at the
40/60-second endpoints. This demonstrates that the settling guard can also fail
in the baseline; it does not establish stable settling for every trajectory or
erase the corrected build's original scenario miss. No threshold or physical
setting was adjusted. That variability remains an explicit open issue.

Two earlier candidates were rejected before deployment. The first left queries
behind a kinematic target; the second lost a stationary active body's observed
pose during a later fetch. Those failures explain why the final predicate
requires inactivity as well as exact pose equality.

The second rejected candidate also had one full-suite settling failure:
34 of 599 house nodes were awake at the eight-second facade checkpoint, above
the fixture's 5% expectation (175 tests passed, one failed, 27 ignored).
Three isolated repeats passed in each SDK arm: house awake counts were 20/0/22
in the baseline and 0/0/15 in that candidate, with zero post-burst house fractures.
The full ordered authored sequence subsequently passed all four tests in both
arms, with zero awake house chunks. The original failure remains recorded;
these repeats do not erase it or prove that all settling behavior is stable.
No assertion, force, velocity, fracture output or runtime settling setting was
weakened to obtain a pass. The assertion message now accurately identifies a
settling expectation instead of equating awake bodies with continuing fracture.

## Deployment status

The corrected build is live at
[the city](https://209.121.195.117:40617/city), with Direct GPU enabled. Comparison
against the saved previous process environment found no changes to the city,
world, Direct GPU or Blast physics settings. The active server binary hash is
`51efeb841976fe88eb5f52b1a2d84e4227ee2612d784463f82138315073a2f79`;
the loaded module is the expected `libPhysXGpuActivity_64.so`.

Local browser verification connected over WebTransport, bootstrapped once and
rendered all 96,420 chunks with zero JavaScript errors, orphaned chunks or hash
mismatches. It reported one structure repair. Public HTTPS passed; external UDP
was not verified. The 480×270 FAST/software-rendering check did not fire shots
and is functional bootstrap evidence, not destruction-streaming or visual/FPS
certification. Use Chrome/Edge and accept the existing self-signed certificate
prompt; the certificate expires September 17, 2026 at 05:46:36 UTC.

The promotion retains the open settling issue documented above. It is supported
by the focused query/momentum/replay checks, complete integration suite and
baseline controls; it does not relabel the failed scenario guard as a pass.
All GPU qualification windows used the scoped helper to pause only an empty
deployment and restore its exact previous binary afterward. The rollout saved
that prior binary at `.certs/vast-city/web-fps-server-before-contact-publication`
and kept the proxy, frontend, mapped ports and certificate.

Simulation sources are game commit `66a7257` and solver commit `646a0f41`;
solver `359b554e` adds the final inactive-shape query regression. Commits remain
local: pushing is still blocked by the previously reported automatic approval
review for private-source upload.

During preparation, the disk filled and a status check found the previous
server absent. Generated candidate debug build products were removed, then the
exact qualified release binary and saved settings were restored. The cause of
the process exit was not established.

## Evidence and remaining work

Evidence is in
[`bench-results/simulation-frontier/direct-contact-preparation`](../bench-results/simulation-frontier/direct-contact-preparation).
`baseline-*` denotes the original observation path; `candidate-*` and `final-*`
are the two rejected intermediate builds; `qualified-*` is the corrected
inactive-only predicate. The table above uses only `baseline-*` and `qualified-*`.
Earlier broad checks are retained under `qualification-preliminary` and
`qualification-active-kinematic`; `qualification` contains the final rerun.

CPU shape ownership, contact ordering, reduction and load routing remain the
next GPU-integration targets. The existing bending-gain ceiling, depenetration
limit, settling/idle regressions, full GPU topology checkpoint and other items
in the [simulation fidelity contract](simulation-fidelity-contract.md) remain
open. This increment does not establish that all inherited fidelity limiters
are gone. The broader simulation-frontier goal remains active.
