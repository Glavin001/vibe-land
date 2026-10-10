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
| C | `high-oracle` | `VIBE_IMPACT_CAPACITY=1`, `PX_DESTRUCTION_IMPACT_ITERATIONS=131072`, `PX_DESTRUCTION_IMPACT_EVAL_ITERATIONS=1000000` | the ADMM impact solve at its correctness budget. **Retired** (see below) |
| D | `high-explicit`, now `high` itself | `VIBE_IMPACT_STEP=1`, `PX_DESTRUCTION_IMPACT_EXPLICIT=1`, `VIBE_IMPACT_CAPACITY=0` | static plus the explicit impact step, with the handoff fixes (routing, bounds per impactor, corrected warm start): the high profile |

**Arm C is retired (2026-10-08, the owner).** It was too slow to be the
solution: 0.6-2.4 s per impact evaluation on average and 56-257 s at worst,
and 95 min for six trials. It was also no ground truth: on the roof meteor
its own corrected pass bounded none of the contact rows and stopped a 110 t
meteor as if on a rigid roof. The physics gates (through, energy, held;
enters, slows; local vs collapse) are the acceptance. No arm is right by
definition. The cached C trials stay in `scripts/verify/ground-truth/` as an
optional reference only. They are not extended or rerun.

```bash
scripts/verify/impact-arms.sh                                 # high and high-static, 3 repeats of each trial, then the table
scripts/verify/impact-arms.sh --repeats 5 --trials cannonball-framed-house
scripts/verify/impact-arms.sh --judge-only OUTDIR             # re-tabulate existing runs
```

Identical runs can end local or in a collapse, because the rigid simulation
is not bitwise repeatable on the GPU. So each trial runs at least 3 times per
arm, each in its own process:
- `acceptance.sh ARM` (the test bed only, behind the provenance check, on the
  shared slot);
- `VERIFY_LABEL` of its own;
- `VIBE_TESTBED_EARLY_END=1` (see "Run length").

The gates and the outcome per run:
- **shots:** through, energy, held (as in "Ground truth" below);
- **driving:** enters, slows, held;
- **local or collapse:** the test bed's `house.frameBeyondReach` counts the
  frame joints broken farther from the impactor's line than its reach plus
  the longer of the joint's two members. The reach is a shot's radius, or the
  car's half-section. That is the farthest a struck member, or one falling
  from it, can act. Any such break is progressive failure: a collapse.

`impact-arms.mjs` prints one row per trial and arm. Arm C's cached entry is
shown where one exists, marked as keyed to another SDK when it is. Each row
has:
- the local/collapse count and each gate's passes;
- the spread (min-max over the repeats) of the bonds broken, the frame joints
  beyond reach, the frame still anchored, the roof members down, the exit
  speed, the energy residual, the cost per impact tick and the run's length.

The older table (one run per arm, against C) printed one row per shot and arm:

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

### Ground truth (the cached arm C; retired)

Arm C is retired (above). What follows records how its cache was built and
judged. The cache remains an optional reference beside the physics gates and
is not rerun. When it was live, arm C was slow (seconds per impact tick), so it
ran once per SDK and scene, and the faster arms were compared against its
cache.

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
| Compatible | `0696c5fae` (integration merging `feat/impact-capacity` `3426f54f7`), recorded with `ground-truth.mjs compat`. Its 5 changed files are the impact step's code (method 1 only), `recordRest` (launched only for method 1) and `breaksBySource` (a log counter in otherwise unused slots). Arm C's ADMM path is unchanged. That revision was never installed: garage-hifi went straight to `fc77bf97a`, whose handoff fixes (bounds per impactor body) change C's path too, so the cache is keyed to another SDK there |

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

### Run length (the 15-minute rule)

No GPU run may take more than 15 minutes, and `gpu-watch.py` alerts main past
that. Runs are kept short in three ways:
- **One trial per process.** `impact-arms.sh` runs every trial and repeat as
  its own `acceptance.sh` with a `VERIFY_LABEL` of its own.
- **The trial ends once its outcome is decided** (`VIBE_TESTBED_EARLY_END=1`).
  The impactor must be done with the house: a shot's balance window has
  closed, every shot of a volley is out, and the impactor has stopped or has
  touched nothing of the house for 3 ticks. Then nothing may break for the
  house's fall time, sqrt(2H/g), so nothing still falling can land and break
  more. The report gives `endedEarlyS`.
- **Every run on a fixed SDK revision.** The install is versioned (see
  Provenance), so no run waits on a rebuild.

Suites that broke the rule as of 2026-10-08, measured from their logs:

| Run | Took | Why | What keeps it short |
|---|---|---|---|
| arm C, 6 trials (`acceptance.sh high-oracle`, test bed) | 95 min | the ADMM solve: 0.6-2.4 s per evaluation, 56-257 s worst, about 1,100 evaluations on the truck | retired |
| `acceptance.sh high`, every part (correctness full, SDK 5d26ce19d) | 78 min | the parts run in series: town qualification 52 min, test bed 15 min (13 trials in one process), lab 5 min, veneer 4 min | trials one per process (`VERIFY_TRIALS`, `VERIFY_LABEL`), and early end. Town still needs splitting per structure |
| `qualify_structures.py` on Vibe Town (high packs) | 52 min | every town structure qualified at rest one after another, in one job | needs a job per structure (or per batch under 15 min). Not done yet |
| `flag-matrix.sh` | 50 min | every pack at rest under each flag variant, in series. One variant (high without section rotation) took 13 min alone | needs a job per variant and pack. Not done yet |
| `meteor-window-high` (test bed) | 62 min | meteor trials in one process, with no early end | early end, a trial per process |
| `veh5-matrix-high-real` lab (scenario matrix) | 55 min; its cannonball cases 39 min | all of the lab's scenario cases in one test-bed process | needs scenarios.sh to run a case per process with early end. Not done yet |
| `scenarios.sh high` | 40 min | lab 23 min, fleet 13 min, town 4 min, in series | as above |
| `correctness.sh full` | 2.4 h (one run 10 h) | the sum of the above | the parts above. `quick` takes 3-13 min |

### Provenance

`scripts/fidelity/provenance.sh PROFILE` checks that the SDK and the packs are
what the profile claims. `correctness.sh` and `acceptance.sh` call it before
any high-fidelity case.

- **SDK.** The SDK's `sdk-artifacts.json` must say `source_dirty: false`. Its
  `source_revision` must be its checkout's HEAD, or a revision with no
  `physx/` or `blast/` changes since. Otherwise the high profile refuses to
  run. `VERIFY_ALLOW_STALE_SDK=1` runs it anyway, and the run records that.
- **Versioned installs.** `rebuild-garage-sdk.sh` installs into
  `out/install/NAME@<rev>`. It then repoints the `NAME` symlink in one rename.
  `vehicle-testbed.sh` and `acceptance.sh` resolve the link when they start,
  so a run keeps one revision, and `PHYSX_ROOT` names it (`garage-hifi@fc77bf97a`).
  A rebuild never rewrites a file a live run has open. The three newest
  versions are kept. An older one is pruned only when `lsof +D` shows no
  process using it.
- **Following the branches.** `scripts/ops/sdk-follow.sh` runs detached under
  nohup, one instance, with every exit logged. Every 60 s it merges each moved
  PhysX branch into integration/high-fidelity. It reads the branches from
  `branches.tsv`, plus the build-only ones in `scripts/ops/sdk-follow.tsv`.
  It then rebuilds and installs the versioned SDK, so a new run starts at most
  one build behind. A conflict or a failed build is logged and never resolved
  by the script. CuMetal kernels carry per-source header dependencies (PhysX
  `perf/cumetal-depfiles`), so a one-kernel commit rebuilds and installs in
  about 45 s. Before, every header edit recompiled all 57 kernels, about
  4.5 min.
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
| alternate-path-bridges | a two-span beam loses its middle roller; at 2.5x the static demand of the 2L span it holds, midspan stress w x (2L - x) / 2S | alternate load path, GSA 2016 3.2 / UFC 4-023-03 3-2 (holds even with the dynamic increase factor 2) |
| alternate-path-collapses | the same at 0.5x (twice the two-span demand, so it stood before): over half its chunks end > 1 m down in 2 s | progressive collapse: no alternate path |
| invariance/&lt;case&gt; | each statics case solved mirrored (x -> -x), turned a quarter about the vertical, and with every bond's chunks reversed grades every bond the same, to 1% of the structure's largest force, stress or twist (exact model scales). Quick: cantilever-tip-load, simply-supported-udl, two-span-continuous, three-hinged-frame, pratt-truss, torsion-round-shaft; full: every unrotated case. Reflection and reversal are exact; a quarter turn moves answers by up to 0.49% (FP32 order) | invariance (catches axis, sign and bond-end bugs; a mutation that leaves patches unturned fails 21 of 47); and every mass doubled doubles every answer (superposition, [Gere] 1.8: catches a load counted twice or a nonlinearity below capacity; worst 3.4e-4); and twice the size (lengths x2, masses x8) gives forces x8, stresses x2, twist x16 (dimensional analysis: sigma ~ rho g L). High-fidelity passes all 23; runtime fails 21 (its capped grade M/A x min(6/sqrt(A),3) is not dimensionally consistent) and section-bending 9 (uniform rotational stiffness does not scale with the section), each with its exact model missing by the same amount. A case whose stage returns no load (simply-supported-point/n37) fails rather than passing vacuously. Global equilibrium (Newton's first law, [Hibbeler] 5.3): where every anchor bond is horizontal (12 cases), the vertical support reactions add up to the total weight -- the exact model to every digit, the stage within 0.19% (catches a lost or doubled load anywhere in the structure) |
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
| impact-restitution | the rebound off an unbreakable slab; a slab hung on weak joints stands until the hit, then is broken through, not bounced off | e = v_out/v_in | [Hibbeler Dyn] 15.4 |
| pair-reuse | keeping unchanged contact pairs across a corrected pass gives the reference path's answer: plate punch, hung slab, 12 x 12 wall | the same breaks, the same ball velocity | `preserveUnchangedContactPairs` (an optimisation) |
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
7. **Stage: a fragment freed from a kinematic (anchored) source took no
   momentum.** Fixed 2026-10-10 in PhysX `fix/fragment-wake` (on
   `clean/high-fidelity`); the runtime SDK (garage-roof) predates the fix and
   still shows it.
   - impact-plate-punch: all four of the plug's joints broke, but the plug
     never moved and the ball rebounded at -1.1 m/s. Now the plug leaves at
     2.50 m/s and the ball at 2.19 m/s. The momentum lost to the joints is
     78 N s, inside their 133 N s capacity impulse.
   - impact-restitution: a slab hung on weak shear joints. The joints broke,
     and the ball still bounced (+0.46 m/s). Now slab and ball fall together
     (-0.72 m/s). Until that day this case put the weak slab on the anchor
     plate. There the plate still holds the slab up after its joint fails, so
     "breaks through" was ill-posed; the slab is now held only by its joints.
   - **Cause.** The split re-installs the kinematic source as the free plug.
     With `preserveUnchangedContactPairs` (the game's setting), the corrected
     pass kept the plug's contact pairs classified as kinematic, so the plug
     had no mass in the solve. Not the wake counter: free split bodies
     copying their source's zero wake counter is a separate, opt-in fix
     (`fragmentWake`, `VIBE_NATIVE_FRAGMENT_WAKE=1`) that these cases do not
     need.
   - **pair-reuse.** This case runs three split impacts with pairs kept and
     with the reference path (every pair re-narrowphased): the answers must
     be identical.
     - Plate punch and hung slab are now bit-identical.
     - The 12 x 12 wall still diverges in the corrected pass of its first
       fracture tick: 101 against 103 bonds; the ball's tangential velocity
       -2.58 m/s against the reference's -0.73 and the rolling condition's
       -0.70 [Goldsmith]. A known gap of the kept-pair path. The
       high-fidelity profile uses the reference
       (`VIBE_NATIVE_PRESERVE_CONTACT_PAIRS=0`); the game keeps pairs by
       default.

   This was the "wall that will not break" seen from the projectile's side.
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

### Studless houses: what the two-storey house does without its ground-floor front studs

Re-derived 2026-10-08 (house author). Numbers come from the high-profile
pack's own masses, the CPU oracle (`structures/town-kit/scripts/stress-share.py`
and `static-cascade.py`) and the kit's cited capacities.

Two variants are qualified. Each gets its own expectation.

**`veneer-house--no-ground-front-studs` (as built): stands.**

- **The demand.** In the intact house, the ground floor's front studs other
  than the junction stud carry 28.3 kN down to their bottom plate (oracle).
  That is the load which needs a new path once they are gone. The earlier
  50.2 kN was everything above the ground floor in the front half. Half of
  that load reaches the centre wall through the joists and rafters, which
  span front to centre.
- **What is left: two paths, either one enough.**
  - **The junction stud stays.** `withoutStuds` keeps it, since it carries
    the partition. At x -1.8 it supports the front wall, so the upper
    storey spans 6.66 m and 3.06 m, not 9.9 m.
    - Over 6.66 m: M = w L^2/8 = 5.07 kN/m x 6.66^2 / 8 = 28 kN m. The chord
      force over the 2.6 m lever arm is 10.8 kN, and 9.1 kN at the splices
      near x 0.
    - In high-profile packs the chords are spliced
      (docs/calibration/house-headers.md "Splices"): the top plate at
      9.7 kN (8-16d, IRC R602.3.2) and the rim at 6.4 kN (2-20d), 16 kN
      together. So u = 0.57-0.67.
  - **The brick ties.** The upper frame carries 153 ties: 136 to its studs
    and 17 to the rim.
    - A corrugated tie slides at about 0.4 kN (Choi & LaFave 2004). That
      gives 61 kN against 28 kN, so u = 0.46.
    - Its in-plane stiffness is about 0.02 kN/mm (BS EN 845-1
      movement-tolerant ties: ~0.2 kN at 10 mm), so sharing 28 kN over 153
      ties costs about 9 mm of sag.
    - The veneer under them is 90 mm brick on its own footing. The extra
      2.9 kN/m at the tie line, 95 mm off its centre, leaves the face in
      0.08 MPa net tension, under masonry's flexural tensile strength
      (EN 1996-1-1 f_xk1 0.1-0.4 MPa).
    - The ties are made flexible, not free, so they do carry floor load
      once the frame sags. The earlier assumption that they carry none "by
      design" was the error.
- **The prediction: stands.** Local joints at the gap may break (cripples,
  sill trimmers, board screws), under the collapse share.
  - Oracle, junction stud kept: 21 bonds broken, frame 100% anchored. The
    ties carry 10 kN; the chords carry under 2 kN, because the ties are the
    stiffer path.
  - Measured on high with re-bearing: 0.45% (before the splices) and 0.64%
    (with them).
  - The check is `studless-upper-storey-stands`: broken under the 2%
    collapse share.

**`veneer-house--frame-no-ground-front-studs` (new): collapses.**

This variant is the frame alone (no brick, no board), with the ground
floor's front studs and junction studs out.

- **What it removes.** It takes out both of the paths above: the ties go
  with the veneer and the junction stud is gone. It also removes the deep
  beam's web: a stud wall without sheathing or board has no in-plane shear
  resistance beyond its nails' racking, so plate and rim do not act as
  chords of one beam.
- **What carries the front line over the 9.7 m between the side walls:**
  - **The rim** (2 / 240 x 45 plies with the flooring, 262 mm deep): M_Rk =
    2 f_m,k b h^2 / 6 = 24.7 kN m. Against M = W L / 8 = 29.2 kN x 9.72 / 8 =
    35.5 kN m pinned it has u = 1.44, and 0.96 against W L / 12 clamped. Its
    corner laps (2 nails) are pins, so pinned governs.
  - **The floor joists cannot cantilever.** The front and back halves only
    butt over the centre wall.
- **The prediction: collapses.** Oracle static cascade: 921 of 2,085 bonds
  broken. The check is `studless-houses-collapse`: broken >= 2%.

The 2% is still `qualify-veneer-houses.mjs`'s share, not a derivation. The
derivations above decide each variant's side of it. A load-path test
(members fallen, as the test bed's `house.collapsedMembers`) should replace
it once qualification records one.

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
| Monster truck at its real weight, 5000 kg on 293 kg wheels (908def37) | `mass-budget.test.ts` (`monster-mass`) |
| Chassis anchor at the rear crossmember; wheels on lug studs, ISO 898-1 10.9 (1526105b, ee38c294) | acceptance car-coasts-ride-height wheels-kept rows; test bed `blast-*`, `knock-mirror` (`chassis-anchor-lug-studs`) |
| House stop: an anchored brick in the corrected pass (6bd0e913) | acceptance truck-through-house (`house-stop`) |
| Vehicle joints 100-1000x too strong: each joint bounded by its members' sections, opt-in `VIBE_REAL_VEHICLE_JOINTS` (2ea3a19b, c365c1f4) | `real-joint-capacity.test.ts` (`real-joint-capacity`): a panel on a tube holds what the tube can; wheel studs keep their counted section |
| Brittle vehicle joints cascading at real capacity: metal joints ductile, ultimate slip A x 5.65 sqrt(S) (0193a7e2) | `real-joint-capacity.test.ts` (ductility); `fracture.rs` `native_conversion_carries_ductile_slip_parallel_to_materials` (`vehicle-ductile-slip`: the slip reaches the stage) |
| Coasting truck breaking its rear corners on the paved lane's 25 mm lip (0193a7e2) | scenario `coast-over-paving-lip` (`vehicle-coast-lip`): 251 bonds and 4 wheels brittle (`VIBE_VEHICLE_JOINTS_BRITTLE=1`), 0 ductile |
| Car joints graded against a dead stop on the anchored wall it breaks (trial pass; 42.7 MN on the truck vs 0.52 MN measured) | `vehicle_contact_load.rs` (`vehicle-contact-load`, failing first: the impact agent's anchored-contact bound fixes it); the test bed's `loadBalance` audit (`VIBE_TESTBED_AUDIT=1`) |
| Steel joints brittle in the static verdict | `static_ductile.rs` (`static-ductile-steel`, PhysX fix/static-ductile-steel, `PX_DESTRUCTION_STATIC_DUCTILE`) |

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
| studless-houses-collapse | qualification of the no-front-studs variants and the bare frame without its ground floor's front and junction studs | >= 2% of bonds broken (`COLLAPSE_SHARE`) |
| studless-upper-storey-stands | qualification of the two-storey without its ground floor's front studs, as built | < 2% of bonds broken (it stands on the junction stud and the brick ties) |
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
