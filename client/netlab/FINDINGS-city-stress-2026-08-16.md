# City streaming under mass destruction — measured 2026-08-16

Method: `npm run netlab -- run --scenario city-demolition[-heavy] --stack dev`, isolated
PhysX-GPU server (ports 4051/4052/5599), headful Chrome on an RTX 4090, real WebTransport.
Artifacts in `netlab/results/`. Server build `01:27:42`, git `eda5b1d`.

| | `city-demolition` (grid 2) | `city-demolition-heavy` (grid 4) |
|---|---|---|
| chunks / peak awake bodies | 3,078 / **2,597** | 16,512 / **16,150** |
| peak live islands | 1,787 | 12,643 |
| verdict | **0 fail** — healthy | **3 fail**, all four channels degraded |
| client frame gap p99 (busy vs settled) | 18.4 / 18.3 ms | 46.7 / 19.2 ms |
| server real-time pace | 60.0 Hz | **55.7 Hz (7.2% tick deficit)** |
| city bandwidth peak (client total) | 2.73 Mbps | 5.65 Mbps |
| chunks rendered below ground | 1 | **242** |

**At ~2,500 bodies the streaming is healthy.** Every city gate passes: no topology
sequence gaps, no orphaned chunks, no duplicate records, bandwidth inside the project's
4.0 Mbps burst ceiling, and the collapse costs no measurable frame time (18.4 ms busy vs
18.3 ms settled). The 2,500-body regime is not where the problems are.

## Finding 1 — client renders chunks below ground that the server never puts there

At 16k bodies the client shows **109–242 chunks up to 1.34 m below the ground plane**,
while the server reports `min_body_y = +0.073` — *no* body below ground at all. It is a
pure client/server divergence, and it is not a delivery fault: `topoSeqGaps = 0`,
`orphanedChunks = 0`, `duplicate_body_records = 0` for the whole run.

That means the client's reconstruction of chunk world pose (island body pose composed with
chunk local offset) is producing positions the server's physics never held. It scales
sharply with island count — 1 sunk chunk at 1.8k islands, 242 at 12.6k — which matches the
documented failure mode of island offsets captured from a stale view at promotion time.

Note the project's own e2e spec asserts `minChunkY > -2 m`, so at −1.34 m **this passes the
existing test suite while being plainly visible** (a half-buried chunk). The tolerance is
too loose to catch it.

## Finding 2 — the pose stream saturates its ceiling, starving bodies of updates

The per-client chunk-datagram ceiling is 10,400 B/send × 30 Hz = 2.50 Mbps. Server-side
measurement peaks at **2.47 Mbps / 300 records per second** — the encoder is enforcing the
cap exactly as designed. But that cap is a fixed record budget, so as the body count grows
the per-body refresh rate collapses:

- 11,809 awake bodies served by 158 pose records/s → an average body is refreshed once per
  **~75 s** (interest management trims to visible bodies, so in-view refresh is better than
  this bound, but the budget is hard).
- 28 of 102 sampled seconds sat pinned at the cap.

Everything past the budget holds a stale pose on the client. This is the most likely
mechanism behind Finding 1 and is worth confirming directly.

## Finding 3 — total city bandwidth is 2.3× the governed stream

Client-observed city bandwidth peaked at **5.65 Mbps** while the server's governed pose
stream peaked at 2.47 Mbps. The ~3.2 Mbps difference is traffic the ceiling does not
govern: reliable topology, baseline and bootstrap packets. At 12.6k islands the
promote/retire/migrate churn costs **more than the pose stream it is meant to support**,
and it pushes the total past the project's own 4.0 Mbps burst ceiling.

## Finding 4 — server overload is the root of the netcode symptoms at 16k

The causal chain the attribution reports, in order:

1. **SERVER**: tick p95 29.7 ms against a 16.7 ms budget, 108 over-budget seconds, 7.2% of
   ticks never happened. `stress_solve` peaks at 15.4 ms — essentially the entire budget.
2. → **NETWORK**: snapshot gap p95 38.1 ms against a 16.7 ms cadence (max 80 ms). Nothing
   is wrong with the link; the snapshots were produced late.
3. → **SYNC**: corrections 35 cm, 2 rendered steps >50 cm beyond authoritative velocity,
   2 clock-offset jumps larger than a tick.

Separately and independently, **RENDER** degrades on the client: 36 fps mean, frame gap p99
46.7 ms while busy versus 19.2 ms once settled, chunk recompose p95 5.4 ms. That is local
render cost scaling with awake bodies, not a delivery problem.

## Finding 5 — rubble still does not sleep at scale

At the end of the heavy run only **68 of 12,068 bodies were asleep** with 1,296
`resettled_wakes`. Everything stays awake, which keeps the stress solver at full cost and
keeps the encoder competing for the same fixed record budget. Consistent with the existing
sleep-threshold work not yet holding at this scale.

## Two harness bugs found and fixed while validating these numbers

Both would have produced confident, wrong reports:

- **Freeze detector** compared authoritative *velocity* to rendered *displacement*. A
  player walked into rubble keeps a 6 m/s desired KCC velocity while going nowhere, so a
  perfectly-tracking client scored 17.2% frozen with a 966 ms freeze. Corrected to compare
  authoritative *displacement*; the same run now reads 3.3%.
- **Micro-reversal detector** counted every rendered direction flip. Of 28 flips, 21 were
  the server genuinely bouncing the player over rubble and faithfully rendered. Corrected
  to count only reversals the authoritative path did not make: 7 real ones.

Both are covered by regression tests in `netlab/analyze.test.ts`.

---

# Per-chunk pose anomalies during collapse (added 2026-08-16, phase 2)

Detectors added at the four points every presented chunk pose flows through, then
`city-demolition` (grid 2, ~2,600 awake bodies — the *healthy* regime from the table above)
run three times. Counts are exact; the recorder reports per-type totals even when its rate
cap thins the stored samples.

| mechanism | run 1 | run 2 | run 3 | stability |
|---|---|---|---|---|
| **chunk pose jump at topology apply** | 2,487 | 2,141 | — | **stable** |
| — median / p90 / max displacement | 0.21 / 0.77 / 1.39 m | 0.38 / 0.88 / 1.45 m | — | **stable** |
| render-clock rollbacks | 2,437 | 6,324 | 764 | high, variable |
| — share dropping a live correction | 13% (worst 7 cm) | — | 6% (worst 4.6 cm) | small effect |
| chunk teleport at render (>1.5 m/frame) | 28 | 78 | 350 | **unstable — do not quote a rate** |
| raw-pose renders ("two-writer flicker") | 146 | 1 | 332 | unstable |
| membership violations | 0 | 0 | 0 | — |
| migrate missing/empty destination | 0 | 0 | 0 | — |
| settle rollbacks | 0 | 0 | 0 | — |
| corrupt island frames | 0 | 0 | 0 | — |
| correction snaps (>5 m abandoned) | 0 | 0 | 0 | — |

## Finding 6 — chunks jump ~0.2–1.45 m at the moment of fracture

The one reproducible artifact. Every topology batch that re-parents chunks moves their world
pose: **~2,100–2,500 discontinuities per 90 s demolition, median 0.2–0.4 m, worst ~1.45 m**,
clustered exactly on the fire/fracture events. A chunk is the same physical object before and
after it joins an island, so this displacement is not physics — it is the client re-composing
the chunk against the promotion pose with no continuity from where it was already drawn.

This matches the reported symptom (flicker/teleport "something weird with the fracture") far
better than any of the corruption paths, all of which measured **zero**.

## What this rules out

The previously-fixed fracture positioning bugs are **not** recurring at this scale: zero
membership violations, zero migration anomalies (missing or empty destination), zero orphans,
zero topology sequence gaps, zero corrupt island frames, zero settle rollbacks. The
`c2614f7` empty-destination defect and the unsent-resync defect are real and still present in
the code, but neither fired in these runs — they need a migration edge case this scenario
does not reach.

Render-clock rollbacks are frequent (hundreds to thousands per run) but mostly benign: the
rewind is a fraction of a tick and only 6–13% of them abandon a correction, worst case ~7 cm.

## Measurement corrections made while validating this

Two detector bugs, both caught before reporting, both of which had produced dramatic wrong
numbers:

- **Two-writer flicker** first counted *writer alternation*, which is normal operation —
  `samplePresentation` writes every live body each frame and runs before the renderer reads,
  so a raw write landing between frames is overwritten before anyone sees it. Rewritten to
  sample the pose source **at draw time**: 1,058 "flickering bodies" became 36.
- **Adoption jump** was first measured inside `adoptIslandMembers`, which runs *before*
  `promote` inserts the body — so the "after" read hit the missing-body fallback and reported
  a median 24 m jump. Moved to span the whole topology batch: median 0.21 m.

---

# Root cause + fix of the fracture flicker (added 2026-08-16, phase 3)

## The mechanism, proven from a suspect body's raw wire stream

A body that teleported repeatedly was tapped at the packet layer. Its wire trajectory was a
**perfectly smooth ballistic arc** (launched ~11 m/s up, decelerating at g). The written
instance positions, however, alternated every ~33 ms between two points ~1.7 m apart on that
same arc — the presented pose (6 ticks behind) and the raw pose (newest tick), interleaving
at exactly the datagram cadence. The client was drawing two time bases of one clean stream.

Root cause: `applyRecord` wrote the raw wire pose into the shared ledger slot on every
datagram. Its only legitimate role is as a placeholder before a body is first sampled; once
presentation owns the body, any raw write that survives to draw time renders the chunk one
interpolation delay ahead of its island, then it snaps back. **Fix: the raw write now happens
only until the body's first presented sample** (`cityClient.applyRecord`).

## The promotion fix (F1) was never a regression

The post-F1 "teleport explosion" (11,440 → 28,142 events in some runs) was the flat 1.5 m
probe threshold flagging **legitimate motion**: since the push-speed redesign removed the old
12 m/s clamp, ejected debris genuinely flies at 40–70 m/s (verified in raw records: vx
41→67 m/s), and a distant body on an 8-frame render stride covers several metres per write.
Run-to-run totals (28 / 78 / 11,440 / 134 / 7 / 28,142 / 269) tracked how much fast debris
each run's physics produced — not any client defect. The probe now judges each step against
the chunk's own recent write-to-write speed (EMA); note the EMA absorbs a *sustained*
oscillation after ~3 events, so the draw-time flicker detector remains the dedicated sensor
for two-writer regressions.

Two earlier analysis artifacts corrected on the way: the "1066 ms periodicity" was the event
rate cap's 1-second budget window aliasing the samples; and the first adoption-jump numbers
(median 24 m) were measured mid-`promote` before the body existed.

## Acceptance (two consecutive 90 s demolitions, grid 2, ~2,600 bodies)

| detector | before | after |
|---|---|---|
| chunk teleports (velocity-aware) | bursty, up to 28k flat-threshold | **0, 0** |
| two-writer flicker at draw | 1–332 | **0, 0** |
| correction snaps | 0 | 0 |
| membership / migrate / settle-rollback / corrupt frames | 0 | 0 |
| fracture discontinuities | ~2,300 hard jumps (median 0.2–0.4 m) | ~2,000 seeded glides (median seed delta 0.14 m over 100 ms) |
| player-path metrics | — | inside A/A noise band |

Remaining known artifact (deferred, Tier 2): render-clock rollbacks (`samplePresentation`'s
anchor estimator; worst 2.6 ticks, 3% abandon a live correction, worst 0.62 m). Needs a
filtered clock, not a patch.

---

# Certainty campaign (2026-08-17): the user's symptom, proven and fixed

User report: city loads intact / less destroyed, "flickers over" when moving and shooting,
building tops floating, chunks never correcting. Demand: 100% certainty with automated
proof. Every hypothesis now has a verdict and a pinned test.

## Certainty ledger

| # | hypothesis | verdict | proof artifact |
|---|---|---|---|
| H1 | late-join: bootstrap arrives but screen never repaints | **disproven** | `city-latejoin` runs incl. LTE + join-moment screenshots: correct render, staleDrawn 0 |
| C1 | intact-render race at join | **structurally impossible** | server queues manifest→bootstrap adjacently on the one ordered stream (`main.rs` join path); client buffers pre-manifest city packets and replays them synchronously at CityClient creation |
| H4 | **lost/dropped join bootstrap silently accepted** | **confirmed defect, fixed** | `lastTopoSeq===0` accepted any first topology seq — a client missing its bootstrap ran an intact ledger forever (screen==ledger, ledger≠server — invisible to every screen-side detector). Fix: topology refused until bootstrapped; resync requested. Tests: `cityClient.test.ts` "does not silently accept…" (failed pre-fix) |
| H3 | **background tab: settles while rAF paused never repaint** | **confirmed, reproduced, fixed** | `city-background` scenario (rAF stubbed hidden, network flowing): **690 stale chunks at refocus, 28 permanent** — screenshot shows an intact slab hovering over correct rubble, the user's exact visual. Fix: repaint queue (settles/promotions/migrations/wakes; all on bootstrap) drained into the dirty set. Post-fix: **0 stale**. Gate: `cityStaleDrawnChunks` (standing, final-sample) |
| C4 | silent accumulated desync | **instrument built; found a different (bounded) issue** | forced end-of-run resync diffs ledger vs fresh server bootstrap per chunk. Calibration on a settled city: uniform **~8–9 cm systematic delta on ~1.1k chunks (max 0.099 m)** — a pose-composition convention mismatch between the bootstrap and incremental paths, equal on all clients, class of the historical COM-vs-centroid bugs. Follow-up root-cause queued; gate set above the measured floor so gross desync (order-of-magnitude larger) still fails |
| H2 | floating tops = physics settling | **not reproduced on this scene** (1–3 floating settled islands, minor) | `cityFloatingSettledIslands` detector landed. The user's screenshot was the `fractured-district` scene on a CPU stress solver — reproducing needs that scene; detector is ready for it |
| — | scene note | **surprise finding** | this scene self-shatters on spawn: 7,501 broken bonds, 1,716 islands with zero shots, identical at stress 0.10 and 1.0 — worth its own look |

## Why the user's exact report is now explained

Playing in one tab while chatting in another (this session's own usage!) hits H3 on every
return to the game tab, and any bootstrap loss on a real network hits H4 permanently. Both
produce precisely "looks intact/stale until I shoot near it, then it flickers to reality,
and some chunks never fix themselves". Both are fixed, both have failing-before tests, and
the `city-background` scenario + standing-staleness gate keep them fixed.

---

# Invulnerable monoliths (2026-08-17): reproduced, quantified, root-caused

User: "I shoot some buildings and they shatter, I shoot others and half the building remains
one piece no matter how much I shoot, and it flies away instead of collapsing."

## Reproduced automatically

`city-monolith` scenario: cut a tower's supports, then pour sustained fire into the largest
island **while tracking it as it tips and flies** (new `huntLargestIsland` drive command —
a fixed aim point stops hitting a moving slab, which would make the test pass vacuously).
New metric `cityLargestIslandSpanM` measures the biggest island's AABB in **metres**: chunk
count alone is misleading, since a 5-chunk island of bonded slabs is still a wall-sized panel.

| condition | largest island under ~114 s of tracked fire |
|---|---|
| default shot stress (1.2e7) | **7.8 m / 5 chunks for 54 s → 6.6 m / 4 chunks for the remaining 60 s** |
| 10× shot stress (1.2e8) | 26.3 m → 14.6 m by t=31 s → 6.6 m by t=103 s |

So islands break down readily while large, then **stall**: past roughly 5–6 chunks / ~7 m,
sustained accurate fire removes about one chunk per minute. That is the user's monolith.
10× stress accelerates the descent but converges to the same ~6.6 m floor — the shot energy
is a rate limiter, not the barrier.

## Root cause (verified in code, not inferred)

1. **Refuted:** nothing filters stress or bond damage by kinematic/anchor status.
   `destruction.cc:1323-1352` queues a stress contact for every chunk shape within the 2.5 m
   radius; the `bodyKinematic` test at :1343 gates **only the velocity push**. Free islands
   do receive shot stress, and PhysX contact reports feed them too (`destruction.cc:1190`).
2. **The asymmetry — free islands carry zero self-weight stress.** Gravity enters the solver
   as a uniform per-node *acceleration* (`NvBlastExtStressSolver.cpp:2224-2240` + `:804-812`),
   so an unanchored island has no relative velocity between nodes and therefore **no standing
   bond load**. An anchored structure sits at ~1/2.7 of limit under self-weight (`city.rs:190`),
   which is why breaking one of its bonds cascades. A free island has nothing to redistribute:
   every shot is an isolated local event that must supply the entire fracture energy itself.
3. **Separation requires graph disconnection.** `NvBlastActorSplit` only emits new actors when
   the bond graph disconnects (`ext_stress_bridge.cpp:1455`). The pack averages ~7 bonds/node,
   so freeing one chunk means killing all ~7 of its bonds — with no load path to help.
4. **The blast loads the strong mode.** Shot stress is applied along the shot direction, i.e.
   *into* the material, and this pack's compression limits are **10× its tension limits**.
5. **Measurement blind spot:** `broken_bonds` is *inferred* from chunks ending up on different
   PhysX bodies (`destruction.cc:809-825`), gated behind a topology-changed check (`:1145`).
   Bond damage that does not separate anything is completely invisible, so "the island never
   breaks" and "the metric reads 0" are indistinguishable today. The adapter already computes
   `overstressedBondCount`, `contactsQueued/Processed/Dropped`, `solverIslandCount/Skipped`
   (`NvBlastExtStressPhysX.h:194-215`) and `getBondUtilisations` — **none cross the FFI**.
6. Ruled out: `VIBE_CITY_MAX_BODIES` (unset → unlimited; it previously caused this exact
   symptom), `VIBE_CITY_GRAPH_REDUCTION` (0), single-chunk size (largest chunk is 4.5 m
   foundation; slabs are 3×0.22×2.8 m — the monolith is an island, not one big chunk).

## Recommended fix (server-side, not yet implemented)

Add the **direct radial damage path Blast is designed for and this project never wired up**:
a shot should damage bonds by proximity/falloff within the blast radius, independent of the
stress solve — the canonical `NvBlastExtDamage`-style weapon model. That fixes the class of
bug rather than the instance: it makes fracture independent of whether an island happens to
carry standing load. Load it in **tension** (radially outward from the impact) rather than
along the shot vector, since tension limits here are 10× weaker.

Land alongside it: plumb `overstressedBondCount` / `contacts*` / `bondUtilisation` through
`FfiDestructionStats` → `DestructionStats` → `CityStatsSnapshot`, so "bonds damaged" is
finally distinguishable from "island separated" — without that, no test can prove the fix
works at the bond level.

Gate for the fix: `city-monolith` must drive `cityLargestIslandSpanM` below ~3 m within the
80 s fire window (today: stalls at 6.6 m).
