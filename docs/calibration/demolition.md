# Calibration 4: controlled demolition of a three-storey RC frame

Status (2026-10-07): **blocked by an engine gap.** The mechanism and the test
exist. The building that stands on its charges collapses at rest, before any
charge fires, in every configuration. The control case ("charges placed, none
fired") fails, so the delay sequences cannot be judged yet.

Sources:

- `server/src/calibration_charges.rs`: the charges;
- `structures/calibration/scenarios/demolition.mjs`: the cases and the debris
  checks;
- `src/frame-building.mjs` with `charged: true`: the building.

## The demolition

The building is the ordinary-design three-storey RC frame of
[frame-column.md](frame-column.md): 3 x 6 m bays, 6 m deep, untied precast
floor planks.

**Pre-weakening.** The building is stripped: no partitions, no cladding. The
floors are already untied (precast planks on mortar beds), as a contractor
would leave them.

**Charges.** Every ground-floor column is loaded. A firing cuts its column
line (both frames) in one tick, which is what a linear-shaped or drilled
charge does to the member. Each charged column section is a plain static
PhysX box the building stands on, not a stage chunk. It is removed at its
firing's tick, so the structure above loses the support and the stage's
stress solve sees the change through the contact loads that stop. The blast's
air pressure on the rest of the structure is not modelled. That is a
reasonable simplification for column charges, whose energy goes into the
member.

The same file drives the GPU test and the film. `main.rs` applies the charges
in the match loop before the city step (`VIBE_CALIB_CHARGES`).

**Delay sequences.** Rows are 0.25-0.5 s apart, as in practice:

| Case | Firings | Intent |
|---|---|---|
| standing | none | control: it must stand on its charges |
| east-first | lines x 18, 12, 6, 0 at 1.0 / 1.3 / 1.6 / 1.9 s | the collapse runs east to west, each bay folding in |
| core-first | lines x 6, 12 at 1.0 s, then x 0, 18 at 1.25 s | the middle drops and pulls the outer bays in: into the footprint |

**Prediction.** The hand calculation is a plane frame per firing stage, as in
[frame-column.md](frame-column.md). The first firing of east-first leaves the
east bay cantilevering 6 m from line x 12. Each beam must then carry
w L^2 / 2 ~ 535 kN m against M_Rk 154 kN m: u 2.85 at the x 12 faces, on
all three floors. The bay folds down about those hinges. Each later firing
repeats it one bay west. Core-first takes 5x the beams' capacity at the first
firing.

The demolition engineer's checks are written into the test (`expect`):

- 95% of the frame's mass ends within the footprint plus 3 m;
- no chunk is thrown more than 6 m beyond it;
- the mass centroid moves 0 to +6 m east for east-first and stays within
  +-1.5 m for core-first;
- each firing breaks bonds within 0.5 s.

## What happened

The standing control comes down in default, section and rotation, with ~450
bonds broken. It breaks 359 bonds on the first tick, before any charge
fires. The stress solve report (`VIBE_CALIB_TRACE=1`) shows why. On the first
tick the stage reads contact loads at the supports of 10,000-25,000 m/s^2 on
the 326 kg floor-1 joints, which is 3.6-8 MN at a single support. The whole
building weighs 3.4 MN. From the second tick the contact loads are sane, at
50-180 m/s^2. The building's own reaction at a column is ~430 kN.

The spike is not the gap at the supports: with every support lowered 2 mm,
so no contact exists at the first tick, it is unchanged at 22,000 m/s^2. With
the supports moved away there are no contact loads at all, and nothing breaks
while the building falls. The spike is the first contact solve of a heavy,
unanchored, many-chunk structure on point supports, read by the trial as a
static load.

Default and rotation, with the supports in place: east-first and core-first
also leave 98% of the frame within the footprint plus 3 m. The centroid stays
within 0.1 m. But that is the at-rest collapse, not the sequence.

## Engine gaps found

1. **A structure standing on contact supports breaks on its first tick.** The
   first contact solve's impulse on a heavy unanchored structure is read as a
   static load of 2-8x its weight at a single support. City structures stand
   on bonded anchors, so they never meet this case. A demolition has to,
   unless the stage can cut bonds on command.
2. **There is no way to cut a member at a tick.** `PxDestructionScene` has no
   call to break given bonds or retire given chunks. Crushing does retire
   chunks, but by load, not by command. A charge should be a stage operation:
   break these bonds now, then let the corrected pass resolve the split. Two
   things would do it:
   - a `breakBonds(const PxU32* bonds, PxU32 count)` applied before the next
     trial, with a bridge call `native_cut_bonds(structure, bonds)` and the
     match loop reading it from `VIBE_CALIB_CHARGES` (bond lists instead of
     boxes);
   - with that, the building stays anchored on its ground columns, and a
     charge breaks the column's bonds at its tick.

   The scenario, its debris checks and the film need no change beyond the
   firings' format.

## Reproduce

```sh
node structures/calibration/run.mjs demolition                 # three configurations
VIBE_CALIB_TRACE=1 node structures/calibration/run.mjs demolition --configs rotation --ticks 4   # the first-tick contact inputs
```
