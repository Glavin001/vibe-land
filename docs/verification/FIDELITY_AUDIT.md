# Fidelity audit: caps, fudges, clamps and heuristics

The audit asks one question of every number in the GPU destruction pipeline
that changes a result: would a correct physical model need it? The pipeline
covers authoring, the bridge, the native stage and the Blast stress solver.

Audited 2026-10-07 at these revisions:
- vibe-land `feat/native-macos-app` d3ad5f77
- PhysX `feat/section-rotational-stiffness` 231644fb4
- impact model E at `feat/impact-capacity` 4d78a2ea6, in `.claude/worktrees/impact-e`

Line numbers are as of those commits. Several of these files are under active
edit, so search for the quoted symbol if a line has moved.

Paths:
- `PhysX/...` is under `/Users/glavin/Development/PhysX`.
- `E/...` is the impact-e worktree.
- Anything else is vibe-land.

## How to read it

**Kind** says what the item is:

| Kind | Meaning |
|---|---|
| **FUDGE** | Changes a physical result away from the model. No physical source justifies it. |
| **MODEL** | A modelling simplification with a physical basis but a known error. |
| **PHYS** | Physical, with a cited source. |
| **NUM** | A numerical guard or tolerance. It is fine if it never binds on valid input, or binds only at rounding. |
| **BUDGET** | A cost/accuracy budget. The 16/64 stress iteration caps, the 1e-3 tolerance and `internalCorrectionLimit` 1 are owner-approved and not up for change here. |
| **GAME** | A gameplay input such as a weapon or a driver assist, not a material or contact model. |

**Rec** is the recommendation:

| Rec | Meaning |
|---|---|
| **DELETE** | Remove outright. |
| **FLAG** | Replace behind a flag in the high-fidelity profile. |
| **KEEP** | Keep, with the justification given. |
| **MODEL** | Needs a model that does not exist yet. |
| **DONE** | Already replaced in the high-fidelity profile, by this audit or by the capability named. |

"Effect" is measured wherever a measurement was cheap. The tests behind the
measurements are `physx-bridge/tests/fidelity_audit.rs`, plus `section_rotation.rs`
and `section_bending.rs` where cited. Pack counts come from
`structures/vibe-town/out/vibe-town-hero.json` (143,541 bonds) and
`vibe-town-real.json` (132,529 bonds).

## Summary

72 rows.

| Kind | Rows | DONE | FLAG | MODEL | DELETE | KEEP |
|---|---:|---:|---:|---:|---:|---:|
| FUDGE | 39 | 12 | 6 | 11 | 6 | 4 |
| MODEL | 10 | 0 | 0 | 9 | 0 | 1 |
| PHYS | 4 | 0 | 0 | 0 | 0 | 4 |
| NUM | 10 | 0 | 0 | 0 | 0 | 10 |
| BUDGET | 5 | 0 | 0 | 0 | 0 | 5 |
| GAME | 4 | 0 | 0 | 1 | 0 | 3 |

Notes on the counts:
- The 4 FUDGE rows marked KEEP are dormant on the production path:
  - A5: Blast path only.
  - D8: default 1.
  - E9: off by default.
  - F8: off by default.
- Of the 12 FUDGE rows marked DONE, these two are this audit's: A1 and F1.
- The NUM rows include one guard to make loud: A7, the GPU-prepare silent fallbacks.

### What this audit removed, in the high-fidelity profile only

The runtime default is unchanged; the runtime arms of the tests prove it.

1. **Bond stiffness floors, area 1e-4 m² and length 0.05 m.**
   - Flag: `VIBE_BOND_TRUE_STIFFNESS=1`. I wrote the flag. The stiffness agent landed it in
     2c9fd106, where `VIBE_SECTION_ROTATION=1` also implies it.
   - Test: `fidelity_audit.rs::bond_stiffness_floors`. Runtime vs true stiffness:
     - **Three parallel bonds of one length (Gere & Goodno 2.4).** Runtime: the 0.4 cm² sliver reads 2.500× its
       neighbours' stress, exactly the floored springs. True stiffness: one stress, W/ΣA, error 0.000%.
     - **A block between anchors 3 and 9 cm away (Hibbeler 4.4).** Runtime: 9/14 of the weight on the near
       bond. True stiffness: 3/4 and 1/4, error 0.000%.
     - **The same bar at 30 / 90 cm.** No floor binds there, and both profiles give bit-identical stresses.
2. **PhysX's default 100 rad/s spin clamp on native clusters, vehicle carriers and rounds.**
   Fragments inherit it.
   - Flag: `VIBE_NATIVE_UNCAPPED_SPIN=1`, committed in d3ad5f77. The call sites came in with 8031fc22.
   - Test: `fidelity_audit.rs::bond_stiffness_floors`, case 4, against Hibbeler 19.2-19.4.
   - **Runtime:** a 1 m rod struck 0.4 m off centre peaks at 73 rad/s, with ω/v at 41% of m d/I. The clamp
     does not only cap the spin; inside the contact solve it moves the impulse into translation.
   - **Uncapped:** 176.5 rad/s, ω/v within 0.66% of m d/I, and constant to 0.000% over the next 30 ticks.
   - I added the flag to `scripts/fidelity/high.env` and `runtime.env`. Those files belong to the
     verification agent and are not committed by me.

## The table

### A. Stress solve: stiffness and where the bond's spring sits

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| A1 | Bond stiffness floors `max(A, 1e-4)`, `max(L, 0.05)`. `physx-bridge/src/native_destruction.cc:460,464`; the same in Blast `PhysX/blast/source/shared/stress_solver/stress.cpp:236-262` (`MIN_AREA`, `MIN_LENGTH`). | f34e71ba, 2026-09-18, the first native stage. No reason recorded; it is a divide-by-zero guard that binds on real bonds. | FUDGE. Stiffness uses the floored area while strength uses the true area, so a sliver draws load it cannot carry (structure_lint `sliver-bonds`, 2026-09-26). | k = E A / L at the true A and L. A bond with A = 0 or L = 0 is an authoring error. | `VIBE_BOND_TRUE_STIFFNESS` (implied by section rotation). | Binds on 111 of 143,541 hero bonds: 4 area, 107 length. See "What this audit removed". | DONE |
| A2 | Contact length `L = max(d, sqrt A)`. `native_destruction.cc:448-452`. On for vehicles; on for everything under section rotation. | 7b8b8aeb, 2026-09-30: a panel on its brace, 2 cm between centres, read as hundreds of times stiffer than its neighbours. | PHYS. A flat elastic contact is E sqrt(A) stiff (rigid flat punch, K. L. Johnson, *Contact Mechanics* 3.8). | As is. | n/a | Load sharing moved 1% median, 4% p90 on two fleet cars (code comment). | KEEP |
| A3 | Uniform rotational stiffness k Ls² about every axis, with Ls the mean bond offset for the whole stage. `PhysX/blast/source/sdk/extensions/stressgpu/detail/StressBondRotation.cuh:5-8`, `NvBlastExtStressGpu.cu:3861-3866`. | Blast import (e0a93ea74, 2026-09-05). One scale keeps the operator conditioned. | FUDGE. A 2 cm pin strip holds a moment like a full joint, so supports clamp (`tests/textbook/build.rs` header). | k I/A per principal axis and k I_p/A in twist, from the bond's own section. | `VIBE_SECTION_ROTATION` (63284285, PhysX 8bbfaac11). | See A4 for the measurement. | DONE |
| A4 | A bond between two dynamic chunks is sprung at the chunks' **midpoint**, not at its face (`centerBonds = true`). `PhysX/.../NvBlastExtStressSolver.cpp:277`, `stress.cpp:143-147`, `NvBlastExtStressGpu.cu:3838-3845`. | Blast import. | FUDGE. A force on an off-axis chain gains a lever arm that is not there, which the bond moments must then balance. | Spring at the bond centroid. | `VIBE_SECTION_ROTATION` moves it there (`NvBlastExtStressGpu.cu:2151-2160`). | Measured (my first hanger variant): a block on three equal-length hangers, a 0.4 cm² sliver between two 2 cm² hangers, true stiffness, uniform rotation. The sliver reads **1.80×** its neighbours' stress, where the textbook says 1.00. Under section rotation the springs sit at the faces; that arm needs an SDK with rotation, and garage-roof lacks it. | DONE |
| A5 | Equal-mass weighting: every node's inverse mass and inertia set to 1. `stress.cpp:214-225`, `NvBlastExtStressSolver.cpp:278`, `NvBlastExtStressGpu.cu:3761-3763`. | Blast import, for conditioning. | FUDGE on the Blast path. The native resident path uses real M^-1/2 (`NvBlastExtStressGpu.cu:3868-3885`). | Real masses. | Native stage (production). | None on native /city. Only the Blast core path is affected. | KEEP (Blast path only) |
| A6 | Stiffness exponent `VIBE_*BOND_STIFFNESS_EXPONENT` (default 1) and `VIBE_BOND_STIFFNESS_CLAMP` (default off). `native_destruction.cc:466-505`. | 7b8b8aeb, A/B to improve conditioning. | FUDGE when ≠ 1 or when set. Exponent 0.5 moves load sharing 23-30% median. | Exponent 1, no clamp. | n/a; default already physical. | None at default. | DELETE (keep only as diagnostics in tests) |
| A7 | GPU-prepare silent fallbacks: area ≤ 0 → 1 m², colScale ≤ 0 → 1, node distance < 1e-6 → 1 m, zero normal → displacement or (1,0,0). `NvBlastExtStressGpu.cu:3795-3817`; `NvBlastExtStressSolver.cpp:341`. | Blast import. | NUM, but it hides bad data: a 0-area bond silently becomes a 1 m² bond. | Refuse invalid input. The native runtime already does (`PxgDestructionRuntime.cu:1406`); the bridge refuses 0 area under true stiffness. | n/a | None on valid packs. | KEEP; make loud (assert in the native path) |

### B. Bending, torsion and grading

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| B1 | Bending gain `6/sqrt(A)` capped at `bendGainMax` 3. `PhysX/blast/include/extensions/stress/NvBlastExtStressFormula.h:223-224`. Set at `destruction/src/native_runtime.rs:589` and `PhysX/physx/include/PxDestructionScene.h:144`. | Blast import. The comment at `NvBlastExtStressSolver.cpp:122-157` reports a 47,631-chunk masonry ring broke 2,423 bonds at gain 10 and 0 at gain 3. The cap hid A3/A4: a wrong single rotational length scale amplified "the discretisation's own moments". | FUDGE. Below 4 m² every bond reads as a 2 m deep section; a 45×90 stud's bending is understated about 20× (diagnose-structure-failure skill). | σ = M/W with the bond's own section modulus. | `VIBE_SECTION_BENDING` / `VIBE_SECTION_ROTATION` (06d6534cf). Test `section_rotation.rs::bend_gain_cap_unused_with_sections`: bend_gain_max 0.01, 3 and 1e6 give bit-identical stresses. | Runtime unchanged. | DONE |
| B2 | Torsion gain `4.81/sqrt(A)` capped by the same `bendGainMax`. `NvBlastExtStressFormula.h:182-189`. | Blast import. | FUDGE. 4.81 is Saint-Venant's square-bar constant (1/0.208), but the cap is the bending cap. | τ = T / Z_t from the section. | Section bending (`extStressCalcBondStressSection`). | n/a | DONE |
| B3 | Section path's fallback when no section is found: a square patch, 6M/a³ and twist 4.2426/a³ (`NvBlastExtStressFormula.h:292-295`). The bridge drops the measured section when the authored area exceeds the faces' overlap (`physx-bridge/include/bond_section.h:184`). | 06d6534cf, d7a7afde. | MODEL. A square patch is the only shape the area alone defines. The torsion constant differs from B2's 4.81 (an inconsistency). | The real section. Authoring must make the authored area match the overlap. | n/a | n/a | MODEL (fix the authoring cases that fall back, and use one torsion constant) |
| B4 | Section moduli shrink linearly with remaining area: `live = health/originalArea`. `NvBlastExtStressFormula.h:279-290`. | 06d6534cf. | MODEL. Assumes the section loses width at full depth. | Track the damaged section, or treat damage as a crack depth. | n/a | n/a | MODEL |
| B5 | The old path never moves the solver's midpoint moment to the bond centroid. `PhysX/physx/source/gpudestruction/src/PxgDestructionMaterial.cuh:49-52`. | Blast import. | FUDGE (the counterpart of A4). | M_c = M_P + (c − P) × F (`PxgDestructionMaterial.cuh:37-43`). | Section bending. | n/a | DONE |
| B6 | Legacy fold when `bendGainMax ≤ 0`: bending as `2/nodeDist` added to the axial stress with its sign. `NvBlastExtStressFormula.h:190-201`. | Blast legacy. | FUDGE. Unused by vibe-land, which passes 3. | n/a | n/a | n/a | DELETE (dead path) |
| B7 | Fibre stresses: σ_t = N/A + M/W and σ_c = M/W − N/A. `PhysX/blast/include/extensions/stress/NvBlastExtStressMaterialFormula.h:9-17`. | Blast. | PHYS (engineering beam theory). | As is. | n/a | n/a | KEEP |
| B8 | Shear graded as the average V/A, plus twist. | Blast. | MODEL. The peak shear of a rectangle is 1.5 V/A (Gere & Goodno 5.8). | Shear coefficient from the section (1.5 for a rectangle, 2 for a thin tube). | n/a | Shear utilisation understated by up to 1/3 on solid sections. | MODEL |

### C. Damage and failure law

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| C1 | **Damage-arrest ceiling**: sub-fatal damage stops at `residualAreaFraction × A0` (`NvBlastExtStressMaterialFormula.h:51-56`). Values are authored in `PhysX/blast/blast-stress-solver/structures/lib/materials.mjs:224-266` (RC 0.10, prestressed 0.16, slab 0.09, steel 0.6, wood-frame 0.08), inherited by the town kit through `structuredClone` (`structures/town-kit/src/materials.mjs:6`). | Blast import. A parking deck at 1.1× its cracking stress lost its seams "whatever the fatal limit said" (`NvBlastExtStressSolver.h:191-209`). | FUDGE. The residual area carries stress at the **concrete's** limits, not the steel's. Stress is capped at about 1/residual × the pre-crack load, so wherever 1/residual < fatal/elastic a loaded joint pins just under fatal and never resolves (skill note: petronas pinned at 2.95 against 3.00). | A cracked reinforced section is a different material: the steel carries tension at f_y over its own area (EN 1992-1-1 9.2.1.1 ρ ≈ 1%), with the concrete in compression. Timber has no meaningful residual. | Partly real capacities. **But** `real-capacities.mjs` keeps the clone's residual: the `-real` props (mailbox 1,470 bonds, bus shelter, street sign, bike rack, billboard) have steel residual 0.6, so a ceiling of 1.67 against a fatal/elastic of 1.69-2.03. **They pin below fatal.** | 68,439 of 143,541 hero bonds (48%) carry residual > 0. 2,039 hero bonds use steel materials whose ceiling (1.67) is under their band (12). | MODEL (stiffness agent: residual 0 for every real-capacity material; a two-material cracked section for RC) |
| C2 | Sub-fatal damage rate: `health × min(m · dt · damageRate, 1)`, with damageRate 2/s. `NvBlastExtStressMaterialFormula.h:47-49`; `native_runtime.rs:588`; `PxDestructionScene.h:144`. | Blast import, tuned on the cantilever ladder (`NvBlastExtStressSolver.cpp:5492-5528`, `BLAST_DAMAGE_RATE`). | FUDGE. No material loses section at 2/s between its long-term and short-term strength. Timber between k_mod 0.6 and 1.0 fails over hours to months (duration-of-load, the Madison curve; EN 1995-1-1 2.3.2.1). | Brittle materials (glass, masonry, plain concrete): elastic = fatal, no rate. Ductile joints: plastic slip to an ultimate slip, which E already does (`ductileSlip`). Timber: a duration-of-load (k_mod) law. | E's ductile joints; town-kit's `LONG_TERM` 0.6 is the k_mod line. | Not measured. In most material tables it decides when a joint between elastic and fatal goes. | MODEL |
| C3 | Linear interaction: utilisation = max(axial excess) + shear excess. `NvBlastExtStressMaterialFormula.h:27-40`. | Blast. | MODEL. Real criteria are quadratic: von Mises σ² + 3τ² ≤ f² for steel; EN 1995-1-1 6.2.4 for timber. | Per-material interaction. | n/a | Conservative by up to 2× at equal σ, τ excesses. | MODEL |
| C4 | Crushed chunk's mass vanishes (`DestroyChunk`). `debrisMassFraction` and `debrisFragmentCount` are validated but unused. `PxgDestructionRuntime.cu:397`, `PxgDestructionTransaction.cuh:41`. | Crush, 5b157e4a. | FUDGE. Mass is not conserved. | Comminuted mass becomes debris (fragments, or particles that carry momentum), per the authored fraction. | n/a | n/a | MODEL |
| C5 | Crush strain-rate length `cbrt(volume)` (`PxgDestructionRuntime.cu:237-240`); rate strengthening floored at 1 (`NvBlastExtStressMaterialFormula.h:91`). | Crush. | MODEL / FUDGE. The floor keeps quasi-static strength at slow rates. | The DIF law of CEB-FIP MC90 (already cited for the parameters) is ≥ 1 by construction, so the floor is harmless. The length should be the loaded dimension. | n/a | n/a | KEEP floor; MODEL length |
| C6 | Crush parameters silently default to 1.0 when ≤ 0: crushEnergy, crushViscosity, referenceStrainRate. `native_destruction.cc:338` and following; `NvBlastExtStressMaterialFormula.h:97-98`. | Crush. | FUDGE (silent default). | Refuse a crushable material without them. | n/a | None on authored packs. | DELETE (refuse) |
| C7 | Crush and ductile tables skipped for binary scene payloads (VLSP/VLSW). `server/src/city.rs:1398-1406`. | Crush/E plumbing. | FUDGE by omission. A binary pack loses its crush and ductility. | Carry them in the binary format. | n/a | n/a | MODEL (pack format) |
| C8 | `fatal = elastic × band` with bands of 2.5-12 in the legacy material table (`PhysX/.../structures/lib/materials.mjs` SPEC). | Blast authoring: "Band 3, not 10. ... 10 makes concrete behave like rubber". | FUDGE. Tuned on what an 18 m drop should break. | Characteristic strengths from standards (the town-kit convention, `materials.mjs:76-93`: fatal = f_k, elastic = k_mod f_k). | `VIBE_REAL_CAPACITIES` for props and trees. Not yet for buildings. | n/a | MODEL (stiffness agent: real limits for the building materials) |

### D. Authored material limits

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| D1 | Legacy base table: masonry and timber elastic limits "roughly doubled" because of B1's gain; prestressed tension 0.28 "where the garage stops shedding bonds". `PhysX/.../structures/lib/materials.mjs:70-132`. | Blast authoring. | FUDGE. Double-counts with the gain cap: when section bending removes the cap, the doubled limits remain. | EN 338 / EN 1996 / EN 1992 characteristic values. | Section bending plus real limits. | n/a | FLAG (stiffness agent: un-double the limits when `VIBE_SECTION_BENDING` is on) |
| D2 | `vibe-town/strengthen.mjs`: trees ×100, bus shelter ×30, market stall ×30 on tension and shear. `build-town.mjs:63-67,206-210`. | c3cb9eb4, 2026-10-06. "The smallest factor that stands", because the kit's tuned limits (D3-D5) fell apart at rest. | FUDGE (a cap on a cap). | Real capacities. | `VIBE_REAL_CAPACITIES` (factors drop to 1). | n/a | DONE (for the props it covers) |
| D3 | Outdoor props `fractureSeamScale` (road-barrier footing 3e-5 … glass 1), plus connector tension and shear ×0.1. `structures/town-kit/src/outdoor-props.mjs:11-24,120-148`. | 352f9221, 2026-09-26. Tuned to the playground's 500 kg cannonball at 25 m/s. | FUDGE. | Real capacities. | `VIBE_REAL_CAPACITIES`, but only for bike-rack, street-sign, billboard, bus-shelter, market-stall, mailbox and hydrant. **Streetlight, bollard, bench, planter and low-wall keep the cuts in REAL mode.** | n/a | FLAG (stiffness agent: cover the remaining props) |
| D4 | Living-tree wood: tension fatal 8e4 Pa, branch fibre 8e3, root 6e6. `structures/town-kit/src/tree.mjs:48-51`. Labelled "Effective gameplay fracture thresholds" (:119). | 352f9221. | FUDGE. About 700× under green oak's modulus of rupture of 57 MPa (Wood Handbook), and about 7000× for branches. | Green-wood capacities. | `VIBE_REAL_CAPACITIES` (`real-capacities.mjs:243-251`). The metadata label stays. | n/a | DONE (fix the label) |
| D5 | Chair mortise ×0.5 on all six limits (`props.mjs:7-12`); café-table seams ×0.02 (`town-dressing-visuals.mjs:6-14`). | Kit authoring: "releases before the whole table skates away". | FUDGE (area expressed as strength). | Joint capacity from the joint. | Not covered by real capacities. | n/a | FLAG (stiffness agent) |
| D6 | Round-number joints with fatal = 2 × elastic and no source: glazing-joint, plastered-timber-wall, timber-joint, furniture-joinery, cladding-fastener, insulated-appliance-panel. `materials.mjs:22-27`. | Kit authoring. | FUDGE. | Fastener and connection capacities. The veneer houses' EN 1995 joints show how. | Partly (veneer houses). | n/a | MODEL |
| D7 | Fallback concrete when a pack has no materials: 12/30, 1.2/3, 1.6/4 MPa. `destruction/src/city_config.rs:96-105`, `scene_pack.rs:313-322`. | 6567941e. | FUDGE (a placeholder). | Refuse a pack without materials. | n/a | None on current packs. | DELETE |
| D8 | `VIBE_CITY_STRESS_LIMIT_SCALE`, a uniform limit multiplier (default 1). `scripts/record-baseline-set.sh:11` runs at 0.45. | 6567941e: a sensitivity dial. | FUDGE when ≠ 1. | 1. | n/a | None at default; baselines recorded at 0.45 are not physical. | KEEP at 1 (mark baselines) |
| D9 | Real capacities, the uncited or approximated parts: shelter screw shear 8 kN; roof-screw pull-through "10 MPa"; plywood f_u 23 MPa; hydrant elastic ratios 0.9 / 0.6; sheet strength ∝ t/T (bending goes as (t/T)²); compression set to the bending-equivalent stress. `real-capacities.mjs:70-201`. | d22bbcb1 (WIP). | MODEL. Mostly derived and cited. | Cite or derive each. | n/a | n/a | MODEL (stiffness agent) |
| D10 | Vehicle joint profile: steel weld/bolt 120/300 MPa, alloy, rubber, glazing 3/12 MPa ("tuning inputs, NOT a vehicle qualification result"). `client/src/vehicles/strength-profile.mjs:9-41`. Glazing's 12 MPa fatal is under its own reference range of 20-120 (`reality.mjs:47`). | 8dbb935b and later. | FUDGE / MODEL. The lug stud is ISO 898-1 (PHYS). | Joint capacities per fastener or weld (as the stud already is). | n/a | n/a | MODEL |
| D11 | Wall-tie and other joints authored at exactly the stiffness floor (area 1e-4), with modulus back-solved from fastener slip. `materials.mjs:265-277`, `veneer-houses.mjs:78-104`. | 863ec644. The solver gives a bond one stiffness for every direction. | MODEL (a justified workaround). | Anisotropic joint stiffness (axial ≠ shear). | E's `impact_modulus` (8031fc22) for impacts. | Under A1's removal these keep their authored area, so they are unaffected. | KEEP; MODEL for anisotropy |

### E. Impact and projectiles

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| E1 | Infinite-mass impact contact: the elastic solve takes a contact impulse with the struck structure's joints as rigid to the anchors, so load reaches anchors that a real impact never loads within the tick. | Native stage design. | FUDGE. | Impact capacity E: what the joints cannot carry accelerates the chunks (d'Alembert). | `VIBE_IMPACT_CAPACITY` (bcafd760). | See the E agent. | DONE (E agent) |
| E2 | E's joint stiffness scale `stiffnessScale` (10, now 1 in the working tree). `E/physx/source/gpudestruction/src/PxgDestructionImpact.cuh:68-78`. | E design: the gravity-sharing weights are too soft for a hit (a wall tie). | FUDGE at 10. At 1 with per-material `impact_modulus` (8031fc22) it is physical. | k = E A / L with the impact modulus. | 8031fc22. | n/a | DONE when 1 lands (E agent) |
| E3 | E's capacity cones use `6/sqrt(A)` and `4.81/sqrt(A)` capped at `bendGainMax` (`PxgDestructionImpact.cuh:335`), and `impactCapacity` **requires `!sectionBending`** (E runtime, about :1440). | E reuses today's grading. | FUDGE: B1 and B2 again. The high-fidelity profile cannot have both capabilities. | Cones from the section moduli (S0, S1, Z_t), rotational stiffness k I/A. | n/a | n/a | FLAG (E agent: section moduli in E) |
| E4 | E's ramp levels 32, factor 2, 4096 iterations, tolerance 1e-5, capacity band 2e-3, 256 rounds. `PxgDestructionImpact.cuh:79-95`. | E design. | NUM. A capped island is reported (`capped`). | n/a | n/a | n/a | KEEP; report capped islands as failures in the textbook suite |
| E5 | Native round: momentum 3e5 N·s at 20 m/s and 0.4 m radius, so 15 t at about 56,000 kg/m³ (7× steel), spawned at the hitscan point. `server/src/city.rs:106-112`, `destruction/src/native_runtime.rs:150-171`, `native_destruction.cc:1500-1545`. | 5be2c510, 2026-08-24: parity on bond breakage. | GAME / FUDGE. | A real projectile with real density (the cannonball, E7), or a weapon whose momentum is a real round's (5.56 mm: ~1.8 N·s). | n/a | n/a | MODEL (game design) |
| E6 | Blast-path shot profile: stress impulse 1.2e7 N·s, push 12 m/s Δv regardless of mass, radius 2.5 m. `city_config.rs:267-312`. | Content tuning. | GAME / FUDGE. Not used by the native stage. | n/a | Native rounds. | n/a | KEEP (Blast path only) |
| E7 | Cannonball 10,650 kg, steel density 7850 kg/m³, 60 m/s; impedance sqrt(ρE). `city.rs:168-194`, `physx_runtime.rs:217-218`. | | PHYS. | As is. | n/a | n/a | KEEP |
| E8 | Vehicle front impedance `sqrt(300e3 m)/A`. `native_destruction.cc` (vehicle impact capacity). | E. | PHYS (EN 1991-1-7 Annex C, k = 300 kN/m). | As is; the frontal area comes from the bounding box (a MODEL). | n/a | n/a | KEEP |
| E9 | Excess forces at split (Blast path), unbounded impulses: off by default (`VIBE_CITY_EXCESS_FORCES`), with scale 0.012 (`lib.rs:641`). | Measured 946 m/s ejections. | FUDGE, already off. | Fracture releases stored elastic energy; E models that. | E. | n/a | KEEP off |

### F. Rigid-body dynamics, rest and hibernation

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| F1 | PhysX's default `maxAngularVelocity` 100 rad/s on native clusters, vehicle carriers and rounds, inherited by every fragment. Implicit: nothing sets it. `add_dynamic` already lifts it (`physx_bridge.cc:4062`). | Never chosen. | FUDGE. PhysX: enforcing it introduces momentum error. | No clamp. | `VIBE_NATIVE_UNCAPPED_SPIN` (this audit). | Struck rod: runtime 73 rad/s and ω/v 41% of textbook; uncapped 176.5 rad/s, 0.66%. | DONE |
| F2 | Scene stabilization `eENABLE_STABILIZATION`, on by default. `physx_bridge.cc:3849-3855`. | 6dcd4755, 2026-09-24. PhysX's default "make piles rest". | FUDGE (PhysX damps and scales gravity on slow bodies in contact). | Off. | `VIBE_PHYSX_STABILIZATION=0` exists. | **Measured: no effect** on a block sliding from rest down a 30° incline. Both give 0.3350 m in 1 s against Hibbeler 13.4's 0.3286 m (+2.0%, PhysX patch friction). The documented effect is rocking rubble (`native_observation.cc:366-372`). | MODEL (measure on a resting pile before flagging) |
| F3 | Fragment depenetration forced to 2.0 m/s whenever vehicles are registered (`native_destruction.cc:1238`). Vehicle carrier cap 0.5 m/s (`:162`, `VIBE_VEHICLE_MAX_DEPENETRATION_VELOCITY`), inherited by car fragments. | 0aafdc7b (2026-09-27); d69b5bed (2026-09-30, "wedged wreck pieces no longer rock"). | FUDGE. It hides overlapping authoring and wedged pieces. | Fix the overlap (authoring), or use a contact model that does not inject energy (TGS with a position bias). | n/a | Not measured. | MODEL |
| F4 | Loose vehicle-piece contact offset: 0.02 m, raised to `reach × 1.25/60` up to 0.5 m, ±25% hysteresis, downward speed only. The 1/60 is hard-coded instead of dt. `native_destruction.cc:982-1018`. | c7787e24, 2026-09-27: anti-tunnelling. | FUDGE. | Speculative CCD. The native stage forbids scene CCD (`native_destruction.cc:201`), which is the real gap. | n/a | n/a | MODEL (CCD in the stage) |
| F5 | `DestructibleSettings::default` damping, linear 0.25 and angular 0.35 (`physx-bridge/src/lib.rs:642-643`). The city overrides it to 0 (`city_config.rs:49-61`); garage cars take the default through `..Default::default()` (`server/src/garage_destruction.rs:67`). | Blast defaults. | FUDGE (latent). | 0, with energy lost in contacts. | n/a | None in the city. | DELETE (default to 0) |
| F6 | Dynamic props: sphere damping 0.3 / 0.5, box angular 0.5 ("Rapier parity", `physx_bridge.cc:4064-4068`). Chassis angular damping 0.5 (`server/src/physx_runtime.rs:237`), inherited by car fragments. | 9d91e579 and earlier. | FUDGE. | 0 (air drag is negligible at these sizes). | n/a | n/a | FLAG (the profile should zero fragment damping at least) |
| F7 | One contact material for everything: friction 0.5, restitution 0.1 (`lib.rs:134-136`). | | MODEL. Concrete on concrete is about 0.6-0.7; timber on steel differs. | Per-material friction and restitution. | n/a | The incline test: +2% slide at μ 0.5. | MODEL |
| F8 | Rest heuristics, all off by default: forced settle (`VIBE_CITY_NATIVE_SETTLE_TICKS`), settle-freeze, rest-sleep windows (120 ticks, 3 mm / 0.3°), debris floor. `native_observation.cc:275-688`. Blast path: `settle.rs` force-sleeps 5 s after promotion. | 6dcd4755 and others. | FUDGE (pose-based, off). | Hibernation, as its own state: pose-based freeze and force-based thaw (the hibernation worktree). | Hibernation (`feature/debris-hibernation`). | None at default. | KEEP off; DONE by hibernation |
| F9 | World bound 1000 m and retire floor 5 m below ground: streaming only, the bodies keep simulating. `native_runtime.rs:222-228,943-965`, `ground_watch.rs`. | 0a7d6ae5. | NUM (detector / stream). | n/a | n/a | No physics effect. | KEEP |
| F10 | Rigid solver iterations 4 position / 1 velocity (`physx-bridge/include/solver_iterations.h:21-26`). | | BUDGET (PGS convergence). | n/a | n/a | n/a | KEEP; justify with a stack test |
| F11 | Angular-acceleration term (α × r) left out of the chunks' inertial loads; only g − ω × (ω × r) is used. `PxgDestructionRuntime.cu:149-154`. | Native stage. | MODEL. | Include α × r from the body's integrated angular acceleration. | n/a | Matters for a body spun up by a hit within the tick. | MODEL |
| F12 | Fragment gravity bookkeeping: Vehicle2 carriers weightless, fragments weightless on their split tick when they get a command share (`PxgDestructionCorrection.cuh:264-266`). | 32e162a3f / 1ae478f29. | NUM (bookkeeping against double-counting). | n/a | n/a | n/a | KEEP |

### G. Gravity

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| G1 | Stale 20.0 resting-load gravity on the Blast path. | Two copies of `VIBE_WORLD_GRAVITY` defaulting to 20 after the world moved to 9.81. | FUDGE (a bug). | Scene gravity. | f3744df8 (2026-09-24); test `gravity_single_source.rs`. | Resting loads were 2× too large on that path. | DONE |
| G2 | `VIBE_WORLD_GRAVITY` moves the PhysX scene but not `MoveConfig` gravity (`netcode/src/movement.rs:33,87`), nor the hard-coded 9.81s at `server/src/city.rs:1431` (warm-start compatibility), `physx_runtime.rs:147` (rolling resistance), `:527` (suspension rest load) and `:1264` (lateral limiter). A stale comment at `destruction/src/city_config.rs:216-219` still says the world "had been raised to -20". | Copies. | FUDGE (a split world when the variable is set). | One source: everything reads the scene's gravity. | n/a | None at the default 9.81. | DELETE the copies and the stale comment (extend `gravity_single_source.rs`) |

### H. Vehicles (structure and driving)

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| H1 | Vehicle sliver filter: bonds under 1e-4 m² dropped; a part's only link is kept with its area **raised** to 1e-4 (`client/src/vehicles/prepare-asset.mjs:56-70`). Lint blocker `structure_lint.rs:189-194`. | 8dbb935b / eb6a706d, 2026-09-26: 7-8% of vehicle bonds were slivers. Removing them "let trophy and monster drive with zero breaks". | FUDGE. It exists only because of A1. | Keep the measured area. A true-stiffness sliver carries only its share. | A1 (`VIBE_BOND_TRUE_STIFFNESS`). | With A1 removed, re-admitting the slivers is correct in the solve (fidelity_audit case 1). The minimum-mount inflation is a strength fudge either way. | FLAG (vehicle lab: re-admit slivers, no area raise, under the profile) |
| H2 | Mass-budget bond-area inflation `bond.area *= massScale` (×1.41-1.99) (`client/src/vehicles/prepare-asset.mjs:82-85`, `mass-budget.mjs`). | 908def37, 2026-10-06: real weights (a 5000 kg monster truck). | FUDGE ("NEVER FAKE STRENGTH WITH BOND AREA", the base table's own rule). | Real weight with real joint capacity; area stays geometric. | n/a | n/a | MODEL |
| H3 | `MIN_CHUNK_KG` 1.0: lighter parts merge into a neighbour (`client/src/vehicles/chunk-merge.mjs:20`). | a49d35ed: solver conditioning. | NUM / MODEL. Changes what can break off. | A solver that conditions mass ratios (preconditioning), not merges. | n/a | n/a | KEEP (conditioning); revisit after the solver work |
| H4 | Wheel mass 0.02 m; sprung mass 0.25 m per corner regardless of the COM (`physx_bridge.cc:2542-2545`). Bump stop 10× spring at 1× critical (`physx_runtime.rs:227-233`). | Driving. | MODEL / FUDGE. | Per-corner sprung mass from the COM (statics); wheels from the asset. | n/a | n/a | MODEL |
| H5 | Driver assists: steering slew, speed-scaled lock, a lateral-accel limiter `min(0.65 μ g, 7.5)`, top speed caps, coast resistance (Crr 0.015, Cd 0.45 applied as brake torque). `physx_runtime.rs:202-298,1264`. | 9d91e579 and later. | GAME. | n/a | n/a | n/a | KEEP (input shaping, not physics). Coast resistance should be a force, not a brake torque (MODEL) |
| H6 | Player-vehicle impact: 80 kg player, lethal at 25 m/s × 80 (`physx_runtime.rs:1466-1507`, `shared/src/movement.rs:49,53`); player push constants (`physx_bridge.cc:118-123`). | Gameplay. | GAME. | n/a | n/a | n/a | KEEP |

### I. Solve budgets and numerical tolerances

| # | What (file:line) | Why it was added | Kind (source) | Correct model | Replaced by | Effect if removed | Rec |
|---|---|---|---|---|---|---|---|
| I1 | Stress iteration caps: 16 (city), 64 (fleet) (`native_runtime.rs:84-92`); garage 64. | Owner-approved (2026-10-01). | BUDGET. | n/a | n/a | n/a | KEEP (do not change) |
| I2 | Relative residual tolerance 1e-3 (`native_runtime.rs:103-108`). | Owner-accepted 2026-09-21: 1e-5 never converged inside the cap. | BUDGET / NUM. **Finding:** it bounds the global weighted residual, so a member carrying ~0.2% of the load (a sliver beside 100 cm² bars) can read 80% off even when the solve is "converged". Seen in an early variant of fidelity_audit case 1. | Per-bond force accuracy (the opt-in `forceTolerance`, 1e-3, 881 car solves at ≤ 0.4% force error). | `VIBE_NATIVE_STRESS_FORCE_TOLERANCE` (opt-in). | n/a | KEEP; recommend force tolerance in the high-fidelity profile |
| I3 | `internalCorrectionLimit` 1 (`native_destruction.cc:31-50`). | Owner rule. | BUDGET. | n/a | n/a | n/a | KEEP (stays 1) |
| I4 | `PX_DESTRUCTION_ALLOW_UNCONVERGED=1`: unconverged solves continue next tick. | Owner rule with the 64 cap. | BUDGET. | n/a | n/a | n/a | KEEP |
| I5 | Stagnation stop: no 1% residual improvement in 512 iterations → stop, reported unconverged (`StressComponentIteration.cuh:28,288-290`). | Stalled solves. | NUM. | n/a | n/a | n/a | KEEP |
| I6 | Settled-skip steadiness 1e-3 relative over 4 frames; idle gate (bit-identical inputs only). `NvBlastExtStressSolver.cpp:812-828`, `PxgDestructionRuntime.cu:319-355`. | Performance. | NUM (the idle gate is bit-exact). | n/a | n/a | n/a | KEEP |
| I7 | Float guards: area floor 1e-6 inside the gain formula, normalisation 1e-20, pivot 1e-12, FTZ, `64·FLT_EPSILON` cycle closure, unit-quaternion 1e-5, command audit `1e-4(1+|b|)`. | Rounding. | NUM. They bind only at rounding on valid input. | n/a | n/a | n/a | KEEP |
| I8 | Bond-section coplanarity tolerance 1e-4 m and authoring overlap tolerances (1e-5 m, 1e-7 m² in `geometry.mjs`; 3e-6 in `bond-surfaces.mjs`). | Authoring rounding. | NUM. | n/a | n/a | n/a | KEEP |
| I9 | `kUnbreakableLimit = 0.5·FLT_MAX` sentinel. | Blast. | NUM (sentinel). | n/a | n/a | n/a | KEEP |

## Recommendations left for the other agents

These are not changed here; the agents named own the files.

**E agent** (PxgDestructionImpact.cuh, the E worktree, the bridge's impact code):
1. **E3:** E's capacity cones use the capped area gains, and impact capacity
   refuses `sectionBending`. The high-fidelity profile turns on both
   `VIBE_SECTION_ROTATION` and `VIBE_IMPACT_CAPACITY`, so today it cannot run
   as specified. Build the cones from the bond sections (S0, S1, Z_t, as
   `extStressCalcBondStressSection` does), and use rotational stiffness k I/A
   (the section rotation rows) in place of k Ls².
2. **E2:** keep `stiffnessScale` at 1 once the per-material impact modulus has
   landed (8031fc22); 10 was a fudge.
3. **E4:** report a capped island as a failure in the verification suite, not
   as a held joint.

**Stiffness agent** (the PhysX main-checkout stress solver files; town-kit
materials.mjs, real-capacities.mjs, outdoor-props.mjs, tree.mjs):
1. **C1, which needs fixing:** `real-capacities.mjs` spreads the base material
   with `{...table[bond.m]}`, so it keeps the cloned `residualAreaFraction`.
   Steel's 0.6 caps a real-capacity member's stress at 1/0.6 = 1.67× the
   pre-crack load, which is below its own fatal/elastic ratio (1.69-2.03).
   Mailboxes, the bus-shelter roof, street signs, bike racks and billboards
   therefore pin just under fatal: the damage-arrest ceiling again. Set
   residual 0 for every real-capacity material. Trees keep wood-frame's 0.08
   under `greenWood`; timber has no reinforcement either.
2. **D3, D5:** `VIBE_REAL_CAPACITIES` does not cover streetlight, bollard,
   bench, planter or low-wall (outdoor-props cuts ×0.1 and `fractureSeamScale`
   stay), nor the chair ×0.5 and café table ×0.02.
3. **D1:** the legacy table's "doubled" timber and masonry elastic limits
   compensate for the bending-gain cap (B1). Under section bending they
   double-count. Use characteristic values when the profile has section
   bending (the town-kit convention: fatal = f_k, elastic = k_mod f_k).
4. **D4:** `tree.mjs:119` still labels REAL mode "Effective gameplay fracture
   thresholds".
5. **B3:** use one torsion constant for the square-patch fallback (4.81, the
   B2 constant, against the fallback's 4.24). Report how many bonds fall back.

**Vehicle lab:**
1. **H1:** under `VIBE_BOND_TRUE_STIFFNESS`, re-admit sub-1e-4 m² bonds at
   their measured area and stop raising sole links to 1e-4. Test with the lab's
   rough-course run.
2. **H2:** carry real weight without inflating bond area.

**Verification suite** (`docs/verification/`, `physx-bridge/tests/textbook/`):
1. `scripts/fidelity/high.env` now exports `VIBE_NATIVE_UNCAPPED_SPIN=1`, and
   `runtime.env` unsets it. I made those edits in your uncommitted files;
   please keep them.
2. Consider `VIBE_NATIVE_STRESS_FORCE_TOLERANCE=1e-3` in the high-fidelity
   profile (I2). Without it, a lightly loaded member's stress is not resolved
   by a "converged" solve.
3. `tests/fidelity_audit.rs` is a separate test target that reuses nothing
   from `textbook/`. Fold its cases into `cases.rs` if you prefer; its
   high-fidelity arm needs an SDK with section rotation to cover A4.

## Running the tests

```
VIBE_GPU_SHARED=1 PHYSX_ROOT=/Users/glavin/Development/PhysX/out/install/garage-roof \
CARGO_TARGET_DIR=<yours> cargo test -p vibe-land-physx-bridge --features native-destruction \
  --test fidelity_audit -- --ignored --test-threads=1 --nocapture
```

`bond_stiffness_floors` re-executes itself, once per profile, because the
bridge reads its flags once per process. `stabilization_on_an_incline` builds
one scene per setting.
