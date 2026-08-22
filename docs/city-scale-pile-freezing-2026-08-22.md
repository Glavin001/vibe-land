# Freezing settled rubble: taking the pile out of the solver

2026-08-22. Implementation and measurements for the campaign named in
`city-scale-next-sleeping-piles-2026-08-22.md`. That doc identified the
binding constraint and ranked the solves; this one records what was
built, what it measures, and what is still open.

## The problem, restated from the measurement

PhysX sleeps per **contact island**, never per body. A settled rubble
field is one island of thousands of touching chunks, so it can only
sleep as a whole, and waking any single member wakes every body it
transitively touches.

From the live 24k-chunk downtown session (`/tmp/city-telemetry.jsonl`,
823 samples over 17 minutes):

| event | pile before | real damage | woke | result |
|---|---|---:|---:|---|
| t+232s | 12,017 bonds | **+7 bonds** | 2,218 | re-slept |
| t+508s | 22,090 bonds, 0 awake | +365 bonds | **6,065** | 60 → 34 Hz, **never re-slept** |

The amplifier is the island, not the damage: a shot that broke seven
bonds woke two thousand bodies. And past a merge threshold somewhere
between 10k and 22k broken bonds the pile stops recovering at all —
after t+508s awake sat at 6,112 for the remaining eight minutes of the
session with essentially no further damage, tick pinned at ~25 ms.

The performance envelope on this hardware, from the same capture:

| awake bodies | tick avg | effective Hz |
|---:|---:|---:|
| 0–1k | 5.5 ms | 60 |
| 1–3k | 14.8 ms | 60 |
| 3–4k | 18.8 ms | **53 — the knee** |
| 4–5k | 23.9 ms | 42 |
| 5–6k | 26.9 ms | 37 |

## The solve

Make settled debris **kinematic**. A kinematic body generates no contact
pairs against other kinematic or static geometry, so an all-kinematic
pile has no island to wake and no contacts to converge — while dynamic
debris and the player controller still collide with it, so rubble stacks
on the pile and players walk over it. The actor and its island serial
survive the round trip, which is what lets the network layer treat a
freeze as the settle it already handles.

Waking is **spatial**: an impact releases the frozen bodies its blast
neighbourhood reaches, plus the column above it, and nothing else.

### Why not the alternatives

- **Per-body `putToSleep`** is a closed line, documented at
  `destruction/src/runtime.rs:394`: you cannot hold one body of an
  *active* island asleep, so PhysX wakes it straight back, ~650 times a
  second, with visible judder.
- **`eDISABLE_SIMULATION`** removes collision as well as simulation, so
  debris and players fall through settled rubble.
- **Filter-data island seaming** fails twice: writing filter data wakes
  sleeping actors (the identity-stamp lesson), and a woken body whose
  neighbours no longer collide with it falls through the pile.
- **Rebuilding the pile as a Blast stress graph** (the industry
  re-aggregation design) was deferred deliberately. The telemetry shows
  islands ≈ bodies 1:1 — settled rubble is mostly single-chunk bodies
  with no remaining bonds, so there is no bond structure to
  re-aggregate. It would also need substantial unbound Blast surface
  (runtime asset creation, asset merge, contact harvesting) and a
  `PxScene::overlap` binding. Spatial wake approximates the response at
  a fraction of the cost. Revisit if the wake behaviour proves too crude
  on video.

### Why the criterion is pose, not velocity

Bodies in a deep pile carry contact-impulse velocities far above any
usable threshold while their poses go nowhere, so a velocity floor never
fires on the population that matters. It is also unsafe in the other
direction: PhysX caps depenetration at 1 m/s, so a body climbing out of
the floor reads as slow. A 2 cm rigid shell held for 60 ticks is immune
to both — such a body crosses the shell fifty times over inside the
window. This mirrors the codec's own park criterion
(`debris_codec.rs`), so the simulation's "has not moved" and the wire's
"has not moved" are the same predicate.

## What PhysX actually does, measured

Six GPU tests in `physx-bridge/tests/freeze_wake_semantics.rs`, all
passing on a 4090. The first was the load-bearing risk of the whole
design:

1. **Making one body of a sleeping pile kinematic does not wake the
   rest.** `setRigidBodyFlag` is a rigid-body write, and rigid-body
   writes are exactly what woke the entire city 60 times a second in the
   identity-stamp regression. It does not cascade, so freezing a pile in
   bounded batches is safe.
2. Freezing a whole pile emits **no retire and no promote events** — a
   freeze is not a topology change, so the client keeps the body's
   chunks.
3. Frozen bodies leave the snapshot stream (which is what stops the
   encoder paying for them) but **keep their colliders**: a ray still
   finds the pile.
4. Unfreezing returns bodies within 5 cm of their frozen pose at under
   0.5 m/s — no depenetration pop.
5. Serial 0 is refused by both calls: unfreezing a structure's support
   actor would drop a standing building into free fall.
6. Unknown, duplicate and already-frozen ids are no-ops, because the
   caller's picture of what is live is a tick old by construction.

## Results

### One shot into settled rubble

`city_bench::one_shot_into_settled_rubble_wakes_only_its_neighbourhood`,
A/B'd against its own control in one process (absolute wake counts
depend on how much rubble a given run produced, which GPU
non-determinism moves 10–15%):

| | bodies | frozen | woke on one shot |
|---|---:|---:|---:|
| freezing off | 507 | 0 | 409 (**81% of the pile**) |
| freezing on | 647 | 618 | 95 (**15%**) |

That is the live session's shape reproduced, and bounded.

### Retiring the pile PhysX will not sleep

`city_bench::pose_freezing_retires_the_pile_physx_will_not_sleep`, over
30 s of walking away from the same demolition:

| | frozen | awake body-seconds | fully quiet |
|---|---:|---:|---|
| engine-sleep freezing only | 137 | 14,279 | never |
| + pose shell | 622 | **3,204** (−78%) | 22 s |

The control's own census names the population it leaves behind: 462
awake bodies pose-quiet at the end of the run — motionless, and never
slept.

### Sustained downtown ramp

300 s of `record-city-trace` on `fractured-downtown.json` (24,105
chunks), 2,000 shots ramping from one every 8 ticks to one every 3, same
schedule both runs. Damage stops around t+180–215 s; the rest is quiet.

| | freeze off | freeze on |
|---|---:|---:|
| broken bonds | 16,087 | **21,523** |
| bodies created | 4,458 | **6,164** |
| median awake while shooting | 1,963 | **837** |
| p95 awake while shooting | 4,031 | **2,126** |
| peak awake | 4,041 | **2,591** |
| median sim ms while shooting | 11.6 | **9.3** |
| p95 sim ms while shooting | 19.0 | 20.5 |
| awake body-ticks over the run | 41,834,860 | **12,925,123** |
| frozen at the end | 0 | 6,090 |
| membership mismatches | 0 | 0 |

The shape matters more than any single number: **freezing destroyed 34%
more of the city while carrying 57% fewer awake bodies at the median and
69% less awake work over the run.** Cost stopped tracking cumulative
damage and started tracking only what is currently in motion.

The most load-bearing line is peak awake. The measured knee on this
hardware is ~3,000 awake bodies; the baseline peaks at 4,041, past it,
and spends 2,269 ticks (13% of the run) at 3k or above. The freeze run
peaks at 2,591 and **never enters those buckets at all**:

| awake | freeze off | freeze on |
|---|---:|---:|
| 0–1k | 925 ticks (5%) | **14,123 ticks (78%)** |
| 1–2k | 6,128 | 3,143 |
| 2–3k | 8,678 | 734 |
| 3–4k | 1,105 | **0** |
| 4–5k | 1,164 | **0** |

**The decay criterion is where the two runs stop resembling each other
at all.** After the last damage the baseline never drops under 1,000
awake bodies for the remainder of the run; the freeze run is already
there. That flat baseline tail is the live session's pathology
reproduced headlessly — the pile stops being touched and keeps being
simulated anyway — and the campaign's acceptance target (awake under 1k
within ~5 s of a collapse ending) is met with freezing and never met
without it.

Two caveats stated plainly. p95 sim is slightly *worse* (19.0 → 20.5 ms)
and about 7% of ticks exceed the 16.7 ms budget in **both** runs: those
are live collapses, where the bodies are genuinely in motion and must be
simulated. Freezing does not address that and should not — and the
freeze run is doing 34% more collapsing. And the headless shot plan
saturates around 16–22k broken bonds, so the ≥40k sustained figure from
the live human session was not reproduced offline; 16–22k does sit in
the band where the live capture bracketed the merge threshold, but the
far tail remains unmeasured here.

### A measurement bug worth recording

The first version of this ramp reported 95% fewer awake bodies. It was
wrong, and the way it was wrong is the interesting part.

`record-city-trace` fires shots through `destruction.apply_blast`
directly rather than through `CityRuntime::apply_shot_ray`, so it never
called `wake_around`. Frozen rubble in the offline harness could
therefore never come back: shots into a settled pile did nothing, and
the run looked cheap because it had stopped simulating a city it had
also stopped destroying.

It surfaced on the 10-floor high-rise with shots spaced 1.5 s apart, so
later rounds land on settled rubble. Damage against wall-clock, freezing
on: **763 broken bonds at t+30 s, and 763 for the remaining 15 s**,
against an unfrozen control that went on to 2,112. A 60% *drop* in
destruction was being reported as a performance win. With the wake wired
in, the same scenario gives 2,122 against the control's 2,039 — equal
within GPU non-determinism — at 341 peak bodies against 497.

The lesson is that a freeze number is only meaningful next to a damage
number. Every table above therefore carries broken bonds and bodies
created alongside the cost, and the freeze run has to be doing *at
least* as much destruction for its cheapness to mean anything.

### Instrument check

`city_bench::awake_and_sleeping_counters_agree` exists because the
freeze policy keys on these counters and they had to be shown to
partition the population before being trusted. They do: awake +
sleeping + one kinematic support actor per structure accounts for every
body. It also explains a pre-existing bench failure —
`demolished_tower_comes_to_rest` gives up at 20 s on a pile that holds
~390 bodies awake at under 1 m/s and then sleeps all at once at second
22. Two seconds short of a pass, and 21 seconds of simulating a pile
that is not moving.

### Encoder surge (independent)

`LiveEncoder::add_body` rebuilt the whole lane radii table — 24,105
entries for a downtown pack — per admitted body. Admitting 6,000 bodies
into a 24k-lane table:

| | |
|---|---:|
| table rebuild per body | 57.17 ms |
| point update | **0.49 ms** (117×) |

The 57.17 ms is not a coincidence: the worst encoder tick ever recorded
live was 57.8 ms, produced by one contact-island wake admitting 6,000
lanes at once. The radii rebuild *was* that spike. Verified byte-exact
against the full codec protocol (archive 36,646,007; debris-codec
13,814,930; island 975,959; live 8.821 avg / 22.551 peak; all gates
PASS).

## Wire impact: none

The freeze reuses the settle the wire already carries, and the wake
rides `ChunkStreamEncoder::ingest_tick`'s fourth argument — a channel
that was fully built, tested, encoded and applied client-side, and
passed `&[]` from both call sites. Zero client changes.

The one new obligation is that a **pose-frozen** body has never been
slept by the engine, so no settle record exists for it and it is about
to leave the pose stream; the freeze synthesizes one at the frozen pose
in the same tick. `encoder::tests::a_woken_body_clears_its_settle_on_the_wire`
drives promote → settle → wake through real encode/decode into a
client-side ledger and asserts the island comes back un-parked.

## Incidental repairs found on the way

- **C++ id packing never got the widening `ids.rs` received** (commits
  `1f28cc0`, `b8131f5` touched Rust only): chunk ids were packed
  `structure << 12` and bonds `<< 16` against Rust's 16 and 20, and
  `queue_chunk_damage` masked node indices to 12 bits on a 24,105-node
  structure. Latent because production runs one structure, where the
  shift is a no-op — and this campaign targets the multi-structure
  merged-pile case. Guarded by a test verified to fail with the bug
  reintroduced ("chunk id 4097 decoded to structure 0, event says 1").
- **`physx-bridge/tests/destruction_smoke.rs` had not compiled in a
  while**, invisibly: it is gated on a feature `cargo check --workspace`
  does not enable.
- **Both codec regression gates have been unrunnable since the crate
  moved into the workspace**, using a bare `cargo run` that is ambiguous
  now that there are three binaries.
- The codec skill's island-stream reference was stale at 985,445 B;
  master measures 975,959, so a re-measure read as a 1% regression.

### Frozen rubble is weightless, and what that cost to fix

A kinematic body has infinite mass and is not accelerated by gravity, so
a frozen chunk exerts no force on what it rests on. On the ground that
is free. On a structure still standing it deletes load that should be
helping bring the structure down.

The industry design's answer is to freeze only what has "predominantly
static support", and that test is implemented here
(`FreezeTracker::is_supported`, using the spatial index already built:
grounded, or resting on rubble already retired and therefore
transitively grounded). **It defaults off, and that is a measurement.**

Requiring support re-creates the problem the system exists to solve. A
body that cannot find a grounded neighbour can never be retired, so it
stays awake indefinitely. With the condition on, the one-shot bench saw
the pile fail to come to rest at all — 431 bodies still awake after
180 s, where the *unfrozen* control settled fully.

So the trade is: an unquantified fidelity risk against a measured
regression that undoes the win. The downtown ramp is the evidence that
settles it in practice — freezing measures 34% *more* destruction than
its control, so weightless rubble is not suppressing collapses at scale.
`VIBE_CITY_FREEZE_GROUNDED=1` turns the condition on for anyone who
wants to revisit it with a scene where the load path matters more.

## Configuration

All default to current behaviour; nothing freezes unless switched on.

| variable | default | meaning |
|---|---:|---|
| `VIBE_CITY_FREEZE` | off | master switch |
| `VIBE_CITY_FREEZE_AFTER_TICKS` | 30 | engine-asleep ticks before freezing |
| `VIBE_CITY_FREEZE_BATCH` | 256 | freezes per tick, bottom-up |
| `VIBE_CITY_FREEZE_POSE` | off | also freeze awake-but-motionless bodies |
| `VIBE_CITY_FREEZE_POSE_TICKS` | 60 | ticks inside the shell |
| `VIBE_CITY_FREEZE_SHELL_M` | 0.02 | shell radius |
| `VIBE_CITY_WAKE_RADIUS_SCALE` | 1.0 | multiplier on impact radius |
| `VIBE_CITY_WAKE_ABOVE_M` | 2.0 | upward release above an impact |
| `VIBE_CITY_POSE_CENSUS` | off | count pose-quiet bodies without acting |
| `VIBE_CITY_FREEZE_GROUNDED` | off | freeze only ground-supported rubble (see above) |

## Open

- **Defaults are still off.** Flipping them is gated on the sustained
  downtown ramp and on video.
- **Floating shelves.** Frozen rubble outside a wake volume stays put
  even if its support is blasted away. `VIBE_CITY_WAKE_ABOVE_M` releases
  the column above an impact; whether the residual reads as a ledge or a
  glitch is a perceptual call and needs footage, not percentiles.
- **Freezing onto a moving support.** Bottom-up ordering and the 1 s
  pose window make this unlikely rather than impossible; the shell test
  rejects a body whose support is moving, but not one whose support is
  momentarily still.
- **Bounded surge admission** in the live encoder was left unbuilt: the
  quadratic fix removed the measured spike, and spatial wake bounds the
  wake sets that would produce another. The smear mechanism
  (`join_restates_per_span`) is there if it is ever needed.
