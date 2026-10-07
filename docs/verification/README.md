# Verification: does the destruction stage do what a structural engineer expects?

This suite checks the PhysX native GPU destruction stage (CuMetal on the Mac)
against closed-form structural mechanics, locks in this week's accuracy fixes
with regression tests, and runs the owner's acceptance scenarios. Every result
is reported for two **engine profiles**:

- **runtime**: what the game ships. Every new capability is off.
- **high-fidelity**: every accuracy capability is on. Optimisation work gates
  on this profile. The runtime profile must never regress.

```bash
scripts/verify/correctness.sh quick    # ~5 min: textbook + quick regressions, both profiles
scripts/verify/correctness.sh full     # ~1.5-2 h: + refinement study, rest, impact SDK,
                                       #   all regressions, acceptance scenarios in both profiles
scripts/verify/correctness.sh full --only acceptance
```

The run writes `target/verify/<stamp>/report.md`. That is one table: for each
case and check it gives the textbook value and, for each configuration, the
simulated value, the error and the status. Exit 1 means something FAILed.

Statuses:

- **PASS**: within the 1% tolerance.
- **KNOWN-GAP**: listed in `physx-bridge/tests/textbook/expected.tsv` (or
  `scripts/verify/acceptance-expected.tsv`) with its measured error and a cause.
  A gap fails again (GAP-WORSE) if its error grows past 1.25x the recorded error
  plus 0.5%.
- **FIXED**: a listed gap that now passes. Remove it from the list.
- **FAIL**: anything else.

Tolerances are never loosened to make a check pass. A gap is recorded with its
number and its cause.

## The profiles: one switch

```bash
source scripts/fidelity/high.env       # or runtime.env
scripts/fidelity/profile.sh high CMD   # run CMD in a profile
scripts/fidelity/check.sh              # which capabilities does $PHYSX_ROOT carry?
scripts/fidelity/build-packs.sh high   # the high-fidelity packs (isolated copy, target/fidelity/high)
scripts/fidelity/packs.sh high         # their paths
```

| Capability | Flag | Needs |
|---|---|---|
| Bond bending and torsion from the real section | `VIBE_SECTION_BENDING=1` | `PX_DESTRUCTION_SECTION_BENDING` |
| Rotational stiffness from the real section | `VIBE_SECTION_ROTATION=1` | `PX_DESTRUCTION_SECTION_ROTATIONAL_STIFFNESS` |
| Bond stiffness E A / L with no floors, contact length max(d, sqrt A) | `VIBE_BOND_TRUE_STIFFNESS=1`, `VIBE_BOND_CONTACT_LENGTH=1` | bridge (implied by rotation) |
| Impact capacity E and impact-pressure crush | `VIBE_IMPACT_CAPACITY=1` | `PX_DESTRUCTION_IMPACT_CAPACITY` |
| Chunk crushing | `VIBE_CRUSH=1` (pack build), `VIBE_NATIVE_CRUSH=1` | `PX_DESTRUCTION_CRUSH_CORRECTION` |
| Real capacities for outdoor props and trees | `VIBE_REAL_CAPACITIES=1` (pack build) | |
| Hulls referenced from their centroid | `TOWN_KIT_HULL_ORIGIN=centroid` (pack build) | |
| Players snap to ground within 0.2 m | `VIBE_PLAYER_SNAP_TO_GROUND=1` | |
| No 100 rad/s spin clamp on native bodies | `VIBE_NATIVE_UNCAPPED_SPIN=1` | bridge |

**The combined SDK carries every capability.** `high.env` points at
PhysX `integration/high-fidelity` (3913a3b38, install `garage-hifi`).
Runtime stays on `garage-roof`.

The bridge refuses a flag its SDK lacks. Against another SDK, `check.sh
--degrade` drops the missing flags and records them in
`VIBE_FIDELITY_MISSING`, and the configuration name says what actually ran:

- `high-fidelity(no-impact)`: run without impact capacity (for example, on the
  rotation-only garage-multihull);
- `high-fidelity(no-rotation)`: run without section rotation.

### The product's stage environment in tests

The game always runs the stage with `PX_DESTRUCTION_ALLOW_UNCONVERGED=1`: an
unconverged stress solve is published and carried into the next tick. GPU
tests set it with `physx-bridge/tests/common/stage_env.rs` (`product()`), or
`strict_converged()` for the one test of the strict mode.
`scripts/verify/lint-gpu-test-env.sh` (regression `gpu-test-env`) fails any
test that attaches the stage without either. `correctness.sh` also exports the
variable as a backstop.

## How the textbook cases are built

Each case is a structure of rigid box (or convex hull) chunks joined by bonds,
exactly what the stage is given. It runs on the GPU stage at the **shipping
solver settings** (`physx-bridge/tests/textbook/stage.rs`):

- 64 stress iterations per tick, tolerance 1e-3, warm start;
- one corrected pass;
- `PX_DESTRUCTION_ALLOW_UNCONVERGED=1`.

A static solve that does not converge in one tick carries on the next tick, as
it does in the game. The iteration cap is never raised and the tolerance is
never loosened.

Each check reports three numbers:

- **textbook**: the closed form, with its formula and source.
- **model**: the exact f64 answer of the stage's own discrete model
  (`model.rs`). Every bond is a spring k = (E/E_ref) A / L, with a rotational
  stiffness k Ls^2 (runtime) or k I/A from its section (high-fidelity), and the
  grading of the configuration. Model vs textbook is the **chunking's** error;
  it is deterministic.
- **stage**: what the GPU computed. Stage vs model is the **solver's** error
  (FP32, production tolerance).

Across every case and every configuration the stage matches its model to
better than 0.1% (most to 0.00%). Where a case misses the textbook, the
discrete model already misses it. These are modelling gaps, not solver bugs,
with one exception (see the known gaps).

Supports are physical details, because the stage only knows chunks and bonds
(`build.rs`):

- A **fixed end** is the member's face bonded to an anchor plate centred on that
  face.
- A **pin** is a 2 cm bearing strip on a 2 cm block.
- A **roller** is a 30 cm pendulum link with a 2 cm strip at each end.
- A **hanger** is the same link from above.

A 2 cm strip resists moment only through its section, so pins and rollers
behave as pins and rollers only when rotational stiffness comes from the
section (high-fidelity). In the runtime solve every bond is k Ls^2 stiff in
rotation, so the strips clamp.

### Cases (closed form, source)

Sources:

- [Gere] Gere & Goodno, *Mechanics of Materials*
- [Hibbeler] Hibbeler, *Structural Analysis*
- [Hib-MoM] Hibbeler, *Mechanics of Materials*
- [Roark] Young & Budynas, *Roark's Formulas for Stress and Strain*
- [Timo-Goodier] Timoshenko & Goodier, *Theory of Elasticity*

Statics:

| Case | What is checked | Formula | Source |
|---|---|---|---|
| cantilever-tip-load | root and midspan bending stress, root shear, axial = 0 | M = P a, sigma = M/S, S = b d^2/6, V = P | [Gere] 4.4, 5.5 |
| cantilever-self-weight | root and midspan bending stress, root shear, under rho = 2400 kg/m3, g = 9.81 | M = w L^2/2, V = w L, w = rho A g | [Gere] 4.4 |
| simply-supported-point | both reactions, bending beside the load | R = P/2, M = P x/2 (max P L/4) | [Gere] 4.5 |
| simply-supported-udl | reactions, midspan and quarter-span bending | R = w L/2, M = w x (L - x)/2, max w L^2/8 | [Gere] 4.5 |
| propped-cantilever-udl | prop reaction, fixed-end shear and moment, span moment near 5L/8 | R = 3wL/8, 5wL/8, M = wL^2/8, 9wL^2/128 | [Gere] 10.3, [Roark] 8.1 |
| fixed-fixed-udl | end and midspan moments, end shear | wL^2/12, wL^2/24, wL/2 | [Gere] 10.4, [Roark] 8.1 |
| fixed-fixed-point (full) | end moment, moment beside the load | P L/8, P x/2 - P L/8 | [Roark] 8.1 |
| two-span-continuous | centre and end reactions, hogging moment over the centre support | R_B = 10wL/8, R_A = 3wL/8, M_B = wL^2/8 | [Hibbeler] 10, [Roark] 8.1 |
| axial-column | axial force at the base and mid-height | N = P + w (h - y) | [Gere] 1.2 |
| eccentric-column | compression and tension fibres, outside the kern | sigma = -P/A -/+ P e/S | [Gere] 11.5, [Hib-MoM] 8.4 |
| portal-frame-lateral | base and column-top moments, column shears, overturning axial forces | M_base = (Hh/2)(1+3k)/(1+6k), k = (I_b/L)/(I_c/h) | [Hibbeler] 11.5 (slope-deflection with sidesway) |
| three-hinged-frame | thrust, vertical reaction, beam axial force, knee moment | H = M0(crown)/h (UDL: wL^2/8h) | [Hibbeler] 5.3 |
| pratt-truss | end diagonal, chords, hanger, diagonal, zero-force centre vertical, reaction | method of joints | [Hibbeler] 3.4 |
| torsion-round-shaft | torsional shear (root, mid), bending, shear | tau = T r / J, sigma = M c / I | [Gere] 3.3, [Roark] A.1 |
| torsion-square-shaft | torsional shear | tau = T / (0.208 a^3) (Saint-Venant) | [Roark] 10.1, [Timo-Goodier] 109 |

The portal frame's lateral load is applied by turning the frame 90 degrees
(structure pose), so a 10 t knee's weight acts along the frame. The round shaft
is a 28-sided hull. The 32-sided version had 64 hull vertices, and the cooked
hull dropped one: the section's principal axis then followed the long edge and
bending read 40% high. Keep hull chunks well under the cooker's 64-vertex limit.

Failure, redundancy, gravity and rest (`failure.rs`). Materials are brittle
(elastic limit = fatal limit). The breaking load is found by bisection to 0.1%,
with a fresh world for each trial.

| Case | What is checked | Formula |
|---|---|---|
| break-cantilever-root | breaking load; the root bond breaks first | P = f_t S / a |
| break-column-crush | breaking load; the base bond crushes first | P = f_c A - w h |
| break-eccentric-tension | breaking load; the tension face cracks | P = f_t / (e/S - 1/A) |
| break-simply-supported | breaking load; the bonds beside the load break first | P = 2 f_t S / x |
| redundancy-propped | the hanger fails; the beam holds as a cantilever; root moment redistributes to wL^2/2 | indeterminate: alternative path |
| redundancy-simple | the hanger fails; the beam falls (> 1 m in 1.5 s) | determinate: mechanism |
| gravity-free-fall | a broken-off fragment accelerates at g (not 2g, not 0) | dv/dt = g |
| rest-near-capacity (full) | a tower at 95% of crushing capacity and a cantilever at 95% of tension capacity stand 10 s, with no break and no stress creep | statics |

The full tier also runs a **refinement study**: the indeterminate cases at 2x
and 4x the chunk count (`case/nN`).

Dynamics and impact (`dynamics.rs`). Projectiles and loose blocks are plain
PhysX bodies; targets are stage structures.

Sources:

- [Hibbeler Dyn] Hibbeler, *Engineering Mechanics: Dynamics*
- [Goldsmith] Goldsmith, *Impact*
- [Hibbeler Statics] Hibbeler, *Engineering Mechanics: Statics*

| Case | What is checked | Formula | Source |
|---|---|---|---|
| impact-momentum | a ball strikes a free stage body: momentum, and the block's speed | m v = m v' + M V; V = m v (1+e)/(m+M) | [Hibbeler Dyn] 15.2-15.4 |
| impact-plate-punch | a ball punches a plug out of a framed plate: the joints break; the exit speed stays within the joints' capacity impulse (no bounce, not free) | v' = v (m - e m_p)/(m+m_p) - at most F dt/(m+m_p) | [Hibbeler Dyn] 15.4 |
| impact-restitution | the rebound off an unbreakable slab; a weak slab is broken through, not bounced off | e = v_out/v_in | [Hibbeler Dyn] 15.4 |
| impact-glancing | 45 degree impact: the friction bound, the rolling limit, and the friction impulse reaching the slab's bond | \|J_t\| <= mu J_n; dv_t = min(mu (1+e) v_n, 2 v_t/7); bond shear = m dv_t/dt | [Goldsmith] ch. 3 |
| impact-sudden-load, impact-drop | a 1 t block released, or dropped 0.1 and 0.4 m, onto a cantilever: peak root stress over static | DAF = 1 + sqrt(1 + 2h/delta_st) (2 for h = 0) | [Gere] 2.8 |
| rest-load-asleep | the block at rest keeps loading the beam after PhysX puts it to sleep | statics | |
| tip-or-slide | blocks on a tilted plane: the tall one tips at atan(b/h), the squat one slides at atan(mu) | tan theta = b/h, tan theta = mu | [Hibbeler Statics] 8.2 |
| crush-locality (high only) | a round into a crushable masonry wall: no crush at rest, a crush on the hit, every crushed chunk within 1.4 m of the point struck | contact footprint (0.4 m) plus one block, proposed | |

The struck-rod spin (omega/v = m d/I, [Hibbeler Dyn] 19.2-19.4) is in
`physx-bridge/tests/fidelity_audit.rs`.

### What rigid chunks and bonds cannot represent (known limits, not faked)

- **Deflection within a chunk, and elastic dynamics.** Chunks are rigid. There
  is no wave propagation and no vibration. A suddenly applied load gives the
  static answer, not the textbook 2x dynamic amplification: the quasi-static
  stress solve has no elastic mass-spring dynamics to overshoot.
- **Buckling.** Euler buckling, lateral-torsional buckling and P-delta need
  geometric nonlinearity. The stress solve is linear and posed on the undeformed
  geometry. A slender column carries any axial load up to its crushing stress.
- **Continuous plastic hinging, and ductility in bending.** A bond is brittle,
  or ductile in slip under impact capacity. No moment-rotation plateau
  redistributes moments as plastic analysis does.
- **Saint-Venant torsion of non-circular sections.** The stage grades torsion
  with the interface (weld-group) modulus I_p / r_max. That is exact for a
  circle and 12% unconservative for a square (measured, torsion-square-shaft).
- **Shear deformation and shear stress distribution.** The bond's shear spring
  is E A / L (not G A_s / L), and the stage grades V/A (mean), not 1.5 V/A
  (the peak in a rectangle).
- **Joints.** Every joint between chunks resists moment. Pins and rollers are
  narrow contact strips, valid only in high-fidelity. A truss with real
  gussets has secondary bending: 2.4% on the bottom chord here.

## Known gaps

The full list with numbers is in `physx-bridge/tests/textbook/expected.tsv`.
By cause:

1. **runtime grading** (bending and torsion stresses 80-90% low): the moment is
   graded as M/A x min(6/sqrt(A), 3), not M/S. The gain cap is a 2 m deep
   section for every joint. The eccentric column's tension face never cracks
   (it reads 0 MPa against 2.18 MPa). The cantilever breaks at 5x its textbook
   load.
2. **runtime and section-bending rotational stiffness** (reactions 1-13% off,
   moments in indeterminate structures and frames wrong): every bond is
   k Ls^2 stiff in rotation, with Ls one length for the whole structure. Pin
   and roller strips clamp. Load shares by that stiffness, not by EI. The
   three-hinged frame's thrust reads 19% low.
3. **high-fidelity discretisation** (1-3.5% at 0.5 m chunks): fixed-fixed,
   propped and two-span beams. The true-stiffness rule (2c9fd106) sets a bond's
   spring length to max(distance, sqrt(A)). A fixed end at a thin anchor then
   counts as softer than a rigid wall, and chunks shorter than their section
   depth soften every joint. So the **refinement study diverges** (fixed-fixed
   end moment: 1.8% at n12, 4.2% at n24, 2.1% at n48 with midspan 8.3% at n24).
   Before that rule (floors, centre distance) the same study converged at
   second order: 0.69% at n12. This is the physical contact length against the
   textbook's rigid wall, a modelling choice to put to the owner.
4. **Stage: zero solve under extreme mass ratios.** The case is
   simply-supported-point/n37: a 10 t chunk, 0.013 kg beam chunks and 1e-4 kg
   bearing blocks. The stage reports every bond force as 0 and "converged" at
   iteration 0, every tick, in all configurations. The same beam in 19 chunks
   solves exactly. With the light chunks 100x heavier, the n37 beam solves and
   converges. The same light support blocks keep the stage from ever setting
   its convergence flag, although its forces match the model from tick 1:
   "converged NO by tick 600, accurate tick 1". That flag gates the stage's
   settled-component skip, so this costs performance as well. It is a real
   conditioning issue for the solver owners.
5. **Square torsion** (12%, every configuration): Saint-Venant, see the limits
   above.
6. **Truss gussets** (2.4%): rigid 0.3 m gussets on 2 m panels.
7. **Stage: a freed fragment of a sleeping structure is born asleep and takes
   no momentum.** Both profiles show it.
   - impact-plate-punch: all four of the plug's joints break, but the plug
     never moves (not even under gravity) and the ball rebounds at -1.1 m/s.
   - impact-restitution: the weak slab's joint breaks, and the ball still
     bounces off it.

   This is the "wall that will not break" seen from the projectile's side.
8. **Stage: a resting load disappears when its body sleeps.** A 1 t block on
   the cantilever's tip adds the textbook stress, exactly (high-fidelity: 6.896
   against 6.898 MPa). About 0.5 s later PhysX sleeps the block, and the root
   stress falls back to self-weight. Rubble and parked cars resting on a floor
   stop loading it. Both profiles show it.
9. **PhysX contact** (1.6-4.3%):
   - restitution reads 0.1026 against the authored 0.1;
   - friction overshoots the rolling limit (dv_t 3.77 against 2.0 m/s), but
     stays within mu J_n;
   - the tall block tips at 22.1 degrees against 21.8;
   - the squat block slides at 27.7 degrees against 26.6.
10. **Rigid chunks: no elastic dynamic amplification.**
    - A sudden load peaks at 1.37x static, not 2x.
    - A drop's peak is set by the tick, F = m sqrt(2gh)/dt: 8.3x and 18.7x
      against the energy method's 7.2x and 13.2x for 0.1 and 0.4 m.

    These are known limits.

11. **High-fidelity on garage-hifi, impact capacity** (passes with
    `VIBE_IMPACT_CAPACITY=0`):
    - The stage fails a step (`PhysX fetchResults failed`, "Native GPU
      destruction stage failed") in the redundancy and free-fall cases, when
      bonds break under gravity. On other runs the simply supported beam stays
      up after its hanger fails.
    - Crush locality: a round breaks 33 bonds of a crushable masonry wall and
      crushes nothing, because impact-pressure crush replaces the virial crush.
      With impact capacity off it crushes 15 chunks, as far as 3.24 m from the
      point struck. That is not local (the bound is 1.4 m, proposed).

## Regression tests (`scripts/verify/regressions.tsv`)

One line per fix: id, tier, the fix and what the test proves, and the command.

| Fix | Test |
|---|---|
| Stale 20.0 resting-load gravity (f3744df8) | `gravity_single_source.rs` (source scan and one default); textbook cantilever-self-weight (rho A g at 9.81: a solver fed 20 reads 2.04x) |
| Carrier double gravity (PhysX e58f080a9) | PhysX ctest `destruction_gpu_carrier_gravity`, `physx_native_chunk_loads_fragment_gravity`; textbook gravity-free-fall (a structure fragment falls at g); vehicle lab ride-height criteria (acceptance) |
| Roof / island centre-of-mass mismatch (bcbc27d8) | `wire_chunk_poses` studless collapse and cannonball (1 mm); `mass_offset` tests, client topology and manifestBinary tests, town-kit hull-origins |
| Oracle bond-normal orientation (f03cd6e6) | `structures/town-kit/scripts/test-stress-share.py` (new: fails on the pre-fix script) |
| Crush freezing a step under correction (PhysX fix/crush-in-correction) | ctest `blast_stress_gpu_crush_correction`; `native_gameplay` crush tests on a crush SDK; vehicle lab `failedSteps == 0` |
| Coast resistance (a15ebd6e) | vehicle lab `coast` (acceptance: car-coasts-ride-height) |
| Vehicle ride height under double gravity | vehicle lab ride-height criteria for knock-mirror, debris-wheel and near-miss (acceptance) |
| Strike collision in films (7ee21fa9) | `node --test client/native/film` (`assertStrikesClear`) |
| Mortar joints (01ec017a) | town-kit `veneer-houses.test.mjs`; Vibe Town qualification (acceptance) |
| Section bending and rotation (f3288d7c, 63284285) | `section_bending.rs`, `section_rotation.rs` |
| Stiffness floors and spin clamp (200f31b0) | `fidelity_audit.rs` (both profiles; see docs/verification/FIDELITY_AUDIT.md) |

## Acceptance scenarios (`scripts/verify/acceptance.mjs`)

These are the behaviours asked for this week. The list is data (`node
scripts/verify/acceptance.mjs list`), judged from the existing harnesses: the
vehicle test bed, structure qualification, wire poses, the route walk and the
film unit tests. `scripts/verify/acceptance.sh PROFILE` runs the harnesses on
the profile's SDK and packs, then judges.

| Scenario | Harness | Gate |
|---|---|---|
| packs-stand-at-rest | qualification of every structure in the lab, veneer and town packs, each alone; the lab's `rest` trial | no bond broken from tick 0, the settle included (the deliberately studless variants excepted) |
| truck-through-house | test bed `framed-house`, `house` | through the front wall; in high fidelity, through the house (past the back face, z 27.9); house bonds broken within the oracle band 7-12% of 3,084; the roof's mean drop under 0.2 m; no roof member down more than 0.5 m; at least 80% of the frame still anchored; no failed step |
| shots-through-house | test bed `smallshots-framed-house`, `cannonball-framed-house`, `meteor-framed-house` | three 100 kg balls between the studs: through, under 1% of the bonds. Cannonball: through, 4-10%, roof and frame hold, nothing broken more than 8 m away. Meteor: through the house, 12-20% (the oracle's ~490 of 3,084); its roof and frame are measured only (its path takes supports) |
| crush-only-where-hit | test bed `rest`, `near-miss`, `knock-mirror`, cannonball; qualification; textbook crush-locality | no crush without a hit; a crush on a hit (high); crushed chunks within 1.4 m of the point struck (textbook, high) |
| houses-stand-and-converge | qualification of the veneer houses | PASS (<= 10% unconverged, <= 0.5% broken) |
| studless-houses-collapse | qualification of the no-front-studs variants | >= 2% of bonds broken (`COLLAPSE_SHARE`) |
| roof-drawn-where-physics-has-it | `wire_chunk_poses` | worst <= 1 mm |
| stairs-walkable | `walk_route.py` (with `--snap` in high) | the walk passes |
| car-coasts-ride-height | test bed `coast`, `knock-mirror(-driving)`, `debris-wheel`, `near-miss` | criteria.mjs |
| turning-slalom-avoidance | test bed `drift`; the film unit tests | criteria.mjs; unit tests |
| vibe-town-qualifies | qualification of the town pack | no FAIL, FALLS, CRUSH or ERROR |

`structures/vehicle-lab/criteria.mjs` has only lower bounds ("house damaged >=
20"), so a hit that destroys the whole house passes it. The bands above come
from the impact oracle (`structures/town-kit/scripts/impact-study.py`,
`impact-e-replay`). The other thresholds are marked *proposed* in
`acceptance.mjs` for the owner to confirm:

- roof members down more than 0.5 m;
- 80% of the frame still anchored;
- nothing broken more than 8 m away;
- crush within 1.4 m.

Two behaviours have no automated gate yet:

- slalom and avoidance: `scripts/turning-lab.sh` is a film with no pass/fail;
- crush positions in the vehicle lab: only the textbook wall checks them.

### Running on a shared machine

- Every GPU job goes through `scripts/perf/gpu-run.sh` (main checkout's path),
  which admits at most 4 shared jobs machine-wide. The suite runs one at a time.
- A test whose log stops growing for 10 minutes is killed and rerun once,
  reported ENV if it fails again. That is a process stuck in a GPU wait behind
  another process's hung dispatch.
- A Metal command-buffer timeout (`kIOGPUCommandBufferCallbackErrorTimeout`,
  CUDA error 2) is also rerun and reported ENV.
- PhysX's own ctests never receive the `PX_DESTRUCTION_ALLOW_UNCONVERGED`
  backstop: their strict tests pin it.

## Reusing the scenarios (performance suite)

- Textbook structures are data. `VERIFY_DUMP=dir cargo test ... --test textbook`
  writes each one as JSON (chunks, hulls, bonds with contact patches,
  materials, pose rotation). The Rust builders live in
  `physx-bridge/tests/textbook/cases.rs`.
- The acceptance list is `node scripts/verify/acceptance.mjs list`.
- The regression list is `scripts/verify/regressions.tsv`.
