# Calibration 1a: an RC slab viaduct, piers taken out one at a time

Status (2026-10-07): with section bending (`VIBE_SECTION_BENDING=1`) or section
rotation (`VIBE_SECTION_ROTATION=1`), the engine matches the prediction. It
holds through the first two removals, with every loaded bond within 2-5% of the
hand calculation, and it collapses at the third, as predicted. The default
engine reads the deck's bending 3.65 times too low: it survives the third
removal, which the real bridge would not. It fails only at the fourth removal,
and then it does not fall. Pieces of deck freed from every anchor stay jammed
between the supports as a flat arch of rigid blocks. That is an engine gap.

Source: `structures/calibration/src/bridge-slab.mjs` (structure, design, hand
calculation), `structures/calibration/scenarios/bridge-piers.mjs` (cases).

## The structure

A two-lane overbridge deck, bare (surfacing and parapets stripped, as before
demolition), integral with its abutments and its wall piers. There are no
bearings: this is the CIRIA C543 / BD 57 integral form usual for short-span slab
viaducts.

| | |
|---|---|
| Spans | 10.5 + 5 x 10 + 10.5 m = 71 m, six wall piers |
| Deck | solid C35/45 slab, b = 8.0 m, h = 0.60 m (span/17), segments 1.0 m long |
| Piers | 6.0 m wide x 1.0 m thick x 6.0 m tall, 3 chunks, on thin anchor plates |
| Concrete | C35/45: f_ck 35 MPa, E_cm 34 GPa (EN 1992-1-1 Table 3.1); 25 kN/m^3 (EN 1991-1-1 Table A.1) |
| Steel | B500B, f_yk 500 MPa (EN 1992-1-1 Annex C) |

**Design.** The deck steel is designed to EN 1992-1-1 for the ULS envelope of
self-weight plus EN 1991-2 Load Model 1, both factored 1.35. Load Model 1 here
is lane 1 at 9 kPa with a 2 x 300 kN tandem, and lane 2 and the remaining area
at 2.5 kPa with 2 x 200 kN. The UDL is patterned span by span, and the tandem
is placed at each midspan. Design moments: M_Ed = +2,437 / -3,944 kN m. The
steel is 180 cm^2 each face (rho 0.42%), the same top and bottom along the
deck. The engine has one tension limit per bond, so the reinforcement is
symmetric. The piers have 0.2% each face (EN 1992-1-1 9.6.2 minimum).

**Capacities (characteristic, gamma = 1).**

| | Value | Basis |
|---|---|---|
| Deck M_Rk | 4,724 kN m | stress block 3.1.7(3), compression bars neglected |
| Deck M_yk | 4,547 kN m | first yield, cracked section |
| Deck V_Rk,c | 3,058 kN | 6.2.2(1), C_Rk,c = 0.18 |
| Pier N_Rk | 221 MN | |
| Pier M_Rk | 5,554 kN m | |

**From capacity to engine material.** The stage breaks a bond when a fibre
stress passes its limit. Each limit is therefore the stress the stage's own
formula reaches at the section's capacity:

- tension = M_Rk / S_el = 9.84 MPa
- compression = N_Rk / A
- shear = V_Rk / A

For reinforced concrete in flexure, elastic equals fatal: steel does not lose
strength under sustained load. Compression is the exception, with elastic at
0.85 of fatal (Ruesch; EN 1992-1-1 3.1.6 alpha_cc). See
`structures/calibration/src/materials.mjs`.

## Loads and the hand calculation

Self-weight only: 120 kN/m of deck. The hand calculation is a linear-elastic
plane frame (`src/frame2d.mjs`, direct stiffness, the method behind moment
distribution) on gross sections (EN 1992-1-1 5.4):

- the deck is fixed at the abutment faces;
- the piers are fixed at their footings and rigidly joined to the deck.

Every bond the engine has is checked where the engine checks it. For the deck
that is M and V at each 1 m segment joint, including the faces of the segment
over each pier rather than the pier centreline. For each pier joint it is the
fibre stresses under N and M.

Lumping each chunk's weight at its centroid, as the engine does, changes the
answer by 0.1%. The prediction carries a +-15% band on utilisation:

- concrete scatter (mean f_y ~1.1-1.15 f_yk, JCSS);
- a solve converged to 1e-3 of its forces (0.4%);
- E A for G A_v shear stiffness (~1% of deflection at these spans).

| Step | Removed | Largest span | Hand calc: worst bond, M | u | Prediction |
|---|---|---|---|---|---|
| 0 | none | 10.5 m | abutment face, M = -1,121 kN m | 0.24 | holds |
| 1 | pier 2 | 20 m | deck at pier 1's face (x 11), -3,270 kN m | 0.69 | holds |
| 2 | piers 2, 5 | 2 x 20 m | deck at pier 6's face (x 60), -3,288 kN m | 0.70 | holds |
| 3 | piers 2, 3, 5 | 30 m | deck at pier 4's face (x 40), -7,960 kN m | **1.69** | **collapses** |
| 4 | piers 2-5 | 50 m | deck at pier 6's face, 4.87 x M_Rk | 4.87 | collapses |
| 5 | all six | 71 m | abutment face, 10.7 x M_Rk | 10.7 | collapses |

Pier 1 or pier 6 alone would give u 0.91, because a gap against a fixed
abutment loads the abutment's fixed end hardest. The order therefore takes out
the piers away from the abutments first. A real bridge loses no strength under
sudden removal in a static analysis. The dynamic increase of up to 2 that GSA
2016 allows for sudden removal does not arise in the engine: its chunks are
rigid, so no strain energy is released. See the write-up's "engine gaps".

## Simulation

`node structures/calibration/run.mjs bridge-piers` puts the six cases side by
side, 24 m apart, on the real city stage (`server/src/calibration.rs`). It runs
600 ticks at 60 Hz, FP32, a 64-iteration stress cap, internal correction limit
1, `PX_DESTRUCTION_ALLOW_UNCONVERGED=1`, and the native app's stress settings.
The engine is vibe-land 5d7ddfe9. The SDKs are PhysX garage-roof (0e0aba8a0)
for default and section, and garage-multihull (9d5024d1e+) for rotation.

| Step | Prediction | default | section | rotation |
|---|---|---|---|---|
| 0 | holds, u 0.24 | holds, 0 broken | holds, 0 broken | holds, 0 broken |
| 1 | holds, u 0.69 | holds | holds | holds |
| 2 | holds, u 0.70 | holds | holds | holds |
| 3 | **collapses**, u 1.69 | **holds** (0 broken) | **collapses**: 72 bonds tick 1, deck falls 6 m | **collapses**: 78 bonds tick 1, falls 6 m |
| 4 | collapses, u 4.87 | fractured, jammed (16 broken, 55 chunks free, 3 mm drop) | fractured, jammed (54 broken) | collapses, falls 6 m |
| 5 | collapses, u 10.7 | fractured, jammed (45) | fractured, jammed (66) | fractured, jammed (40) |

Ratios below are the engine's utilisation over the hand calculation's, for
every bond with hand u >= 0.2, at the first solve at rest:

| Step | default (vs its own gain model) | section | rotation |
|---|---|---|---|
| 1 | 1.001 (0.999-1.02) | 1.002 (0.94-1.12) | 0.999 (0.98-1.02) |
| 2 | 0.997 (0.75-1.00) | 1.004 (0.75-1.13) | 0.987 (0.87-1.00) |

At the critical bond, deck@11 in step 1, the engine reads 0.665 (section) and
0.700 (rotation) against the hand calculation's 0.692. In step 3 the hand
calculation's worst bonds (deck@11, @12, @39, @40, all u >= 1.29) all break on
the first tick in section. In rotation deck@39 survives, because deck@40 broke
beside it.

**Verdict:** section and rotation match the prediction. The first collapse is at
step 3, it starts at the predicted bonds, and nothing breaks before. Default
does not match: it survives step 3 at u 0.57. Measured against its own model
(the gain), the default stage is exact to 0.1%. The bridge then fails at step
4, but it does not fall.

## Engine gaps found

1. **Default bending reads 3.65x too low for this deck.** With the gain capped
   at 3, sigma = M/A min(6/sqrt(A), 3) gives an effective S of 1.753 m^3 for
   the 8 x 0.6 m section, whose S is 0.48 m^3. The pier is 2.45x too low. The
   gain model predicts that error to 0.1%. The default stage's bridge survives
   a 30 m span that is 69% over its capacity.
2. **Broken decks jam as rigid flat arches.** In step 5 every deck bond is
   broken, and the 71 pieces still hang between the abutments for 10 s with a
   3 mm drop. The same happens in step 4 under default and section. A chain of
   tight rigid blocks between rigid supports cannot rotate: each block's
   diagonal is longer than its length. The thrust that holds it,
   H ~ w L^2 / (8 f) with f <= h, is ~126 MN for the 71 m span. Real concrete
   would crush at the hinge edges at once. The stage has neither contact
   crushing nor deformable chunks. With crushing (`VIBE_CRUSH`, an SDK with
   `PX_DESTRUCTION_CRUSH_CORRECTION`) the jammed blocks' virial would crush
   them. That is not yet evaluated here.
3. **Anchor geometry is part of the stiffness.** A bond's compliance runs
   centroid to centroid. A 1.5 m abutment anchor bonded to the deck end read
   the fixed-end moment 15% low (ratio 0.85), because its centroid adds 0.75 m
   of flexible "deck" to the clamp. Thin anchor plates (0.1 m) fix it: ratio
   1.02. This is an authoring rule for any anchored structure.
4. **Rotation's contact length flattens monolithic members.** Under
   `VIBE_SECTION_ROTATION` a bond's spring length is max(distance, sqrt(A))
   (PhysX/vibe-land 2c9fd106: the flat-punch rule). For a 4.8 m^2 deck section
   on 1 m segments, every bond becomes 2.19 m long. The abutment's 0.55 m bond
   is softened to match, so the fixed-end moment reads 17% low (0.198 against
   0.237). The punch rule fits a contact between separate bodies. It does not
   fit a cut through one member whose section is wider than the cut spacing:
   slabs, walls, decks. Every other loaded bond is within 2%.
5. **No dynamic amplification on sudden loss.** Rigid chunks store no strain
   energy, so removing a support cannot overshoot. The engine is a sequence of
   static analyses. GSA 2016 asks for a dynamic increase factor of up to 2 for
   a linear static analysis of sudden removal. A real bridge between 0.5 and 1
   of its capacity statically may fail dynamically. None of these cases is in
   that band.

## Reproduce

```sh
node structures/calibration/run.mjs bridge-piers                    # all three configurations; exit 1 on a miss
node structures/calibration/run.mjs bridge-piers --configs section  # one
node structures/calibration/run.mjs bridge-piers --judge-only       # re-judge the last reports
PHYSX_ROOT=<an SDK with impact model E> node structures/calibration/run.mjs bridge-piers --configs impact
```

Outputs go to `structures/calibration/out/bridge-piers/`:

- `spec.json`: cases, predictions, every bond's key and hand utilisation;
- `report-<config>.json`: the GPU run;
- `verdict.json`.

Video: see `docs/calibration/README.md`.
