# Public city reports, 2026-09-06, 02:20–02:22 UTC

Three new public gameplay reports confirm that the rooted-fragment wire fix is
being exercised without the previous repeated structure repairs. They also
confirm that destruction still overwhelms the simulation tick, expose a startup
outbound-queue overflow, and retain below-ground chunk readings that need a
matched server/client pose capture. This is not evidence of a performance win.

The reports identify the actual deployed artifact: game `ed9c2ad`, solver
`646a0f414816204483c7eccdbd049fa1208e8f80`, SHA-256
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`.
The serving working directory's `21c1818-dirty` fingerprint is not the executable
revision. Direct GPU, CUDA stress, native sleeping, and existing freeze settings
remain in use. The experimental multilevel solver and GPU contact ordering are
not in this release. No simulation or transport setting changed for this report
analysis.

## Destruction and input delay

| Capture UTC | Shots reported by client | Server awake bodies | Server bodies | Tick mean | Tick p95 | Pending inputs |
|---|---:|---:|---:|---:|---:|---:|
| 02:20:45 | 5 | 1,020 | 1,840 | 21.26 ms | 45.59 ms | 0 |
| 02:21:32 | 19 | 3,712 | 5,535 | 76.84 ms | 126.08 ms | 0 |
| 02:22:00 | 21 | 5,435 | 7,427 | 115.48 ms | 200.62 ms | 109 |

Tick timings are 180-tick rolling windows. The final window is about 6.9 times
the 16.67 ms budget for 60 Hz; its reciprocal is roughly 8.7 ticks/second before
scheduling overhead. The last 109 queued 60 Hz inputs represent about 1.82
seconds of input history, not a measured end-to-end latency. The first two
snapshots show the queue empty. At disconnect after reset, the log records 120
pending inputs. The last report has 26,683 broken bonds.

The largest captured tick is 230.25 ms at tick 5,410: 173.29 ms city work and
55.64 ms dynamics. The ring retains parent spans only, so it cannot attribute
that outlier to a particular restore, fracture or contact operation. The final
300-tick ring overlaps 60 ticks of the preceding report; do not count overlapping
ticks twice or combine its mean with the separate 180-tick statistics.

The final first-physics-pass point sample contains 134,594 decoded contact
records (including friction records, not distinct contacting body pairs):

| Host phase | Time |
|---|---:|
| Ownership | 3.14 ms |
| Validation/canonicalization | 3.13 ms |
| Sorting | 9.70 ms |
| Reduction | 3.45 ms |
| Routing | 5.69 ms |
| **Host subtotal** | **25.12 ms** |

Device contact observation/copy adds 1.72 ms; the host pose mirror costs 1.76 ms.
The host contact subtotal alone exceeds the entire 60 Hz tick budget. The
02:21:32 replay point sample separately records 30.21 ms restore, 35.98 ms repeat
physics and 12.39 ms repeat destruction. Their sum is 78.58 ms within that
sample's 94.37 ms city step. The final point sample has no replay; its high
rolling city average does not mean replay was absent throughout the window.

These observations support work on exact contact processing and restore before
claiming that a faster stress kernel alone solves the full tick. Existing Direct
GPU host setters enqueue metadata for the next simulation; API call count is
not a count of PCIe round trips. Fine-grained native restore timing is needed
to locate the actual cost. The broader physical-solver and contact-ordering
qualification gates remain open.

## Topology and below-ground geometry

All three new reports have zero structure repairs, sequence gaps, hash
mismatches, settle rejects, and orphan counts. Hash checks increase 20 → 31 → 33;
only the two startup bootstrap events appear in the client event rings. The
previous six-report session contained 46 repeated repairs. This is encouraging
field evidence for the deployed rooted-fragment fix, not a controlled identical
shot replay or proof that every visual pose is correct.

Below-ground diagnostics read 0 → 221 → 145 chunk centroids below −0.25 m, with
minimum Y −0.17 → −3.02 → −2.81 m. The client computes these from its topology
ledger's composed chunk world poses. Server minimum body-origin Y reads +0.057,
−0.064 and −0.058 m. Body origins and chunk centroids differ, and client snapshots
are 38, 54 and 58 ticks later than the attached server snapshots; these values
cannot isolate a physics penetration from a client transform error.

All three `deepest` records are null: the producer only records chunk/body
provenance below −5 m. That threshold loses the details needed to diagnose this
session's shallower anomaly. A follow-up should record provenance whenever the
same −0.25 m diagnostic fires, plus corresponding authoritative shape poses.
Do not clamp positions or suppress contacts to make the diagnostic green.

The geometry sweep is gated, and reports do not carry its execution timestamp
or enabled state. Nonzero ground readings establish that a sweep ran at some
point; zero stale-drawn counts and empty teleport rings do not establish
continuous visual correctness. The analyzer now retains the geometry fields
and explicitly documents these limits instead of omitting the anomaly.

## Startup outbound queue overflow

All three reports contain the same cumulative 565 outbound drops, including 273
snapshots. They did not increase between these captures. Server logs locate the
overflow at 02:19:59.752–02:20:04.285 during the second connection's startup,
before the first gameplay report. At 02:20:04.304 the server logs a replacement
bootstrap after a dropped reliable packet. This matches two client bootstrap
events and is distinct from the now-absent structure repair loop.

The 287 explicit non-droppable warnings comprise 273 local-player energy
packets (kind 115), five city baselines (121), five match-stat packets (124), two
city topology hashes (128), and two player rosters (113). The warning count is not the
entire drop counter; other droppable packets have no per-packet warning.

Source inspection finds one bounded outgoing queue shared by reliable traffic
and datagrams. The WebTransport writer awaits an entire reliable write before
it drains the next item; `try_queue_packet` drops even non-droppable packets
when that queue is full. This makes a reliable-stream stall capable of blocking
otherwise independent datagrams. The reports/logs show the overflow and
rebootstrap; they do not capture the exact network write responsible for the
stall. Merely increasing the queue would not establish a correctness fix.

Next transport qualification should deliberately stall bootstrap consumption,
verify independent datagram progress and ordered reliable delivery, and retain
explicit overload behavior without blocking the authoritative simulation.

The client remains on public WebTransport in all three reports. No datagram
fallbacks, malformed packets or GPU warnings are recorded. Zero destruction
queue drops applies to that queue only. A falling bytes-per-second rate during
slow ticks is not sufficient evidence of bandwidth saturation.

## Browser and remaining evidence

Client frame point samples are 36.19, 20.78 and 7.95 ms; GPU frame samples are
21.14, 8.01 and 3.46 ms. The early browser frame is expensive too, but these three
samples cannot establish a sustained FPS distribution or its cause. The
periodic telemetry timer is retained between invocations; do not add it to
every frame. The final server cost is much larger than that browser sample.

The log contains 22 shot routes and 21 hits before reset, including one miss
after the last report. Four native "requires a prior capture" errors occur
after reset and must not be attributed to the preceding demolition without
more evidence. Snapshot validity across reset remains a correctness audit item.

The [source-hashed summaries](../bench-results/simulation-frontier/player-reports-2026-09-06/summary.json)
and [selected session evidence](../bench-results/simulation-frontier/player-reports-2026-09-06/session-events.json)
retain the supporting measurements without committing raw reports, player
positions or addresses. `verify-results.py` reproduces the analysis, checks
original file hashes, independently verifies the key totals, and verifies that
schema 3 preserves all previously recorded measurements. No deployment is
claimed by this analysis.


## Restore profiling follow-up

The [native restore attribution](restore-profile-2026-09-06.md) now supplies a
validated contact-free reference and opt-in phase instrumentation. It restores
6,001 bodies in 1.48 ms median without profiling, so reproducing the contact-heavy
city state matters before attributing its 30.21 ms restore to API call count.
That work is committed but not deployed; it records a high-coordinate numerical
precision failure separately and makes no city speedup claim.


## Streaming release follow-up

The [outbound stream fix](outbound-stream-isolation-2026-09-06.md) is deployed.
Datagrams and recoverable fallbacks no longer occupy reliable-state queue slots;
a stalled reliable write does not block WebTransport datagram submission.
Private city destruction and public browser checks passed. Heavy simulation
ticks and below-ground geometry remain open, with no claimed physics speedup.


The subsequent [exact-shot recorder qualification](shot-input-replay-2026-09-06.md)
found and corrected recorder drift in shot range and authored building heights.
Its full-height manifest now matches this live city exactly. Recorded inputs are
replayed bit for bit at 5–7k awake-body loads, while physical outcome variation
remains visible. This supplies better comparison inputs; it does not resolve the
reported below-ground geometry or establish a new simulation speedup.


The later [04:46 live session analysis](city-player-reports-2026-09-06-live.md)
contains six more human reports and a read-only live capture. It confirms zero
recorded outbound drops or topology repairs on the new streaming build while
exposing much larger contact batches and rollback costs. The observed city
geometry and diagnostic provenance issues remain open.
