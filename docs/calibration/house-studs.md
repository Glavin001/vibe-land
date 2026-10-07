# Calibration 2: a brick-veneer bungalow, front-wall studs taken out one at a time

Status (2026-10-07): **not yet calibrated.** No engine configuration currently
reproduces the engineering answer, for three different reasons:

- **Default stage:** the house holds with all five studs out. It is far too
  strong in bending: the plate reads 0.07-0.6 of the hand calculation. The
  load also goes into ceiling joists that cantilever from the centre wall, a
  path a real roof does not have.
- **Section bending:** the intact house collapses on tick 1.
- **Section rotation:** the intact house breaks its rafter heels at rest and
  comes down or sheds its roof.

The kit is being requalified for section rotation by another agent. This
scenario is the test that will say when it agrees with an engineer. Every
miss is recorded in `structures/calibration/known-gaps.json`.

Sources:

- `structures/calibration/src/house.mjs`: the bungalow as the kit builds it,
  plate re-chunking, loads, hand calculation.
- `structures/calibration/scenarios/house-studs.mjs`: the cases.

## The structure

The town kit's brick-veneer bungalow (`structures/town-kit/src/veneer-houses.mjs`,
unchanged):

- C24 stud frame: 90 x 45 studs at 600 mm, a doubled 90 x 90 top plate,
  140 x 45 ceiling joists tying 190 x 45 rafters at a bolted heel;
- concrete tiles;
- a 90 mm brick veneer on ties, and 13 mm gypsum board.

Joints are rated by their fasteners (the kit's `materials.mjs` CONNECTIONS:
IRC R602.3(1), EN 1995-1-1). Removal order, from the middle of the front wall's
plain run, between the partition junction at x -1.8 and the door's king stud at
x 1.532:

| Studs out | x of the studs removed | Gap over the top plate |
|---|---|---|
| 1 | -0.037 | 1.2 m |
| 2 | + 0.563 | 1.8 m |
| 3 | + -0.637 | 2.4 m |
| 4 | + 1.163 | 2.77 m |
| 5 | + -1.238 | 3.33 m |

There are three houses per step:

- **frame**: the frame alone, with its front top plate re-chunked;
- **authored**: the frame as the kit authors it;
- **built**: brick and board on, plate re-chunked.

**Why re-chunk.** The kit makes a top plate one chunk per 2.4 m, so the stage
checks its bending only at those seams: a plate chunk over a gap is rigid.
`rechunk` cuts the front plate 57 mm either side of every stud and midway
between studs. Each existing bond is re-hung on the piece it bears on, and
each cut gets a full-section C24 bond. The stage then checks the plate where
the hand calculation peaks.

## Loads and the hand calculation

The loads come from the pack's own masses. The roof is a tied couple roof:
each rafter line puts half its weight (rafters, tiles over it, its share of
the ridge board) on each eaves plate, which is 1.39 kN at every rafter seat.
Each ceiling joist puts half its weight on the eaves plate (0.05 kN). That is
2.18 kN/m on the front plate.

The plate is a continuous C24 90 x 90 beam over the studs that remain (rigid
supports, pinned), loaded at the seats. Its two ends sit at the junction stud
and the king stud. There the plate runs on over a junction and a built-up
header, so the truth lies between pinned and clamped, and both bound the
answer:

- C24: f_m,k 24 MPa, f_v,k 4.0 MPa, E_0,mean 11 GPa (EN 338).
- Sustained limit: k_mod 0.6, the kit's `elastic`.

| Studs out | Gap | Worst plate M (kN m), pinned / clamped | Short-term u (f_m,k) | Sustained u (0.6 f_m,k) | Stud reaction next to the gap |
|---|---|---|---|---|---|
| 0 | 0.6 m | 0.02 | 0.04 | 0.07 | 1.5 kN |
| 1 | 1.2 m | 0.26 | 0.09 | 0.15 | 2.6 kN |
| 2 | 1.8 m | 0.56 / 0.58 | 0.19-0.20 | 0.32-0.33 | 4.4-5.2 kN |
| 3 | 2.4 m | 1.05 / 1.07 | 0.36-0.37 | 0.60-0.61 | 6.5-7.9 kN |
| 4 | 2.77 m | 1.90 / 1.68 | 0.58-0.65 | 0.96-1.09 | 7.2-8.1 kN |
| 5 | 3.33 m | 3.39 / 2.24 | **0.77-1.16** | 1.28-1.94 | 4.0 kN |

**Engineering prediction (model `real`).** The plate breaks at its short-term
strength.

- With 4 studs out it holds today (u <= 0.65).
- With 5 out it is at its strength (0.77-1.16 between the bounds): either.
  Expect it down, sooner or later. At 1.3-1.9 of the sustained limit, timber
  fails within days to years (duration of load).
- Bearing perpendicular to the grain at the stud next to the gap
  (f_c,90,k 2.5 MPa on 90 x 45: at most 0.8) is a deformation, not a collapse.

As built, the gypsum board screwed to the plate and studs is a deep beam that
an engineer does not count. It can only help: ~350 N per screw at 300 mm is
~1.2 kN/m of shear transfer.

**The kit's model (`kit`).** The stage applies the kit's limits as brittle. It
damages a bond above the sustained limit (k_mod 0.6) and breaks the stud-plate
joints at their bearing limit (0.6 x 2.5 MPa). It should therefore come down
at 4 studs out: stud bearing 1.18-1.33, plate 0.96-1.09.

## Simulation

The cases run 600 ticks with 18 houses side by side, at the native app's
64-iteration cap. The town kit qualifies houses at 16; that run is reported
below too.

| Studs out | Prediction (real) | default | section | rotation |
|---|---|---|---|---|
| 0-3 | holds | holds | **collapses at rest** | heels break at rest; frame-0, 1 and 3 fall |
| 4 | holds | holds | collapses | collapses |
| 5 | either | holds | collapses | collapses |

Authored and built houses do the same in every configuration. At 16
iterations, with the as-built houses re-chunked, the default stage broke 4
stud-top bonds at rest in the first tick, and none at 64. That first-tick cold
solve is not converged at 16 iterations.

**Bond utilisation at rest, engine / hand (default).** The plate's bonds read
0.2-0.5 of the hand calculation at 3-5 studs out. For step 5, at the plate's
critical cut, the engine has 0.086 where the hand calculation has 1.15.

The CPU oracle (`stress-share.py`, the engine's converged min-norm model)
shows where the load goes: the ceiling joists cantilever from the centre
wall. Their splice and heel joints reach 0.64-0.74, and the plate stays below
0.15. Under the default stage's capped bending gain, a 140 x 45 joist reads 14
times too little bending stress, so it can cantilever 3.7 m with a rafter's
load at its tip.

## Engine gaps found

1. **Default bending is 14-22x too low for timber members.** sigma =
   M/A min(6/sqrt(A), 3) caps at 3/m for any bond under 4 m^2:
   - a 90 x 90 plate: S_gain = 2.7e-3 m^3 against S = 1.2e-4;
   - a 140 x 45 joist: 14x too low.

   Load then takes paths a real house does not have.
2. **Section bending alone breaks the intact house.** With true section
   moduli but the default rotational stiffness (one length scale for every
   bond), the min-norm solution puts moments through nailed joints that their
   45 x 90 patches cannot carry. King, jack and header joints break on tick 1.
   The truss shows the same (see truss-members.md). Section bending needs
   section rotation.
3. **Under section rotation the heels fail at rest.** The CPU oracle with
   `--angular section` agrees with the GPU: 2.5-2.8x the heels' elastic limit.
   The joint's rotational stiffness from its own small patch leaves the bolted
   heel carrying the rafter thrust in shear (3.2 MPa). The kit has to be
   requalified for rotation; that work belongs to the rotational-stiffness
   agent.
4. **The kit's top plates are rigid between 2.4 m seams.** Plate bending can
   only fail at a seam. Re-chunking fixes it; the kit's builder should cut
   plates at the studs.
5. **Studs are soft springs.** The kit rates every timber joint by its fastener
   slip in every direction (materials.mjs SLIP: one stiffness per bond). A stud
   bearing on its plate in compression is ~50x stiffer than its nails in slip
   (E_90 A / t ~33 kN/mm). Soft studs push load sideways along the plate to
   headers and corners: under rotation the studs next to a gap carried 0.06
   of the hand calculation's bearing. One stiffness per bond (no
   tension/compression asymmetry) is an engine limit.
6. **Duration of load is compressed into seconds.** The stage damages a bond
   above its sustained limit at 2/s. A plate between 0.6 and 1.0 of its
   short-term strength fails in seconds on the stage, where a real one fails
   in days to years. The `kit` model (0.6 f_m,k) is what the stage can
   reproduce. `VIBE_STRENGTH_SHORT_TERM` (f03f4cc9, opt-in) drops sub-fatal
   damage and should make the stage match `real`. Not yet run here.

## Reproduce

```sh
node structures/calibration/run.mjs house-studs                         # default, section, rotation at 64 iterations
VIBE_CITY_NATIVE_STRESS_ITERATIONS=16 node structures/calibration/run.mjs house-studs   # the kit's qualification cap
uv run structures/town-kit/scripts/stress-share.py <case pack> --bending section --angular section   # the CPU oracle
```
