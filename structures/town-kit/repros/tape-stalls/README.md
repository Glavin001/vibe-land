# September 21: four-building stop-motion and projectile rebound

The supplied 70-second tape demonstrates two different faults. The main stop-motion
fault is now fixed and deployed. The roof impact behavior is reproduced in native
physics, but is **not yet fixed or qualified**. No roof-strength experiments were deployed.

## Confirmed stop-motion root cause

The server's body identity layout had been expanded to support more independent
buildings: 8 structure bits and 20 island bits. Rust `destruction/src/ids.rs` and
C++ `physx-bridge/src/native_destruction.cc` agreed. The browser's
`client/src/city/topology.ts` still used 6 structure bits and 22 island bits.

Example, structure 2 / island 719:

- The server sends `0x802002cf` (2149581519).
- The old browser constructs `0x808002cf` (2155872975) for that same island.
- `CityClient.applyRecord()` cannot find the body and buffers the movement record.
- Topology promotions and periodic structure repair messages still carry poses,
  so pieces update intermittently, with long holds between those updates.
- Structure 0 is unaffected by this packing difference. Tests only exercising
  structure 0, or using the browser's own ID helper as their producer, missed it.

This is an integration error in the independent-building migration, not a renderer
running at two frames per second. It also explains why topology/bond agreement can
look healthy: topology and movement are separate streams.

### Identical bytes through the actual CityClient

`replay-client.mts` feeds recorded packet arrivals through the shipping CityClient,
using a deterministic clock and 120 Hz presentation sampling. No substitute client
or synthetic motion model is used. The replay covers the first 61 seconds.

| Structure | Old client matched / attempts | Corrected matched / attempts |
|---|---:|---:|
| 0 | 81,167 / 81,211 | 65,311 / 65,355 |
| 1 | 0 / 205,582 | 102,960 / 103,224 |
| 2 | 0 / 56,098 | 28,049 / 28,049 |
| 3 | 0 / 405,322 | 202,895 / 202,931 |

These are application attempts, **including buffered retries**, not unique wire
records. The difference in totals is expected: matching records stop being retried.
The small remaining misses are concentrated around topology arrival/lifecycle
transitions; this audit alone does not prove every pending record eventually applied.

For body `2149581519`, from 58.2 to 60.0 s:

- Old display position stays exactly `[-13.17, 2.880889, -16.31]`.
- Corrected position moves from `[-13.187333, 2.900222, -16.420667]` to
  `[-13.745562, 1.045901, -18.639494]`.
- At 58.64 s the tape contains 60 server observations in the last second,
  a last physics step of 3.90 ms, and 4,285 awake bodies. There are occasional
  expensive impact ticks, but those do not explain the multi-second body holds.

Actual browser screenshots were also captured and inspected using the supplied
tape. `replay-comparison.jpg` shows the same damaged building around replay time
58.2 s, before/after the ID fix. Browser playback uses software rendering and slowed
playback; its FPS is **not** a production benchmark. Use deterministic replay data
for frame-by-frame measurements. Screenshots have small capture-time differences.

## Fix and validation

Only the body-key packing/unpacking helper changed in production. Both now use a
`0x100000` structure stride. Six regression cases use literal Rust-compatible wire
IDs for structures 0, 1, 2, 3, 64 and 254, and check that another building stays put.
Five nonzero-structure cases failed before the fix. All 69 related tests pass after
it, and the client type check passes.

The public client was rebuilt/deployed using `.claude/skills/vastai-deploy/SKILL.md`.
The four-building asset, correction limit 1 and server physics settings were preserved.
Public HTTPS and local-browser WebTransport/bootstrap/render checks passed. The
browser connection check bypasses public NAT locally; it is not remote UDP proof.
Deployment health and the manifest hash are saved with this review.

Public page: https://209.121.195.117:40613/city

## Native projectile comparisons

The private `house-impact-review` harness now records the projectile's position and
velocity **every physics tick**, in addition to chunk poses/membership, breaks,
convergence and body motion. Cannonballs use the city's 10,650 kg / 60 m/s launch.
Meteors use the actual server planner, seed 20260921, radius 2 m and mass ~110,584 kg.
All comparisons use gravity 9.81, the deployed runtime, one building in isolation,
and real collision-driven destruction. Each starts only after 30 consecutive
simulated seconds of intact convergence, rest and zero breaks/crushing.

GPU cases ran sequentially. The public server was also running; timings are not
exclusive-GPU benchmarks. Per-case provenance records hardware, source/runtime/binary
hashes, settings and exact assets. Numerical trajectories are the evidence here.

| Case | Corrections | Result at first impact | Total broken bonds (15 s) |
|---|---:|---|---:|
| Reference two-storey, meteor | 1 | Continues down at 112.9 m/s; penetrates | 1,453 / 1,714 |
| Bayline porch house, meteor | 1 | Reverses upward at 16.15 m/s | 738 / 7,458 |
| Bayline bungalow, meteor | 1 | Reverses upward at 7.43 m/s | 1,597 / 4,318 |
| Bayline bungalow, cannonball | 1 | X velocity +60 -> -4.29 m/s | 407 / 4,318 |
| Same bungalow/shot, cannonball | 2 | Continues at +58.99 m/s | 934 / 4,318 |
| Bayline porch house, cannonball | 1 | X velocity +60 -> -0.64 m/s | 627 / 7,458 |
| Reference two-storey, cannonball | 1 or 2 | This particular shot also rebounds | 57 / 1,714 |

The reference cannonball shot is not a universal penetration baseline: it hits a
particular wall/window region. The meteor comparison and bungalow correction A/B
are the strongest controlled results.

`native-impact-comparison.jpg` contains actual recorded native poses and a sphere
at the measured projectile position. It confirms the porch roof loses a small
patch while retaining most of the building, whereas the reference largely collapses.
These are native poses, without the network/client identity bug.

### What causes the different impact behavior, and what remains unresolved

The bungalow cannonball comparison establishes a contact-correction depth problem
for this layered construction: one corrected solve leaves it rebounding; two let
it penetrate. The native bridge documents that each extra correction allows another
fracture/contact reevaluation inside the same physics tick. The authored houses
contain overlapping-in-projection layers (siding, infill/frame, trims; roof covering,
rafters and a solid ceiling deck). They need to be qualified against the intended
correction budget, not just tested for initial stability.

The roof also differs substantially from the reference: 100 mm stone-strength
covering panels are bonded to neighbors and rafters, and a 180 mm ceiling deck is
joined at full structural timber strength. In the baseline meteor test, none of
62 ceiling/frame-beam bonds broke, and only 4 of 97 ceiling/ceiling bonds broke.
A small visual hole is therefore not evidence that the load-bearing barrier failed.

However, **strength or correction count alone is not a proven complete root cause
for the porch meteor rebound**. Controlled probes show:

- Roof seams/mounts changed to cladding-fastener strength: intact passes, 955 breaks,
  but nearly identical upward meteor rebound.
- Roof structural connections changed to timber-joint strength: intact passes,
  1,442 breaks, but identical initial rebound.
- Both changes: intact passes, 972 breaks, but still upward deflection.
- Correction limits 2, 4 and 16 on the unchanged porch asset still rebound.
- Ceiling connections changed to timber-joint strength: intact passes, 2,908 breaks,
  but the meteor still rebounds; 6 debris bodies escape and final rest fails.
- 128 stress iterations at correction limit 1 fails **before launch**: 159 bonds
  break on the first gravity step. The harness refuses to proceed to a shot.

Therefore, do not ship a blanket strength reduction or a larger iteration budget
as a claimed solution. The remaining roof work is to identify the resisting shapes
and contact impulses during the corrected native passes, then author realistic
roof/ceiling joints and collision layers that pass intact and penetration gates.
The present data localizes this issue to native impact response plus asset load
paths; the precise remaining roof mechanism is not yet established.

Some damaged cases also fail final convergence/rest: the porch cannonball retains
awake jitter, and the reference meteor has zero awake bodies but an unconverged
solver after 15 s. A completed run or a plausible still image is not a release pass.

## Additional streaming issues, not included in the deployed fix

These can cause residual cadence artifacts after correcting IDs:

1. The v2 sender permits moving bodies to go 30 ticks (500 ms) between records;
   the client caps extrapolation at 8 ticks (133 ms). Measured airborne records in
   this tape have 503–506 ms gaps, with metres of true displacement between them.
2. Native per-body contact count is unavailable and exported as `contacts: 0`.
   The classifier interprets zero as contact-free and therefore labels much
   contacting rubble ballistic. Almost every record in the late damage window is
   ballistic, despite many native contacts.
3. Client ballistic gravity is still hardcoded to 20 m/s², while the server and
   measured tape trajectory use 9.81. That produces avoidable prediction error.
4. Encoder preselection truncates at 1,200 candidates ranked by event/speed,
   before per-client age priority. With over 4,000 awake bodies, slower pieces can
   be excluded before their overdue age is considered.

These findings are separate from the proven zero-match ID bug. Increasing the
prediction horizon for all rubble would hide missing updates and incorrectly apply
gravity through contacts. They need a coordinated scheduler/contact/gravity fix.
The optional legacy blast-core backend also retains its SDK's old 22-bit default
layout; it must be aligned with the host's 20-bit layout before being enabled.
This review and deployment exercise the native backend.

## Reproduce and inspect

From the repository root:

```sh
node client/node_modules/tsx/dist/cli.mjs structures/town-kit/repros/tape-stalls/analyze.mts
node client/node_modules/tsx/dist/cli.mjs structures/town-kit/repros/tape-stalls/replay-client.mts new-run-label
node client/node_modules/vitest/vitest.mjs run --root client src/city/cityClient.test.ts src/city/topology.test.ts src/city/rootedWire.test.ts src/city/chunkDiagnostics.test.ts src/city/destructionEvents.test.ts
```

`client-original*` are preserved measurements from the old source before the change;
`client-corrected*` use the same tape with just the ID helper fixed. Do not overwrite
those baselines. New replay labels are required for repeated runs.

Outputs: `structures/town-kit/out/reviews/tape-stalls/`.
Native cases: `structures/town-kit/out/reviews/house-cannonball/rebound-*` and `probe-*`.
Dense native recordings are gzip-compressed JSON. `series.json` holds the per-tick
projectile data. `provenance.json` and `deployment-verification.json` record revisions,
asset hashes, SDK/runtime identity and deployment checks. Browser errors are empty.

`preview.mjs` starts a private client preview on 6187 with its own cache.
`screenshots.mjs` loads the attachment into a fresh browser's replay store;
`REVIEW_URL` and `REVIEW_LABEL` choose a local build and output label.
`native-shots.mjs` uses the town-kit viewer on 6174 to render native recordings.
These scripts do not send reports or shoot/reset the public city.

## Larger town deployment

After the four-building check, the public scene was switched back to
`out/bayline-framed-36.vlsp`: 24 framed houses/bungalows and 12 shops, plus a
separate streets/props instance. It contains 70,546 chunks and 189,492 bonds.
The movement ID fix and correction limit 1 were retained. Binary instance checks
found no cross-building bonds, and browser startup checks found zero broken bonds
and no orphaned chunks or hash mismatches. This is a deployment check, not full
destruction qualification. Review records are in `out/reviews/framed-town-switch/`.
