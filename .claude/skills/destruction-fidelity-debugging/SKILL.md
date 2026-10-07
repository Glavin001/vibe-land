---
name: destruction-fidelity-debugging
description: The fast path from "the destruction looks wrong" to the cause, learned on the high-fidelity work of 2026-10-07. Use when a structure collapses at rest, a projectile or vehicle bounces off or stops dead ("infinite wall"), pieces fly or float, the impact solve is slow or capped, or a flag combination misbehaves. Covers the two profiles, flag bisection, the impact-solve capture/replay, the momentum and energy checks, the environment traps and the machine-safety rules.
---

# Destruction fidelity debugging

Each section below is a failure that cost hours on 2026-10-07, with the check
that now finds it in minutes. Read the traps first: half of that night's "bugs"
were the environment.

## 0. Before anything: is the environment the product's?

| Symptom | Real cause | Check |
|---|---|---|
| "PhysX fetchResults failed" on the first steps | `PX_DESTRUCTION_ALLOW_UNCONVERGED` unset; the stage refuses capped steps | The bridge GPU tests set it through the shared helper; the server defaults it since cfe1ef5a. Never export it for ctest: strict tests pin it to 0 |
| Nothing breaks, the truck stops dead, balls pass through | Same variable unset on a server | `wall-runtime-strict-*` A/B; regression `server-unconverged-policy` |
| A "flake" that fails every time in one run | An exported env var reaching a strict test | Rerun alone without the variable before calling it a flake |
| A result predates a fix | A stale SDK install or stale packs | Check `out/install/<sdk>/sdk-artifacts.json` (`source_revision`, `source_dirty`); rebuild packs with `scripts/fidelity/build-packs.sh high` after authoring changes |
| GPU test crawls or times out | GPU oversubscribed | `ls ~/Library/Caches/vibe-land-gpu`; everything goes through `scripts/perf/gpu-run.sh` |

## 1. Machine safety (the Mac froze twice and logged out once)

- Run every GPU job through `VIBE_GPU_SHARED=1 /Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh <label> <cmd>`: 3 machine-wide slots, one per agent.
- Timing work takes the exclusive lock (no `VIBE_GPU_SHARED`).
- No GPU dispatch longer than about 100 ms. Apple GPUs don't preempt long compute, so WindowServer starves: freeze, `btn_rst` panic, or a userspace-watchdog logout.
- Bound solver loops per dispatch (the impact solve's resumable state machine, fbe58eab1).
- Never launch a windowed app (`native-mac.sh run`) while agents run GPU work.
- Evidence after a freeze: `/Library/Logs/DiagnosticReports/` `forceReset-full-*.diag` (panic string), `WindowServer_*.userspace_watchdog_timeout.spin` (which processes were running), `gpuEvent-*.ips`.

## 2. Two profiles, always both

- `scripts/fidelity/runtime.env`: every fidelity flag off. This is what ships, and it must not regress.
- `scripts/fidelity/high.env`: everything on. Correctness and optimisation are judged on this one.
- Report both. A fix that only works in one profile is half a fix.

## 3. Collapse at rest: bisect the flags, one at a time, on the same pack

The lab's veneer house broke 3,041 of 3,084 joints at rest under `high.env`. One flag per arm, the same pack, counting broken bonds **from tick 0** (`sceneBrokenPairs`; the test bed's own "at rest" window starts after the settle and hides it):

| arm | result | meaning |
|---|---|---|
| runtime flags on the high pack | 0 | not the pack |
| high, sections off | 0 | not true stiffness, tolerance, spin or crush |
| high, impact off | 2,747 | sections are involved |
| sections, crush off | 51 (heels 30/30) | the trigger |
| heels ×100 (diagnostic pack, `scripts/hifi/diag-strongheel.py` on vibe-land `integration/high-fidelity`) | 20 | confirmed |

Then name the bonds: `scripts/hifi/broken.py LABEL PACK` (material counts; on `integration/high-fidelity`), `scripts/impact/trigger-bonds.py` (which bonds trigger the impact solve), the oracle (`scripts/stress/oracle.py`) for "past elastic or past fatal at rest".

**Lesson:** feature interactions fail where no single flag does. That night it was crush × section bending, and impact capacity × sections. Every new flag needs an at-rest run in the full high profile, not only alone.

## 4. "Infinite wall": something bounces off or stops dead

Run `physx-bridge/tests/infinite_wall.rs`: deterministic arms, seconds each, `INFINITE_WALL_ARM=<arm> <bin> --exact arm --ignored --nocapture`. Assert against momentum and capacity bounds, not appearance:

- The impactor's exit speed must lie between "stopped by what the joints can carry" and "free flight". Bound: `v ≥ v0 − Σ(capacity·dt)/m`, and the rebound ≤ `e·v_n`.
- Known mechanisms:
  - the server policy (above);
  - the corrected pass treating still-anchored chunks as infinite mass;
  - mass-0 supports above grade (the town-kit anchor lint, `TOWN_KIT_BURIED_ANCHORS=1`);
  - a capped impact solve that applies nothing;
  - the tick-average force against a 1 ms Hertz pulse (contact crush's job);
  - the 100 rad/s spin clamp distorting contact impulses (`VIBE_NATIVE_UNCAPPED_SPIN`).
- The lab-wide grid is `scripts/wall-matrix.sh` (`WALL_PACK`); its report is `structures/vehicle-lab/wall-report.mjs`.

## 5. Momentum or energy from nowhere

After any change to contact or the impact solve, check:
- The impactor gains no speed against a chunk that held. Arm `unbreakable`; it was +19.7 m/s before ca8c4339e.
- The fragments' kinetic energy stays at or below what the impactor lost. Measured: 0.4-0.56 of it.
- Upward launches are geometric (speed falling) or bounded by restitution.

## 6. The impact solve is slow or capped

1. Run `PX_DESTRUCTION_IMPACT_LOG=1`. Per evaluation you get islands, solves, iterations, capped, residual and dispatches.
2. Capture: `PX_DESTRUCTION_IMPACT_CAPTURE=DIR`, which writes evaluations slower than 1 s.
3. Replay: `destruction_impact_capture_replay`, with `IMPACT_TRIGGER_REPORT=1` to name the trigger bonds.
4. Read the residual trace. **A residual that falls and then explodes** (1e-5, then 4e3 within a few steps) is a solver bug, not hard physics: on 2026-10-07 it was the L1 section projection returning infeasible points on thin sections (122e83998). Check the projection's feasibility before you suspect conditioning.
5. A capped solve must commit nothing (fbe58eab1). A yielded joint carries its state forward, so the solve goes quiet at rest (6aa23ee9b).

## 7. Cross-model consistency

Every place that judges a joint must use the same model:
- the elastic verdict;
- the impact solve's capacity set;
- the crush virial;
- the oracle.

Mismatches found that night:
- capped bending gains (`bendGainMax`) left in the impact cones;
- isotropic rotation against per-axis rotation;
- bearing joints unknown to the impact solve;
- a reversed bond-normal sign in the oracle.

When a feature changes how a joint is graded, grep every grader.

## 8. Oracle disagreements

The Python oracle is not ground truth. When the GPU and the oracle disagree (the meteor, +71%), check:
- the oracle's own inputs (it had wall ties too soft);
- its discretisation (a ramp start fixed at 1/256);
- which bonds each one breaks (Jaccard).

Make them converge on the same answer before blaming either side.

## Related

`stress-convergence` (the elastic solve), `diagnose-structure-failure` (the audit card), `native-destruction-faults` (runtime faults), `capture-visual-artifact` (pose traces for visual glitches), `perf-measure` (timing), `debugging-discipline`. Docs: `docs/verification/README.md`, `docs/verification/FIDELITY_AUDIT.md`, `docs/calibration/`, `docs/perf/BACKLOG.md`.
