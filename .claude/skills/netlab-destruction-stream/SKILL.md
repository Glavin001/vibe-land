---
name: netlab-destruction-stream
description: Measure and change what the destruction stream sends — the encoder tape and replay that make an A/B mean anything, the five semantic scenarios, and the send audit that says which of six gates dropped a body and what that cost. Use when debris arrives late or not at all, when changing the scheduler, priority or byte ceiling, or before claiming a streaming change helped.
---

# Measuring the destruction stream

## The physics is not deterministic, so never A/B two recordings

Three recordings of the *identical* scripted collapse, driven from the
identical shot tape, broke **5,300, 6,740 and 7,052 bonds**, with
fall-notification p99 of 34, 34 and 42 ticks. That spread is larger than most
scheduling changes worth making. An A/B between two *runs* cannot attribute a
difference to the change under test.

Record the physics once, then replay the encoder against it:

```bash
# once, on the GPU (~60 s)
record-city-trace --demolish --encoder-tape-out wedge.tape \
  --packets-out pkts --packets-wire 2 --output truth.towertrace

# as often as you like (~0.3 s, no GPU)
netlab-encoder --tape wedge.tape --manifest pkts/manifest.json
```

The replay reproduces the recorder's own in-process audit **cell for cell** —
that equality is the check that the tape is faithful, and it is worth re-running
after any encoder change. The camera lives in the tape header, not on the
command line, because interest and the pixel error budget are camera-dependent
and a replay from elsewhere is a different question wearing the costume of a
comparison. `--camera-eye/--camera-look` override it deliberately, and every
line of output then says `OVERRIDDEN`.

**On a Mac, the recording half does not build.** `record-city-trace` refuses
to run without the Blast `cuda-stress` feature, which is Linux/NVIDIA-only, so
tapes are recorded on a Linux box. The replay is CPU-only and builds on the
Mac (`cargo build --release -p vibe-land-destruction --bin netlab-encoder`,
into your own `CARGO_TARGET_DIR`); copy the tape and its `pkts/manifest.json`
over. For a stream measurement recorded on the Mac itself, use Netlab v2
(`docs/netlab-v2.md`), which replays a paired session bundle through the
production encoders and records with `client/netlab/v2/record-bundle.sh`
under the GPU lock.

## The scenario set, and why it is a set

```bash
scripts/netlab/scenarios.py record      # five GPU runs
scripts/netlab/scenarios.py replay      # all of them, ~7 s
scripts/netlab/scenarios.py summarize
```

| scenario | the question it exists to answer |
|---|---|
| `wedge` | one tower over sideways — the regime the artefacts were reported in |
| `slabs` | few large bodies: expensive records, enormous on-screen error |
| `rubble` | many small bodies: cheap records, the budget is the constraint |
| `sustained` | three buildings, no idle stretch to recover in |
| `aftermath` | thousands awake and barely moving, long after anything happened |

**The set is not ceremony.** A stride fix once looked complete on `wedge`
(p99 14, max 128) while `slabs` still had a **19.7-second** straggler and
`rubble` a 22.6-second one — and `sustained`/`aftermath` were never about the
stride at all, being ceiling-bound. Three distinct causes that a single
aggregate would have averaged into one unactionable number.

## The send audit: which gate, and what it cost

`ChunkStreamEncoder::enable_send_audit()` (measurement only, never on in a
match) records a cross-tab of **phase** against **outcome**.

Phases are chosen by how *predictable* the body is from the client's side,
because that decides what a record is worth: `resting`, `just-freed`,
`falling`, `tumbling`, `landing`, `settling`.

Outcomes are the six places the send path drops a body, in evaluation order:
`eval-cap`, `rest-stride`, `rest-unchanged`, `not-relevant`, `not-newsworthy`,
`ceiling`, `sent`. A conservation test asserts they partition the candidates,
so the totals reconcile against the one number the encoder decides
independently. **Check that test still passes after touching the send path** —
without it the cross-tab is numbers that do not add up.

Plus the headline: **ticks from a body entering free flight to the first record
that follows**, per body, with the gate that turned it away most often while it
waited. A latency alone says "it was late", which does not pick a fix.

## Traps that have each produced a wrong conclusion here

**1. A metric whose denominator does not match its numerator.**
`error_per_byte` divided total error by *all* of a cell's bytes, including
first-ever records, which have no measurable error avoided — there is no prior
pose to compare against. The `sent` cell is full of exactly those: 1,796 of
6,311. That made sent records look 18% *less* valuable than the ones the
ceiling discarded, and it was reported as evidence the ranking was broken. It
was the denominator. Matched properly, the ranking is fine for `just-freed`
(+42%) and `tumbling` (+47%), and only slightly inverted for `falling` (−4%).

**2. Believing a fix without measuring it.** Two plausible, well-argued changes
did nothing:

- *Burst budget* (bank a second of unspent ceiling): cost **5–8% more bytes**
  across all five scenarios and moved p99 and max by nothing. In `sustained`
  the ceiling losses among the slowest falls went **up**, 362 → 380. A body that
  loses the ranking loses it at any budget. Kept, tested, defaulted **off**.
- *Value-per-byte ranking* in `select_with_ceiling`: correct in principle and
  **inert** in practice, because during a collapse nearly every record is a
  31-byte ballistic one, so cost is constant. Kept because it is the right
  question for a byte budget, claimed as no improvement.

**3. Raising the ceiling to fix a latency tail.** Quadrupling it did not move
p99 or max by a single tick. The tail was a *policy* gate, not bandwidth — and
after that gate was fixed, the same p99 and max held at half the ceiling as at
double it. Establish which gate before spending bytes.

**4. A stride staggered on the wrong clock.** `REST_EVAL_STRIDE` staggered by
sim tick, but sends only happen on ticks divisible by `send_interval_ticks`, so
at 30 Hz on a 60 Hz sim `sim_tick` is always even and `(even + slot) % 8` is
never zero for an odd slot. **Half of all bodies were never re-evaluated** while
under the rest speed. Two tests now pin that every slot gets an evenly spaced
turn at the real send cadence.

**5. "Resting" defined by speed alone.** A chunk one tick into free fall is
slower than the rest threshold, so the gate built to save work on settled
rubble was deferring the single most valuable record in the stream. Free flight
now exempts a body for its first `FRESH_FALL_TICKS`, bounded so long-settled
bodies keep their stride. p50/p90/p99 went to **zero ticks in every scenario**
at byte-identical cost.

## Fixture hygiene

The scripted collapse lives in `destruction::demolition`, shared by the live
`/city-demolish` endpoint and the offline recorder, because two copies had
already drifted and a fixture that does not reproduce what a player triggers is
worth nothing. Two defects found in the fixture itself, both silent:

- `tallest_footprint` ranked over a `HashMap` and several cells tie at the same
  height, so four identical invocations aimed at four different corners. Ties
  now break on cell coordinate.
- The jitter RNG shifted 33 bits and divided by `u32::MAX`, yielding
  `[0, 0.5)`. `jitter` silently meant twice what it said and any value ≥ 0.5
  demolished nothing: 1,563 targets at 0.0, 452 at 0.35, zero at 0.6.
