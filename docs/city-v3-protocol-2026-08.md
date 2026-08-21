# Wire v3.1: the whole-world destruction streaming protocol

2026-08-21. This is the protocol record: what v3.1 is, what it measures as,
what it trades away, and why it replaces wire v2. Every number names its run;
the matrix that reproduces them is
`research/destruction-codec/tools/run_v31_matrix.sh`, judged end-to-end by
the single-source pipeline (`record-city-trace --packets-out` → the SHIPPING
client via `client/tools/replay-city-client.mts` → `destruction-codec
state-diff`). No hand-written client models exist anywhere in the
measurement path; that rule is what made these numbers trustworthy after
four separate model-divergence incidents.

## The protocol, in one page

**Substrate.** Islands are rigid by construction (Blast stress solver), so
one pose per island reproduces every member chunk exactly — rate scales
with awake islands, not chunks. Per island: analytic segments (ballistic
arcs ≈ free), impulses at contacts, delta-coded sampled chains for
contact-riding motion, Rest terminals. Hindsight span fitting (the flush
window) with motion-masked precision (0.5 cm base → 2 cm cap for fast
movers). Cross-trace-trained zstd dictionary, self-describing per-datagram
compression tag.

**Transport split** ("sparingly reliable" by design): droppable datagrams
carry poses (span packets, body-atomic, bounded continuity chains, smeared
restatement + nack healing); the reliable channel carries only topology,
settles, lane assignments and bootstrap — measured at 2–4 % of bytes
(0.26–0.57 MB of 4–30 MB runs).

**Identity (v3.1).** Records address dense lanes; the reliable lane map
binds lanes to entities. A wrapping u8 **lane-map epoch** is bumped per
assignment batch, stamped in every datagram header (former reserved byte)
and every lanes message. The receiver refuses a lane's records when the
packet's epoch serially precedes the lane's assignment, age-bounded to 64
bumps against the newest epoch seen (assignments are fixed points on a
wrapping counter; unbounded comparison starved the whole stream — measured,
fixed, tested). This made lane reuse *sound*: the pre-epoch reassignment
race produced 40 cross-tenant excursions (worst 78 m) per ramped run; with
the epoch, zero across every gate run since.

**Rate governor (v3.1).** Feed-forward: an EMA of per-span wire bytes
steers the next span. Overload stretches flush 100 → 250 ms first
(measured ≈ −40 % bytes per doubling, error flat), then widens the masked
bound toward its calibrated 4× cap; release is reverse-ordered with
hysteresis. **Overload spends latency first, precision second, correctness
never** — the exact inverse of v2, which spends correctness silently. The
client spends the latency smoothly: sampling delay follows the observed
span cadence, slewed at 0.05 ticks/frame (stepping it teleported every
mover by delay-delta × velocity — measured, fixed).

**Joinability (v3.1).** Parked lanes deliberately exhaust their Rest
budget (re-stating a settled pile forever measured 0.5+ Mbps of pure
repetition), so a joiner is owed a statement of every occupied lane:
`begin_join_restate` smears 64 lanes/span on join and on every resync,
beside the bootstrap and full lane map. Convergence bound:
occupied_lanes/64 spans (~4 s at 4 k lanes, 100 ms flush).

## Why it beats v2, with receipts

Same content, same physics, same shipping client, deltas measured by
truth-aligned state-diff (which *measures* presentation delay rather than
assuming it, per-second, so lateness and wrongness are never conflated):

| axis | wire v2 | wire v3.1 | run |
|---|---|---|---|
| moving-chunk err p95, matched flush | 5.7 cm | 5.6 cm | iso 3-leg 08-21 |
| all-chunk err p95 (stale scenery) | 13.9 cm | **1.9 cm** | ramp 08-21 |
| freezes (still while truth moves) | 4,139 | **0–13** | ramp, W1/W2 gates |
| worst single event | 2.6 m freeze | 1.09 m (physics-bounded) | W1 gate |
| bytes, matched content | 0.79 Mbps | **0.73 Mbps** | iso 3-leg |
| bytes under barrage | ceiling-capped, then *starves* | governed: 2.40 avg / 5.22 worst-s at 5 Mbps budget | W2 gate |
| reliable-channel share | 21 % (baselines) | **2–4 %** | ramp |
| latency (measured) | 100 ms | 133 ms floor → 233 ms governed | state-diff |
| server encode | 0.5 ms/tick **per client** | 2–9 ms/tick **for all clients** | ramp timings |
| loss (in-proc wifi-bad, harsher than real) | 6 fails, 2,793 end divergence | 4 fails, **599** | 08-20 parity |
| end-state ledger divergence, clean | up to 2,793 (resync storms, historic) | **0–1 chunks** | netlab series |
| structural failure mode | silent staleness, unbounded | bounded error, visible latency | design + all runs |

The v2 number that matters most is not in any single row: its cost model
pays overload in *silent wrongness* that byte metrics cannot see (the
5.65 Mbps + 75-second-staleness coexistence that started this work). v3.1's
failure mode under any overload is "slightly later, slightly softer,"
bounded and measured.

## Trade-offs, stated against interest

- **Latency floor.** 133 ms best-case (50 ms flush + interpolation) vs
  v2's 100 ms; the governed world feed runs 167–267 ms under load. The
  personalized WT tier later runs the same codec at short flush for the
  interactive bubble; fracture *events* bypass the pose path entirely
  (reliable + glide) on both wires.
- **Bytes track destruction intensity** up to the budget; beyond it the
  precision curve engages (masked bound → 4×, ≈ 8 cm worst). On the ramp
  this concentrated in one ~2 s episode at the barrage peak (67 cm err-p95
  second) — the calibration tail named in the W2 gate.
- **Epoch window**: identity ordering is exact within 64 assignment
  batches (~1–2 s at maximum churn); beyond it, latest-wins tick rules
  govern (correct in practice, but the guarantee is windowed).
- **Physics envelope is the real ceiling**: ≥ ~4 k simultaneously awake
  bodies breaks 60 Hz simulation on current hardware before either wire is
  the problem (sim p95 33 ms/tick at 6.5 k bodies, measured). The codec is
  sized to be flawless inside that envelope; coverage tiering (the MoQ
  track split) is the planned lever beyond it, and the per-client screen
  bound is why it scales.
- **Theoretical floor**: packing is exhausted (four entropy coders, a
  learned basis, cross-block continuation — all < 1 %). Remaining levers
  are structural and mostly taken; measured-and-kept: reach-tiered
  small-rubble contract (−7.4 %, flag-gated pending perceptual sign-off).
  Estimated-and-deferred: varint velocities (single digits), quintic
  segments (~5 %, reversal-gated).

## The rigor instruments (what "tested" means here)

1. `run_v31_matrix.sh` — four envelope scenarios (steady barrage,
   escalating ramp, projectile storm, settle-rewake), each through the
   shipping client, each judged by state-diff + byte/timing receipts.
2. `state-diff` — truth-aligned per-chunk comparison: measured per-second
   presentation delay, moving-only percentiles, freeze / excess-step /
   reversal artifact classes with per-building localization and
   frame-exact timestamps.
3. `packet_rate_overlay.py` — burned-in per-second receipts (bytes,
   accuracy, sim/encode/client compute) on every comparison video.
4. netlab browser gates + impairment profiles + Playwright pixel capture
   (`NETLAB_RECORD_VIDEO=1`) — the real client over the real transport.
5. codec-verify — byte tripwires (debris 13,814,930 exact through every
   change in this line) and both legacy regression gates, proving offline
   inertness of every live-path mechanism.

## Known open items

- **Post-merge browser regression** (task #23): the first netlab runs after
  the upstream merge crash per-frame ("reading 'y' of undefined") and trip
  the merged cityMembershipViolations gate under full demolition; the
  offline pipeline (same ledger code) converges cleanly, so suspicion is on
  merged migration semantics × v3 topology hold-back, or merged
  recording-gated analysis. Blocks the browser leg of the matrix, not the
  offline legs.
- Perceptual sign-off pending (user, by video): small-rubble tier;
  governed-flush feel at 250 ms.
- KEYSTATE cadence flag for the MoQ tier (mechanism exists as join
  restate; the periodic form is a flag away).
- Lane epoch at u16 in the lanes message if churn ever makes the 64-batch
  window tight.
