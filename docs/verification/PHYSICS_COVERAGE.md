# Physics coverage: every law, a precise scenario, a known answer

This is the catalogue of the physics the destruction stage must uphold. Each
law has a scenario with a closed-form answer, code that computes the exact
answer, and a check that measures the stage against it. The aim is to know
the answer exactly, then say how far the real-time stage is from it and
whether a player would see the difference.

Updated 2026-10-09 (garage-clean, CuMetal 8943f10). Status words:

- **covered**: a check runs in the suite (case id given);
- **partial**: some of the law is checked, or only in one profile;
- **missing**: no check yet (in the build plan at the end);
- **out of scope**: deliberately not modelled; the consequence is stated.

## Scope: the destruction stress solver

The subject is the PhysX fork's GPU destruction stage: Blast's stress solve
(`blast/source/sdk/extensions/stressgpu`) and the native stage around it
(`physx/source/gpudestruction`). Loads go in (gravity, the contact impulses
PhysX reports, the bodies' states); bond stresses, verdicts and the new
chunk-to-body hierarchy come out (AGENTS.md, "GPU destruction"). vibe-land
uses it and trusts it, so this is where exhaustive, exact coverage matters.

Rigid-body dynamics belong to PhysX. Open-source PhysX (this fork is based
on Release 104) ships 80 snippets and a PVD test, but no rigid-body test
suite; NVIDIA's own tests are not public. On Metal, the dynamics are checked
by:
- CuMetal's PhysX conformance tests: `conformance_physx_grb`, `_box`,
  `_friction`, `_multibody`, `_stacked`, `_trimesh` and `_pbd_recreations`,
  which compare GPU runs on Metal with references; all pass since the
  2026-10-09 merge;
- this suite's dynamics cases (G, H), which exercise PhysX on Metal
  incidentally.

Section G keeps only what the destruction stage itself does to bodies:
- building a compound body out of chunks (its mass, centre of mass and
  inertia);
- splitting one at a fracture (momentum carried over);
- the load inputs it reads from PhysX (section I).

## How a check is read: three numbers and a class

Every check prints three numbers:

- **textbook**: the closed form;
- **model**: the exact answer of the stage's own discrete model, in f64 on
  the CPU (`physx-bridge/tests/textbook/model.rs`);
- **stage**: what the GPU produced in FP32 at the shipping settings.

The gaps between them separate two kinds of error:

- **textbook to model** is a modelling error: chunking, the grading formula,
  rigid chunks;
- **model to stage** is a solver error: convergence, FP32.

### Deviation classes

These say how different the stage's result is, and whether a human would
notice.

| Class | Size | Meaning | Visible? |
|---|---|---|---|
| E0 exact | ≤ 1e-3 (the solve tolerance) | rounding | no |
| E1 numerical | ≤ 1% (the suite's tolerance) | the same answer for every purpose | no |
| E2 quantitative | > 1%, same verdict | the same bonds break, the same things hold or fall, the same mechanism; only the load or time at which it happens shifts | rarely: things break somewhat early or late |
| E3 behavioural | a different verdict | holds instead of collapsing, a different bond breaks first, a different mechanism (tips instead of slides), or something that never happens (a slender column that never buckles) | yes |

**Verdict-flip band.** A stress error turns into behaviour through
utilisation, u = stress / capacity. Suppose the stage reads a stress
(1 + ε) times the true one. Then every member with true utilisation u in
[1/(1+ε), 1) breaks in the stage but not in reality, or the reverse for
ε < 0. The band says how much of a real structure behaves differently:

- runtime's bending grade reads 1/7 of M/S on a 0.2 x 0.4 m beam, so every
  member between 14% and 100% of its bending capacity holds when it should
  break: E3;
- a 0.5% error flips only members within 0.5% of failure: E1, numerical.

## A. Statics

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| Newton I, vertical: ΣR_y = W | any structure on horizontal anchor joints: reactions = Σ m g | Hibbeler 5.3 | **covered**: invariance/* equilibrium, 12 cases; stage within 0.19% (E1); n37 E3 (zero forces, being fixed) |
| Newton I, rotation: ΣM = 0 | reactions' moment about both horizontal axes equals the weight's: Σ R_i x_i = Σ m_i g x_i | Hibbeler 5.3 | **covered**: invariance/* moment equilibrium, where the supports' own moment is under a tenth of the tolerance (pins, rollers; not a fixed base). Worst 0.18% (E1); n37 E3 |
| Method of sections | each bond's force equals the load beyond it | Gere 4 | **covered** implicitly: every beam case's shear and moment checks |
| Method of joints (trusses) | member forces of a determinate truss | Hibbeler 6.2 | **covered**: pratt-truss, rafter-tie-truss (runtime: gaps E2/E3, high: pass) |
| Biaxial loading (3D) | a column under eccentricity in both axes: the corner fibre σ = −P/A ± P e_x/S ± P e_z/S | Gere 11.5 | **covered**: biaxial-column. High and section-bending: exact. Runtime: E3 (the capped grade on the resultant moment reads the corner at 3.1 MPa against 10.9, no tension against 6.5) |

## B. Mechanics of materials (a member's internal stress)

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| Axial | column σ = P/A | Gere 1.2 | **covered**: axial-column |
| Flexure | σ = M/S at sections of cantilevers and simple, propped, fixed and continuous beams | Gere 5.5 | **covered**: 10 cases. High: pass. Runtime: E3 (capped grade, about 1/7 of M/S) |
| Transverse shear force | V at sections | Gere 4.3 | **covered** (as force, 12 checks) |
| Shear stress distribution | τ_max = 1.5 V/A (rectangle) | Gere 5.8 | **out of scope**: joints are graded on average shear. The peak is 1.5x for a rectangle, an E2 bias on shear failure loads |
| Torsion, circular | τ = T r / J | Gere 3.3 | **covered**: torsion-round-shaft |
| Torsion, non-circular | τ = T / (0.208 a³) (square) | Roark 10.1 | **covered**: torsion-square-shaft (known gap in both profiles) |
| Combined axial and bending, kern | e > d/6 puts the base in tension | Gere 11.5 | **covered**: eccentric-column, break-eccentric-tension |
| Section shape | an I-section or hollow patch has S = I/c far from a rectangle of equal area | Gere 5.6 | **missing**: patches are any polygon (poly_bond); no check uses a non-rectangular section |
| Dimensional consistency | twice the size: forces 8x, stresses 2x, twist 16x | Buckingham Π | **covered**: invariance/*. High: pass. Runtime: E2/E3 (grade not dimensionally consistent). Section-bending: E2 |

## C. Indeterminate structures (compatibility)

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| Force method, one degree | propped cantilever R = 3wL/8 | Hibbeler 10 | **covered** (high: 1 pass, 3 known gaps) |
| Fixed ends | fixed-fixed M_end = wL²/12 | Gere 10 | **covered** (known gaps both profiles) |
| Continuous beams | two-span R_B = 10wL/8 | Hibbeler 10 | **covered** |
| Frames | portal frame under lateral load; three-hinged frame | Hibbeler 11 | **covered** |
| Stiffness share | three posts under a rigid slab, the middle one 3x stiffer: it carries P k_m / (k_m + 2 k_o) = 60% | Gere 2.4 | **covered**: stiffness-share. High: exact. Runtime and section-bending: E3: a bond's spring length is the chunks' centre-to-centre distance, so joints far from a big chunk's centre read soft and the load path moves (73% / 20% / 20%). The reference model had the same stale formula for high; corrected 2026-10-09 |
| Redundancy, alternate path | a lost support: an indeterminate beam redistributes; a determinate one falls; a two-span beam bridges 2L or collapses | Hibbeler 2.4; GSA 2016 | **covered**: redundancy-*, alternate-path-* (high: pass; runtime: E3, never collapses) |
| Refinement convergence | answers converge to the closed form as chunks shrink | (FE practice) | **covered**: n19/n37/n24/n48/n41/n81 cases (n37: E3, the zero-force bug) |

## D. Stability

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| Euler buckling | pin-ended column P_cr = π²EI/L² | Gere 11.3 | **out of scope, measurable**. Chunks are rigid and the solve is linear (no geometric stiffness), so a slender column fails only by crushing at A·f_c. When slenderness L/r exceeds π√(E/f_c) (about 86 for concrete with E 30 GPa and f_c 40 MPa, 76 for S355 steel) the stage overstates capacity by P_crush/P_cr: E3 (stands when it should buckle). Planned check: report that factor against λ. |
| Lateral-torsional buckling, P-Δ | slender beams; sway frames | Timoshenko & Gere | **out of scope**, the same reason |
| Rigid-block overturning and sliding | a block on an incline tips at tan θ = b/h, slides at tan θ = μ | Hibbeler Statics 8.2 | **covered**: tip-or-slide (E2, 1.6% and 4.3%: PhysX contact patch) |
| Overturning of a structure | a tall wall under lateral load tips about its toe when M_overturning > W b/2 | Hibbeler 8.2 | **missing** (a structure, not a block: the anchor joints decide) |

## E. Failure and capacity

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| Brittle limits: tension, compression, shear | the load at which the predicted bond breaks, to 0.1% | Gere 1 | **covered**: break-cantilever-root, break-column-crush, break-eccentric-tension, break-simply-supported |
| Weakest link first | the predicted bond breaks first (ties within 0.2% allowed) | | **covered**: the same cases |
| Mohr–Coulomb shear | τ = f_v0 + μ σ_c (EN 1996-1-1 3.6.2) | | **covered**: mohr-coulomb-textbook, -graders, -static |
| Ductility at joints | steel yields without section loss, necks past fatal | EN 1993-1-8 | **covered**: static-ductile-steel, vehicle-ductile-slip |
| Plastic collapse of members | fixed-fixed beam collapses at w_p = 16 M_p/L², first yield at 12 M_y/L²; propped cantilever 11.66 M_p/L² | Neal, *Plastic Methods*; Horne | **missing**: the textbook proof that ductile redistribution happens |
| Re-bearing | a fastened joint bears in compression once its fasteners fail | | **covered**: rebearing-textbook |
| Progressive collapse | see C, alternate path | GSA 2016 | **covered** |
| Crushing locality | crushing only near the strike | | **covered**: crush-locality |
| Fracture energy | breaking a joint absorbs G_f × area | Bažant | **out of scope**: brittle joints dissipate nothing. Debris keeps energy a real fracture absorbs: E2 (faster debris), measurable as kinetic energy after the break against before minus G_f A |
| Size effect, strain rate | strength falls with size; rises with loading rate (CEB-FIP DIF) | Bažant; fib MC2010 | **out of scope**: E2 |

## F. Masonry

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| No-tension material, middle third | see B, kern | Heyman | **covered** |
| Bed-joint friction | Mohr–Coulomb; sliding at μ | EN 1996-1-1 | **covered** |
| Arch thrust | a three-hinged parabolic arch under a uniform load: H = wL²/(8f), and no bending along the arch | Heyman, *The Stone Skeleton* | **missing** |
| Wall overturning | see D | | **missing** |

## G. Rigid-body dynamics

PhysX does the dynamics. The rows marked **stage** are the destruction stage's own work and the priority; the rest are PhysX on Metal, checked here
incidentally (see Scope).

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| Free fall | a fragment accelerates at g, not 2g or 0 | Newton II | **covered**: gravity-free-fall, carrier-gravity |
| Linear momentum in impacts | Σ m v is conserved | Hibbeler 15 | **covered**: impact-momentum |
| Energy bounds | no energy gained in an impact | | **covered**: impact-energy-* |
| Restitution | rebound at e v | Hibbeler 15.4 | **covered**: impact-restitution (E3: breaks through instead) |
| Friction | a block holds at tan θ < μ and slides above; glancing impulse ≤ μ J_n | Coulomb; Goldsmith | **covered**: surface-materials, impact-glancing (E2: dv_t overshoots rolling) |
| **stage**: Compound body | mass Σm; centre of mass Σ m x / Σ m; inertia Σ(I_i + m_i(d²1 − d dᵀ)) (parallel-axis theorem) for a body of many chunks | Hibbeler 17.1 | **partial**: roof-com-* check the centre of mass; inertia untested |
| **stage**: Rotation of a compound body | a chunked bar toppling about its foot: α = 3g/(2L) cos θ; torque-free spin keeps L = Iω | Hibbeler 17.4 | **missing** |
| **stage**: Momentum at a split | the fragments of a body that breaks mid-motion carry exactly its linear and angular momentum, and each moves with the rigid field v + ω × r at the split | Newton III; Hibbeler 19 | **missing**: the destruction-specific invariant (no kick, no lost spin at fracture) |
| **stage**: No energy from fracture | kinetic energy after a split ≤ before (the corrected pass must not inject) | | **partial**: impact-explicit-energy (impact machinery) |

## H. Impact loading

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| Suddenly applied load | dynamic amplification 2 | Gere 2.8 | **covered**: impact-sudden-load. E2/E3 (0.32): rigid chunks store no strain energy |
| Drop from h | DAF = 1 + √(1 + 2h/δ_st) | Gere 2.8 | **covered**: impact-drop. E2/E3 (0.16 to 0.41): the peak follows the tick, not the stiffness. The owner decision "inertia over an impact's duration" is the fix |
| Impulse capacity | a plug held by joints of known capacity: exit speed | Hibbeler 15.4 | **covered**: impact-plate-punch |
| Penetration | NDRC/UFC 3-340-02 depth; Recht–Ipson residual speed | | **covered** (closed forms): scenario-physics |
| Vehicle impact force | EN 1991-1-7 Annex C | | **covered** (closed form): scenario-physics |

## I. Load-path inputs (what the stage is told)

| Law | Scenario and exact answer | Source | Status |
|---|---|---|---|
| Self-weight is ρ g once | g = 20 reads 2.04x; one gravity source | | **covered**: gravity-single-source, gravity-self-weight |
| A resting body loads what it rests on | a block on a beam adds its weight to the beam, awake or asleep | Newton III | **covered** as a known gap. rest-load-asleep is E3: once PhysX sleeps the block, the beam stops feeling it |
| A stack's contact force | each block carries the weight above it | Newton III | **missing** |
| Vehicle contact load | a parked car's wheel loads equal its weight | | **covered** as a known gap: vehicle-contact-load |

## J. Numerical meta-laws (catch whole classes of bug)

| Law | Scenario and exact answer | Status |
|---|---|---|
| Frame invariance | mirrored, turned, bonds reversed: the same answers | **covered**: invariance/* (exact, or 0.49% for a quarter turn) |
| Superposition | 2x the load gives 2x every answer | **covered**: invariance/* (≤ 3.4e-4) |
| Dimensional scaling | see B | **covered** |
| Determinism | the same run gives bit-identical answers | **covered**: answer-drift (233 answers) |
| Time-step independence | a static answer does not depend on dt | **missing** |
| Iteration independence | a converged answer does not change with more iterations (diagnostic only; the product stays at 64) | **missing** |
| Mass-contrast robustness | a 1e8 mass span must solve or say it did not | **open bug** (n37): being diagnosed |

## Build plan, in order of value per effort

1. **Non-rectangular sections** (B): an asymmetric (triangular) section, whose
   two extreme fibres differ 2x. (Rotational equilibrium, stiffness share and
   biaxial bending: done.)
2. **Momentum at a split** and the **compound-body inertia tensor** (G): the
   destruction-specific invariants, which no other suite checks.
3. **Time-step independence** (J) and a **stack's contact force** (I).
4. **Plastic collapse** (E), with ductile joints in the high profile.
5. **Arch thrust** (F) and **wall overturning** (D/F).
6. **Euler buckling** (D): a measuring check. It reports P_crush/P_cr
   against slenderness and records the E3 region. It does not demand
   buckling.
7. **Fracture energy** (E): a measuring check, kinetic energy after a break
   against before minus G_f A.

A known gap stays in `physx-bridge/tests/textbook/expected.tsv` with its class
and its reason (MODEL, STAGE, PHYSX CONTACT, MODEL LIMIT). A gap that grows
fails (GAP-WORSE); one that closes is reported FIXED.
