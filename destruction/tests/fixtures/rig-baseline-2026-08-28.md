# Rig baseline — before any physics change (2026-08-28)

Measured with `rig_scenarios_sim` on the GPU path, packs as authored, material
table untouched. This is what "the buildings feel too strong" is, in numbers.

## Rest utilisation, intact and settled

| rig | peak bond utilisation | overstressed bonds |
|---|---|---|
| rig-column | 0.015 | 0 |
| rig-portal | 0.027 | 0 |
| rig-cantilever | 0.420 | 0 |
| rig-garage | 0.343 | 0 |
| rig-pane | 0.031 | 0 |
| rig-wall | 0.294 | 0 |
| rig-toppled | 0.316 | 0 |

## The scenarios

**Garage, every column on one side cut.** Peak utilisation climbs 0.81 → 0.84 →
1.01 (one bond overstressed at t=3 s) and then settles at **0.99 for the
remaining 22 seconds**. Zero bonds break. The overhang drops **0.00 m in 25 s**.

**Cantilever ladder.** Every rung from 1 m to 6 m holds. Utilisation is a flat
**0.42 for 30 seconds** — the 6 m shelf and the 1 m shelf are equally safe as
far as the solver is concerned. No rung ever fails.

**Slab on one ledge.** Does exceed 0.25 utilisation, so a bearing contact is a
real load path — re-grounding works in principle.

**One city shot on a column.** Breaks 6 of the rig's 10 bonds. A single hit is
most of the answer.

## What this says

The story is sharper than "rest stress is far below yield". Two of these rigs
sit at a third to a half of their elastic limit standing still, which is a
reasonable place for a structure to live. The defects are:

1. **Nothing accumulates below the elastic limit.** A bond at 0.99 utilisation
   is exactly as immortal as one at 0.015: damage is `(stress − elastic)`, so
   at 99% of yield it is zero, forever. The garage sits one percent under the
   line for 22 seconds and is never any closer to failing than when it started.

2. **Bending is understated, so the cantilever never gets near the line.** A
   12 m concrete plate hanging off a column grid reads as 0.99; a 6 m shelf off
   a wall reads as 0.42. Both should be far past yield. Two compounding causes,
   both already located: bend is folded into the axial stress with `copysign`,
   so it is checked against the COMPRESSION limit (48 MPa) instead of producing
   tension (6 MPa, eight times weaker); and it is scaled by `2/nodeDist` where a
   section modulus belongs (`6/sqrt(area)`), which understates it roughly
   tenfold again.

3. **A shot is far past fatal**, so weapons never exercise the gradual-damage
   band either. Everything in this simulation either cannot be damaged or is
   annihilated.

Fix order follows from this: bending first (it is why the load is not seen),
then re-measure, then calibrate limits, then tune the time constant.

---

# After the bending fix + recalibration (same day)

Changes: bending resolved into tension/compression fibres instead of being
folded into the axial sign; bending scaled by a bounded section modulus;
bond damage made a per-second rate with instant failure past the fatal limit;
material tension/shear fractions raised (reinforced joints), masonry and timber
elastic limits roughly doubled.

| rig | rest utilisation before | after |
|---|---|---|
| rig-column | 0.015 | 0.025 |
| rig-portal | 0.027 | 0.052 |
| rig-cantilever | 0.420 | 0.936 |
| rig-garage | 0.343 | 0.848 |
| rig-pane | 0.031 | 0.166 |
| rig-wall | 0.294 | 0.833 |
| rig-toppled | 0.316 | 0.827 |

## What now works

**Cantilevers fail by length.** 2, 4, 6, 8 and 10 m shelves hold; the 12 m one
tears off. Before, a 6 m shelf sat at a flat 0.42 utilisation for thirty
seconds. The failure threshold is now within a factor of two of what hand
statics predicts for the section, which it was nowhere near before.

**Failure is delayed and ordered by severity.** At a damage rate of 0.5/s the
10 m shelf let go at 7 s and the 12 m at 4 s — both visibly held first, and the
one nearer its limit took longer. That is the effect the whole exercise was
for, and it is now a property of the model rather than a coincidence.

**A blast still breaks things.** Separating the two mechanisms matters here:
with a single rate slow enough to make a floor strain visibly, a rocket
deposited under a percent of a bond's health in its one tick and broke nothing
at all. Overload past the fatal limit now fails immediately; only the
sub-fatal band accumulates.

## What is still short

**The garage does not come down.** With one whole side of columns cut it now
reaches 3.08x its elastic limit with ~30 bonds overstressed — it is being felt,
where before it was not — but it sits there for 25 s without failing. At a
damage rate of 2/s and before the bending amplification was bounded it did
collapse, at ~18 s and only ~1 m of sag. It is right at the boundary and needs
another calibration pass, not another mechanism.

**One body will not settle.** `every_structure_stands_under_its_own_weight`
fails on the parking garage with a single body still awake at 5 s. No bonds
break (the invariant that matters holds), it settles in 1 s when run alone, and
it passes with the bending flags off — so it is the bending change keeping one
chunk marginally alive, not a structure coming apart.

---

# Re-measured with the solver actually solving

Everything above, and every calibration decision taken from it, was measured
through a solver that stopped re-solving a structure on its second tick. Those
numbers were a property of the settled-island skip, not of the buildings. This
is the same measurement after that was fixed, at 20 s so the readings have
converged (checked against 5 s; only algedra moves, by one bond).

| building | hottest joint class | max | mean | over limit |
|---|---|---:|---:|---:|
| parking-garage | parapet→slab | 0.98 | 0.16 | 0 |
| algedra-tower | balcony→slab | 1.03 | 0.05 | 1 |
| house-1story | wall→wall | 0.22 | 0.02 | 0 |
| house-2story | glazing→wall | 0.20 | 0.04 | 0 |
| villa-savoye | slab→wall | 0.94 | 0.12 | 0 |
| park-432 | wall→wall | 1.18 | 0.10 | 6 |
| petronas | slab→wall | 1.12 | 0.12 | 3 |

## What this overturns

The conclusion I had been working from -- that these buildings sit at a few
percent of their materials' limits and are ten to twenty times too strong --
is **wrong**. It came from reading frozen stresses.

Measured properly, the hot joints in four of the seven are at or past 1.0
standing still, and park-432 and petronas already carry a handful of bonds
over the line. Globally weakening concrete, which is what "too strong" implied
and what I was about to do, would have pushed those into self-destruction. The
sliver cull is what is currently keeping the count at single digits.

## What it points at instead

Means of 0.02-0.16 against maxima near 1.0 is a stress-CONCENTRATION pattern,
not a strength problem: a handful of attachment joints -- balcony to slab,
parapet to slab, slab to wall -- carry an order of magnitude more than the
material around them, in every building independently. That is the same shape
of finding as the slivers, one level up: the load path narrows at attachments.

So the next lever is those attachments and the weapon, not the material table.
