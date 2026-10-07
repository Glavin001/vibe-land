# Calibration structures

These are standard structures whose real-world behaviour an engineer or a
demolition contractor can predict. For each one there is a hand calculation
from codes and textbooks, an automated GPU test that holds the simulation to
that prediction, and a captioned film. The question they answer: *if you build
it here and take its supports out the way an expert would, does it stand and
come down the way the real one would?*

| Scenario | Write-up | Removed | Prediction | rotation | section | default |
|---|---|---|---|---|---|---|
| RC slab viaduct, 7 x 10 m | [bridge-piers.md](bridge-piers.md) | piers, one at a time | holds at 20 m spans (u 0.69); collapses at the 30 m span (u 1.69) | **matches**; bonds within 2% at rest | **matches** | survives the 30 m span (bending read 3.65x low) |
| Glulam Pratt truss, 24 m | [truss-members.md](truss-members.md) | members | zero-force vertical: holds; any cut that leaves a mechanism: collapses | **matches, 6 of 6**; bonds 0.97-1.02 x hand | falls intact | carries cuts at u 3-55 |
| Brick-veneer bungalow | [house-studs.md](house-studs.md) | front-wall studs | 4 out holds; 5 out at the plate's strength | falls intact (heels) | falls intact | holds all 5 (too strong) |
| Three-storey RC frame | [frame-column.md](frame-column.md) | a ground-floor column (GSA / UFC) | ordinary design collapses (u 2.5-2.9); UFC design bridges (u 0.6-0.7) | ordinary: **matches**; UFC: collapses (open: a 3D path) | falls intact | misses the edge removal |
| Controlled demolition | [demolition.md](demolition.md) | ground-floor columns, timed charges | into the footprint, from the side fired first | **blocked** by an engine gap | blocked | blocked |

Profiles: "section" is `VIBE_SECTION_BENDING=1` and "rotation" is
`VIBE_SECTION_ROTATION=1`; see "Engine configurations" below. The common
thread: true section moduli are right only together with section rotational
stiffness. Section bending alone breaks every frame-like structure at rest.

## Method

1. **Structure.** It is built as the engine builds anything: chunks and bonds.
   Real sections, real materials, and real joints with cited capacities
   (`structures/calibration/src/materials.mjs`, the town kit's
   `materials.mjs`). Nothing is tuned.
2. **Hand calculation.** It checks every bond the engine has, at the same
   place, with the engine's own failure law: fibre tension N/A + M/S, fibre
   compression M/S - N/A, shear V/A, against the elastic (sustained) and fatal
   limits. The capacities are the section's code capacities expressed as those
   stresses. The analysis is a linear-elastic plane frame
   (`src/frame2d.mjs`, direct stiffness). Each case carries a prediction per
   model:
   - `real`: true section moduli. This is the engineering prediction.
   - `gain`: the default stage's capped bending gain. It diagnoses the
     default configuration.
   - `kit`: the town kit's sustained limits, for timber.

   A case's state is `holds` below 1 - band, `collapses` above 1 + band, and
   `either` in between. The band is justified in each write-up (typically
   +-15%).
3. **Simulation.** A scenario's cases stand side by side in one scene and run
   on the real city stage (`server/src/calibration.rs`). The stage runs in
   FP32 with the native app's stress settings, a 64-iteration cap, internal
   correction limit 1 and `PX_DESTRUCTION_ALLOW_UNCONVERGED=1`. Each case is a
   static alternate-path analysis: the structure without the removed members,
   from the first tick. That is how GSA 2016 runs a removal, and it is the
   engine's own load case: rigid chunks store no strain energy, so a sudden
   removal has no dynamic overshoot.

   Demolition is the exception. Its charges cut members at their firing
   ticks (`server/src/calibration_charges.rs`, `VIBE_CALIB_CHARGES`).
4. **Judge.** `src/judge.mjs` measures, per case:
   - the bonds broken (with the tick and stresses);
   - pieces cut off from every anchor (`fractured`);
   - how far the structure fell (`collapses`: more than 1 m);
   - the engine's bond utilisations at rest against the hand calculation's,
     bond by bond.

   Every engine configuration is held to `real`. Its own model is judged as a
   diagnostic. A case passes when its state matches and, for a collapse, the
   hand calculation's critical bond breaks on the first breaking tick.

## Engine configurations

| Name | Flags | SDK |
|---|---|---|
| default | none | PhysX garage-roof (0e0aba8a0, clean) |
| section | `VIBE_SECTION_BENDING=1` | garage-roof |
| rotation | `VIBE_SECTION_ROTATION=1` | garage-multihull (section rotational stiffness) |
| impact | `VIBE_IMPACT_CAPACITY=1` + section bending | any SDK given by `PHYSX_ROOT` (impact model E) |

## Running

```sh
node --test structures/calibration/tests/hand.test.mjs                 # CPU: the hand calculations
node structures/calibration/run.mjs --all                              # GPU: every scenario, three configurations
node structures/calibration/run.mjs bridge-piers --configs section     # one scenario, one configuration
node structures/calibration/run.mjs bridge-piers --judge-only          # re-judge the last reports
PHYSX_ROOT=<SDK with impact model E> node structures/calibration/run.mjs bridge-piers --configs impact
```

- The harness builds from a pinned worktree, `target/calib-src`. The shared
  checkout often carries other work in progress. `CALIB_SRC=.` builds the
  checkout itself.
- Each SDK gets its own cargo tree (`target/calib-<sdk>`).
- `CALIB_TIMEOUT_S` cuts off a run stalled behind a saturated shared GPU.
- Exit status is 1 on any miss that `structures/calibration/known-gaps.json`
  does not record as a known engine gap, and on any recorded gap whose state
  changed.
- The spec (`out/<scenario>/spec.json`) holds the scene, every bond's key and
  hand utilisation, and the predictions. A perf suite can replay the same
  scene with no builders.

## Films

`structures/calibration/film/reel.sh <scenario>` films each case from tick 0
in the native app (`scripts/native-mac.sh film calibration --scene calib`,
`client/native/films/calibration.mjs`). It captions each case with the
removal, the hand calculation's prediction and what the engine did, and splices
the takes into `target/native-video/calibration-<scenario>-<stamp>.mp4`.
