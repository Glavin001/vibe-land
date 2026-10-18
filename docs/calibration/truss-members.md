# Calibration 1b: a glulam Pratt truss footbridge, members cut

Status (2026-10-07): **under section rotation (`VIBE_SECTION_ROTATION=1`) the
engine matches the prediction in all six cases.** At rest, its bond
utilisations are within 0.97-1.02 (median) of the hand calculation. Section
bending alone breaks the intact truss on tick 1. The default engine carries
cuts no real truss would survive: a centre diagonal at u 3.1, an end diagonal
at u 10.

Sources:

- `structures/calibration/src/truss.mjs`: structure, connection design, hand
  calculation;
- `src/planar.mjs`: the plane-frame chunk builder;
- `scenarios/truss-members.mjs`: the cases.

## The structure

A 24 m footbridge: two Pratt trusses 3 m apart, each with six 4 m panels and
3 m deep (span/8).

- **Members.** GL28h glulam (EN 14080: f_m 28, f_c,0 28, f_t,0 22.3,
  f_v 3.5 MPa, E 12.6 GPa), all 200 mm wide. Chords and end posts are 280 mm
  deep, verticals and diagonals 200 mm. Chords are continuous through the
  joints.
- **Joints.** Web members and end posts sit in slotted-in steel plates with
  12 mm S235 dowels, sized for the member's ULS force (EN 1995-1-1 8.2.3, 8.5.1).
  One dowel is 2 x 11.6 kN in double shear (mode h, eq. 8.11). The group's
  effective number is n^0.9, with at least 4 dowels. The joint's stiffness is
  the dowels' slip modulus, K_ser = rho_m^1.5 d / 23 per shear plane, doubled
  for steel-to-timber.
- **Engine materials.** Tension = shear = R_k / A on the member's end section,
  compression = f_c,0. Sustained limit k_mod 0.9: a crowd is a short-term
  action (EN 1995-1-1 Table 3.1).
- **Deck.** Cross beams at every bottom panel point carry the deck and make the
  U-frames that hold the trusses upright. Each cross beam's mass is its
  panel's deck (1.5 kPa) plus crowd: q_fk = 2.0 + 120/(L + 30) = 4.22 kPa
  (EN 1991-2 eq. 5.1), 34.3 kN per truss per panel point.
- **Bearings.** Both are fixed (pinned). The stage cannot give a bearing
  freedom to slide, because a bond to an anchor holds in every direction. Some
  short footbridges are built with two fixed bearings.

| Member | N (pin-jointed, kN) | Dowels | R_k (kN) |
|---|---|---|---|
| bottom chord, end panels | -25 | (continuous) | |
| bottom chord, centre panels | +50 | | |
| top chord | -201 / -226 | | |
| end posts | -157 | 14 | 249 |
| end verticals B1-T1 | +36 | 4 | 81 |
| verticals B2-T2 | -21 | 4 | 81 |
| midspan vertical B3-T3 | -1 | 4 | 81 |
| end diagonals T1-B2 | +95 | 8 | 151 |
| centre diagonals T2-B3 | +32 | 4 | 81 |

Because both bearings are fixed, the bottom chord is relieved: the end panels
are even in compression. The truss is partly a two-hinged arch.

## The hand calculation

There are two analyses (`frame2d.mjs`):

- **Pin-jointed** (the method of joints, the dowelled joints slipping as
  pins): the engineering prediction while the truss is still triangulated. A
  cut that makes it a mechanism makes it singular.
- **Rigid-jointed:** the same frame with rigid joints. It checks every bond at
  the joint faces and mid-member with the engine's failure law, so it covers
  Vierendeel action and the secondary moments.

**Prediction:** a member cut that leaves the truss a mechanism brings it down,
because these joints cannot carry the panel's shear as a Vierendeel frame. A
200 x 200 joint's moment capacity is a few kN m. A member cut that leaves it
triangulated holds.

| Case | Cut | Pin-jointed | Rigid-jointed, short-term u | Prediction |
|---|---|---|---|---|
| step0 | none | u 0.63 (end diagonal's dowels) | 0.83 | holds |
| step1 | midspan vertical B3-T3 (-1 kN) | 0.62 | 0.82 | holds |
| step2 | + centre diagonal T2-B3 | mechanism | **3.15** (Vierendeel in the centre panel) | collapses |
| chord | centre bottom chord B2-B3, alone | 0.62: still a two-hinged arch on fixed bearings | 0.84 | holds |
| end-diagonal | T1-B2, alone | mechanism | **10.1** | collapses |
| top-chord | T2-T3, alone | mechanism | **55** | collapses |

The cut chord holding is a consequence of the fixed bearings. On a pin and a
roller, the textbook truss, a cut bottom chord is a mechanism (the CPU test
checks both).

## Simulation (600 ticks, the cuts both trusses)

| Case | Prediction | default | section | rotation |
|---|---|---|---|---|
| step0 | holds | holds | **falls at rest** | holds; bonds 1.02 x hand (0.75-1.15) |
| step1 | holds | holds | falls | holds; 0.97 |
| step2 | collapses | **holds** | collapses | collapses tick 4: 82 bonds, falls 2.9 m |
| chord | holds | holds | **falls** | holds; 1.02 |
| end-diagonal | collapses | **holds** | collapses | collapses tick 1 |
| top-chord | collapses | **damaged** (6 bonds) | collapses | collapses tick 1 |

In rotation step2, the first bonds to break are the end diagonals' joints at
the bottom (T1-B2 at B2). The hand calculation has them past capacity too
(the Vierendeel panel's shear goes into them), though it ranks the centre
verticals' joints first.

## Engine gaps found

1. **Default bending is far too low for timber sections.** The capped gain
   reads the chords' and joints' bending 4-10x low. The default truss carries
   a cut end diagonal, which a real one cannot.
2. **Section bending without section rotation breaks the intact truss.** With
   one rotational length scale for every bond, the min-norm solution carries
   load as bond moments. With true section moduli those moments break the
   bottom chord's bonds on tick 1 (the CPU oracle: up to 6.3x the dowel
   joints' limit at rest). Section rotation puts the load into axial forces,
   as a truss carries it, and gives the engineering answer.
3. **No sliding bearing.** Bonds to anchors resist every direction, so a
   roller bearing cannot be built. The engine's truss is a two-hinged arch: it
   survives a cut bottom chord that would drop a simply supported truss.
4. **No buckling.** Rigid chunks do not buckle. The top chord's out-of-plane
   buckling, which governs real pony trusses, is out of reach. The calibration
   takes the chord as braced by its U-frames.
5. **One tension limit per bond.** EN 1995 checks f_t,0 = 22.3 MPa in axial
   tension and f_m = 28 MPa in bending. The engine's one fibre limit uses f_m,
   so axial tension is read 25% generously.

## Reproduce

```sh
node structures/calibration/run.mjs truss-members
node --test structures/calibration/tests/hand.test.mjs    # pin-jointed forces against the method of sections
```
