# Scenario-outcome matrix: what each hit should do, and what it does

The owner's brief (2026-10-07): list every scenario and its expected outcome
(a cannonball against a wall gives localized destruction; a meteor gives more;
a cannonball against a truck destroys a lot of the truck; a truck can still
drive after lesser hits), put automated tests with assertions on all of it, and
only then continue optimising performance. Where the simulation is proven
correct by tests and the outcome still does not match the real world, the
authoring changes.

- **Data:** `scripts/verify/scenarios.json`: impactors, targets, scenarios, each
  with the harness case that plays it (a wall-matrix case,
  `structures/vehicle-lab/wall-matrix.mjs`, or a test-bed trial,
  `structures/vehicle-lab/trials.mjs`).
- **Physics:** `scripts/verify/scenario-physics.mjs` (unit-tested by
  `scenario-physics.test.mjs`, regression `scenario-physics`).
- **Judge:** `scripts/verify/scenarios.mjs` (`table`, `judge`, `markdown`).
- **Run:** `scripts/verify/scenarios.sh runtime|high` (lab with the monster
  truck, the fleet cars, Vibe Town; one shared GPU slot). `correctness.sh full`
  runs it: gated in high, reported in runtime.

## How each expectation is derived

Expectations come from the real world, not from the engine and not from the
authored joint strengths. The scene supplies only geometry (where the brick,
studs and panes are, and their masses at real densities). Strengths come from
the cited sources.

### Shots (cannonball, meteor, 100 kg and 1 t balls)

1. **The path.** A square prism of the projectile's frontal area is swept along
   its line through the struck structure (`pathLayers`). Each chunk it overlaps
   contributes its overlapped share of mass (the real plug) and its whole mass
   (the engine's plug: the stage breaks whole chunks). Chunks across the path
   (walls, panes, posts) form layers by depth. Chunks lying along it (a floor, a
   side wall) add mass and bending work, not thickness.
2. **Each brittle layer** (brick, stone, concrete): the modified NDRC formula
   (Kennedy 1976; UFC 3-340-02 ch. 4; DOE-STD-3014):
   G = K N W/d (V/1000d)^1.8, K = 180/sqrt(f'c), x/d = 2 sqrt(G) or G + 1,
   perforation e/d = 3.19 x/d - 0.718 (x/d)^2 (or 1.32 + 1.24 x/d). N = 0.84
   (hemispherical nose). Inverted for the ballistic limit v_bl of the layer.
   Masonry is taken as concrete of the masonry's compressive strength:
   - brick masonry f'c 10 MPa: EN 1996-1-1 eq. 3.1 (K 0.55, f_b 20, M10 mortar)
     gives f_k 8.9 MPa, mean 10-13 MPa;
   - stone masonry 13 MPa (natural stone K 0.45, f_b 40);
   - concrete C30/37, f_cm 38 MPa (EN 1992-1-1 Table 3.1).
3. **Each timber layer:** the work to break its members in bending, C24 mean
   (EN 338: f_m,mean ~36 MPa, E 11 GPa): P_u = 4 f_m W/L, work P_u delta/2.
   A 38 x 89 stud is 3 kN and ~50 J. Glass, gypsum and sheet add plug mass only.
4. **Residual speed** layer by layer, Recht & Ipson (1963):
   v_r = m/(m + m_p) sqrt(v^2 - v_bl^2).
5. **Outcome.** NDRC's scatter is taken as +-20-25% on thickness. Through at
   0.8x and 1.25x thickness: *through*. Stopped at both: *stopped*. Otherwise
   *either*, and the scenario's `intent` chooses.
6. **Exit-speed band** for the engine: from the engine's whole-chunk plug at
   1.25x thickness, to the real plug at 0.8x. Plus or minus 10% of v_in for the
   tick sampling, as in `acceptance.mjs`. Measured as the approach speed when the
   projectile first clears the struck layer by its own diameter (probe `vExit`;
   8 m in for the whole-house shots).

### Vehicles into structures

EN 1991-1-7:2006 Annex C (C.2, C.4): a deforming vehicle with k = 300 kN/m
gives F = v sqrt(k m), lasting sqrt(m/k). Each target's resistance is a range
from the cited codes (`scenarios.json` `targets`):

| Target | Resistance | Why |
|---|---|---|
| veneer wall | 8-30 kN | 4 C24 studs across 2.24 m at 3 kN each, end nails 0.5-1 kN (EN 1995-1-1 8.3), 90 mm veneer f_xk1 0.1-0.4 MPa (EN 1996-1-1 Table 3.6) |
| masonry wall 7 x 2.5 x 0.25 | 12-45 kN | cantilever from its base: f_xk1 Z + N t/2 = 17-39 kN m at a 1.2 m contact |
| brick house 0.25 m | 170-520 kN | punching around the front: 6.9 m x 0.25 m of joints at f_vk0 0.1-0.3 MPa (EN 1996-1-1 Table 3.4) |

Comparing F with the range gives the outcome:

- F above the range: *through*.
- F below the range: *stopped*.
- F inside the range: *either*.

The exit speed is momentum with the plug carried (the car pushes its rubble),
less the work of pushing each layer at its resistance.

### Vehicles as targets

The test bed records, in the carrier's frame, every part the projectile's
sphere reached to its mid-plane through the part's thinnest dimension
(`swept`). It also records the mass held on only through those parts
(`separatedMassKg`), and whether the front and rear wheels stay joined in the
bond graph without them (`frontRearJoined`).

- **Swept parts.** A part the projectile occupied cannot stay attached unless
  the projectile stopped. So every swept part comes off, and so does everything
  held only through them.
- **Lesser hits.** The car keeps its wheels and drives (>= 3 m in 3 s,
  `criteria.mjs`) unless its path took a wheel or cut the car in two. The tyre
  contact is checked against the corner's capacity: F = v sqrt(k m_r), with
  ten M22 10.9 lug studs at 1.95 MN in shear (ISO 898-1) and a monster truck's
  250-500 kN landing loads.
- **The cannonball.** A truck cannot stop it: stopping 639 kN s within the
  ball's own 1.37 m diameter needs ~6.7 MN on a frame of ~10 chromoly tubes at
  ~266 kN each. It punches through and ends beyond the truck's far side.

### Locality, standing, "more"

- **Local.** No broken bond is farther from the line of travel than the hit's
  reach, r + 2t + l:
  - **r:** the impactor's radius (a car's half-width).
  - **2t:** the punching perimeter around it. A concentrated load through a
    slab or wall of depth t fails on a cone whose control perimeter lies 2t out
    from the loaded area (EN 1992-1-1 6.4.2, basic control perimeter u1 at 2d;
    a cone at 26.6 degrees). Past it the remaining wall carries only what the
    perimeter's joints carried when they broke (momentum and the joints'
    capacity), and that load spreads and falls off with distance in the plane,
    so it breaks nothing farther out.
  - **l:** the longest member with a joint inside that perimeter. A member cut
    or hinged there (a stud, a plate, a sheet, a veneer panel on its ties)
    hangs from or falls about its other joints, up to its own length away, and
    can break them. Every member is a chunk, so that is the chunk's longest
    dimension, read from the pack for each case.

  This replaces "2R", R = r + t + the struck chunk's size. The factor 2 had no
  derivation. The old R used a 45 degree cone (t) where the code's perimeter is
  2t. It also counted only the struck chunk, not the longest member reaching
  into the perimeter. The reach comes out larger for light balls, where long
  members (a sheet, a plate) reach into the perimeter: the 100 kg ball into the
  veneer wall gets 4.1 m, against 2.1 m before. It comes out smaller for the
  meteor into the masonry wall: 3.0 m, against 5.5 m before.

  Not covered: secondary impacts. Debris thrown through the house by the hit
  can break a joint anywhere it lands, which is real. The test bed cannot tell
  a debris break from a load-path break, so a debris break also counts against
  locality. The collapse test that separates gravity from the hit is the
  impact comparison's fallen members
  (`impact-arms.mjs`, `house.fallenBeyondReach`).
- **Collapse** (the impact comparison, `scripts/verify/impact-arms.mjs`).
  A house collapses when part of it loses its load path to the ground and
  falls. The test bed counts frame members that meet all four conditions:
  - **off the anchored body:** no bonded path to an anchored chunk remains;
  - **fallen:** dropped by more than their own depth, so they are off their
    bearing;
  - **beyond the impactor's reach:** farther from its line than its half-size
    across it plus the member's own length, so the hit itself did not strike
    or carry them;
  - **in an assembly:** still bonded into a detached body of two or more
    chunks.

  The last condition separates collapse from debris. An assembly falls as one
  because the joints that tied it to the rest of the house broke while its own
  held: its load path was cut. A member knocked loose by debris, or cut by the
  hit, has its own joints broken and falls alone. Those lone members are
  counted separately (`looseFallenMembers`) and shown, but are not collapse.
  Two members knocked off together by one piece of debris would count, which
  is rare and an over-count. The outcome is local when no member collapsed.
  Counts: `house.collapsedMembers` and `house.looseFallenMembers` (the test
  bed's house summary).
- **Stands.** No roof member down more than 0.5 m (the house probe's
  definition). The corner and roof hits only measure it, because a corner loses
  its posts and the plates over it may sag within physics.
- **More.** A meteor breaks more of a target than a cannonball does: its swept
  area is (2/0.687)^2 = 8.5 times larger.

### Validity (stated, not hidden)

- **NDRC range.** NDRC is calibrated on missiles of d <= ~0.3 m at 30-300+ m/s
  into concrete. Here it is extrapolated to a 1.37 m ball and to masonry, but
  the conclusions do not depend on it:
  - the cannonball's and meteor's perforation thicknesses (2 m and more)
    exceed every wall here by 7x or more;
  - their exit speeds are set by plug momentum, not by v_bl.

  Only the 100 kg ball's marginal cases (0.25-0.30 m masonry) lean on the
  formula, and those are marked.
- **Terrain.** The ground is a rigid floor (FIDELITY_AUDIT E10), so hits at
  grade (`veneer-base`, `masonry-base`) are not in the matrix.
- **The Vibe Town house and bus shelter.** The wall matrix's town-house aim misses the house
  (`townTarget` aims at the group's bounding face, which for the house is not its wall and for the open-fronted shelter is open air; both cases were "untouched" in
  the 2026-10-07 town run). It is left out until the aim is fixed.

## Artistic intent

Where physics leaves a range, the matrix chooses the more readable result
inside it, and says so:

- **ball100-stone-house:** the ball goes through. 0.30 m of stone against an
  NDRC perforation thickness of 0.36 m is inside the scatter.
- **truck20-brick-house:** the truck goes through. 775 kN against a punching
  resistance of 170-520 kN, and the owner's bar of 2026-10-07: a truck at
  20 m/s gets through the first wall.
- **truck10-brick-house:** left as *either* (387 kN against 170-520 kN) and
  only measured.

## The matrix

Measured 2026-10-08.

- **runtime:** garage-roof SDK, default packs: 108 checks pass, 55 fail, 23
  reported.
- **high:** garage-hifi 9e5d201f5 (provenance clean), high packs: 89 pass,
  89 fail, 23 reported.

Vehicle cases run with the default high profile (the opt-in joint bound off).
Regenerate this table with `node scripts/verify/scenarios.mjs markdown`. The
verdict rows are in `target/verify/scenarios-PROFILE/scenarios.json`.

### Meteors: judged from first contact with the structure (owner, 2026-10-08)

A meteor scenario must hit the target structure before anything else. Damage
and pass-through are judged from first contact with the structure to its exit
or its first other contact. Ground contact is reported separately. The lab's
at-grade meteors entangle the hit with the rigid ground (FIDELITY_AUDIT E10):
the sphere's bottom is below grade at the wall (veneer y 1.16, brick 0.86,
masonry 1.25, all with r = 2 m), or the shot dips below grade within the house
(slope 0.3). For those cases the judge reports the outcome and exit speed and
does not gate them.

The three clean meteor scenarios derive their expectation from energy against
path work and the plug carried:

| Scenario | Derivation |
|---|---|
| **meteor-into-roof** (`wm-veneer-roof-meteor-0`) | Comes in from above at 45 degrees and meets the roof first. Its path holds tiles, battens, rafters and the ceiling: ~850 kg swept and a few kJ of member work, against 1.08 GJ and 15.5 MN s. Through at 132 m/s [127-135]. A 4 m rock reaches the floor before it clears the roof plane, so its speed is taken one roof depth past first contact. |
| **meteor-through-upper-wall** (`wm-stone-house-upper-meteor-0`, new target `stone-house-upper`) | Aimed at 4.4 m on the two-storey house's upper brick storey (bottom 2.4 m up), near-level from the street, 9 m out. Through the 11 m deep house and out of the far wall with its bottom 1.9 m above grade. The NDRC limit of each brick wall is ~nothing to it. The swept upper floor (8.3 t across the path, up to 17 t more lying along it) gives an exit of 110 m/s [95-136]. More than the cannonball's damage on the same line (`cannonball-upper-wall`, exit 52 m/s [44-52]). |
| **meteor-into-vehicle** (`meteor-truck`) | `meteor.rs plan` drops it on the parked truck from above. It sweeps 80 parts (1.44 t) to their mid-plane. Every part it cuts comes off, and so does everything held on only through them (>= 1.49 t, 30%). |

The verification agent is redesigning the probe and the trials. Until then:

- the roof check uses the probe's per-tick window;
- the upper-wall check uses its 12 m speed sample;
- ground contact is the E10 known gap.

| Scenario | Expected (derivation) | runtime | high |
|---|---|---|---|
| cannonball-veneer-wall | through; exit 58.5 m/s [56.5-58.5]; local within 2.8 m; roof holds | **FAIL** damage local (bonds broken > 2R from the line): 1890 of 2974; stands (roof members down > 0.5 m): 79 of 102 | **FAIL** outcome: 0.02 m past the face (through > 1.67), v 60.0 -> -3.9 m/s; exit speed (m/s): never past; damage local (bonds broken > 2R from the line): 2 of 111; nothing holds past its capacity: partial hold |
| cannonball-veneer-stud | through; exit 58.4 m/s [56.7-58.4]; local within 2.8 m; roof holds | **FAIL** damage local (bonds broken > 2R from the line): 1901 of 3017; stands (roof members down > 0.5 m): 77 of 102 | **FAIL** outcome: -0.01 m past the face (through > 1.67), v 60.0 -> -0.5 m/s; exit speed (m/s): never past; nothing holds past its capacity: partial hold |
| cannonball-veneer-corner | through | PASS (1) | **FAIL** outcome: -0.01 m past the face (through > 1.67), v 60.0 -> 0.0 m/s |
| cannonball-veneer-window | through; exit 59.8 m/s [57.9-59.8]; local within 5.0 m; roof holds | **FAIL** damage local (bonds broken > 2R from the line): 999 of 2901; stands (roof members down > 0.5 m): 77 of 102 | **FAIL** outcome: -0.01 m past the face (through > 1.67), v 60.0 -> -1.3 m/s; exit speed (m/s): never past; nothing holds past its capacity: partial hold |
| cannonball-veneer-door | through; exit 59.2 m/s [58.5-59.2]; local within 5.5 m; roof holds | **FAIL** damage local (bonds broken > 2R from the line): 655 of 2953; stands (roof members down > 0.5 m): 77 of 102 | **FAIL** outcome: -0.01 m past the face (through > 1.67), v 60.0 -> -2.8 m/s; exit speed (m/s): never past; nothing holds past its capacity: partial hold |
| cannonball-veneer-roof | through; local within 7.5 m | PASS (2) | **FAIL** outcome: never a roof depth past; nothing holds past its capacity: INFINITE WALL |
| cannonball-masonry-wall | through; exit 56.1 m/s [54.3-56.2] | PASS (2) | PASS (2) |
| cannonball-brick-house | through; exit 56.9 m/s [53.3-57.0] | PASS (2) | PASS (2) |
| cannonball-stone-house | through; exit 54.4 m/s [48.1-54.6] | PASS (2) | PASS (2) |
| meteor-veneer-wall | through; exit 137.6 m/s [136.6-137.8]; local within 5.4 m; more than cannonball-veneer-wall | **FAIL** damage local (bonds broken > 2R from the line): 328 of 3067 | **FAIL** nothing holds past its capacity: partial hold |
| meteor-masonry-wall | through; exit 134.8 m/s [133.5-134.9]; local within 5.5 m; more than cannonball-masonry-wall | PASS (2) | PASS (2) |
| meteor-brick-house | through; exit 126.4 m/s [120.1-128.5]; local within 10.3 m; more than cannonball-brick-house | PASS (2) | PASS (2) |
| meteor-stone-house | through; local within 9.0 m; more than cannonball-stone-house | PASS (2) | **FAIL** nothing holds past its capacity: partial hold |
| meteor-into-roof | through; exit 132.0 m/s [127.0-134.9]; local within 12.7 m; more than cannonball-veneer-roof | **FAIL** exit speed (m/s): 98.7 | **FAIL** outcome: never a roof depth past; exit speed (m/s): never past; nothing holds past its capacity: partial hold |
| cannonball-upper-wall | through; exit 51.9 m/s [43.6-52.4] | PASS (2) | **FAIL** every step completed: 1 |
| meteor-through-upper-wall | through; exit 109.7 m/s [95.2-121.9]; more than cannonball-upper-wall | PASS (3) | **FAIL** outcome: -2.01 m past the face (through > 4.30), v 139.8 -> -11.3 m/s; exit speed (m/s): never past; more than cannonball-upper-wall: 85; nothing holds past its capacity: partial hold |
| ball100-veneer-wall | through; exit 52.6 m/s [32.2-53.0]; local within 1.7 m; roof holds | **FAIL** outcome: -0.01 m past the face (through > 0.59), v 60.0 -> -5.4 m/s; exit speed (m/s): never past; damage local (bonds broken > 2R from the line): 1426 of 1708; stands (roof members down > 0.5 m): 1 of 102 | **FAIL** outcome: -0.01 m past the face (through > 0.59), v 60.0 -> -0.1 m/s; exit speed (m/s): never past |
| ball100-masonry-wall | through; exit 36.3 m/s [21.8-40.4]; local within 1.8 m | **FAIL** outcome: -0.01 m past the face (through > 0.54), v 60.0 -> -4.4 m/s; exit speed (m/s): never past | **FAIL** outcome: -0.01 m past the face (through > 0.54), v 60.0 -> -0.6 m/s; exit speed (m/s): never past |
| ball100-brick-house | through; exit 37.1 m/s [16.4-41.0]; local within 2.5 m | **FAIL** outcome: -0.01 m past the face (through > 0.54), v 60.0 -> -4.4 m/s; exit speed (m/s): never past | **FAIL** outcome: -0.01 m past the face (through > 0.54), v 60.0 -> -0.5 m/s; exit speed (m/s): never past |
| ball100-stone-house | through; exit 24.1 m/s [0.0-32.4]; local within 2.3 m; *intent: through: 0.30 m of stone against an NDRC perforation thickness of 0.36 m is inside the formula's scatter; the matrix chooses the hole* | **FAIL** outcome: -0.00 m past the face (through > 0.59), v 60.0 -> -3.9 m/s; exit speed (m/s): never past | **FAIL** outcome: -0.00 m past the face (through > 0.59), v 60.0 -> -3.9 m/s; exit speed (m/s): never past |
| ball1000-veneer-wall | through; exit 56.7 m/s [48.1-56.7]; local within 2.0 m; roof holds | **FAIL** damage local (bonds broken > 2R from the line): 1644 of 2320; stands (roof members down > 0.5 m): 72 of 102 | **FAIL** outcome: -0.01 m past the face (through > 0.92), v 60.0 -> -2.7 m/s; exit speed (m/s): never past |
| ball1000-masonry-wall | through; exit 51.0 m/s [28.2-51.6] | PASS (2) | PASS (2) |
| ball1000-brick-house | through; exit 51.6 m/s [41.0-52.1] | PASS (2) | PASS (2) |
| truck10-veneer-wall | through; F 387 kN vs 8-30 kN; exit 8.3 m/s [7.4-8.4]; local within 3.6 m; roof holds; wheelsKept 4 | **FAIL** exit speed (m/s): 2.6; stands (roof members down > 0.5 m): 86 of 102 | **FAIL** outcome: 0.45 m past the face (through > 1.30), v 10.1 -> 0.3 m/s; exit speed (m/s): never past; wheels kept: 2 |
| truck20-veneer-wall | through; F 775 kN vs 8-30 kN; exit 16.9 m/s [15.1-16.9]; local within 3.6 m; roof holds; wheelsKept 4 | **FAIL** exit speed (m/s): 9.9; stands (roof members down > 0.5 m): 85 of 102 | **FAIL** outcome: 0.48 m past the face (through > 1.30), v 20.0 -> 0.3 m/s; exit speed (m/s): never past; wheels kept: 2 |
| truck30-veneer-wall | through; F 1162 kN vs 8-30 kN; exit 25.4 m/s [22.7-25.4]; local within 3.6 m; roof holds; wheelsKept 4 | **FAIL** stands (roof members down > 0.5 m): 88 of 102; wheels kept: 1 | **FAIL** outcome: 0.18 m past the face (through > 1.30), v 25.5 -> -1.5 m/s; exit speed (m/s): never past |
| truck10-masonry-wall | through; F 387 kN vs 12-45 kN; exit 6.6 m/s [6.1-6.6]; wheelsKept 4 | PASS (3) | **FAIL** exit speed (m/s): 4.1; wheels kept: 2 |
| truck20-masonry-wall | through; F 775 kN vs 12-45 kN; exit 13.3 m/s [12.5-13.3]; wheelsKept 4 | **FAIL** exit speed (m/s): 9.8 | **FAIL** wheels kept: 1 |
| truck30-masonry-wall | through; F 1162 kN vs 12-45 kN; exit 20.0 m/s [18.8-20.0]; wheelsKept 4 | **FAIL** wheels kept: 2 | **FAIL** exit speed (m/s): 14.0; wheels kept: 1 |
| truck10-brick-house | either; F 387 kN vs 170-520 kN; wheelsKept 4 | PASS (1) | **FAIL** wheels kept: 2 |
| truck20-brick-house | through; F 775 kN vs 170-520 kN; wheelsKept 4; *intent: through: 775 kN against 170-520 kN; the owner's bar (2026-10-07) that a truck at 20 m/s gets through the first wall* | PASS (2) | **FAIL** wheels kept: 0 |
| truck30-brick-house | through; F 1162 kN vs 170-520 kN; exit 21.8 m/s [11.9-22.1]; wheelsKept 4 | **FAIL** wheels kept: 3 | **FAIL** every step completed: 2; wheels kept: 0 |
| truck-through-veneer-house | through; F 775 kN vs 8-30 kN; local within 3.6 m; roof holds; wheelsKept 4, drives true | **FAIL** outcome: middle at z 24.79 (through at 27.9); damage local (bonds broken > 2R from the line): 1480 of 2841; stands (roof members down > 0.5 m): 102 of 102; wheels kept: 3 | **FAIL** outcome: middle at z 19.46 (through at 27.9); damage local (bonds broken > 2R from the line): 56 of 394; wheels kept: 2; drives away (m in 3 s): 1.6 |
| truck-through-masonry-wall | through; F 775 kN vs 12-45 kN; wheelsKept 4, drives true | **FAIL** wheels kept: 2; drives away (m in 3 s): 1.9 | **FAIL** every step completed: 1; wheels kept: 0; drives away (m in 3 s): 0.0 |
| cannonball-through-veneer-house | through; exit 56.7 m/s [53.3-56.7]; local within 2.8 m; roof holds | **FAIL** damage local (bonds broken > 2R from the line): 1936 of 2991; stands (roof members down > 0.5 m): 102 of 102 | **FAIL** outcome: -0.01 m past the face (through > 1.67), v 60.0 -> -7.2 m/s; exit speed (m/s): never past; nothing holds past its capacity: partial hold |
| meteor-through-veneer-house | through; exit 134.2 m/s [132.6-135.8]; local within 5.4 m; more than cannonball-through-veneer-house | PASS (3) | **FAIL** outcome: -1.43 m past the face (through > 4.30), v 134.1 -> -10.8 m/s; nothing holds past its capacity: partial hold |
| cannonball-truck | sweptOff true, separatedOff true, through true, drives unless-cut | **FAIL** every part it cut through comes off: 7 of 16 off (kept: Left cage member 2, Left cage member 5, Left cage member 7, Left cage member 13); and what was held on only through them: 283 kg off | **FAIL** every part it cut through comes off: 0 of 16 off (kept: Seat pan, Seat back, Left cage member 2, Left cage member 5); and what was held on only through them: 15 kg off |
| meteor-truck | sweptOff true, separatedOff true, drives no | **FAIL** every part it cut through comes off: 76 of 80 off (kept: Right cage member 5, Right cage member 13, Right cage member 14, Body sill front mount) | **FAIL** every part it cut through comes off: 13 of 80 off (kept: Front right wheel assembly, Front right spring and damper, Nose panel, Dashboard); and what was held on only through them: 179 kg off |
| ball1000-truck | sweptOff true, separatedOff true, through true, drives unless-cut | **FAIL** every part it cut through comes off: 0 of 2 off (kept: Body sill, Door outer skin); and what was held on only through them: 0 kg off | **FAIL** every part it cut through comes off: 0 of 2 off (kept: Body sill, Door outer skin); and what was held on only through them: 0 kg off |
| ball100-truck | sweptOff true, drives unless-cut | PASS (2) | PASS (2) |
| debris-wheel-truck | wheelsKept 4, drives true | PASS (1) | **FAIL** wheels kept: 3 |
| graze-cab-truck | sweptOff true, wheelsKept 4, drives true | **FAIL** every part it cut through comes off: 0 of 1 off (kept: Left cage member 12) | **FAIL** every part it cut through comes off: 0 of 1 off (kept: Left cage member 12) |
| mailbox-cannonball | through | PASS (2) | PASS (2) |
| streetlight-cannonball | through | PASS (2) | **FAIL** every step completed: 2 |
| tree-cannonball | through | PASS (2) | PASS (2) |
| street-sign-cannonball | through | PASS (2) | PASS (2) |
| mailbox-truck | through; F 775 kN vs 2-20 kN; wheelsKept 4 | PASS (3) | **FAIL** wheels kept: 2 |
| streetlight-truck | through; F 775 kN vs 10-25 kN; wheelsKept 4 | **FAIL** wheels kept: 3 | **FAIL** wheels kept: 2 |
| tree-truck | through; F 775 kN vs 35-285 kN; wheelsKept 4 | PASS (3) | PASS (3) |
| meteor-mailbox | through; more than mailbox-cannonball | PASS (2) | **FAIL** more than mailbox-cannonball: 18 |
| meteor-bus-shelter | through | PASS (1) | PASS (1) |
| desert-wall | through; wheelsKept 4, drives true | **FAIL** wheels kept: 2; drives away (m in 3 s): 1.8 | **FAIL** wheels kept: 2; drives away (m in 3 s): 2.8 |
| desert-framed-house | through-front; wheelsKept 4 | **FAIL** wheels kept: 2 | **FAIL** outcome: middle at z 18.90 (through at 20.34); wheels kept: 2 |
| derby-wall | through; wheelsKept 4, drives true | **FAIL** wheels kept: 2; drives away (m in 3 s): 0.0 | **FAIL** wheels kept: 3 |
| derby-framed-house | through-front; wheelsKept 4 | **FAIL** outcome: middle at z 19.58 (through at 20.34) | **FAIL** outcome: middle at z 18.92 (through at 20.34) |
| circuit-wall | through; wheelsKept 4, drives true | PASS (3) | PASS (3) |
| circuit-framed-house | through-front; wheelsKept 4 | PASS (2) | **FAIL** outcome: middle at z 18.89 (through at 20.34) |
| buggy-wall | through; wheelsKept 4, drives true | **FAIL** wheels kept: 2; drives away (m in 3 s): 2.2 | **FAIL** outcome: middle at z 20.00 (through at 20.125); wheels kept: 3; drives away (m in 3 s): 1.8 |
| buggy-framed-house | through-front; wheelsKept 4 | **FAIL** outcome: middle at z 19.46 (through at 20.34) | **FAIL** outcome: middle at z 18.65 (through at 20.34); wheels kept: 2 |


## Engine or authoring

Each failure is classified by evidence: the probe (held over capacity,
energy), the A/B runs, and whether the authored model itself predicts the
observed outcome.

### Engine (route to main)

1. **The high impact solve stops or bounces shots off the veneer house.** This
   covers the cannonball (wall, stud, window, door, through the house), the
   1 t ball, the meteor into the roof and the upper wall, and the truck at
   10-30 m/s against a wall rated at 8-30 kN. The probe flags a **partial hold**
   (an anchored set took more than its bonds can carry) or an **infinite
   wall**: the roof cannonball, and the meteor bouncing off the upper storey at
   -11 m/s. The same shots go through masonry, brick and stone in high. Runtime
   passes every one of them on outcome and exit speed. This is the known impact
   convergence problem (PhysX `feat/impact-capacity`). The two clean meteor
   cases are now its reproduction without the ground.
2. **The 100 kg ball stops at every wall in both profiles.**
   - Real world: through at 22-53 m/s. NDRC gives a perforation thickness of
     0.38 m against walls of 0.09-0.30 m.
   - The probe says "held": the tick's average force, 100 kg x 60 m/s / dt =
     0.36 MN, is under the struck chunks' capacity.
   - A real breach is made by the ~1 ms Hertz pulse (MN-level) and the plug's
     inertia: a 119 kg block of the lab wall takes half the ball's momentum.

   This is the stage's tick-averaged contact for light, fast projectiles (the
   probe's PULSE class), an impact-model gap, not authoring: the mortar
   joints are EN 1996 values.
3. **Cars lose wheels in collisions that EN 1991-1-7 bounds far below their
   corner capacity.**
   - Runtime: truck30 into masonry 2 of 4 wheels; the wall trial 2; the fleet
     cars 2 each.
   - High (joint bound off): 1-4.
   - EN 1991-1-7 gives 0.4-1.2 MN for the whole front, against ~2-5.6 MN wheel
     mounts.
   - The rigid carrier meets the wall in a tick or two. `criteria.mjs` records
     35 g and 10 MN on the fascia at 78 km/h, 10-20 times the Annex C force of
     a deforming vehicle.

   Engine: the vehicle contact model (E8's frontal impedance does not hold the
   force down). The truck's exit speeds behind walls are also 30-60% under
   plug momentum in runtime (2.6 against 8.3, 9.9 against 16.9 m/s).

   **Root cause (2026-10-08, the test bed's `loadBalance` audit,
   `VIBE_TESTBED_AUDIT=1`).** The audit compares the stress input on the car
   with the force its measured momentum change needs. The car's joints are
   graded in the trial pass, where the struck wall or house chunks are still
   anchored (kinematic, infinite mass). So the car takes a dead stop, plus the
   solver's position correction for up to 0.36 m of first-tick penetration.
   Its breaks are committed from that pass, and the corrected pass then lets
   the wall go.

   Monster truck, high (explicit step), default joints, first tick of contact:

   | Trial | Graded | Measured |
   |---|---|---|
   | Masonry wall at 10 m/s | 3.2 MN (a dead stop) | 1.7 MN |
   | Masonry wall at 20 m/s | 38.9 MN | 0.20 MN |
   | Lab wall | 42.7 MN | 0.52 MN |
   | Framed house | 44.2 MN | 7.0 MN |

   Stopping the truck dead in one tick takes 6.5 MN. The excess is the same
   with the impact step off, crush off, or any depenetration cap.

   The wheels go by their own inertia under these loads: about 800 g on 293
   kg. At 10 m/s, Vehicle2's corner constraint adds 520 kN per front wheel,
   about 0.37 MN m at the hub against the square-patch mount's 69 kN m.

   - **Test:** `physx-bridge/tests/vehicle_contact_load.rs` (regression
     `vehicle-contact-load`). It grades 1227 kN against 791 kN of momentum
     change (1.55x) on a wall the car breaks, and 1.00 on static and unbroken
     walls.
   - **Fix:** the impact agent's anchored-contact bound in the rigid solver.
     Every contact on an anchored chunk, in every pass, is bounded by what
     that chunk can transmit, C dt + m v_close.

   The authoring side is the joints' brittleness. Next item.
4. **Corner load spike with nothing hitting the car** (found by the joint
   bound). Coasting on a flat street, the rear upright-wishbone bond went from
   0.28 utilisation to past 1 within 5 ticks, at steady 10-14 kN wheel loads
   (`target/vehicle-testbed/scen-ab-on.json`, coast, audits). Stiffness is
   unchanged by the bound, so the forces are the stage's own, and the spike
   exists in the default assets too. It is hidden there by 100x joints.
5. **Vehicle joints cannot be ductile.** Ductile slip reached the stage
   (0193a7e2), but only the ADMM impact solve used it. That solve is now
   retired, and the static verdict grades steel brittle at fatal.

   PhysX fix/static-ductile-steel (`PX_DESTRUCTION_STATIC_DUCTILE`) gives metal
   joints (E >= 50 GPa) with an ultimate slip a static rule:
   - they strain-harden between the elastic and fatal limits with no section
     loss;
   - past fatal they neck by the slip of the excess, (u - 1) F_u / k plus
     1/2 (u - 1) F_u / m_light dt^2;
   - they rupture at the ultimate slip.

   Vehicle metal joints yield at a cited f_y/f_u (S355, 10.9, 6061-T6). Test:
   `static_ductile.rs`.

   On the trucks the rule waits for item 3's bound. Mode 1, the rule as built,
   still loses wheels against the 39 MN over-count, though the cannonball
   shreds the truck (675 bonds). Mode 2, the return mapping alone, keeps every
   wheel but stops the cannonball shredding it (47 bonds).
6. **Runtime grading** (known gaps 1-2). From one hit the whole veneer house
   comes down: 1,900-2,990 bonds broken beyond 2R, roof 77-102 of 102 members
   down. This covers the cannonball, the 1 t ball and the trucks.
7. **Failed steps** in high on the brick-house trucks, the masonry-wall trial,
   the upper-wall cannonball and the street-light cannonball (1-2 steps each).

### Authoring

1. **Vehicle joints 100-1000x too strong** (FIDELITY_AUDIT D10). Each joint
   was given the joint stress (300 MPa steel) over the measured face contact:
   - a roof panel on its cage: 70 MN;
   - the fascia on its grille: 72.5 MN;
   - the median joint 0.86 MN, against a truck weighing 49 kN.

   Evidence, in both profiles:
   - the cannonball passes through the truck yet takes off 7 of the 16 parts
     it cuts in runtime and 0 of 16 in high (15 kg off where >= 312 kg must
     go);
   - the meteor takes off 179 kg in high where >= 1.49 t must go;
   - the 1 t ball and the meteor grazing the cab cut a sill, a door skin and a
     cage member that stay on.

   With the section bound (below) the cannonball took 1.42 t off. The owner's
   "a cannonball destroys a lot of the truck" needs this, and engine items 4
   and 5 first.
2. **Glazing joint 12 MPa** (reality.mjs finding: glass flexure 20-120 MPa).
   The joint is the polyurethane bead, not the glass: 3-6 MPa lap shear, over
   a bead much narrower than the face. Documented, not changed: it is the same
   face-area problem as item 1.
3. **Harness aims.** The town-house and bus-shelter matrix cases aim at the
   group's bounding face and miss. They are out of the matrix until
   `townTarget` aims at the nearest wall chunk.

### Measured, not gated (physics allows the range)

- **Masonry.** Panels struck out of plane crack along their mortar joints to
  their supports (yield lines, EN 1996-1-1 Table 3.6 f_xk 0.1-0.4 MPa), so
  breaks beyond the hole are physical. In high: masonry 8 of 92 bonds,
  stone 52 of 228, brick house 110 of 388, upper storey 12 of 235.
- **The veneer corner and the roof:** the roof's state.
- **truck10-brick-house:** a stop or a breach are both physical.

### What passes

- **Runtime:** every shot through masonry, brick and stone (outcome and exit
  speed within the Recht-Ipson band); the cannonball and meteor through the
  veneer house (outcome, exit); all town props (outcome, breaks); the
  upper-wall meteor and cannonball; the 100 kg ball into the truck (drives on).
- **High:** shots through masonry, brick and stone; the house stands with the
  roof up where the shot got in; locality inside 2R on every veneer case; the
  meteor breaks more than the cannonball on every house target; the tree, the
  sign and the post box.


## Recalibrations

### Vehicle joints bounded by their members' sections

`client/src/vehicles/real-joint-capacity.mjs`, commits 2ea3a19b and c365c1f4.

**Source.** A joint fails no later than the parent metal beside it:

- EN 1993-1-8 4.5.2 and 4.7, full-strength welds;
- EN 1993-1-8 3.6.1, net-section rupture;
- spot welds 4-10 kN (AWS D8.9M, ISO 14273);
- M10 8.8 bolts 46 kN.

**Model.** Each joint's limits scale so that limit x area equals the joint
stress times the smaller member's section, where the section is the member's
budgeted mass / density / length. Stiffness keeps the measured area, and wheel
mounts keep their counted studs.

**Effect on the monster truck.** 661 of 857 joints are bounded:

- median 860 to 280 kN;
- p90 4.4 to 0.81 MN;
- the wishbones ~130-300 kN, now below the 5.6 MN wheel mount (damage order:
  panels, then suspension, then wheels).

**Test.** `client/src/vehicles/real-joint-capacity.test.ts` (regression
`real-joint-capacity`): a panel on a 1.75 x 0.120 in tube holds what the tube
can (119 kN), not 300 MPa over the face; wheel studs are unchanged.

**Status.** Opt-in, `VIBE_REAL_VEHICLE_JOINTS=1`, and **not** in `high.env`.
With it on, the truck broke its rear corner while coasting and lost wheels in
every collision (engine items 4 and 5). It goes into the high profile once the
stage's corner loads are explained and vehicle joints can be ductile. It was
not tuned to any outcome.

### House authoring: no change

Every value checked has its source: the veneer houses' C24, nails, ties and
mortar joints (EN 338, EN 1995-1-1, EN 1996-1-1, NDS, AS 1684) and the
outdoor props' real capacities (`real-capacities.mjs`). The house mismatches in
this matrix are engine items 1, 2 and 6.

