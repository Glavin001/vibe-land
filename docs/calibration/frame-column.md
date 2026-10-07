# Calibration 3: a three-storey RC frame, a ground-floor column removed (GSA 2016 / UFC 4-023-03)

Status (2026-10-07), under section rotation:

- **Matches:** the ordinary building stands; it collapses when its corner or
  edge column is taken out, as predicted; the UFC-designed building stands.
- **Does not match:** the UFC building comes down when its corner or edge
  column goes, where the plane-frame calculation says it bridges (u 0.70 /
  0.59). The engine fails at the corner beam ends, which the plane analysis
  leaves out (see "Open").

Section bending alone breaks even the intact frame at rest. The default
engine is too strong in some cases and too weak in others.

Sources:

- `structures/calibration/src/frame-building.mjs`: the structure, two
  designs, the hand calculation;
- `structures/calibration/scenarios/frame-column.mjs`: the cases;
- `structures/calibration/walk.mjs`: the stair walk test.

## The structure

- **Frames.** 3 bays of 6 m by one 6 m bay, three 3.5 m storeys. Two moment
  frames (z 0 and z 6) are joined at every column line by transverse beams.
  C30/37, B500B, links 2 x 8 mm at 150 mm.
- **Floors.** 200 mm precast planks, 1.2 m wide, spanning 6.3 m between the
  frames' beams on mortar beds: simply supported and untied, as in
  Ronan-Point-era construction.
- **Loads.** The planks carry, smeared into their weight:
  - self-weight;
  - 1.5 kPa finishes;
  - half the 3 kPa office imposed load.

  That is D + 0.5 L, the load at the time of the event (GSA 2016 3.2.4; UFC
  4-023-03 3-2.11): 8.0 kPa, or 29.7 kN/m on a frame beam.
- **Stair.** An exterior stair tower at the x 18 end, on its own footings: the
  kit's dogleg proportions with a 1.35 m half landing, 175 mm risers and a
  290 mm going, and floor landings level with each floor.

| Design | Beams | Columns | Basis | M_Ed | As per face | M_Rk |
|---|---|---|---|---|---|---|
| ordinary | 300 x 600 | 400 x 400, 1% | EN 1992-1-1 ULS of the intact frame, 1.35 G + 1.5 Q | 129 kN m | 5.8 cm^2 | 154 kN m |
| robust | 350 x 800 | 500 x 500, 2% | UFC 4-023-03 linear static: Omega_LD 2.0 on 1.2 D + 0.5 L over the bays above each removed corner/edge column, m = 2 (ASCE 41-13 Table 10-7, conforming RC beams) | 569 kN m | 20.5 cm^2 | 720 kN m |

## The hand calculation

Each frame line is a plane frame (`frame2d.mjs`, gross sections), with the
planks' reactions as a line load on its beams and half the transverse beams'
weight at its joints. A removed column is the frame without it, which is the
GSA linear-static alternate path. The engine's static load is the same, with
no dynamic increase factor. Rigid chunks release no strain energy, so the
engine's removal is static. GSA asks for a DIF of 2 in a linear analysis, and
the real building would feel that dynamic increase.

Bonds are checked where the engine has them: at the beam faces at the
columns, at each 0.8 m beam chunk joint, and at each column's ends.

| Case | Removed (ground floor, frame z 0) | Worst bond | u | Prediction |
|---|---|---|---|---|
| ordinary-intact | none | beam floor 1 at x 5.8 | 0.52 | holds |
| ordinary-corner | x 0 | beam floor 2 at x 5.8, hogging -438 kN m | **2.85** | collapses: the corner bay, all floors |
| ordinary-edge | x 6 | beam floor 2 at x 11.8 (12 m double span) | **2.47** | collapses: bays 1-2 |
| robust-intact | none | | 0.17 | holds |
| robust-corner | x 0 | beam floor 2 at x 5.75, -503 kN m | 0.70 | holds: bridges by cantilever |
| robust-edge | x 6 | column floor 2 at its base | 0.59 | holds: bridges the 12 m |

Catenary and membrane action are not modelled, and they are not available in
rigid chunks, which do not elongate. A real ordinary frame might find some
catenary capacity in continuous bottom bars at very large deflections. GSA
credits that only with detailing this building does not have.

## Simulation (600 ticks; 64-iteration cap)

| Case | Prediction | default | section | rotation |
|---|---|---|---|---|
| ordinary-intact | holds | holds | **collapses at rest** | holds (engine u 0.46 against 0.52) |
| ordinary-corner | collapses | collapses | collapses | collapses (356 bonds, 9.9 m) |
| ordinary-edge | collapses | **holds** | collapses | collapses (381 bonds) |
| robust-intact | holds | holds | fractured (planks' mortar beds) | holds (2 mortar beds crack: tolerated) |
| robust-corner | holds | holds | collapses | **collapses** |
| robust-edge | holds | holds | collapses | **collapses** |
| with-stair (ordinary, intact, stair tower on) | holds | **stair falls** | collapses | holds |

Under rotation the intact frames read 0.88-1.16 of the hand calculation's
bond utilisation (median 0.88).

## Verdict

**Rotation** separates a building that has no alternate path from one designed
with one only for the ordinary design. It collapses the UFC design too.

**Open: the UFC design under rotation.** The engine's first breaks in
robust-corner are the floor-1 beam bonds next to the removed corner (x 0.25,
1.04 m), not the hogging face at x 5.75 that the plane frame predicts. The
removed corner joint hangs on two paths:

- its own frame's cantilever;
- the transverse beam to the other frame's intact corner column.

The plane analysis has the first only. The second twists the corner joint and
bends the frame beam's end about its weak axis. The engine checks that with
the equivalent fibre limit M_Rk / S_el of the strong axis: one tension limit
per bond, the same in every direction. That is not the weak-axis capacity of
the real reinforced section. This needs a 3D hand calculation, a grillage of
both frames and the transverse beams, before calling it an engine error.

**Default.** It holds the ordinary-edge case at real u 2.47: its bending gain
reads a 0.3 x 0.6 beam's moment 2.4x low. Its stair tower falls at rest.

**Section.** It breaks the intact frame on tick 1. Columns go first, under
moments the default rotational stiffness puts through their joints: section
bending needs section rotation, as in the truss and the house.

## Engine gaps found

1. **Section bending without section rotation fails frames at rest.** This is
   the same finding as the truss and the house.
2. **Default bending reads 0.3 x 0.6 m beams 2.4x low.** The gain caps at
   6/sqrt(A) for A < 4 m^2. Under default, the ordinary building survives the
   loss of an edge column.
3. **One tension limit per bond.** An RC member's capacity is different about
   each axis (reinforcement layout), and in tension and compression. The
   equivalent-fibre mapping is exact for the strong-axis bending it is derived
   from, and approximate elsewhere. See "Open".
4. **No catenary or membrane action, and no dynamic increase.** Both follow
   from rigid chunks.

## Stairs

The stair tower is walk-tested by `node structures/calibration/walk.mjs --snap`.
The game's player walks up the dogleg to floor 1 and back, under the
`route_walk` rules (structure_qualification.rs). Under the shared-GPU load on
2026-10-07 the run timed out before the walk: result pending.

## Reproduce

```sh
node structures/calibration/run.mjs frame-column            # three configurations
node structures/calibration/walk.mjs --snap                 # the stair
```
