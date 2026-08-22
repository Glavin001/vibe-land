# The next real scale win: making merged rubble piles sleep

2026-08-22. Written directly after the first human play session on wire
v3.1 (downtown, full authored strength, CUDA stress solver). The netcode
line is at its floor; this doc names the layer that now binds, with the
live data that proves it, the in-repo prior art, and ranked directions for
the solve.

## What the live session measured

Five stats-panel samples across one sustained demolition session
(single player, RTX 4090, `fractured-downtown.json`, 24,105 chunks,
`VIBE_CITY_STRESS_LIMIT_SCALE=1.0`, wire v3.1 governed at 5 Mbps):

| sample | broken bonds | bodies (awake) | islands | tick avg / p95 ms | effective Hz | physx step | city stream |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 29,878 | 8,473 (7,356) | 8,251 | 35.5 / 46.4 | **28** | 17.4 ms | 0.72 Mbps |
| 2 | 30,962 | 8,789 (7,672) | 8,561 | 43.1 / 59.6 | 23 | 17.4 | 1.22 |
| 3 | 33,130 | 9,344 (8,238) | 9,122 | 46.3 / 66.6 | 22 | 18.8 | 1.72 |
| 4 | 38,407 | 10,827 (9,645) | 10,590 | 43.4 / 57.7 | 23 | 19.5 | 1.50 |
| 5 | 40,567 | 11,404 (9,522) | 11,166 | 49.4 / 67.3 | **20** | 20.2 | 1.26 |

Supporting offline measurement (ramped downtown, per-tick timings.jsonl):
sim p50 18.3 ms / p95 34.4 / max 287 at 6.6–6.9k peak bodies; the same
scene at ~950 awake holds 60 Hz comfortably. **The envelope on this
hardware is ~3–4k simultaneously awake bodies; sustained downtown play
sits at 7.5–9.6k and runs the world at a third of real time.**

Two secondary symptoms, both downstream of the low sim rate:
- Ground tunneling grew with the rate drop: `below ground` 12 @ −2.4 m at
  28 Hz → 23 @ **−227.7 m** at 20 Hz (per-step displacement doubles as Hz
  halves; CCD margins authored for 60 Hz stop covering it).
- Client frame p95 25–33 ms drawing 24k chunks on PRETTY+shadows — heavy
  but not the binder; QUALITY: FAST is the local mitigation.

## Why this is the lever (and the netcode is not)

Every cost in the system is linear-or-worse in **awake body count**:
`physx step` (17→20 ms alone — the entire 16.7 ms budget), blast begin
6.6→9.0 ms, readback ~1 ms, encoder ingest 2.6–7.5 ms, client compose,
and stream bytes (~0.6 kbps/awake body). The wire proved itself the cheap
layer in this exact session: a city-wide collapse cost 0.7–1.7 Mbps with
zero topology gaps, and the encoder was ≤7% of a tick that physics was
blowing through. Halving awake bodies buys back roughly half of
everything at once; no other single change does.

## The defining characteristic of the real data

**Awake never comes down under sustained play.** Bodies (awake) climbed
monotonically 7.4k → 9.6k while islands tracked bodies ~1:1 (8.2k → 11.2k
islands ≈ one body per island) — thousands of *individually tiny* rigid
bodies that are all TOUCHING. PhysX sleeps per **contact island**, not per
body: one jittering member keeps every transitively-touching body awake.
The downtown pack maximizes this by design — 12 m streets mean toppled
towers merge their rubble fields, and its own scene notes warn "merged
rubble fields settle as one [island]" (`scripts/run-city-server.sh`
scene comment). A single city-block pile is one contact island of
thousands of bodies with, at any moment, *some* member above the sleep
threshold.

This is the same physical phenomenon the encoder already solved for
BYTES: netlab measured 2,283 bodies "active" at settle time with 9,026
re-settle wakes — velocities never quiet even when poses go nowhere. The
codec's answer (pose-anchored parking: quiet = pose inside the rest shell
for a window, wake = drift beyond the bound; `debris_codec.rs` sleep
block) took settled traffic from 1.82 → 0.01 Mbps. **The simulation needs
the analogous fix, at the island granularity PhysX actually operates on.**

## In-repo prior art (read before designing)

1. **The hard-won negative** — `destruction/src/runtime.rs:397`: forcing
   individual bodies asleep fights the engine. "You cannot hold one body
   of an active contact island asleep, so PhysX woke it straight back and
   the cycle repeated ~650 times a second" — visible judder, ~600 of 735
   bodies kept awake. Any solve must operate on whole islands or change
   the island structure; per-body force-sleep is a closed line.
2. **Upstream's recent work** (in the merge): `a5b859d` damps fracture
   debris so PhysX's own sleeper can engage; `bc06138` restored the sleep
   threshold once damping made it safe; `2ca5504` keeps resting load in
   the sim and reports bond stress headroom. These are why the *offline*
   scenes now rest — they are necessary but insufficient at merged-pile
   scale.
3. **The settle tracker** — `destruction/src/settle.rs`: energy-floor
   policy with a hard `force_sleep_ticks` deadline (5 s), designed to give
   the network a definitive "at rest now" moment. Note the tension with
   (1): the runtime currently *observes* engine sleep rather than
   executing the deadline, precisely because of the island-wake fight.
   The tracker is the right policy home once execution has an
   island-safe mechanism.
4. **The stress solver is already GPU** (`cuda-stress`, "CUDA 1/1" in the
   panel; blast solve 2.5–11.8 ms live) — the CPU-solver bottleneck named
   in `efd5844` is handled. What remains is rigid-body simulation of the
   pile itself.

## Ranked solve directions

**A. Pile promotion to static (the direct analogue of encoder parking).**
When a contact island is *pose-stable* — every member inside a small
positional shell of an anchor for N ticks, regardless of velocities —
convert the whole island's bodies to kinematic/static (or remove them
from simulation, keeping colliders). Wake the pile (whole island or a
spatial neighborhood) on external impulse: projectile hit, blast radius,
new debris landing above threshold momentum. Key properties: operates at
island granularity (respects lesson 1); pose-based criterion (respects
the measured velocity-jitter characteristic); reversible; and the wire
already handles the transition (settle records own the pose reliably;
wake re-enters the stream — the whole settle/wake path is tested).
Risks to design against: freezing a pile that is actually still creeping
(the encoder's drift-wake bound is the template: wake when TRUTH would
leave the shell — here, wake when unbalanced force/penetration depth
exceeds a bound); stacking on frozen piles (new debris must rest ON the
static collider — free); and mass-wake stampedes (wake spatially, not
whole-island, if islands have merged city-wide).

**B. Contact-island partitioning.** Attack the "one island = one city
block" merging itself: spatial partition of resting piles (e.g. collision
filtering that seams a pile into ~4–8 m cells once locally stable) so
PhysX's native sleeper can retire cells independently. Less invasive than
A (the engine still owns sleep) but subtler: seams must not create
visible cliffs in the pile, and filter churn has its own cost. Worth a
measurement spike before committing either way; A and B compose.

**C. Physics LOD for distant/settled piles.** Sub-rate simulation for
piles far from any player (step every Nth tick). Orthogonal, bounded win
(the pile still costs on its ticks), real complexity in the bridge.
Only worth it if A leaves a large residual.

**D. Engine-level appeals** (upstream/PhysX): per-island sleep threshold
scaling with island size; solver iteration LOD for resting islands.
Worth filing with the physics owners alongside the data in this doc —
"treat physics as externally optimized" per project direction, but they
need the characteristics documented here to aim at.

**E. Content-side mitigations (already available, not a solve):** the
`fractured-district` pack spaces buildings so piles cannot merge (it
sleeps today); grid-1 downtown is the deliberate stress case. Server
restart is the reset. These bound the problem for playtests while A/B
land.

## Instrumentation to build first (one day, pays for the whole solve)

The panel shows totals; the solve needs distributions. Add to the
destruction stats (server, cheap, per 2 s):
- **Contact-island size histogram** (bodies per island, p50/p95/max) —
  confirms the merged-pile hypothesis directly and sizes A's unit of work.
- **Wake-reason census** (new fracture / impulse / island-neighbor woke
  me / never slept), mirroring the encoder's `CODEC_CENSUS` pattern —
  separates "can't sleep" from "keeps getting woken."
- **Pose-stability census**: how many awake bodies have moved < 2 cm in
  the last second (the encoder's park criterion applied read-only) — this
  is the direct measure of A's addressable population. From the codec's
  settle work, expectation is **the large majority** of awake bodies in a
  resting pile.
- Keep the existing `timings.jsonl` per-tick capture in any experiment
  run: sim ms vs awake count is the acceptance curve.

## Acceptance (inherits the standing instruments)

- Downtown, full strength, sustained demolition to ≥40k broken bonds
  (the live session's profile): **effective Hz ≥ 58 throughout**; awake
  bodies decay to < 1k within ~5 s of each collapse ending.
- `below ground` warning stays at pre-collapse baseline (tunneling was a
  rate symptom).
- No visible pop/judder at pile freeze or wake (the runtime.rs:397
  failure mode) — judged by video per the standing rule, and by the
  state-diff artifact gates (freeze/excess/reversal) which will catch a
  fighting sleeper numerically.
- Codec side needs **zero changes** and inherits the win: bytes, encoder
  ingest, and client compose all scale down with awake count; the parked
  Rest / settle-record path already models exactly this transition.

## Relationship to the roadmap

This is the enabling step for everything on the scale axis: the tier
split (per-player WT + MoQ world tracks) multiplies *viewers*, but only a
sleeping city multiplies *world size*. With piles asleep, the measured
budget arithmetic (≈0.6 kbps per awake body, 5 Mbps world feed, ~4k-body
60 Hz envelope) all holds at district-grid scale — the same numbers, more
city.
