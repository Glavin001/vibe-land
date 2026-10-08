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

When a result looks wrong, start with
`.claude/skills/destruction-fidelity-debugging/SKILL.md`. It covers:

- the environment traps;
- flag bisection;
- the impact-solve capture and replay;
- the momentum and energy checks.

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

### Variants of high ("arms")

A named variant is high plus a small file of the flags it changes
(`scripts/fidelity/arms/ARM.env`). `scripts/fidelity/select.sh NAME` resolves
`runtime`, `high` or `high-ARM` (or `high` with `VIBE_FIDELITY_ARM=ARM`), and
records the full name in `VIBE_FIDELITY_PROFILE`. `profile.sh`,
`acceptance.sh` and `scenarios.sh` take any of these names. Packs and
provenance are the base profile's, since the arms change only runtime flags.

The impact arms compare how a hit is turned into broken bonds:

| Arm | Name | Flags | Role |
|---|---|---|---|
| A | `high-static` | `VIBE_IMPACT_CAPACITY=0` | static solve only |
| B | `high-step` | `VIBE_IMPACT_STEP=1`, `VIBE_IMPACT_CAPACITY=0` | static plus the linear impact step (the candidate) |
| C | `high-oracle` | `VIBE_IMPACT_CAPACITY=1`, `PX_DESTRUCTION_IMPACT_ITERATIONS=131072`, `PX_DESTRUCTION_IMPACT_EVAL_ITERATIONS=1000000` | the ADMM impact solve at its correctness budget: the reference |

```bash
scripts/verify/impact-arms.sh                       # A, B, C on the shots, then the table
scripts/verify/impact-arms.sh --arms static,oracle  # a subset
scripts/verify/impact-arms.sh --judge-only          # re-tabulate existing runs
```

Each arm runs `acceptance.sh high-ARM` on the test bed's shots (the
cannonball, the meteor, the meteor into the roof and into the upper wall), one
GPU job at a time. `impact-arms.mjs` then prints one row per shot and arm:

- **past:** metres past the point struck. FAIL when KE exceeds the path work
  and the shot did not get through.
- **broken, Jaccard:** the house bonds broken, and the Jaccard index of that
  set against arm C's.
- **locality:** the p90 distance of the broken bonds from the shot line (the
  pack's bond centroids), and the share beyond 4 m of it.
- **energy:** what is unaccounted over the structure's window, as a percentage
  of KE (closes within -10% and contact + 10%).
- **momentum:** the impulse delivered to the structure, and whether anything
  held past its capacity.
- **cost:** the stage's step time per tick over the window, mean and max
  (`impactCost` in the test-bed report).

It also takes test-bed reports directly, so the scenario matrix's arms can be
compared the same way:
`impact-arms.mjs --pack P --meta target/verify/scenarios-high-ARM/lab.meta.json --trials ... static=.../scenarios-high-static/lab.json oracle=...`.

An arm that cannot run says why: B is skipped until the bridge reads
`VIBE_IMPACT_STEP`, and `check.sh` drops it on an SDK without
`PX_DESTRUCTION_IMPACT_STEP`. Once B exists and agrees with C on this table,
`high.env` takes B's flags and C stays as the reference arm.

**First comparison (2026-10-08, garage-hifi 9e5d201f5, B not merged yet).**
That SDK lacked feat/impact-capacity's last 22 commits and
perf/rotation-convergence's last 2, which the branch check now refuses. The
numbers are superseded by the rerun on the rebuilt SDK.
Neither arm is physically right on these shots:
- **A (static)** gets every shot through, but breaks 3,072-3,096 of the
  house's 3,113 bonds. Every shot brings the whole house down: 37-61% of the
  broken bonds are more than 4 m from the shot line, and the Jaccard index
  against C is 0.02-0.14. Its stage cost is 59-94 ms per tick on average,
  with a maximum of 144-253 ms.
- **C (ADMM at the correctness budget)** stops every shot at the face. It
  breaks 62-443 bonds, all local. But 94-99% of the impactor's energy is
  unaccounted over the structure's window. The probe reports a partial hold,
  or an infinite wall on the roof shot: a peak of 722 MN against 2.7 MN of
  capacity held. Its stage cost is 1.5-13.7 s per tick on average, with a
  maximum of 15-32 s.

The record is in `target/verify/impact-arms/impact-arms.txt`.

### Ground truth (the cached arm C)

Arm C is slow (seconds per impact tick), so it runs once per SDK and scene, and
the faster arms are compared against its cache.

```bash
scripts/verify/impact-arms.sh --arms oracle --trials T1,T2,... DIR     # run C
node scripts/verify/ground-truth.mjs record --run DIR/high-oracle --pack P --meta M --trials T1,T2,...
scripts/verify/impact-arms.sh --arms step --truth scripts/verify/ground-truth   # B against the cache
```

- **The gates.** C counts as ground truth for a trial only when it passes the
  owner's physical gates:
  - **through:** a shot whose KE exceeds its path work gets at least 1 m past
    the point struck;
  - **energy:** for shots, the balance closes over the structure's window;
  - **held:** nothing holds past its capacity (no infinite wall, no partial
    hold).

  A driving trial (the truck into the house) has no shot terms: the test bed
  records its probe but no energy terms or bond ids. Its gates are **enters**
  (the car's middle gets past the face it first struck), **slows** (it leaves
  slower than it came, its momentum into the structure) and **held**. A
  `shots` run whose probe mass is not the shot's own (test beds before the
  per-shot mass fell back to the cannonball's 10.65 t) is refused: the gates
  read that mass.

  Locality is recorded (each broken bond's distance from the impact line, and
  the house's summary: frame still anchored, roof members down, breaks by
  distance), not gated. Its physics criterion is that every break is the
  bond's own verdict, which the held gate and the at-rest gate cover. A trial that fails stays out
  of the cache. It goes to the impact solve's owner as a bug in C.
- **The cache.** Each passing trial is written to
  `scripts/verify/ground-truth/<trial>.json` and committed. It holds:
  - the broken bonds with their distances from the line, and the gone chunks;
  - the gates and the metrics: KE, path work, past, momentum, peak force, and
    the energy terms over the window;
  - the stage's cost per impact tick;
  - the impactor's path: [tick, position, velocity] at every probe tick.

  The raw run, and failing trials too, go to `target/verify/ground-truth/`.
- **The key.** Each cache file carries a key:
  - the SDK and its source revision, taken from the run's own provenance log;
  - the pack's and meta's SHA-256;
  - the run's flags.

  Recording refuses a run whose SDK is not the one installed, or whose pack is
  newer than the run. A later SDK can be admitted for an entry explicitly:
  `ground-truth.mjs compat --to REV --reason TEXT` records the revision, the
  reason and the diff checked (the files changed since the cached revision and
  the function each hunk is in) in the entry's `compatible` list. The
  comparison accepts that revision, and says why, for that entry only. The
  packs must still match. The comparison refuses a cache whose key differs from
  the current SDK or packs (`VERIFY_ALLOW_TRUTH_MISMATCH=1` compares anyway
  and says so). It warns when an arm compared ran on another SDK.
- **Same place.** The Jaccard index on bond ids is strict: a neighbouring
  joint counts as a miss. The same-place score counts two broken joints as the
  same place when their centroids lie within the larger of their contact sizes
  (sqrt of the bond area). It reports the F1 of matching each set into the
  other.

#### Provenance of the cache

The cache in `scripts/verify/ground-truth/` is from one arm C run. Its trials
must be rerun when any part of this key changes.

| | |
| --- | --- |
| Run | `scripts/verify/acceptance.sh high-oracle target/verify/impact-arms-gt/high-oracle --skip veneer,lab,town,wire,walk,node`, 2026-10-08 04:30-06:06, test bed only, GPU shared slot |
| SDK | `garage-hifi`, PhysX `integration/high-fidelity` `ddcf616bb`, clean; provenance check passed at the start of the run |
| Packs | `vehicle-lab-crush.json` sha256 `554e93d90b46...`, its meta alongside (both built 02:45, before the run) |
| Flags | arm C (`scripts/fidelity/arms/oracle.env`): `VIBE_IMPACT_CAPACITY=1`, `PX_DESTRUCTION_IMPACT_ITERATIONS=131072`, `PX_DESTRUCTION_IMPACT_EVAL_ITERATIONS=1000000`, FP32, correction limit 1, `PX_DESTRUCTION_ALLOW_UNCONVERGED=1` |
| Cached | `cannonball-framed-house`, `meteor-framed-house-upper`, `framed-house` and `framed-house-corner` (the last two driving trials: gates and house summary, no bond ids) |
| Not cached | `meteor-framed-house-roof`: fails energy (56% of KE unaccounted) and held (partial hold). At first contact the corrected pass bounded 0 of 29 contact rows, so the meteor was stopped as if by a rigid roof (1159 to 517 MJ in one tick against 2.9 MJ of fracture and crush). This is a fault in C, not in the authoring. `smallshots-framed-house`: probe mass 10.65 t, not 100 kg (test bed fixed after this run) |
| Compatible | `0696c5fae` (integration merging `feat/impact-capacity` `3426f54f7`), recorded with `ground-truth.mjs compat`. Its 5 changed files are the impact step's code (method 1 only), `recordRest` (launched only for method 1) and `breaksBySource` (a log counter in otherwise unused slots). Arm C's ADMM path is unchanged |

One run has a known flaw. In `meteor-framed-house-upper` the meteor reaches
grade 1.4 m past the back face (centre y 1.90 m, radius 2.0 m, tick 213),
while it still overlaps the back wall. The structure window therefore closes
at the exit (tick 216) rather than at that ground contact. Of the 101 MJ lost
in the window, 86 MJ is the ground tick: friction with
μ ≈ Δv_along/Δv_up = 5.4/10.6 ≈ 0.5. The house's own ticks (209-212) lose
about 15 MJ against 15.4 MJ of fracture and crush, so the balance closes even
without the ground tick. The trial's premise ("leaves by the back wall before
it reaches grade") does not hold: the meteor touches grade with its centre
1.44 m past the back face, inside its own 2.0 m radius. That is an authoring
issue in the trial's aim, not in the engine.

### Provenance

`scripts/fidelity/provenance.sh PROFILE` checks that the SDK and the packs are
what the profile claims. `correctness.sh` and `acceptance.sh` call it before
any high-fidelity case.

- **SDK.** The SDK's `sdk-artifacts.json` must say `source_dirty: false`. Its
  `source_revision` must be its checkout's HEAD, or a revision with no
  `physx/` or `blast/` changes since. Otherwise the high profile refuses to
  run. `VERIFY_ALLOW_STALE_SDK=1` runs it anyway, and the run records that.
- **Feature branches.** An integration branch's head can itself lag the
  feature branches it merges. `scripts/fidelity/branches.tsv` lists the
  branches the high profile depends on, in one place. For each:
  - **PhysX branch:** its current head must be an ancestor of the SDK's
    `source_revision` (`git merge-base --is-ancestor`). `a|b` accepts either
    head, for a branch or the merge that took it.
  - **vibe-land branch:** its head must be in this checkout, unless its changes
    lie outside what the bridge and server build from (`physx-bridge/`,
    `server/`, `shared/`, `destruction/src`). Then it is a note.

  A missing branch is named with its head and the number of commits the SDK
  lacks, and the high profile refuses to run. A server test binary older than
  the SDK install is reported: the run's cargo build relinks it.
- **Packs.** High-fidelity packs older than any authoring source are rebuilt
  (`build-packs.sh high`, a few seconds). Runtime packs that are out of date
  are reported.

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

**Owner gate (hard, high fidelity):** "the cannon ball should go through the
building".

- The cannonball and the meteor must pass the target (`pastTarget` >= 1 m).
- The check is marked `hard`, so it is never a known gap.

**Physics-derived criteria for the shots.** The owner asked for "physically
accurate destruction", not a damage percentage.

- The test bed records `probe` and `physics` (`VIBE_TESTBED_PROBE=1`,
  `server/src/vehicle_testbed.rs`, `wall_matrix.rs` `Strength::path_work`,
  `fracture_work`, `crush_work`).
- Each criterion uses the engine's own joint model. The damage shares (and the
  oracle's bands, 4-10% and so on) are reported, never gated.

1. **Pass-through.** The straight path through the house (a sphere of the
   shot's radius swept 12 m from the face) has a work to cut:
   - **W_f:** the fracture work of every bond of the chunks it sweeps. A brittle
     joint releases F^2/2k at capacity F = f A, with k = E A / max(d, sqrt A).
     A ductile one does F times its ultimate slip.
   - **W_c:** the crush work of those chunks (crushEnergy times volume).
   - **The carry loss:** the kinetic energy lost carrying their mass m_p as a
     plug (perfectly inelastic): KE m_p/(m+m_p).

   If KE > W_f + W_c + KE m_p/(m+m_p), the projectile **must** get through
   (`pastTarget` >= 1 m). The plug is the whole swept mass, so the path work is
   an upper bound and the trigger is conservative. Below it, a stop is
   physically allowed and reported.
2. **Energy closes.** The impactor's KE loss, plus the potential energy the
   fragments released, minus the fragments' translational KE, must equal the
   dissipation the engine models. That dissipation is:
   - the fracture work of the house bonds that broke;
   - the crush work of the house chunks that are gone;
   - the contact loss, at most (1 - e^2) times the carry loss above.

   **Tolerance:** 10% of the impactor's KE, for fragment rotation (not
   measured) and the 3-tick sampling. Unaccounted energy above that is "energy
   vanished".

   **The structure's window.** The balance is closed over the structure's own
   window (the probe's `physics.window`). It runs from the impactor's first
   contact with the structure to whichever comes first:
   - its exit (3 ticks touching nothing of the structure);
   - its first contact outside the structure: a tick off the structure that
     costs it more than 0.5% of its contact KE (grade, terrain, other bodies);
   - 1.5 s.

   The window records the impactor's KE loss and drop, the fragments' KE and
   released PE, and the fracture and crush work at its close. What the impactor
   loses after it (`afterWindowJ`) is reported, never charged to the structure.
   The meteor trials are aimed so the structure comes first:
   - `meteor-framed-house-roof` descends at 45 degrees into the roof;
   - `meteor-framed-house-upper` enters the upper front wall on a 3% descent
     and leaves by the back wall above grade.

   Each is judged on penetration (>= 1 m past the point struck, hard in high),
   pass-through against path work, closure over the window, and momentum
   through what held. The meteor into a vehicle is not judged yet: the probe's
   joint model (the scene pack's bonds) does not hold a car's joints, so its
   path work and dissipation cannot be computed. The original
   `meteor-framed-house` (into the lower wall and the slab) stays as the
   whole-run case.

   Without a window (older probe output), the balance falls back to the whole
   run with two more terms (the ground term is reported separately):

   - **The impactor's own drop** (m g dh over the window), on the supply side.
   - **Ground contact.** The impactor's mechanical-energy loss, ½ m |v|^2 + m g y,
     summed over the window's ticks on which it touches no house chunk. That
     covers the floor slab, grade and kerbs: static, anchored, or outside the
     house's graph. It includes the inelastic normal loss ½ m Δv_n^2 and the
     friction and rolling work there.
   - **Why the ground term exists.** A meteor that ploughs into the slab (about
     113 MJ normal plus about 187 MJ of friction in one tick) and then rolls on
     terrain was otherwise charged to the house. A tick on which it touches both
     the house and the ground is charged to the house.
   - **Terrain.** It offers no penetration resistance (FIDELITY_AUDIT E10). That
     gap stays recorded.
3. **Momentum through what held** (the probe's `peakForceN`, `heldCapacityN`).
   The impulse the impactor lost per tick (dp/dt) went into the struck chunks.
   - If they all stayed on the anchored body, the bonds carrying them must have
     held a force <= their capacity (`touchedCapacityN`, including their
     weight).
   - A force past the capacity of what held is an **infinite wall** (all held)
     or a **partial hold**, and fails. The anchors' reaction is not read
     directly, so this check is the momentum criterion.
4. **Locality as physics.** A bond breaks only when its own verdict exceeds
   capacity. The high profile has no sub-fatal section loss
   (`VIBE_STRENGTH_SHORT_TERM`, tested by `fidelity_audit::sub_fatal_damage_law`),
   and the at-rest gate shows nothing breaks without the hit. Criterion 3 shows
   nothing holds past capacity.
   - **Independent reference:** with `VERIFY_ORACLE_DIR` holding the impact
     oracle's broken set for the same graph and hit
     (`<shot>-framed-house.json`, `brokenIds`, `spread`), the judge reports the
     Jaccard index and the counts. It is labelled a reference, not ground
     truth.

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

## Scenario-outcome matrix

Every impactor and target pair, with the real-world outcome derived from
impact engineering, is in [SCENARIOS.md](SCENARIOS.md). The pairs are data in
`scripts/verify/scenarios.json`, run by `scripts/verify/scenarios.sh PROFILE`,
and part of `correctness.sh full` (gated in high, reported in runtime).

## Reusing the scenarios (performance suite)

- Textbook structures are data. `VERIFY_DUMP=dir cargo test ... --test textbook`
  writes each one as JSON (chunks, hulls, bonds with contact patches,
  materials, pose rotation). The Rust builders live in
  `physx-bridge/tests/textbook/cases.rs`.
- The acceptance list is `node scripts/verify/acceptance.mjs list`.
- The regression list is `scripts/verify/regressions.tsv`.
