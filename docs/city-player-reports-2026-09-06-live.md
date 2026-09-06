# Live city session, 2026-09-06 04:46–04:57 UTC

Six new human reports show the deployed streaming change surviving a substantially
heavier collapse without the earlier queue overflows or topology repair loop.
The simulation remains far below the 60 Hz target. Large CPU contact batches and
rollback/replay dominate the worst ticks; the later live sample leaves most GPU
capacity idle. Below-ground chunk diagnostics remain unresolved.

The executable was verified directly through `/proc/166548/exe`: SHA-256
`7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee`,
game `a4685b3`, solver `bd71ce1b`. The serving checkout's `a59e4ac-dirty`
fingerprint is not the executable revision. Direct GPU, CUDA stress, native
sleeping and existing freezing remain enabled. Contact-ordering and restore
context experiments remain disabled. No server restart, build, benchmark, or
configuration change occurred during the live observation.

## Report progression

Times are the client capture times; attached server snapshots are cached and
asynchronous. Tick averages and p95 values cover 180 simulation ticks.

| Capture UTC | Client shots | Awake bodies | Broken bonds | Tick mean | Tick p95 | Pending inputs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 04:46:05 | 4 | 1,579 | 7,717 | 24.57 ms | 48.38 ms | 0 |
| 04:46:36 | 7 | 2,148 | 12,261 | 40.27 ms | 75.67 ms | 0 |
| 04:46:58 | 16 | 4,066 | 21,100 | 73.23 ms | 131.05 ms | 0 |
| 04:47:11 | 20 | 4,599 | 22,754 | 95.03 ms | 145.64 ms | 0 |
| 04:47:52 | 20 | 7,126 | 32,681 | 152.00 ms | 272.83 ms | 112 |
| 04:47:58 | 21 | 7,887 | 35,434 | 235.51 ms | 450.28 ms | 112 |

The last report has 9,581 chunk bodies. Its maximum retained tick is 487.70 ms
at tick 5,275: 128.83 ms dynamics and 355.43 ms city work. These parent spans
must not be added again to their children. The 112 pending frames represent
1.87 seconds of nominal 60 Hz input history, not a measured input-to-display
latency. The late report's mean is about fourteen times the 16.67 ms tick budget.
This session produced more destruction than the earlier reports; it is not an
identical-input before/after performance comparison.

The final first-pass point sample decoded **491,861 contact records**, including
normal and friction records rather than distinct body pairs:

| Contact phase | Host time |
| --- | ---: |
| Ownership | 2.95 ms |
| Validation/canonicalization | 8.26 ms |
| Sorting | 39.76 ms |
| Body-pair reduction | 16.06 ms |
| Routing | 25.65 ms |
| **CPU subtotal** | **92.68 ms** |
| Device contact observation/copy, separately | 3.97 ms |
| Host pose mirror, separately | 1.62 ms |

The same report's replay point sample records 137.07 ms restoration, 158.29 ms
repeat physics, and 16.57 ms repeat destruction. The snapshot can combine
cached values from different substeps; these are attribution clues, not a
reconstruction of the maximum tick above. They demonstrate that optimizing the
stress kernel alone cannot remove the dominant cost.

## Direct observation while the player remained connected

Ten read-only samples ran from **04:50:34 to 04:51:19 UTC**, about five seconds
apart. No GPU benchmark or build competed with this capture.

- The 180-tick means ranged from 76.34 to 82.99 ms. Their sample mean was
  79.73 ms; this is not a mean of independent, non-overlapping tick windows.
- Published tick numbers advanced 540 over 45 seconds: approximately **12
  authoritative ticks/second**, or nine simulation seconds in 45 wall seconds.
  Stats publish every 60 simulation ticks, so this rate is quantized.
- Awake bodies declined from 7,613 to 7,390. Frozen bodies increased from
  1,977 to 2,244; broken bonds increased from 36,334 to 36,425.
- GPU utilization samples ranged from 2% to 15%, averaging 9.2%. These are
  sampled engine duty-cycle values, not SM occupancy or a kernel profile.
  Process CPU consumption averaged 1.38 core equivalents across all threads.
- First-pass contact CPU work ranged from 30.27 to 39.10 ms, averaging
  33.40 ms across the point samples. Sorting averaged 11.78 ms, reduction
  6.11 ms and routing 8.67 ms. Contact observation/copy averaged 1.45 ms.
- GPU stress time averaged 6.15 ms in the sampled field. Shared city encoding
  averaged 1.08 ms and per-client datagram preparation 0.24 ms. Their scopes
  differ; they are not additive with all other parent/child timings.

This supports a CPU-limited contact/restore path rather than GPU saturation.
It does not isolate whether every GPU idle interval is caused by that path.
The slow simulation also stretches settling in wall-clock time: the debris
experienced only nine simulated seconds during this 45-second observation.

Only nine inbound packets/45 bytes arrived during the sample; input traffic
was low, and pending inputs were zero throughout. That does not establish
responsiveness during active movement or erase the backlog in the reports.

A final read at **04:57:22 UTC** found one connected player, 5,431 awake bodies,
37,183 broken bonds, a 56.38 ms rolling tick mean, 72.87 ms p95 and 194.23 ms
maximum. Pending inputs, outbound drops and GPU warnings were zero. The city
continued settling, but still exceeded the target tick budget substantially.

## Streaming and geometry

All six reports show WebTransport, one bootstrap, and zero sequence gaps,
repairs, hash mismatches, orphan counts and settle rejects. Hash checks increase
14 to 31. All report snapshots have zero outbound queue drops, fallbacks,
malformed packets, recorded destruction-contact drops and GPU warnings. These
are the recorded checks, not proof that no Internet datagram was ever lost.

The live sample added 1,070 reliable packets and 2,845 datagrams, with zero new
queue drops or malformed packets. Outbound byte-counter growth was 3,753,596
bytes over the observation, approximately 0.667 Mbps in wall time. This is
field evidence for the streaming fix under this session's load, not a general
network-capacity or latency certification.

Below-ground chunk counts rise **0 → 1 → 15 → 18 → 127 → 164**. The last
minimum chunk-centroid Y is −1.994 m, while the attached server's minimum body
origin is +0.024 m. Those are different reference points observed at different
times, so they cannot distinguish physical penetration from a transform error.
`deepest` remains null because the producer uses −5 m for provenance despite
counting sunk chunks below −0.25 m. Stale-drawn counts are zero, but sweep
activation/timestamps are absent; this is not a complete visual correctness
proof. Matching authoritative shape poses and client chunk provenance are still
needed. Position clamps would hide the symptom and are not a fix.

Client frame samples are approximately 20–35 ms, not an FPS distribution.
The retained periodic diagnostic timing is 19.84–24.28 ms. It may contribute
hitches while diagnostics are enabled; it is not an every-frame cost, and its
last value is not necessarily aligned with the frame containing the report.

## Telemetry interpretation and next work

Two names in the existing telemetry are misleading under slowdown:

- The `city stream` log's `encode_ms` is `city.last_encode_ms`, which includes
  the broader destruction/city step. Use `encode_shared_ms` and
  `client_datagrams_ms` for the dedicated stream work. `publish_ms` measures
  stats publication and is one published snapshot behind, not city encoding.
- City `packets_per_sec`, `records_per_sec`, `bytes_per_sec` and logged Mbps
  drain counters every 60 simulation ticks. At 12 ticks/second those counters
  span about five wall seconds. Use wall-time network counter differences for
  actual traffic rates. Their producer needs a wall-time denominator or clear
  interval labels.

The evidence prioritizes CPU contact sorting, reduction and routing together,
plus native rollback pose/contact invalidation. The existing GPU tie-order
candidate remains withheld because downstream floating-point accumulation and
settling qualification are unresolved. A compact-key sorting probe is promising
for preserving the exact legacy sequence, but is only a synthetic CPU prototype;
it is neither integrated nor deployed. The broader goal remains moving contact
ownership and stress-load assembly onto the GPU with full interaction fidelity.

[Derived reports, live observations and verifier](../bench-results/simulation-frontier/player-reports-2026-09-06-live/summary.json)
retain source hashes and sanitized timing/counter snapshots. Player identities
and positions are excluded from committed live captures. Original submitted
reports remain unchanged under `debug-reports/`. The
[previous session](city-player-reports-2026-09-06.md) and
[exact-input recorder qualification](shot-input-replay-2026-09-06.md) remain
separate evidence.
