# City player reports, 2026-09-05, 18:51–18:54 UTC

The six latest reports show a server simulation bottleneck during destruction,
plus repeated structure-content repairs. They do not establish a GPU physics
failure or a bandwidth bottleneck. This investigation made no runtime changes,
restarted no services, and deployed no new build.

The running city is still the qualified Direct GPU observation increment:
server source `66a7257`, solver runtime `646a0f41`, binary SHA-256
`51efeb841976fe88eb5f52b1a2d84e4227ee2612d784463f82138315073a2f79`.
Both `/proc` and the reports confirm `VIBE_PHYSX_DIRECT_GPU=1`, CUDA stress,
lazy impulse observation, 32 solver iterations, and one configured replay pass.
The reports identify the server build as 18:27:39, started at 18:48:12.
The source fingerprint includes `-dirty`; the previous deployment report records
the qualified artifact identity. No force, impulse, speed, contact, body, or
fracture budget was added for this analysis.

## What happened during play

These are the server's **180-tick rolling windows**, not instantaneous measurements
or fixed wall-clock windows. Client capture time and the attached server snapshot
are asynchronous; the client was 14–53 ticks beyond the snapshot's tick in these
reports. Awake/body counts below come from the server, not the client's count of
individual chunks.

| Client capture UTC | Shots fired | Awake bodies | Total tick mean | Total tick p95 | Pending player inputs |
|---|---:|---:|---:|---:|---:|
| 18:51:31 | 6 | 282 | 10.68 ms | 13.80 ms | 0 |
| 18:51:56 | 13 | 1,856 | 29.07 ms | 72.48 ms | 0 |
| 18:52:08 | 14 | 3,905 | 62.53 ms | 137.76 ms | 8 |
| 18:53:01 | 15 | 5,008 | 93.18 ms | 202.47 ms | 58 |
| 18:53:32 | 17 | 5,288 | 64.26 ms | 151.57 ms | 0 |
| 18:54:01 | 17 | 5,965 | 109.89 ms | 186.07 ms | 87 |

At the last snapshot there were 8,295 chunk bodies and 29,992 broken bonds.
The 60 Hz simulation target has a 16.67 ms tick budget. The last rolling mean
corresponds to at most about nine ticks per second before scheduling overhead,
not sustained 60 Hz. The 87 queued input frames represent about 1.45 seconds of
60 Hz input history. The queue also drained to zero between slow periods; do not
describe it as continuously growing throughout the session.

The worst recorded tick was **853.49 ms at tick 13,632**: 417.63 ms in dynamics
and 423.96 ms in the city phase. Its report ring records only those parent
timings, so it cannot identify the precise cause of that outlier. Ordinary
high-load ticks and the single extreme hitch need separate investigation.

## Largest measured costs

The final report's **first-physics-pass point sample** contains 125,953 decoded
contact records. Normal contact points and friction anchors are records, so this
is not a count of unique body pairs. Host contact work is:

| Phase | Wall time |
|---|---:|
| Ownership lookup construction | 2.88 ms |
| Validation and canonicalization | 2.61 ms |
| CPU sorting | 8.85 ms |
| Body-pair reduction | 2.75 ms |
| Routing | 5.46 ms |
| **Host subtotal** | **22.54 ms** |
| Device contact observation/copy, additional | 1.14 ms |

That host subtotal alone exceeds the entire 60 Hz budget. The preceding
observation optimization remains useful: pose publication is 1.19 ms in the last
point sample. The expensive remaining work processes contacts after the GPU
simulation and repeats when fracture replay runs.

The 18:52:08 point sample includes a replay: restore takes 36.89 ms, the repeated
physics step 42.57 ms, and repeated destruction 8.89 ms. These are specific
observations, not replay averages. The final snapshot has zero replay passes
for its sampled tick, while its rolling city phase still averages 67.61 ms:
mixing that point sample with the window would hide the expensive replay ticks.

The next performance work should move contact canonicalization/ordering and
eventually ownership/load assembly onto the GPU, and reduce restore overhead
while preserving fracture-child motion, forces, contact behavior, and same-tick
replay. Preserve every contributing contact and the required accumulation order.
Measure the complete tick, including replay and streaming, at this 5–6k-awake
load. The previous no-shot browser smoke test did not exercise it.

## Structure repairs are real, but the log reason is misleading

The client recorded **46 structure repairs**, 41 involving structure 2, with a
median interval of 3.112 seconds. That is close to the client's existing
three-second resync retry interval. All six reports have zero topology sequence
gaps and zero hash mismatches; they also have zero settle-frame rejects.

The server logs every structure-scoped `CityResyncRequest` as a "ledger hash
mismatch". The protocol carries structure IDs but no reason, and the client
also sends that request when `resyncStructures` contains migration faults.
Therefore **46 repairs is not evidence of 46 hash-check failures**.

Source tracing narrows the likely trigger to missing migration destinations:
the two paths populating `resyncStructures` are an absent destination body and a
rejected settle pose, and the latter counter is zero. This is an inference from
the reports and source, not an exact packet replay. Ordinary reports omit
`migrateAnomalies` and the offending node/from/to IDs. Those details currently
reach only the optional recorder. Capture them at the fault and replay the
resulting reliable packet sequence before changing migration semantics.

No report contains an orphaned chunk, retirement orphan, or teleport-probe event.
Those checks do not prove every displayed pose was correct, and a repair can
heal a mismatch before a point sample. The diagnostics do not quantify the
visual displacement caused by these repairs.

## Browser, network, and shot diagnostics

All six client reports say `webtransport`, and the matching server snapshot has
one WebTransport player. This is evidence from the user's public-city session,
in addition to the earlier local smoke test. It does not measure packet loss
or establish unlimited transport capacity.

Sampled client frame times range from 8.55 to 14.73 ms; sampled GPU frame times
range from 4.99 to 8.97 ms. These six frame profiles are not a sustained FPS
distribution. They indicate that the observed server cost is much larger than
these browser frame samples. The retained `telemetryMs` value is 10.08–12.62 ms:
that diagnostic block runs once per 30 rendered frames, and its last timing is
retained between invocations. Do not add it to every reported frame's cost.

The client's observed receive rate is approximately 43–234 kB/s across the
reports. The server reports no datagram fallbacks, malformed packets, or dropped
outbound packets/snapshots in the six captured windows/counters. That does not
rule out network jitter, but it does not support blaming transport saturation
for the 110 ms server work. The log's closed-connection/drop messages follow
the player's 18:54:06 disconnect, after the final report.

The server log records **17 city shot attempts and 15 city hits** during the
session. The client's last-shot text repeatedly says `confirmed=no` and
`dyn_body=0`; city damage uses its separate shot-routing path, so those generic
fields must not be interpreted as proof that the city shots failed. Likewise,
the report's zero generic FPS/ping/snapshot counters conflict with its active
frame, transport and city stream observations and are not usable measurements
of this session's frame rate or latency.

## Fidelity and remaining uncertainty

The last report records 23,096,832 queued and processed destruction contacts,
zero contacts dropped at that queue, zero escaped bodies parked, zero unmapped
body skips, zero duplicate body records, zero GPU warnings, and `degraded=false`.
These counters have specific scopes; they do not certify that all upstream
filters, engine limits, numerical formulas, or replay paths preserve fidelity.
The existing [fidelity audit](simulation-fidelity-contract.md) remains open.

The reports show continued breakage and increasing awake bodies after shots,
but contain no contact-force/energy history or ground-truth load comparison.
They cannot distinguish a legitimate progressive collapse from spurious
stresses or incorrect wake behavior. Do not suppress those fractures or freeze
those bodies to meet a performance expectation.

Priorities established by this investigation:

1. Remove the measured host contact bottleneck and preserve exact interaction
   coverage; qualify the gain under heavy destruction and replay.
2. Reduce replay restore/observation work with correct topology and motion
   semantics. Do not reduce replay coverage to improve the graph.
3. Capture and reproduce missing migration destinations, correct the repair
   log terminology, and fix the actual ledger producer/consumer disagreement.
4. Include input backlog, periodic client telemetry spikes, and end-to-end
   streaming in subsequent full-tick qualification. Keep the 853 ms outlier
   open until a capture can attribute its inner phases.

## Reproduction and evidence

The original `debug-reports/report-1788634*/client.json` and `server.json` files
are unchanged and remain outside version control. The committed
[summary](../bench-results/simulation-frontier/player-reports-2026-09-05/summary.json)
includes both source SHA-256 hashes for each of the six reports, selected
physics settings, separate point/window/counter data, and derived contact sums.
Player locations and arbitrary environment data are omitted.

From this checkout:

```bash
python3 scripts/analyze-city-reports.py debug-reports/report-1788634* \
  --out /tmp/city-player-reports-summary.json
cmp /tmp/city-player-reports-summary.json \
  bench-results/simulation-frontier/player-reports-2026-09-05/summary.json
```

The report analysis was validated by reproducing the JSON and independently
checking its input counts, checksums, aggregate timings, and worst tick against
the originals. No physics or gameplay tests were run for this read-only analysis;
it changes neither the simulator nor the deployed client.

The first implementation follow-up is the
[GPU contact-ordering experiment](gpu-contact-order-2026-09-05.md). It reduced
ordering time in benchmarks, but is not deployed because expanded settling
controls left a possible regression unresolved. The existing Direct GPU city
remains available; the repeated topology repair issue is still open.


## Follow-up: rooted-fragment promotion gap

A subsequent source audit found a concrete candidate for the missing-destination
path. In `DestructionManager::collect_events`, a first-seen kinematic rooted
fragment receives a real island serial, but the promotion event is emitted only
inside `if (!bodies[i].kinematic)`. The later shape loop still emits migrations
to that serial. The client requires the destination to exist and requests a
structure repair when it does not. The server ledger also silently skips an
absent migration destination, so a bootstrap need not restore that fragment.

This is a reproducible source-level inconsistency to target with a rooted-split
fixture, not yet a packet-level identification of the six reported failures.
The existing supporter fixture observes rooted fragments but does not assert
that every migration destination is represented in the wire ledger. Correcting
this requires preserving rooted identity, pose, support and later dynamic
promotion semantics; merely suppressing the repair request would hide the fault.
No topology runtime fix has been deployed as part of this follow-up.

## Later report inventory and solver follow-up

A later inventory still found these six reports to be the latest submissions.
Re-running `analyze-city-reports.py` reproduced the committed summary exactly.
The [native solver setup follow-up](multilevel-native-setup-2026-09-05.md) records
additional standalone numerical checks and their limits. It did not deploy a
new city build or fix the repair loop. The reported contact/replay costs and
missing migration destinations remain open qualification targets.

## Inventory on 2026-09-06: distinguish local verification from play

Two later files exist, captured at 23:45:59 and 23:48:43 UTC. Both identify a
loopback URL, HeadlessChrome and the 480×270 verification viewport. Their client
city snapshots are null, frame counters are uninitialized and event rings are
empty. The server snapshots have zero connected players; the corresponding
server log records only loopback sessions around these times. They are local
verification captures, not new evidence from the user's public play session.
Do not interpret missing counters as zero faults or these idle server timings
(2.98 and 2.78 ms rolling means) as a destruction performance improvement.

The original analyzer raised TypeError on the null city snapshot. Schema 2 now
retains absent city counters as null and records loopback/headless provenance,
telemetry availability, and the allowlisted actual release identity. It does
not infer that an unclassified capture is a human session. Both newer captures
identify release game `ed9c2ad`, solver `646a0f41`, and binary `9b405a0199af…`.
The source-worktree fingerprint alone would identify the wrong build.

All original fields in the six play summaries still match the archived schema-1
results exactly. The schema-2 copies and supplemental local captures are in
`bench-results/simulation-frontier/report-inventory-2026-09-06/`; its
`verify-results.py` checks that preservation, release identity and missing-data
semantics. The earlier literal `cmp` reproduction is specific to schema 1;
compare the original report fields or use this verifier with schema 2.

The rooted-fragment creation/rest-pose fix is now deployed; see
`rooted-fragment-wire-2026-09-05.md` for its tests and limitations. The earlier
sections above record state at the time of each investigation, not current
release status. This inventory changes only analysis tooling and evidence;
no new city runtime or frontend deployment was needed.


## New public session on 2026-09-06

The [02:20–02:22 UTC gameplay reports](city-player-reports-2026-09-06.md) now
exercise the deployed rooted-fragment fix: no repeated structure repairs, but
115.48 ms rolling tick mean at 5,435 awake bodies. They also expose a separate
startup queue overflow and below-ground geometry readings. Use that report for
the latest player observations; the local captures above remain idle checks.
