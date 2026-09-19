# Streaming baseline — scripted wedge collapse

**Run.** `fractured-downtown.json` grid 1 (24,105 chunks / 74,543 bonds), native GPU
destruction. `--demolish` wedge on the 84.2 m tower at (4, −44): 322 rounds, 55° wedge,
35% jitter, 2 rounds/tick from tick 60. 30 s / 1,800 ticks. 7,052 bonds broken, peak
1,460 bodies. Wire v2, one client, 870 sends.

**Stream.** 0.93 Mbps poses + 0.15 Mbps reliable = **1.08 Mbps**. The per-send ceiling
allows ≈2.5 Mbps.

## The funnel, by what the body was doing

`err/byte` is metres of client-side error per wire byte the cell accounts for —
error *avoided* per byte spent for `sent`, error *accepted* per byte saved for the rest.

| phase | outcome | count | share | err/byte (mm/B) |
|---|---|---:|---:|---:|
| resting | rest-stride | 78,835 | 58.9% | 0.48 |
| resting | rest-unchanged | 8,942 | 6.7% | 0.27 |
| resting | not-newsworthy | 43,041 | 32.2% | 0.37 |
| resting | ceiling | 178 | 0.1% | 1.53 |
| **resting** | **sent** | **2,829** | **2.1%** | **0.57** |
| just-freed | rest-stride | 2,530 | 10.7% | 0.33 |
| just-freed | rest-unchanged | 225 | 1.0% | 0.15 |
| just-freed | not-newsworthy | 8,398 | 35.6% | 1.38 |
| just-freed | ceiling | 5,431 | 23.0% | **4.87** |
| **just-freed** | **sent** | **6,988** | **29.6%** | **4.48** |
| falling | not-newsworthy | 207,156 | 72.3% | 1.22 |
| falling | ceiling | 28,891 | 10.1% | 4.78 |
| **falling** | **sent** | **50,566** | **17.6%** | **4.98** |
| tumbling | not-newsworthy | 7,556 | 8.6% | 1.66 |
| tumbling | ceiling | 26,922 | 30.5% | 4.87 |
| **tumbling** | **sent** | **53,752** | **60.9%** | **6.80** |

## Findings

**1. The ranking adds almost nothing at the cut line.** For `just-freed`, records the
ceiling *dropped* are worth **4.87 mm/B** and records it *sent* are worth **4.48 mm/B** —
we are discarding higher-value records than we transmit. For `falling` the two are 4.78
vs 4.98, a 4% edge. If the priority function were ordering by error the sent side should
dominate by a wide margin. It does not. This is the single biggest result here.

**2. The budget is idle on average and saturated at the peak.** 61,244 records were
dropped by the byte ceiling, yet the run averaged 0.93 Mbps against a ≈2.5 Mbps
allowance. All of the loss is inside the collapse burst; the rest of the run leaves
two-thirds of the budget unused. We are rate-limiting the one second that matters and
idling through the twenty-nine that don't.

**3. The resting stride defers bodies that have just broken loose.** 2,530 `just-freed`
evaluations were skipped by `REST_EVAL_STRIDE`, worst deferred error **2.52 m**. The
guard is speed-based (≤ 0.05 m/s) and a body one tick into free fall is slower than that,
so a stride built to save work on settled rubble is delaying exactly the first record
that matters.

**4. Fall notification is fine at the median and terrible in the tail.** Ticks from
entering free flight to the first record: **p50 0, p90 2 (33 ms), p99 34 (567 ms), max
1,388 (23 s)**, and **5 bodies were never told about at all**. So the floating building
is not the typical chunk — it is a small minority starved for enormous durations. One
chunk hanging in a falling façade is what the eye catches.

**5. `not-newsworthy` is the largest drop for falling bodies (72%), and mostly right** —
1.22 mm/B against 4.98 for sent. But its worst deferred error is **5.61 m**, so the gate
is also discarding a tail of badly-wrong bodies. It is a good average filter with no
protection against its own outliers.

## Fixture note

The scenario caught a determinism defect in itself before it measured anything: several
8 m footprint cells tie at 84.2 m, and `max_by` over a `HashMap` picked whichever the
iterator reached last, so four identical invocations aimed at four different corners.
Ties now break on cell coordinate; three consecutive runs now select the same 322 rounds.

## What this baseline cannot yet see

- **Rotation error is not measured.** `state-diff` parses quaternions and discards them.
- **End-to-end error** (what the real client displayed vs truth) is not in this run;
  the packets are captured and the replay path exists, but has not been run yet.
- The collapse is **1,460 peak bodies**; live reports describe 5,000+. The regime is
  right, the scale is roughly a third.
