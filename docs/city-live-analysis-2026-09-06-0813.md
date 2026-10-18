# Live city analysis, 2026-09-06 08:13 UTC

The running city is healthy as a service but remains substantially slower than
its 60 Hz simulation target. Ten read-only samples from **08:13:29–08:14:14 UTC**
observed the same executable, PID 166548, with one connected player. No build,
benchmark, restart, shot or configuration change was performed during capture.

## Measured performance

| Measurement | Observation |
| --- | --- |
| Rolling tick average | 127.16–138.55 ms; target 16.67 ms |
| Rolling tick p95 | 134.87–148.37 ms |
| Published tick advance | 300 ticks / 45 seconds, approximately 6.7 ticks/s |
| Awake bodies | 8,883–8,905 |
| Frozen bodies | 24,451–24,468 |
| Broken bonds | 126,534 → 126,539 |
| First-pass host contact processing | 59.46–74.83 ms; point-sample mean 65.20 ms |
| GPU utilization | 2–17%; sampled mean 10.3% |
| Process CPU consumption | 1.33 core equivalents across all threads |
| Shared city encoding | Point-sample mean 1.82 ms |
| Per-client datagram preparation | Point-sample mean 0.147 ms |
| Outbound traffic | 1,051 packets, 1,064,608 bytes; 0.189 Mbps in wall time |
| New outbound queue drops / malformed packets | 0 / 0 |

Published stats update every 60 simulation ticks: the wall tick rate is
quantized, not a precise scheduler measurement. Ten samples contain six distinct
published snapshots. Rolling windows overlap and repeated phase samples are
not independent ticks. GPU utilization measures sampled engine duty cycle,
not occupancy or a kernel profile. No before/after speedup is inferred from this
evolving scene state.

Merging overlapping tick histories by tick number yields 600 unique consecutive
ticks, including history before the capture. Their mean is **130.13 ms**, p95
**141.11 ms**, maximum **534.51 ms**. The worst tick, 128249, attributes 433.69 ms
to city work and 91.22 ms to first-pass dynamics. This history does not identify
its exact expensive subphase. Point samples showing zero replay time cannot
rule out replays between published snapshots.

The host contact point means break down as follows: ownership 5.80 ms,
validation 6.87 ms, sorting 18.27 ms, reduction 14.03 ms and routing 20.23 ms.
Contact observation/copy adds a separately measured 2.17 ms. Each sampled
first pass has approximately 240,581–243,282 decoded contact records.
GPU stress solve averages 2.49 ms in its point samples, while the encompassing
stress phase averages 21.74 ms. Rollback capture averages 8.88 ms even though
the sampled restore/replay values are zero. Parent timers overlap child timers;
these measurements must not all be added together.

These observations continue to prioritize the CPU contact path and rollback
bookkeeping over packet encoding. They support CPU-side overhead as a major
cause of GPU underuse, without establishing the cause of every idle interval.
The server processes another 5,927,350 queued destruction-contact entries during
the window and records zero dropped contacts or GPU warnings.

There were 162 freeze operations, 151 unfreeze operations, 140 contact wakes and
87 resettled wakes. This is measurable activity in the rubble, not proof of
incorrect sleep behavior. Investigating the causes requires body/contact
provenance; increasing sleep thresholds or suppressing contacts would not be a
fidelity-preserving fix.

Only five inbound packets / 25 bytes arrived. Pending input was zero throughout,
so this quiet-input interval **does not qualify responsiveness during movement**.
The earlier human reports' input backlog remains relevant.

## Submitted reports and geometry

The latest six human gameplay reports remain the ones captured at
04:46:05–04:47:58 UTC. The three newer saved reports at 07:51–07:55 UTC are local
headless bootstrap captures, with missing city/frame telemetry. Their null
geometry fields are not clean geometry results. The separate successful browser
verification evidence is recorded in [the diagnostic deployment note](client-diagnostics-2026-09-06.md).

The human reports show growing below-ground chunk counts, reaching 164, and a
minimum chunk-centroid Y near −1.994 m. The diagnostic client now captures
provenance below the same −0.25 m threshold used by that count.

A further source check narrows the interpretation of the deepest later sample:
the deployed city ground is a box spanning **x/z ±2,000 m**, y −20 to 0, while
the client-observed fragment is near **(2,469.03, −40.46, 512.89) m**. Its centroid
is about 469 m beyond the slab in X. This does not establish tunneling through
the ground; falling beyond its edge is consistent with the observations. There
is no recorded trajectory proving how it arrived there. The deployed
`server/src/demo_world.rs` matches source revision `a4685b3` for this path.
This finding does not explain the original shallow chunks near the buildings.

The inherited kill-floor parking path still has the minimum-height/settle-state
blind spot described in the diagnostic note. No ground enlargement, retirement,
velocity clamp, freeze policy or physical intervention was added here.

## Enabled state and next implementation work

The backend remains game `a4685b3`, solver `bd71ce1b`, executable SHA-256
`7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee`.
**Direct GPU physics, CUDA stress, custom native sleep and the existing freeze
system are enabled.** The diagnostic client was deployed at 07:54:18 UTC; a
reload loads it. This analysis does not deploy a new backend or claim a new
simulation speedup.

The compact-contact candidate is implemented and CPU-tested in both the game
and dependency release branches. Its optional audit compares complete contacts,
ordering, scalar sums, pair history and emitted events against the legacy path
on the same inputs. It remains disabled pending exclusive full-city GPU auditing,
matched-work performance runs, settling and multiplayer checks. Those checks
must run without competing with the connected player's GPU simulation. The
candidate's details and test evidence are in [compact contacts](compact-contacts-2026-09-06.md).

For the larger GPU rollback change, source tracing identifies a correctness
obstacle that a three-array GPU write cannot bypass:

1. Production restore calls `setGlobalPose`, which changes the mass-frame pose,
   updates shapes and resets contact managers; sleeping interactions and triggers
   also receive transform-change notifications.
2. GPU contact-manager refresh can remove an entry with swap/pop and append it
   again. Repeated refreshes can therefore affect contact-manager ordering as
   well as cached state. Deduplicating them needs explicit equivalence evidence.
3. The Direct GPU pose kernel updates device poses, shape transforms and bounds,
   but does not execute those host contact-manager reset operations. It uses the
   device mass frame, which can also lag pending fracture/mass changes.

A GPU rollback implementation must cover those semantics, changed bodies and
new fracture children, and then qualify replay contacts and impulses. This is a
source finding, not an implemented or benchmarked GPU rollback replacement.
It reinforces why contact processing and capture reuse are useful alongside the
already-enabled Direct GPU mode.

[Sanitized samples, source hashes and verifier](../bench-results/simulation-frontier/live-0813-2026-09-06/summary.json)
retain the evidence. Original player reports and private deployment configuration
were not modified or copied into this archive.
