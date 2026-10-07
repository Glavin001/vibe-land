---
name: destruction-fidelity-debugging
description: A principled method for finding why a physics or destruction simulation does something physically wrong — structures failing under loads they should carry, bodies bouncing off or stopping where they should break through, energy or momentum appearing, a solver that is slow, capped or diverging, or features that work alone and fail together. Use before forming a theory about any fidelity bug, and when adding a capability that changes how forces or failure are computed.
---

# Debugging simulation fidelity

A physics bug shows up as a picture that looks wrong. The method is to turn the
picture into a violated **physical statement** you can test, then shrink the
system until one component owns the violation. Theories come last; measurements
come first.

## 1. Rule out the environment before the physics

Many apparent physics bugs are configuration. Before touching a model, check
that the run is the one you think it is:

- **Same settings as the product.** Policies read from the environment can
  differ between the shipped binary, the app, the tests and the scripts, for
  example "publish an unconverged step" versus "reject it". Find every place a
  setting is read and every launcher that sets it. A default that differs
  between them is itself a bug.
- **Fresh builds and assets.** Record the source revision and dirty state of
  every binary and generated asset in the run, and compare them with the code
  you are reasoning about. A result produced before a fix will mislead you.
- **No interference.** On shared hardware, contention looks like timeouts,
  flakes and nondeterminism. Rerun a suspect failure alone before believing it.
- **"Flaky" is a hypothesis to test.** Something that fails every time under one
  condition is not flaky. Find the condition: an exported variable, the order of
  runs, an input file.

## 2. State the expectation as physics, not appearance

"It bounced", "it collapsed" and "it flew" are not testable. Write the bound
that physics allows, then measure against it:

- **Conservation.** Momentum and energy cannot increase without a source: no
  body gains speed from a contact that held, and fragments cannot carry more
  energy than the impactor lost plus what gravity released.
- **Capacity.** A joint carries at most its capacity. An impactor slowed by a
  structure loses at most what the struck joints can carry over the contact
  time. If it loses more, something acted as infinitely strong or infinitely
  massive.
- **Statics.** At rest under gravity alone, an authored structure that a hand
  calculation says stands must break nothing. Count failures from the first
  tick, not after a settling window.
- **Closed form.** Wherever a textbook answer exists (beams, trusses, struck
  rods, free fall, restitution), compare against it numerically.

Every confirmed bug becomes a small deterministic test that asserts the bound.
Write it before the fix and watch it fail.

## 3. Shrink the system

- **Toggle one thing at a time.** With several capabilities behind flags, run
  every flag off, then all on, then all on minus one. Use the same assets, the
  same seed and the same measurement. Interactions fail where no single flag
  does, so the all-on configuration is mandatory.
- **Bisect history** when a previously passing behaviour now fails.
- **Isolate the component.** Capture the failing input to the component (a
  solver's matrix and loads, a contact set) and replay it offline, where you can
  trace every iteration. A full scene is no place to debug a solver.
- **Name the elements.** Go from "the house collapsed" to the exact joints,
  materials and positions that failed first. The first failures are the cause;
  everything after is cascade.

## 4. Read solvers by their trajectories

- **Converging slowly, residual still falling:** conditioning, scaling or a
  genuinely hard (near-mechanism) problem. Precondition, rescale or reformulate.
  Never loosen the tolerance or add iterations to hide it.
- **Falling, then rising and never recovering:** a bug in an operator or
  projection, usually precision loss on extreme inputs (very thin or very
  stiff elements). Check each sub-step's output against its own contract,
  e.g. that a projected point is feasible.
- **Hitting its budget:** report it as unconverged and commit nothing derived
  from the unconverged iterate. Distinguish diverged, capped and converged in
  every log and every statistic.
- **Mixed units in a balancing heuristic** (forces against accelerations): each
  residual should be normalised by its own tolerance.

## 5. Every grader must use the same model

When one part of the system changes how something is judged (a joint's
capacity, its stiffness, the sign convention of its normal), every other part
that judges the same thing must change too: the main solver, any secondary
solver, crush or damage evaluation, reference oracles, test fixtures. Grep for
every grader before declaring a model change done. Inconsistency between two
models is a classic source of "works alone, fails together".

## 6. Reference oracles are evidence, not truth

When the engine and a reference disagree, check the reference's own inputs and
discretisation as hard as the engine's. Measure agreement on what was
predicted (which elements fail, not only how many) and make both converge on
one answer before blaming either side.

## 7. Removing a fudge exposes what it hid

Caps, clamps, floors and tuned limits were usually added to hide a modelling
error. When you replace one with the real model, expect nearby behaviour to
change, and find the original error with `git log -S`/`git blame`. Material
limits tuned to compensate for an old error double-count once the error is
fixed.

## 8. Keep the machine and the evidence safe

- Bound every GPU dispatch to a short wall time (about 100 ms on Apple GPUs,
  which don't preempt long compute well): split long loops into resumable
  dispatches. Cap concurrent GPU jobs through the shared admission script
  (`scripts/perf/gpu-run.sh`). Never run windowed apps on top of a full GPU
  load.
- Keep logs and run scripts in the repository or build trees, not only in
  scratch space that a restart wipes.

## 9. Turn every finding into a detector

A bug found once should be caught automatically forever after:
- **Invariants checked in code, as counters:** diverged solves, infeasible
  projections, dispatch durations, energy and momentum gains.
- **A deterministic test per mechanism** in the regression list.
- **A lint for each authoring rule:** for example, nothing fixed in place above
  grade, and no physical constant duplicated as a literal.

## In this repository

- Profiles: `scripts/fidelity/runtime.env` and `high.env`.
- Suites: `scripts/verify/correctness.sh`, `docs/verification/`, `docs/calibration/`.
- Mechanism tests: `physx-bridge/tests/infinite_wall.rs`, `fidelity_audit.rs`, `textbook/`.
- Audit of caps and fudges: `docs/verification/FIDELITY_AUDIT.md`.
- Impact-solve capture and replay:
  - `PX_DESTRUCTION_IMPACT_LOG=1`: per evaluation, its time and dispatches, every solve's record (island size, ramp level, steps, residual), the coupled-contact rows, and the detectors (capped, diverged, infeasible projections). It synchronises the stream: diagnostics only.
  - `PX_DESTRUCTION_IMPACT_CAPTURE=DIR` writes the inputs of evaluations slower than `PX_DESTRUCTION_IMPACT_CAPTURE_MS` (default 1000; 0 captures every one), at most `PX_DESTRUCTION_IMPACT_CAPTURE_COUNT` (default 4). A capture is raw structs: replay it with a binary built from the same PhysX commit.
  - `destruction_impact_capture_replay CAPTURE [runs]` (PhysX `physx/source/gpudestruction/tests`): the evaluation again, timed. `IMPACT_TRACE=N` prints the residual history every N steps and the worst links with their capacities, gains and stiffnesses; `IMPACT_TRIGGER_REPORT=1` lists the bonds past capacity in the elastic solve, which `scripts/impact/trigger-bonds.py` names from the pack. Settings overrides: `IMPACT_ITERATIONS`, `IMPACT_EVAL_ITERATIONS`, `IMPACT_INNER`, `IMPACT_TOLERANCE`, `IMPACT_RAMP_FACTOR`, `IMPACT_COUPLED`.
  - The oracle comparison: `structures/town-kit/scripts/impact-e-replay.py export|compare` with `destruction_impact_replay` (`scripts/impact/replays.sh`); the oracle is not ground truth (`--oracle-tie-stiffness`, `--oracle-ramp`).
- Related skills: `stress-convergence`, `diagnose-structure-failure`, `native-destruction-faults`, `capture-visual-artifact`, `debugging-discipline`, `perf-measure`.
