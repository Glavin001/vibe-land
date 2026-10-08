# The impact step in real time on the GPU: research and plan

Research note and plan, 2026-10-08. It covers what the impact step should be, and what has to change
around it, for an impact to cost about 1-2 ms per tick on the GPU and look physically right. It is
an approximation by design: the bar is "clearly better than the static solve, local, through when
the energy says so, and fast", not "equal to the slow impact solve E".

No engine code changed and no GPU was used. The prototype is CPU-only (NumPy, FP64 and FP32):

- **Harness:** `scripts/impact/explicit-step.py` on vibe-land branch `research/impact-cheap`, beside
  the earlier harnesses `cheap-formulations.py` and `cheap-contact-time.py` that it imports.
- **Input:** the cannonball's impact-level dump (`target/impact-diag/cannon-island1443.bin`) and
  E's Clarabel result (`cheap-e.json`), the same capture as `IMPACT_CHEAP_FORMULATION.md` (PhysX
  impact-e worktree).

This is still one capture. The meteor and the truck need impact-level dumps from a GPU replay.

## Status (2026-10-08, implementation): what the lab showed

Steps 1-3 of §6 were carried out. Findings that change the plan:

1. **The far damage is the static verdict's, and its cause is a warm start, not the dead load.**
   - **Lab** (step arm B, high profile, PhysX garage-impact 3426f54f7, 3 repeats per shot,
     `scripts/impact/repeat-trials.sh`):
     - Cannonball: collapsed 3 of 3. 2,628-2,785 house bonds broke, 96-97% of them by the static
       verdict. One corrected pass alone broke 2,466-2,672.
     - Truck: the static verdict made 96% of the breaks.
     - Meteor into the front: local in every repeat, the step decided almost all of its breaks.
   - **Mechanism** (captures of the collapse pass and the pass before it,
     `PX_DESTRUCTION_IMPACT_CAPTURE_STATIC`):
     - The trial pass's static inputs carry the impactor's rigid stop. For the cannonball that is
       4.6e7 N on a 2 kg brick; for the truck, 3.5e6 N of depenetration from its released rows.
     - The corrected pass's loads are dead weight only (sum |load| 2.28e7 N, weight 2.29e7 N).
     - Its 64-iteration elastic solve starts from the trial's solution, under loads it no longer
       has. It is unconverged (residual 1.1e7 N) and its verdict breaks 2,466.
     - The same loads, solved to convergence, break nothing.
   - **Reproducer:** PhysX `destruction_gpu_impact_static_handoff_{cannon,truck}`.
2. **The fixes are in the handoff, not in the static verdict's material law:**
   - **Contact routing** (`PX_DESTRUCTION_IMPACT_ROUTE`, rule 2 of §1).
     - The reproducer's corrected pass breaks 0 joints on the cannonball, against 2,610 unrouted.
     - On the truck it breaks 12 joints against 3,053 unrouted; its own loads, converged, break 21.
   - **Contact bounds per impactor body** (`PX_DESTRUCTION_IMPACT_BOUND_IMPACTOR`), instead of per
     struck cluster.
   - **The corrected pass's elastic solve warm-started from the tick's start**
     (`PX_DESTRUCTION_CORRECTED_WARM_START`). It is opt-in and a general fix: every profile has a
     corrected pass.
     - Unrouted, it gives the cannonball its own loads' verdict, 0.
     - It does not fix the truck, whose corrected pass still carries depenetration loads (2,692
       either way). Routing is needed too.
3. **Ductile yield in the static verdict (rule 1 of §1) is left out.**
   - With routing, neither collapse needs it: the corrected loads, converged, break 0 (cannonball)
     and 21 (truck).
   - Where a static cascade does remain, ductile yield makes it worse. The roof meteor's damaged
     house under its dead load:
     - the brittle cascade, every round converged, breaks 682;
     - the secant ductile yield of §1 forms a plastic mechanism and breaks 1,126, with 1,042 more
       yielded.
     - That is genuine plastic collapse of what the meteor left of the roof frame, not an artefact
       of the verdict.
   - The offline +938 / +14 result of §1 came from E's 35-break pattern, not from what the lab
     produces.
4. **The explicit step (§4) is implemented** as method 2, `PX_DESTRUCTION_IMPACT_EXPLICIT`
   (arm `high-explicit`).
   - **Against `explicit-step.py --fp32` on the cannonball dump:** the broken set's Jaccard is
     1.000. The impactor's Δp is within 0.09% at 32 µs and within 0.18% at the production substep.
   - **Substep:** the smaller Gershgorin bound of M⁻¹K and M⁻¹ᐟ²KM⁻¹ᐟ² is rigorous. It gives 49 µs
     against the true 64 µs, where M⁻¹K alone gives 32 µs.
5. **Contact bounds act on pairs, not bodies** (`PX_DESTRUCTION_IMPACT_BOUND_PAIRWISE`).
   - A rigid body's max contact impulse holds for all its contacts. So the impactor's bound (what
     the step delivered per point) also capped its contacts with debris, the ground and chunks new in
     the corrected pass. The truck pushed through debris it could not carry: +10..+17 m (h2, h3).
   - Pairwise, the bound holds only between the impactor and the clusters its rows struck. The
     truck stops inside the house: +6.4 m, 3/3 (C: 5.9 m).
   - gpusolver `contactPairMaxImpulse`; PhysX `destruction_gpu_impact_pair_bounds` (the per-body
     rule fails 4 of 9 cases).
6. **Infinite walls: contacts on anchored chunks that never reach the step.** Static captures of
   the held meteors and 100 kg balls (replay `IMPACT_ROWS`):
   - The rows exist, with correct start-of-tick closing speeds (60 m/s; 72-108 m/s), but are not
     routed: their struck chunks were crushed in the same trial pass, and routing skips a crushed
     chunk. The meteor then meets the next layer in the corrected pass, a contact no step saw: a
     rigid stop against an infinite mass.
   - **The anchored-chunk contact bound** (`PX_DESTRUCTION_ANCHORED_CONTACT_BOUND`): the rigid
     solver's contact pre-prep bounds every contact on a chunk of a kinematic cluster, every pass,
     at what the chunk can take over the step: each live bond's capacity in the load's direction
     (compression or tension for the axial share, shear for the transverse; the routing's reading)
     summed, times dt, plus its mass times the closing speed (gpusolver `PxgAnchoredContactBound.h`).
     A load past it loads some bond past its fatal limit, so the verdict breaks it.
   - **Ghost walls** are counted (`anchoredGhosts`, "ANCHORED GHOSTS"): a chunk whose contact was
     cut at its bound and whose bonds the pass's verdict all kept. Must be 0.
7. **Crushing is energy-bounded** (`PX_DESTRUCTION_CRUSH_ENERGY_BOUND`).
   - The payment stopped a 100 kg ball at 60 m/s (180 kJ) dead against a 0.073 m³ brick chunk
     (3.5 MJ/m³: 256 kJ), and crushed the chunk anyway: an infinite wall, and 76 kJ created. A
     0.975 m³ footing (3.8 MJ) was crushed whole by a cannonball that lost 1.55 MJ in the window.
   - Every crush, every pass, is paid by the body that struck it hardest, all or nothing, out of its
     kinetic energy; a crush no body can pay is not made (its damage stays just short of 1, and its
     bonds go to the step). Chunks crush whole: a coarse chunk crushes only when its striker can
     pay for all of it.
   - `crushEnergyCreated` ("CRUSH ENERGY CREATED"): the energy of crushes no body paid. 0 by
     construction with the bound; the runtime path's clamp shows it (206 kJ on one cannonball run).
8. **Before and after** (high profile, the three flags; wall cases on the verification agent's
   clear-of-grade aim):
   - meteor into masonry: held (0.11 m) → exit 133.6 m/s, floor 132.9;
   - meteor into the stone house's upper wall: bounced back → exit 135.2 m/s, floor 88.0;
   - 100 kg ball into masonry: stopped at the face → through, exit 28.2 m/s;
   - truck: +9.9..+14.5 m → +2.1 m;
   - cannonball: open. With the strongest-sense bound it spread (1,124-1,748 breaks, 10 ghosts,
     late static cascades).
9. **The anchored-chunk bound is not consistent yet (dev only: PhysX dev/anchored-ghost-log).**
   PAIRWISE and CRUSH_ENERGY_BOUND are in the high profile; ANCHORED_CONTACT_BOUND is not.
   - The bound must be the support function of the chunk's bonds' capacity sets along the force,
     sum of (C or T)|a| + S t: never tighter than the verdict. The force-parallel minimum,
     min(C/a, S/t), was too tight (250-1,445 ghosts per run).
   - Ghosts remain because a contact cut at the bound must be graded by whichever model decides its
     chunk. Routing took bounded loads out of the static solve (the rigid-stop excess, resting
     shares, released rows), and on an island the step decides, the static verdict is replaced by a
     step that saw only its routed rows. Keeping those loads (static, and as constant external
     wrenches on the step's nodes) graded the rigid solver's wedge and depenetration artefacts at
     capacity: the truck's house collapsed (2,502 bonds, roof down) and ghosts stayed (65-103).
   - Reading: a per-chunk impulse bound inside a rigid solver with no compliance cannot satisfy
     both graders. The compliant contact rows (two-body work: a finite contact stiffness) are the
     physical route for contacts that never reach the step.

## Status 2026-10-08: hand-off

### What landed

PhysX `feat/impact-capacity` (head `577b28f08`; every commit passed the full
`scripts/perf/rebuild-garage-sdk.sh`, install and Metal pipeline warm gate included):

| Flag (high.env) | What | Commits |
|---|---|---|
| `PX_DESTRUCTION_IMPACT_EXPLICIT=1` | the explicit RBSM step (method 2) | `5168921c2`..`8e9006545`; perf `f43e1e60e`..`be8c29439` (perf agent: about half the cost, longest dispatch 9.5 ms) |
| `PX_DESTRUCTION_IMPACT_ROUTE=1` | contact routing by v√(km) against capacity; resting rows | `5168921c2`, `d2e838f54` |
| `PX_DESTRUCTION_IMPACT_BOUND_IMPACTOR=1` | the corrected pass's bounds per impactor body | `5168921c2` |
| `PX_DESTRUCTION_CORRECTED_WARM_START=1` | the corrected pass's elastic solve from the tick's start | `944b1b723` |
| `PX_DESTRUCTION_IMPACT_BOUND_PAIRWISE=1` | those bounds pairwise (gpusolver `contactPairMaxImpulse`) | `8a9af7ed6` |
| `PX_DESTRUCTION_CRUSH_ENERGY_BOUND=1` | every crush paid, all or nothing, by its striker | `dfe26b799`, `8e11f7f5b` |
| none (always) | `stepContactCritical` captures J, dJ by value (CuMetal reference capture) | `577b28f08` |

The PAIRWISE and CRUSH_ENERGY_BOUND lines are in vibe-land `impact/step` `6f71c27a`, merged
into `feat/native-macos-app` as `947d58cb`.

Counters and tests (PhysX ctest, `scripts/verify/regressions.tsv`):
- `Status::energyDeficit` ("ENERGY DEFICIT"), `destruction_gpu_impact_explicit_energy`;
- `destruction_gpu_impact_explicit_cannon` against `scripts/impact/explicit-step.py --contacts
  jacobi` (Jaccard 1.000, dp 0.00%);
- `destruction_gpu_impact_static_handoff_{cannon,truck}[_unrouted,_pretick]`,
  `destruction_gpu_impact_held_over_capacity`;
- `destruction_gpu_impact_pair_bounds` (`_per_body` WILL_FAIL: the old rule gets 4 of 9 wrong);
- `PxDestructionStageStatus::crushEnergyCreated` ("CRUSH ENERGY CREATED"): 0 on every run with
  the bound; the runtime path's clamp shows it (206 kJ on one cannonball run);
- `PxDestructionStageStatus::anchoredGhosts` (dev only, see below).

### Branches and SDKs

- PhysX `feat/impact-capacity` `577b28f08`: tracked; fast-forward only after a full rebuild.
- PhysX `dev/anchored-ghost-log` `9282247b9`: the anchored-chunk bound's later work, not for
  merging as is (routing under the bound, ContactRow::resting bit 2, the ghost log stored past the
  saturation flags, `exExternal`).
- PhysX `build/impact-high`, `build/impact-dev`: local build branches only (`feat/impact-capacity`
  merged with `fix/static-ductile-steel`; `feat/rebearing` is not yet merged into them).
- The garage-impact SDK is `577b28f08` alone (the gate build). Before the next lab run, build it
  from `feat/impact-capacity` merged with `integration/high-fidelity`, so provenance passes.
- vibe-land `impact/step` (`c6f01a72` plus this section): `scripts/impact/house.py` summarises
  ghosts, crush energy created and crush payments per run; `repeat-trials.sh` runs one trial per
  process, under 15 minutes.

### Open problems

1. **The anchored-chunk contact bound** (`PX_DESTRUCTION_ANCHORED_CONTACT_BOUND`, in
   `feat/impact-capacity` but off). It is the only thing that makes the held meteors pass.
   - With all three flags on, before → after:
     - the meteor into masonry was held (0.11 m) → exit 133.6 m/s, floor 132.9;
     - the stone house's upper wall bounced it → exit 135.2 m/s, floor 88.0, local by r + 2t + l
       (0 of 982 beyond 13.07 m);
     - the 100 kg ball into masonry stopped at the face → through, exit 28.2 m/s.
   - It fails on ghosts: chunks whose contact is cut at the bound while the verdict keeps every
     bond. The counter is `anchoredGhosts`; dev/anchored-ghost-log logs each ghost's impulse, bound,
     the bonds' part, mass, closing speed and points.
   - The bound has to be the support function of the bonds' capacity sets, Σ (C or T)|a| + S t.
     The force-parallel minimum was too tight: 250-1,445 ghosts per run, and the truck went through.
   - A load cut at the bound must reach the model that decides its chunk. Routing took it out of
     the static solve. On a step island, the static verdict is replaced by a step that sees only
     its routed rows.
   - Carrying every non-row load into the step as a constant external wrench (`exExternal`) did
     not fix it. It graded the rigid solver's wedge and depenetration artefacts at capacity:
     - truck: 2,502 bonds broken, roof 83 of 102 down, still +14.1 m;
     - cannonball: 1,104 breaks, ghosts 103.
   - **Conclusion:** a rigid solver with per-chunk impulse bounds cannot be consistent with both
     graders (the static verdict and the step). Each bounded contact is either a real load,
     which has to break bonds, or a penetration artefact, which must not. A rigid contact cannot
     tell the two apart.
   - Reproducers: the per-ghost records above, and `target/impact-capture/wm2/*/impact-*-static.impc`
     (replay `IMPACT_ROWS=1 IMPACT_ANCHORED=1`).
2. **Contacts that never reach the step are infinite walls.**
   - The meteor's and the 100 kg ball's rows exist with the right closing speeds (60 m/s;
     72-108 m/s), but their chunks were crushed in the same trial pass. `routeRows` skips a crushed
     chunk, the corrected pass then meets the next layer with nothing evaluated, and the meteor is
     stopped rigidly.
   - The ball was also stopped dead by the crush payment's clamp. CRUSH_ENERGY_BOUND fixes that
     half.
   - With the anchored bound on, the cannonball's remaining ghosts are its own fast single-point
     contacts (closing 58 m/s) on chunks whose rows never reached the step. Which filter drops them
     (crushed, cluster body, released) is not traced.
   - Captures: `target/impact-capture/wm2/wm-masonry-{ball100,meteor}-0-r1/` (replay
     `IMPACT_ROWS=1`: each row and routeRows' terms).
3. **Crush granularity.**
   - The pressure law (`extStressCrushStep`) is stress-only and volume-independent, so a coarse
     chunk crushes whole: a 0.975 m³ footing (3.8 MJ at 3.9 MJ/m³).
   - With CRUSH_ENERGY_BOUND such a crush is made only when its striker can pay for all of it. It
     never erases more energy than was delivered, but it cannot crush part of a chunk.
   - Splitting coarse chunks (authoring) or a partial-crush state is open. The crush energy
     densities are authored (brick 3.5, concrete 3.9 MJ/m³); citing them is authoring's job.
4. **Per-bond attribution.** Each broken bond should be tagged with its evaluation's impactor body
   and whether that body is the shot's projectile, so locality can exclude debris impacts. Today
   the log splits breaks only between the step and the static verdict, per pass. It should be done
   on a dev branch with a full build. Until then the verification agent separates breaks by time.
5. **Two locality fails** (scenarios.mjs, r + 2t + l), both on the dev SDK with all three flags:
   - meteor into masonry: 18 of 126 beyond 3.0 m;
   - 100 kg ball into masonry: 2 of 20 beyond 1.14 m.
   - Not attributed yet: debris, or the step's 3 m patch.
6. **The truck** (framed house) and `vehicle_contact_load` (1.55: graded 1,227 kN against 791 kN
   needed) belong to the two-body agent. The trial grades the car against a wall the same tick
   then breaks, and the anchored bound never binds there. Pairwise alone stops the truck at
   +6.4 m (3/3).

### Recommendation

Make every impact contact compliant: a finite contact stiffness, Johnson's flat punch
k = 2 a E* with 1/E* = Σ (1 - ν²)/E, a from the patch's spread, clamped between the Hertz radius
and the smaller face. The two-body agent owns that law for vehicles.

- A fast body against a held chunk then decelerates over the contact's duration, inside the step,
  with no rigid penetration artefact to bound.
- A contact past capacity is decided by the step's joints.
- Fold the infinite-wall case into it: every contact on an anchored chunk, crushed-neighbour and
  corrected-pass ones included, becomes a compliant row the step evaluates.
- Keep the anchored bound out of the high profile until that lands.

## Summary

1. **Most of the lab's far damage is not decided by the impact step. It comes from the static
   verdict on the ticks after it.**
   - **Lab, cannonball, step B (`target/vehicle-testbed/step4-high.log`):** the step's own passes
     broke 41 bonds in 395 evaluations. The scene ends with 1,480 broken.
   - **Offline:** take the house with only E's 35 local breaks, or with the explicit step's 65.
     The static verdict under dead load alone, brittle as the engine's is, then cascades into
     **+938 and +880 breaks**, most of them more than 4 m from the hit.
   - **With ductile joints yielding:** the same check adds only **+14 and +6**, all near the hole,
     and the house stands. The intact house breaks nothing either way (max utilisation 0.954).

   The fix belongs in the handoff, not in the impact solver: the static verdict needs the same
   ductile yield as the impact models. Instrumentation already exists to confirm this in the lab
   (PhysX `21d447f04`, breaks by source).
2. **Recommended impact step: explicit dynamics of the bond graph (RBSM) over the tick**, on a
   patch, one threadgroup per patch, all impacts in one dispatch. It uses:
   - symplectic Euler (no linear solve);
   - elastic-perfectly-plastic ductile joints with a radial return and slip-to-failure;
   - elastic-brittle joints that break in the substep their force reaches capacity;
   - the impactor as a node with its momentum;
   - contact as a Moreau inelastic impulse with a Coulomb cone.

   There are no events, no ordering and no thresholds to choose. The failure order is the stress
   wave's.
3. **Prototype on the cannonball, the full tick (16.7 ms):**

   | Measure | Explicit step | Comparison |
   |---|---|---|
   | Bonds broken | 65 | E 35, event ramp 30-40, static model about 900 (lab about 3,000) |
   | Within 2 m of the hit | 59 | |
   | Maximum distance | 2.65 m | |
   | Jaccard vs E | 0.33 | event ramp 0.23-0.32 |
   | nearF1 vs E | 0.77 | same as the event ramp |
   | Cost | 260 substeps, no linear solve | |

   The result is insensitive to the things that should not matter:
   - **Precision:** FP32 = FP64, an identical set.
   - **Substep:** halved, Jaccard 0.98 against the 64 µs run; quartered, counts within 2 at every
     recorded time.
   - **Contact sweeps:** 1 or 4, identical.
   - **Patch:** a 3 m patch (143 chunks) gives Jaccard 0.95 against the full island, with the same
     momentum.
4. **Estimated GPU cost:** about 0.5-1 µs per substep for a 3 m patch in one threadgroup, so
   **0.15-0.5 ms per impact** for 260-520 substeps. Impacts run in parallel, one per GPU core. One
   dispatch of about 1 ms is far under the 100 ms cap. This is an estimate from operation counts;
   the first GPU checkpoint measures it. Step B today: a mean of 256 ms per evaluation.
5. **Momentum differs from E, and the difference is E's contact law.** The ball loses 1,091 N·s
   (E 147, the event ramp about 276). Debris carries 1,150 N·s: the struck bricks leave at the
   ball's speed. The energy books close:
   - impactor loses 46.8 kJ;
   - house kinetic energy 15.2 kJ;
   - plastic work 0.4 kJ;
   - about 31 kJ dissipated by the inelastic contact, which matches ½ · (18 kg carried) · (60 m/s)².

   Whether E's dilating contact cone is the target remains the owner's call (as in
   `IMPACT_CHEAP_FORMULATION.md`).

## 1. Where the far damage comes from: the handoff to the static solve

### Evidence

**Lab.** `step4-high.log`, the cannonball scene (vehicle testbed, impact step on, high profile):

| Quantity | Value |
|---|---|
| Impact step evaluations | 395 |
| Bonds the step broke | 41 (and 34 yielded) |
| Total impact evaluation time | 17.4 s |
| Longest evaluation | 850 ms |
| Longest dispatch | 101 ms |
| House bonds broken at the end of the scene | 1,480 |

So about 97% of the breaks happen outside the step's decisions.

**Offline (`--handoff`).** The next tick's static verdict, reproduced on the damaged house:
- the min-norm elastic solve under dead load, B J = B J₀ (J₀ balances the dump's base load to
  about 11%);
- debris (groups no longer tied to an anchor) removed;
- every joint over capacity breaks, as the engine's material verdict does (`extStressBondDamage`
  has no plastic state: an over-capacity joint loses section until it breaks);
- re-solved until nothing is over.

| Damage handed over | Static verdict, brittle (engine today) | Static verdict, ductile joints yield (secant) |
|---|---|---|
| none (intact house) | +0 (max utilisation 0.954) | +0 |
| E's 35 breaks | **+938**, of which 732 beyond 4 m (rounds: 16, 16, 19, 94, 170, 443, 136, …) | **+14**, all within 4 m; stands after 23 rounds |
| explicit step's 65 breaks | **+880** in 12 rounds (still going), 684 beyond 4 m | **+6**, all within 4 m; stands after 20 rounds |

### Reading

- A local hole moves the dead load onto a few neighbouring joints. Some of them are ductile
  (nailed, screwed or bolted timber). Under an elastic solve they read utilisation 2-7.
- Today's static verdict cannot let a ductile joint hold its capacity while its neighbours take the
  rest, so it breaks them. Each break re-routes more load, and the front walks across the house.
- This is the "no plasticity, so the cascade has no plateau" failure that the earlier note found in
  the linear impact models. Here it runs in the static solve, after any impact model, including E.
- That explains E's lab result: 439 bonds broken against its oracle's 35.

Other routes the lab could still add to (unconfirmed offline):
- contacts that reach the static verdict with the trial's `M v / dt`;
- the 64-iteration static cap leaving a damaged structure unconverged.

The breaks-by-source log separates these.

### What the handoff must do

These rules follow from the models, not from tuning.

1. **The static verdict yields ductile joints instead of breaking them.**
   - **Plastic state:** each bond keeps a persistent secant scale s ≤ 1. When an elastic solve
     reads utilisation u > 1 on a ductile joint, s ← s / u, and the joint carries its capacity.
   - **Failure:** it breaks when its plastic slip passes its ultimate slip (the material's
     `ductileSlip`). The slip is (|δ_rel| − capacity / k) from the solve's own relative
     displacement, the same slip state the impact models already keep (`slipState`).
   - **Brittle joints** break at capacity as today.
   - **Cost:** the secant update is one per-bond kernel after each solve. It converges over the
     next ticks with the existing Krylov carry. Offline it took 20-23 re-solves, about 0.4 s of
     settling at one per tick.
   - **Correctness:** this is the elastic-perfectly-plastic field, which E converges to under dead
     load. It changes nothing at rest: the intact house never yields.
2. **No contact on a structure reaches the static verdict as `M v / dt`.** A contact is
   quasi-static only if its peak elastic force is below what the path can carry. For a mass m_eff
   closing at v on a path of stiffness k, the peak is F = v √(k m_eff) (energy balance; the
   EN 1991-1-7 Annex C hard-impact force).
   - **Route a contact to the impact step** when v √(k m_eff) exceeds the weakest capacity on its
     struck chunk's joints.
   - **Otherwise** it goes to the static verdict, with its load bounded by min(m v / dt,
     v √(k m_eff)).
   - **Every tick:** this decision applies to every tick of contact, not only the first. A ball
     still inside the wall on tick 3 is still an impact.
3. **The impact step's verdict stands for its islands through the corrected pass.**
   - The corrected pass (`internalCorrectionLimit` 1, always on) re-simulates with the split
     applied. The islands the step decided are not re-judged statically in that pass.
   - The step's end-of-window velocities for freed chunks are the momentum handed to PhysX.
   - Whatever strain the remaining structure still holds after the window is dropped. The next
     tick's static solve recomputes it from scratch, and with step 1 it can only yield locally.

## 2. Candidates

**Cost** is per impact on the cannonball's 3 m patch (143 chunks, 477 bonds) unless stated.
**Fidelity** is against E and against physical expectation.

| Candidate | What it is | Cost | GPU parallelism | Fidelity | Risk |
|---|---|---|---|---|---|
| **A. Explicit RBSM dynamics (recommended)** | symplectic Euler on chunks and bonds; elastic-plastic or brittle bonds; Moreau contact | 260-520 substeps × about 0.5-1 µs ≈ **0.15-0.5 ms** (est.) | full: a thread per bond, then per node; 3 barriers per substep; one threadgroup per patch | Jaccard 0.33-0.39, nearF1 0.77-0.83, local, through, dissipative (measured, CPU) | stable dt scales as chunk size / wave speed (CFL): small stiff parts need more substeps (see risks) |
| B. XPBD / TGS small steps, breakable compliant joints | per-substep implicit projection per bond (compliance 1/k), force λ/Δt², clamp at capacity, break | 1-2 projections per substep; unconditionally stable, so fewer substeps on stiff parts | Jacobi (needs averaging) or graph colouring; colouring changes as bonds break | as A when converged; under-converged λ misreads bond forces near capacity | breaks depend on iteration count; heavy-on-light (10 t on 10 kg) converges slowly |
| C. Bond-based peridynamics | point masses, bonds break at critical stretch | as A | as A | loses rotational DOFs and section capacities our RBSM has | regression in fidelity; nothing gained over A |
| D. Event ramp, today's B (implicit, h ≈ 1 ms) | exact critical-λ ramp with SMW rank updates | about 50 events, 83-100 solves; lab mean 256 ms, max 3.5 s | sequential by construction: one event per launch | Jaccard 0.23-0.32, nearF1 about 0.8 (oracle) | cost floor is the event count |
| D′. B with batched events | break all bonds within a window together | window must be shorter than a hop, so events rarely batch | as D | converges to A as the window shrinks to the CFL step | it is A run through a linear solver |
| E. Dense batched Cholesky / mixed precision for D | one factorisation per event | 1-25 ms (estimated in the earlier note) | batched dense | as D | still about 50 sequential events |
| F. Modal precomputation (Glondu et al. 2013) | response from a precomputed modal basis | microseconds per impact | trivially parallel | exact until the first break; the basis is invalid after it | fails exactly where we need it (cascades) |
| G. Geometric fracture patterns (Müller et al. 2013; Teardown; Frostbite) | an impact-aligned pattern or a radius carves the damage | microseconds | trivial | not stress-based: ignores capacity, energy and support | against "physics first, no heuristics" |
| H. Explicit damage front | a front propagated by a rule | cheap | parallel | a heuristic | same objection as G |

**Why A rather than "make B faster":** B's cost is set by its event count, about 50 sequential
solves, and no batching window can be derived that does not shrink to a stress-wave hop.

- Two bonds that cross capacity within one hop time cannot influence each other. So the only
  physically justified simultaneity window is the time a signal takes to cross a bond. With that
  window, an implicit ramp is just a slower explicit integrator.
- A is that integrator directly. It gets plasticity per bond for free: the radial return that
  the linear models lacked, and the reason they over-broke.

## 3. Prototype: explicit RBSM step on the cannonball

### Model

- **Bodies:** the dump's chunks are rigid (6 DOF, mass and inertia tensor); anchors carry no DOF.
- **Bonds:** each bond acts on the solver's 6 link components through the solver's own B with
  stiffness k = comp / dt². The dead load is f = −B J₀ (J₀ is the dump's near-rest state), so the
  house starts in equilibrium and a broken bond releases its J₀.
- **Each substep Δt:**

  ```
  v += Δt M⁻¹ B (J − J₀)                      bond forces on the chunks
  v  = contact(v)                              Moreau: per row an inelastic impulse, P_N ≤ 0, |P_T| ≤ μ|P_N|
  J  = J − Δt k ⊙ (Bᵀ v)                       trial
  brittle: util(J) ≥ 1 − band  → break (J = 0)
  ductile: util(J) > 1         → J /= util, slip += |ΔJ_pl / k|; break when slip > ultimate slip
  ```

- **Impactor:** a node with its momentum (10,650 kg at 60 m/s), tied to its 13 struck chunks by the
  dump's contact rows.
- **No artificial damping.** Dissipation comes from plasticity, fracture and the inelastic contact.
- **Substep:** Δt = 0.9 · 2/ω_max, where ω_max is the largest eigenfrequency of M⁻¹BKBᵀ
  (symplectic Euler is stable for ω Δt < 2). Here ω_max = 2.8e4 rad/s and Δt = 64 µs; the
  per-node Gershgorin bound is 5.6e4.
- **Window:** the whole tick (16.7 ms). Breaks are recorded with their times.

### Results (cannonball, first contact tick)

| Model | Broken | Jaccard vs E | nearF1 vs E | ≤ 2 m | Median / max (m) | Impactor Δp (N·s) | Debris p (N·s) / mass | Cost |
|---|---|---|---|---|---|---|---|---|
| E (Clarabel oracle) | 35 | 1 | 1 | 30 | 1.13 / 8.6 | 147 | 12 / 42 kg | 21 Clarabel solves; GPU 55 s |
| Event ramp, h 1 ms (B's oracle) | 40 | 0.23 | 0.77 | 36 | 0.93 / 2.7 | 276 | 265 / 180 kg | 100 linear solves (lab: mean 256 ms) |
| Static / elastic + inertia over dt (C1) | 890-924 | 0.03 | — | 125-132 | 5.0 / 10.2 | — | — | lab: about 3,000 of 3,113 |
| **Explicit, at 0.5 ms** | 32 | 0.29 | 0.85 | 31 | 0.80 / 2.31 | 1,087 | 931 / 125 kg | 8 substeps |
| **Explicit, at 1 ms** | 47 | 0.39 | 0.83 | 45 | 0.88 / 2.34 | 1,088 | 982 / 147 kg | 16 |
| **Explicit, at 2 ms** | 54 | 0.39 | 0.83 | 51 | 0.91 / 2.34 | 1,089 | 1,050 / 154 kg | 31 |
| **Explicit, full tick 16.7 ms** | 65 | 0.33 | 0.77 | 59 | 0.94 / 2.65 | 1,091 | 1,153 / 308 kg | 260 |

**Timeline:**
- The contact is over within about 0.5 ms (its impulse is 1,295 of 1,301 N·s by then).
- 23 bonds break in the first substep. These are the struck bricks' joints: accelerating a 10 kg
  brick to 60 m/s over a contact of about 0.1 ms takes MN, against joint capacities of about
  1 kN.
- Then a front: 47 breaks by 1 ms, 54 by 2 ms.
- The late breaks (5-16 ms) are the dead load settling around the hole. They are the same thing the
  plastic static check does next tick (+6).

**Sensitivity:**

| Variant | Broken | Jaccard vs the full-island run | Note |
|---|---|---|---|
| Δt 64 µs (0.9 · 2/ω_max) | 65 | 1 | reference |
| Δt 32 µs (Gershgorin-safe) | 66 | 0.98 | converged in Δt |
| Δt 16 µs | 66 | — | counts within 2 at every recorded time |
| FP32 | 65 | 1.00 | the product runs FP32; no precision issue |
| 1 contact sweep (Jacobi) vs 4 (Gauss-Seidel) | 65 | 1.00 | contacts can run fully parallel |
| patch 1 m (27 chunks), fixed boundary | 53 | 0.82 | momentum exact (1,090.9) |
| patch 1.5 m (42) | 54 | 0.83 | |
| patch 2 m (70) | 57 | 0.88 | |
| **patch 3 m (143), fixed** | 62 | **0.95** | momentum exact |
| patch 3 m, absorbing (Lysmer-Kuhlemeyer dashpots, √(k m)) | 61 | 0.94 | no gain over fixed |
| patch 1-1.5 m, absorbing | 47-48 | — | dashpots on the struck chunks drag the impactor (Δp 1.5e3): worse |
| ζ = 5% Rayleigh β (at the hop frequency) | 88 | — | nearF1 0.62: the viscous force counts against capacity, and β over-damps the high modes (ζ 1.7 at ω_max). Rejected |

### Patch and boundary

- **What sets the size is damage reach, not wave reach.** The wave travels about 14 hops in a tick
  (hop time √(m/k) = 1.2 ms), but the damage stops at 2.65 m. Once the path's bonds have failed,
  nothing behind them sees more than they could carry; that is E's saturation, recovered
  dynamically.
- **Size:** 3 m is enough here (Jaccard 0.95, momentum exact). Use the earlier note's cheap
  truncation test: grow the patch while any break lands within one hop of its boundary.
- **Boundary:** fixed is adequate. Absorbing dashpots gain nothing at 3 m, and they hurt on small
  patches where the struck chunks touch the boundary.

## 4. GPU design (CUDA on CuMetal, one dispatch)

**Kernel `impactExplicit`, one threadgroup per patch, all patches of the tick in one launch.**
No grid synchronisation is needed, so CuMetal's single-block cooperative limit and the missing
while-nodes do not matter.

1. **Setup (in-kernel, per patch):**
   - Gather the patch by breadth-first search from the struck chunks to radius R or a node cap.
   - Compress each bond into device scratch: local end indices, link frame (quaternion), two arms,
     k (6), capacity terms (9), J₀, J, slip and flags. That is about 45 floats instead of the 72
     of B plus the rest.
   - Build node adjacency as CSR, so the force gather is deterministic and needs no atomics.
   - ω_max by 10-20 power iterations on the patch (each costs one substep), then Δt = 0.8 · 2/ω_max.
2. **Substep loop (device-side, `__syncthreads` between phases):**
   - **node phase:** a thread per node gathers B(J − J₀) and applies M⁻¹. v lives in threadgroup
     memory (143 × 6 × 4 B ≈ 3.4 KB).
   - **contact phase:** a thread per row, one Jacobi sweep, impactor update reduced in the group.
   - **bond phase:** a thread per bond: Bᵀv, trial, utilisation, break or return, slip.
3. **Output:**
   - broken flags (into the existing verdict, `eBROKEN`);
   - slip state;
   - freed chunks' velocities (handed to the bodies, as the impact step's velocities are today);
   - the impactor's velocity;
   - log counters.

**Cost estimate (to be measured at checkpoint 3):**
- **Per bond:** two 6×6 transforms done as a rotation plus a cross product (about 60 FMA),
  utilisation (about 40 flops) and about 180 B loaded.
- **Per substep, 3 m patch:** 477 bonds on 512 threads is one bond per thread, so about 0.3-0.5 µs
  for the bond phase. The node and contact phases and three barriers add about 0.2-0.4 µs. In all,
  **≈ 0.5-1 µs per substep**.
- **Per impact:** 260-520 substeps → **0.15-0.5 ms** on one GPU core.
- **Batching:** concurrent impacts take the other cores, so 8 impacts on a 10-core Apple GPU
  cost about the same wall time.
- **Full-island fallback** (997 chunks, 3,051 bonds, 1,024 threads): about 3-5 µs per substep,
  so 0.8-2.6 ms.
- **Overhead:** one dispatch (about 0.1 ms commit-to-start).

**The 100 ms rule:**
- **Bound:** a dispatch runs at most `substepsPerDispatch` substeps; the state is resumable in
  device memory, as the event ramp's launches are bounded by work today.
- **Default:** set it so the worst patch (node cap × 4 µs × substeps) stays under 20 ms.

## 5. Literature: what applies

**Game and VFX destruction:**
- **DMM, Pixelux (Parker & O'Brien, "Real-time deformation and fracture in a game environment",
  SCA 2009).**
  - Corotational FEM with fracture driven by the separation tensor of O'Brien & Hodgins
    (SIGGRAPH 1999, explicit FEM).
  - Shipped in a console game with per-frame budgets by limiting element counts.
  - *Applies:* stress-driven fracture on a coarse simulation mesh with render geometry embedded in
    it. That is our chunk/bond split, and it shows a real-time stress-based approach is shippable.
- **NVIDIA Blast** (successor to APEX Destruction).
  - APEX damaged by radius and impulse.
  - Blast's stress extension (`NvBlastExtStressSolver`) runs a fixed iteration budget per frame on
    the support graph and accumulates damage over frames. Our static solve descends from it.
  - *Applies:* the iteration-budget-per-frame model works for static loads, but it has no inertia
    and no plasticity, which is exactly what the handoff analysis found.
- **Havok Destruction; Frostbite / Battlefield ("Destruction 2.0/3.0").**
  - Authored fracture states and breakable connections on a support graph.
  - Collapse follows when supports are lost.
  - *Applies:* the support-graph idea only. Failure is by health and authoring, not stress.
- **Teardown (Tuxedo Labs, 2020).**
  - Voxel damage carved by impact energy and radius.
  - Structural "integrity" is connectivity: disconnected voxel islands fall.
  - *Applies:* it shows how much players accept from connectivity alone. Not physics; rejected
    under our rules.
- **Müller, Chentanez & Kim, "Real time dynamic fracture with volumetric approximate convex
  decompositions" (SIGGRAPH 2013).**
  - A pre-authored fracture pattern aligned at the impact point; real time.
  - *Applies:* the impact-centred, local response is what players read as right, but its pattern
    is geometric (candidate G).
- **Glondu, Marchal & Dumont, "Real-time simulation of brittle fracture using modal analysis"
  (IEEE TVCG 2013).**
  - Contact stresses from a precomputed modal basis over a short impact duration.
  - *Applies:* the impact as a short-duration dynamic event. But the basis is invalid after the
    first break (candidate F).
- **Hahn & Wojtan (boundary-element brittle fracture, SIGGRAPH 2015/2016); Koschier et al.
  (adaptive and XFEM cutting, SCA 2014, SIGGRAPH 2017).** High-quality crack geometry; offline or
  near-interactive. Not applicable at our budget.

**Constraint-based and particle methods:**
- **XPBD (Macklin, Müller & Chentanez, MIG 2016); "Small steps in physics simulation" (Macklin et
  al., SCA 2019).**
  - Compliant constraints with force λ/Δt².
  - Many substeps with one iteration each beat many iterations.
  - *Applies:* candidate B. It is the fallback if CFL substeps are too many for stiff small parts.
    The "small steps" result is the same conclusion as A: resolve time, not iterations.
- **Peridynamics (Silling, JMPS 2000; Silling & Askari 2005); "A peridynamic perspective on
  spring-mass fracture" (Levine et al., SCA 2014); projective peridynamics (He et al., TVCG
  2018).**
  - Bond-based fracture by explicit integration, with critical stretch.
  - *Applies:* it confirms that explicit integration with per-bond breaking is a consistent
    fracture model. Our RBSM bonds are richer, with rotations, sections and capacity cones.

**Engineering methods:**
- **RBSM (Kawai, Nucl. Eng. Des. 1978); spring networks and lattices for concrete (Schlangen & van
  Mier 1992; Bolander & Saito 1998); DEM (Cundall & Strack 1979); masonry DEM (Lemos 2007,
  3DEC/UDEC).**
  - The engineering standard for impact and blast on concrete and masonry is explicit time
    integration of exactly this kind of rigid-block / spring model.
  - Static and quasi-static results come out of the same explicit code with damping and mass
    scaling.
  - *Applies:* A is the textbook method for our model class. It is what an engineer would run.
- **Selective mass scaling (Olovsson, Simonsson & Unosson, IJNME 2005); subcycling (Belytschko et
  al. 1979); asynchronous variational integrators (Lew et al. 2003).** The standard remedies when
  a few stiff, light DOFs set the explicit step. Not needed here: no node exceeded the
  translational bound.
- **Absorbing boundaries (Lysmer & Kuhlemeyer, 1969).** Tested above; unnecessary at 3 m.
- **Nonsmooth contact (Moreau 1988; Jean 1999).** The velocity-level inelastic impulse used for the
  contacts. It has no penalty stiffness to choose.
- **GPU explicit dynamics (Taylor, Cheng & Ourselin, IEEE TMI 2008; Joldes, Wittek & Miller,
  CMAME 2010).**
  - Explicit nonlinear FEM on the GPU in real time for meshes of order 10⁴ elements, with about
    an order of magnitude over the CPU.
  - Our patches are 10²-10³ bodies.
- **EN 1991-1-7 Annex C.** The hard-impact force F = v√(km) behind the routing rule in §1.

## 6. Implementation plan

Each step has a measurable checkpoint. Steps 1-2 come first because they fix the far damage for
every impact model, E included.

| # | Step | Checkpoint |
|---|---|---|
| 1 | **Confirm the source of the far damage in the lab.** Run the cannonball, meteor and truck with `PX_DESTRUCTION_IMPACT_LOG` (the breaks-by-source counter, PhysX `21d447f04`) | static-verdict breaks are at least 90% of the scene's total (expected from step 4: 1,439 of 1,480) |
| 2 | **Ductile yield in the static verdict.** Persistent per-bond secant scale and slip; brittle joints unchanged; behind a flag, then default. **Contact routing** by v√(k m_eff) against capacity, every tick | offline (`--handoff`): +≤ 20 breaks after E's and the explicit damage, none beyond 4 m (today: +14 and +6). Lab: total breaks within 2x of the impact model's own; frame bonds ≥ 90% anchored; roof holds. The rest stability gates unchanged (intact house yields nothing) |
| 3 | **`impactExplicit` kernel** (§4), method 2 of `PxDestructionStressDesc::impactStep`, with the cannonball island replay as its unit test | replay vs `explicit-step.py --fp32`: broken set Jaccard ≥ 0.9, impactor Δp within 1%; **≤ 2 ms per impact including setup (stretch 1 ms); every dispatch < 100 ms** (CuMetal commit log) |
| 4 | **Patch growth and batching.** Truncation test (no break within one hop of the boundary, else grow up to the cap); all of a tick's impacts in one launch; overlapping patches merged | 8 simultaneous impacts in one dispatch ≤ 2 ms total; patch result vs full island Jaccard ≥ 0.9 |
| 5 | **Dumps for the meteor and the truck** (GPU replay, `IMPACT_DUMP`), and the harness run on them | meteor: local hole, roof bonds ≥ 80% held (E: 79-88%); truck: see step 6 |
| 6 | **Swept contacts in the window.** The impactor's path during the tick tested against patch chunks in-kernel, so a ball crosses the wall within a tick. The truck as a body with its own crush (contact force from its own bonds, or the EN crush spring until it is a patch member) | cannonball and meteor through with local holes; truck through the wall and slowed by the energy it spends (Δv consistent with Σ capacity × slip); energy dissipative |
| 7 | **Lab acceptance and perf suite.** Vehicle testbed (house-A scenes) and the city bench with destruction on | the owner's criteria: local damage, through, frame and roof hold; impact cost ≤ 2 ms per tick in `perf/SUITE.md` terms; no dispatch over 100 ms |

Notes on the plan:
- **The step does not touch the fracture correction.** It runs in the trial pass, and its verdict
  stands for its islands in the single corrected pass (`internalCorrectionLimit` 1, unchanged; see
  §1).
- **The event ramp B stays** as the oracle beside E. A remains the runtime path.
- **The static solve's 64-iteration cap is untouched.** Step 2 changes only what the verdict does
  with an over-capacity ductile joint.

## 7. Risks and open questions

- **CFL on stiffer or smaller parts.**
  - The stable Δt is about chunk size / wave speed: here 64-71 µs (brick and timber chunks of
    about 0.3 m).
  - Steel parts of 5 cm (c ≈ 5 km/s) would need about 10 µs, so about 1,700 substeps per tick.
  - Mitigations, in order:
    1. the window can end once the contact is over and no bond is within its band of capacity
       (here 2 ms holds 54 of the 65 breaks; the rest is dead-load settling the static verdict
       repeats);
    2. selective rotational mass scaling;
    3. XPBD substeps for that patch (candidate B).

  Measure on the vehicle dumps before choosing.
- **Contact law.**
  - Rigid inelastic contact pushes the struck bricks at the ball's speed (Δp 1,091 N·s). E's
    dilating cone lets the ball slide past attached bricks (147 N·s).
  - The step should follow the physical target, which is the owner's call. The step itself does
    not depend on it.
- **One capture.** Every number here is the cannonball's first contact tick. The meteor and the
  truck need dumps (step 5).
- **Within-window debris collisions.** Within a tick, freed chunks do not collide with their
  neighbours; PhysX resolves that next tick. The same holds for every impact model so far.
- **Not measured on the GPU.** The ms figures are operation-count estimates. Checkpoint 3 is the
  first measurement.

## 8. Two-body impacts: a destructible car in the window (2026-10-08)

**Problem.** A car's joints were graded in the trial pass against struck chunks that are still
anchored, so they saw a dead stop. The corrected pass then freed the chunks and gave the car far
less Δv. Grading the car only on the corrected pass is forbidden (it would defer its splits past
the corrected re-simulation).
- Detector: `physx-bridge/tests/vehicle_contact_load.rs` compares the load a car is graded on with
  m|Δv|/dt.
  - Breakable wall: 1,227 kN graded against 791 kN (1.55x).
  - Lab monster truck, first contact: 42.7 MN graded against 0.58 MN.
  - Lab, per chunk: grille −21 MN and bumper +17 MN, which are not momentum exchanges.
- First-contact penetration is not the cause:
  - the car starts its first contact tick 0.26 m into the wall in the fixture, 0.21 m in the lab;
  - a contact offset ≥ v·dt finds the wall before the car penetrates, and still grades 1,226.6 kN (fixture) and 107.7 MN (lab).
- Speculative CCD on the car fails the stage (FIDELITY_AUDIT H7).

**Model** (harness `scripts/impact/two-body.py`, law `scripts/impact/contact_law.py`):
- **Patch:** both bodies' bond graphs. The car's island joins the struck patch as nodes, moving
  with its rigid motion at the tick's start, and its joints as links rotated into the struck frame.
- **Rows between the bodies are compliant:**
  - Johnson's flat punch, k = 2aE*, with 1/E* = 1/E_a + 1/E_b. Each chunk's E is recovered from its own
    joints, E = kL/A. Poisson's ratio is left out (≤ 10% on k).
  - a = min(face, max(σ, √(R d))), where σ is the patch points' spread, R is Hertz's relative curvature
    1/R = 1/R_a + 1/R_b (a rigid impactor's R_b = √(5I/2m)), and face is the smaller chunk's.
  - The force is the integral of that tangent stiffness: a flat patch, then Hertz, then the face's punch.
    A single-point contact therefore follows Hertz.
  - Each row has a gap and is integrated by backward Euler. Coulomb friction is the stick impulse,
    clipped.
- **Hybrid car joints:**
  - A car joint stays explicit where its own split-mass frequency satisfies ω_j·h ≤ 1.8.
  - Stiffer car joints are trapezoidal-implicit (A = (I + h²/2 K W̃)⁻¹hK, block Jacobi with split
    masses, two sweeps).
  - The struck structure stays explicit, with its own bound.
- **Step:** h = min(explicit bound, √(3ε m/k) over the compliant rows, 50 µs). This is backward
  Euler's period error (ωh)²/3 on the shortest contact τ = π√(m/k), with ε = 0.1.

**Why not cheaper schemes.** Steel sets the CFL limit: the monster's ω_max is 3.6e5 rad/s, so
h = 5 µs and 3,336 substeps a tick. Against that explicit reference (h 5 and 2.5 µs, compliant rows):

| Scheme | Substeps/tick | Verdict |
|---|---|---|
| Selective mass scaling, M + B diag(μ) Bᵀ (Olovsson 2005) | 278-926 | Accurate at 1e5 rad/s, but 8-31 PCG iterations a solve, each about one GPU phase: no saving |
| Struck region plus a rigid remainder | — | Steel's c·dt = 86 m ≫ 4.3 m: the region is the whole car |
| Rigid (Moreau) rows | — | Every coarse scheme depends on h (car Δv 1.3 → 2.7 m/s over 5 → 140 µs): contact time set by the light parts' hop time. Compliant rows converge |
| Plain trapezoidal Jacobi | — | Gained energy at small h (+3.6%, +7%). The hybrid fixed it |
| Hybrid, trapezoidal, 2 sweeps (chosen) | 733-753 at ε 0.1 | — |

**ε and the scheme's known error.** Sweep of ε from 0.02 to 1 against the reference's spread over
h = 2.5-5 µs (6 runs):

| Case | Reference: dv / broken / yielded | Hybrid, ε 0.02 → 1: dv / broken / yielded | Energy closure |
|---|---|---|---|
| Wall 21.7 m/s, real joints | 2.58-2.59 / 49 / 368-372 | 2.55 → 2.46 / 43-48 / 380 → 342 | +0.8% → −1.9% |
| Wall 10 m/s, real joints | 0.80-0.81 / 38-39 / 74-80 | 0.82-0.87 / 29-33 / 55-75 | |
| Wall 21.7 m/s, default brittle joints | dv 1.90-1.96, broken 169-196 | dv 1.87-2.15, broken 154-169 | |
| Wall 10 m/s, default brittle joints | dv 0.86-0.94, broken 100-109 | dv 0.77-1.24, broken 77-86 | |

- No ε lands inside the reference's spread on every measure.
- The gap comes from the implicit joints filtering the highest-frequency transients, not from ε.
- **Known error of the scheme:** broken joints −5 to −25%, yielded 0 to −25%, car Δv within 1-5%.
- ε = 0.1 is a cost choice. Energy closes within 1% there, and the vehicle gates (wheels, the
  cannonball shredding, energy) decide.

**Hertz check** (`contact_law.py`, 10 kg steel sphere, R 0.1 m, 1 m/s onto rigid steel), against
Hertz's closed form:

| ε | Contact time | F_max |
|---|---|---|
| 0.1 | +8.7% | −24% |
| 0.02 | +3.3% | −15% |
| 0.005 | +0.2% | −9% |

The F_max deficit is backward Euler's numerical damping.

**GPU** (PhysX `feat/two-body-impact`, `PX_DESTRUCTION_IMPACT_TWO_BODY`, `PX_DESTRUCTION_IMPACT_COMPLIANT_ROWS`):
- **ContactRow v3:** `other`, `otherPose`, `patch`.
- **Car rows:** a car row goes to the window when either side is an impact: the routing's
  struck-side test, or the same test mirrored on the car's chunk, v_n√(k_c m_c) against its weakest
  joint. Without the mirror test, a car scraping frozen debris opened about 950 extra windows.
- **Hand-off records for the corrected pass:** end velocities and the rows the window decided.
- **The stress report** carries the window's loads on the car's chunks.
- **Flags off:** bit-identical (IMPACT_HASH).
- **Parity** (`destruction_gpu_two_body_*`, against `two-body.py --export`):

  | Case | Jaccard | Car Δv |
  |---|---|---|
  | Truck, 21.7 m/s, real joints | 1.000 | +0.25% |
  | Truck, 10 m/s | 0.973 | 3.9% (tolerance 9%: the case's own h-spread) |
  | Hertz | — | exact |

- **Cost:** 40 ms on the 992-joint truck window, clock held. The implicit sweeps are 70% of it.
  This is the first optimisation target.
- **Cannonball into a truck:** the derivation picks h ≈ 3 µs (16 µs steel-on-steel contacts on 2 kg
  parts), about 6,000 substeps a tick, 60-95 ms in resumable dispatches.
  - Accepted for now.
  - It is the extreme mass-ratio case for a multi-rate scheme later. Power-of-two AVI levels
    resonated (ρ − 1 up to 0.61 per period: the multi-rate agent, scripts/impact/multirate.py), so
    a stable node-partitioned scheme (Gravouil-Combescure) is the candidate.

**Lab** (monster truck, high profile, real joints and static-ductile steel, 3 repeats each):

| Trial | Two-body off: car bonds broken / wheels lost | Two-body on: car bonds broken / wheels lost |
|---|---|---|
| Wall, 21.7 m/s | 724-729 / 4 | 159-245 / 4 |
| Wall, 10.9 m/s | 270-287 / 4 | 165-376 / 4 |
| Framed house | 728-733 / 4 | 567-689 / 4 |
| Debris on a wheel | 115-146 / 2 | 119 / 2 (after the mirrored test) |
| Cannonball into the truck | 689-690 / 4 (shredded) | 674-693 / 4 (shredded) |

- First contact, graded/measured: 54x and 137x without two-body; 0.1-1.7 with it.
- `vehicle_contact_load`: the main hit is 0.80. One tick fails at 1.19. Stage and static walls are 1.00.

**Wheel loss** (full audit, `VIBE_TESTBED_AUDIT_MAX`) has three causes, and the corrected pass is
behind all three:
1. Rear wishbones break in the impact tick's corrected pass. It grades the car statically against
   its rigid 1.2-3.6 MN stop, where the window gave 0.74-0.82 MN. The harness breaks no suspension
   joint.
2. After the breach, quasi-static contacts with the wall's remains are graded by the static verdict.
3. A rear wheel's suspension-limit row at the wall stump carries 753 kN. The hubs break in the trial,
   and the corrected pass then detaches them (182 kN measured). A kerb test shows the limit row is
   momentum-consistent when nothing breaks (633 kN graded, 633 kN measured).

**Open:**
- **Corrected-pass hand-off** (impact-compliant agent): the window's end velocities as its start;
  pairs the window decided kept out of its rigid solve; the window's verdict standing for its
  islands, the car's included.
- **Then, if rear-wheel loss at the stump persists:** a tyre-bounded Vehicle2 limit row (maxImpulse
  from the pneumatic sidewall force, 148 kN for the monster: 1.6 bar, Monster Jam / BKT) together
  with the rim as a compliant row in the window. Never one without the other.
- **Then:** turn on `VIBE_REAL_VEHICLE_JOINTS` and `PX_DESTRUCTION_STATIC_DUCTILE` in high.env.

**Codegen lesson: new paths go in separate branches.** Metal codegen can round an algebraically
exact no-op differently. Two-body rows subtract an open gap from the normal rate, `g[0] -= gap/h`.
With the flags off gap is 0, so the subtraction is exact. Merged into every rigid row's path, it
still changed cannon-first's `IMPACT_HASH` (ce3e69550d6e675d to b79c17d2a00b01e0). 656 of 8,961
bond forces moved, by at most 1e-5 relative, and no verdict changed. Putting it behind
`if(gap > 0)` did not restore the hash, since the compiler if-converts it. Only a separate branch,
with the rigid row's original lines untouched, did (PhysX 6c7e35e07). A flags-off change must leave
existing arithmetic textually unchanged. Check it with `IMPACT_HASH` on a replay, and with
`scripts/ops/kernel-identity.sh` per kernel. A bisect must include every commit: the first one
skipped here put the blame on the wrong commit.
