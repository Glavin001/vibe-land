# Review notes

This kit remains **WIP, not ready for `/city` integration**. All implementation and generated evidence are isolated here. No engine, main client entry point, city scene, shared configuration or running shared service was changed. No assets have been staged as accepted.

## Current measured revision

Asset SHA-256: `4d0805d3358a2cfe39e713c84da02dcc49ae456dad8dc1d6c2bb934c3f2f92c2`.

The furnished three-storey café has 6,911 chunks, continuous stairs, real floor openings, open doors, a guarded top-floor landing and 24 saved building cameras. Source/dependency hashes, SDK libraries, hardware and solver settings accompany each review. Timing measurements explicitly allow competing GPU work.

- **66/66 matrix checks pass.** Every reusable prop passes intact gravity and impact breakage. All 12 building variants, four furnishing/fence combinations and repeated quarter-turn placements pass their required checks.
- **32/32 intact pose audits pass.** Observed solver convergence and physical rest persist for 30 simulated seconds at 9.81 m/s², with zero spontaneous bond breaks or crushing. Furniture remains upright and near its authored placement.
- Actual capsule traversal passes for both floor counts and mirrored layouts, as well as the furnished default. Routes include rooms, both stair flights, landings, courtyard gate and exits, without teleporting, flying or jumping.
- The default also passes glazing/trim, furniture and fence damage. Wall impact and full collapse still fail the final rest/convergence gate.
- Eight authoring/artifact tests pass, including all structural variants, projectile-origin clearance, collider equivalence and compressed-recording integrity.

See `out/reviews/readiness.json`, `matrix.json`, `rest-audit.json` and the individual native reports. A passing matrix does not override a failed default destruction case. The staging command was checked and correctly refuses the wall failure; the staging directory contains no accepted assets.

## Repairs in this iteration

Counter and bathtub chunks now use geometrically identical eight-corner convex hulls. Their masses, material strengths, fragmentation, joints, impact inputs and gravity are unchanged. The counter impact breaks 25 bonds; the bathtub impact breaks 7. Both return to observed solver convergence and physical rest. Other props retain their previously passing collider representations. Paired box/hull reproductions are preserved in [repros/collider-contact](repros/collider-contact/).

Three collapse projectile origins intersected the intact partition/stairs. They now start in clear space. A conservative sphere/bounds check covers every shot across all 12 structural variants. The corrected sequence now drops all 3,058 tested upper architectural chunks and all 24 tested upper-table fragments; it remains a failed settling case, not an accepted collapse demonstration.

Native recordings and review/revision snapshots are written losslessly compressed. All acceptance hashes cover logical decompressed JSON bytes; missing or corrupt archives fail. The preview, screenshots, pose audit, videos and staging checks read this format. Old uncompressed evidence remains supported.

The preview adds “Frame fragments” and “Track fragments.” Prop damage screenshots frame the actual final debris, and videos can follow its mass centre without changing simulation poses. This matters for the bathtub impact, which carries the broken assembly roughly 63 m from its starting point. Multiple settled-fragment views and a tracked native replay were inspected. Video cache copies are removed only after matching their saved output hashes.

## Remaining failures

**Wall impact:** 365 bonds break, but the solver remains unconverged for 3,597 of 3,600 damage ticks. At second 59, 20 bodies remain awake. No chunk is below the ground; the lowest chunk centre is a buried foundation at -0.25 m. This gate fails despite small recorded rubble motions.

**Support-loss collapse:** 10,989 bonds break, all 3,058 tested upper construction chunks drop more than 1 m, and 24 upstairs table fragments fall with their floors. The solver remains unconverged for 3,594 of 3,600 damage ticks; 3,594 bodies are awake at second 59. No chunk is below the ground. The current multi-angle views and `collapse-failed.webm` visibly retain a failure label.

Both cases begin from a passing intact equilibrium. A timeout, rejected step, missing observation or unconverged solver is a failure. No body is frozen, forced asleep or parked below the world; gravity and destruction remain active.

## Rejected experiments

A broad conversion to suitable convex hulls made one wall case converge but regressed several other prop impacts and caused native topology rejections in some two-storey checks. Its matrix passed only 57/66, so it was not retained. Converting every box also produced GPU-incompatible slender-hull warnings and native crashes. The SDK's convex cooking extent/radius limit is respected by the retained small-prop conversion.

An architecture-only convex comparison, keeping most original prop shapes, also produced a complete collapse but did not settle. Rebuilding contact pairs every frame did not resolve that failure. Higher solver budgets from startup caused spontaneous furniture fractures and were rejected. The existing bridge does not permit reconfiguring its native stage after equilibrium, so an attempted post-equilibrium budget diagnostic was removed rather than exposed as a working option.

These experiments are evidence, not a proven root cause in a particular SDK function. They remain in `out/reviews/diag-*`, the review history, and `convex-global-matrix.json`. Completed diagnostic input packs may be stored as `.json.gz`; restore the uncompressed input before rerunning a native diagnostic. Standard current exports and portable reproduction inputs remain plain ScenePack v2 JSON.

## Visual and physical acceptance

Exterior, interior, stairs, repaired-prop debris, native walkthrough and current collapse views have been inspected. Room finishes and furnishings remain deliberately simple WIP; no finished visual acceptance is granted. `out/reviews/visual-acceptance.json` stays false.

The native bridge currently applies a default bulk material to chunk crushing while accepting authored per-bond materials. See [MATERIALS.md](MATERIALS.md) for the inherited interface limit and engineering approximations. Further settling/contact investigation and visual iteration are still required before this kit can be staged for the later `/city` task.

## Contact accuracy diagnostics and storage recovery

The café still has no release approval. Contact iterations 16/4 and 32/8 each produced passing local wall damage; the 16/4 full collapse did not settle. Combining larger contact budgets with stress budgets 32 or 64 caused initial spontaneous bond breaks and failed intact acceptance. A 2 mm contact generation margin with 16/4 contact iterations passed the wall case but failed full-collapse rest: 13,132 broken bonds, all 3,058 tested upper architectural chunks fallen, 24 upper table chunks fallen, and approximately 5,199 awake bodies at the recording end. Median residual linear speed was 0.0125 m/s; the maximum was 0.2084 m/s. None of the final body centres were below -0.5 m. This is measured residual motion, not an accepted rest state.

The 5 mm diagnostic was interrupted while compressing its recording because the shared disk filled; its report correctly records failure/interruption. Its incomplete 36 MiB `.tmp` was removed only after verifying that no town-kit native job remained. The rerun completed after space recovery and failed: 3,122 bonds broke, but no tested upper architecture or upper table chunks fell; 519 bodies were awake at the 59-second sample. Neither contact-margin diagnostic is accepted. Completed large historical recordings were previously compressed losslessly to Brotli with logical SHA-256 checks; plain JSON, gzip and Brotli readers preserve the same acceptance hashes.

Reusable opening-aware envelope helpers were extracted to `src/parts/envelope.mjs`; all 16 tested café configurations retained byte-identical geometry and authoring metadata. The requested three additional buildings are specified in `EXPANSION.md`, after café acceptance.

The high rigid-contact budget diagnostic (128 position / 32 velocity iterations, 2 mm margin, stress budget unchanged at 16) also failed full-collapse rest: 12,609 bond breaks, 3,058 upper architectural chunks and 24 table chunks fallen, 4,533 final awake bodies after 60 seconds. Raising the contact iteration budget alone is not a solution. The harness now reports the actual final awake-body count rather than leaving the intact-stage count in that field.

The independent viewer now renders glass with front faces, no depth writes, and reduced reflection intensity. Four saved-angle captures in `out/reviews/diag-glass-review-visual/` were inspected; the façade now shows the rooms through the glazing more clearly. All captures completed without rendering errors. Interior wood grain and plaster still need finish work; this is a visual improvement, not visual acceptance.

The unfurnished shell passed intact equilibrium at stress budget 64 with contact iterations 16/4, then failed full-collapse rest: 10,875 broken bonds, all 3,058 tested upper architectural chunks fallen, 3,658 bodies awake at 60 seconds. This rules out loose furniture as the sole cause. A portable, hash-verified shell-only reproduction and provenance are saved in `repros/rubble-settling/`; no shared SDK or bridge source was modified. Staging was rechecked and still rejects the default wall result.

## Three additional buildings

The user authorized proceeding with the other buildings while the café remains in review. New separate builders implement the furnished porch house, brick grocery/flat and workshop/loft. Common parts include foundations, opening-aware envelopes, stairs, guardrails, roofs, room metadata and prop attachment. The café builder and main application entry points were not changed by this expansion.

First review iteration: all three intact states passed native gravity/convergence/30-second idle checks. Grocery and workshop capsule routes passed; the house's reverse route encountered its dining table and was corrected through a clear aisle. A narrow grocery landing passage was widened by moving the bathroom wall. Geometry checks reject all overlaps and disconnected architecture; all normal/mirrored, furnished/empty variants passed. Physical lettering remains readable when mirrored. Gable apex gaps were closed and roof ceilings identified for cutaway preview.

Initial high-power grocery/workshop glazing scenarios caused broad structural damage. Separate calibrated copies retained the exact asset/materials/gravity and strict gates: grocery glazing at 20,000 Ns passed with four broken bonds (three incident to glazing); workshop glazing at 50,000 Ns passed with two target bonds; workshop local wall impact at 20,000 Ns passed with two target bonds. The lower 500 Ns glazing diagnostics correctly failed because they broke nothing. These local test inputs are separate from unchanged severe support-loss collapse inputs. Final candidates are being re-reviewed; read `town-review.json` and `town-variant-review.json` for measured current-hash outcomes, not these historical notes.


### Current expanded-kit acceptance (September 20)

All three additional buildings are implemented as independent ScenePack v2
exports. Current authoring tests: **10/10 pass**. All base and mirrored furnished
capsule routes pass, visiting rooms, stairs, landings and exits without jumping
or teleporting. The base/mirror/repeated-rotation intact pose audits pass
**9/9**, after native convergence and 30 seconds of idle under normal gravity.

The current native inventory is **21/31 gates passed**, not release approval.
`out/reviews/town-status.json` checks current asset and metadata hashes. The
stricter wall gate rejects all six base/reuse wall cases: all 30 rays through
the proposed doorway opening remain blocked. The earlier small numerical
bond-break passes were insufficient and are superseded. Stronger diagnostic
wall shots caused larger damage but failed post-damage convergence/rest.

Grocery and workshop severe support loss drops upper construction and
furnishings but does not settle/converge within the 60-second damaged-state
window. The porch house's original deck could escape below ground in collapse;
a geometrically identical convex collider did not fix it. A 60 mm under-deck
clearance does prevent that escape in both diagnostic and final runs: minimum
chunk centre Y is -0.225 m (buried foundations), with zero chunks below -1 m.
The improved house still fails severe support-loss acceptance because its
upper furniture remains supported and damage does not converge. The current
4,000 Ns assembled-fence shot breaks nothing; that scenario also remains failed.
These are retained failures, with no freezing, suppressed gravity, or discarded
recordings.

Repeated-instance impacts leave the protected copy intact: zero broken bonds,
maximum movement below 0.000007 m for all three. Their wall-opening gates still
fail independently. `stage-town.mjs` rejects the house wall gate and writes no
accepted town assets. Actual-image approval files remain `accepted: false`.

Final captures use the same 1600 x 1000 viewport and saved cameras. Walkthrough
and destruction videos derive from measured native poses; failed destruction
videos and screenshots carry visible failure labels. See `town-captures.json`
for capture completion/errors. Capture and native review share an exclusive
kit-owned GPU-work lock. The main application, `/city`, SDK and bridge are
read-only dependencies throughout this expansion.


Fence calibration follow-up: on an unchanged furnished house, a separate
20,000 Ns impact broke eight fence bonds and reached converged physical rest.
That input replaces the earlier 4,000 Ns shot, which correctly failed because
it broke nothing. No material strength, gravity, sleep setting, or geometry
changed. House and mirrored-house evidence is refreshed after adoption;
`town-status.json` remains the authoritative current inventory.

The final capture workflow completed **24/24 jobs without rendering errors**:
all saved intact views for six normal/mirrored buildings, four damage-view sets
per base building, three native capsule walkthrough videos and three visibly
labelled failed-collapse videos. Actual contact sheets and representative
walkthrough frames were inspected. The house receives an additional refreshed
fence capture after calibration. Exterior gallery: `town-buildings-current.jpg`;
interiors: `town-interiors-current.jpg`; measured damage: `town-damage-review.jpg`.
Material finish remains a visual blocker, especially repetitive interior timber.


After adopting the fence calibration, all refreshed house and mirrored-house
intact/walking checks pass, and the upright pose audit remains **9/9**. The
current native inventory is **22/31 gates passed**: the remaining failures are
the three base collapse cases and six base/repeated-instance wall breaches.
Fencing, glazing and furniture damage pass on the base buildings. No asset is
staged while these failures and the material-finish review remain unresolved.


Final evidence audit: **25/25 checks pass** across current saved-camera images,
local-damage/collapse image sets, fence closeup, and all six native-derived
videos. Hash checks include metadata and source recordings, with native failure
labels preserved. The calibrated fence panel is visibly broken and resting on
the ground. The final full authoring suite remains **10/10**. Explicit workshop
palette choices now work; the reviewed default red workshop is byte-identical.
Staging was retested and still refuses the failed house wall-opening gate.


## Wall traversal and reduced solver reproduction

A 64-chunk wall section isolated the impact problem. Repeated contacts can
remove the wall and settle, but a perfectly empty ray rectangle wrongly treats
low, walkable rubble as an unusable opening. The harness now retains those ray
measurements and independently drives the actual gameplay capsule across the
breach. It requires 2.1 m headroom throughout, no jumping/teleporting, no new
structural breakage from walking, and another 60 converged, physically resting
ticks after crossing. Negative tests still block the intact grocery wall.

The workshop now passes the complete native wall-breach gate, including actual
capsule traversal, on both its furnished base and rotated reuse pair. The
protected instance remains intact. Its normal/mirrored walking and intact
checks pass, as does the nine-case pose audit. The current native inventory is
**24/31**, with four house/grocery base/reuse wall cases and all three full
collapse cases still unresolved. The six-shot workshop input is now authored
through the reusable `breachShots` helper. Geometry, materials and masses did
not change. Low sphere shots that can clip the floor were identified in the
house/grocery diagnostics; corrected trials still failed post-damage rest.

The higher stress-iteration budget used by the native gameplay test is not a
safe workaround. The furnished grocery spontaneously breaks 147 bonds at its
first observed tick at 2048 iterations. Reduction reached a **14-chunk,
14-bond chair**: identical input bytes and harness binary, 16 iterations passes
intact gravity and 30-second idle; 2048 breaks eight bonds at tick one. That
failed tick is observed, unconverged, error zero and not degraded. The packaged
80 KB comparison in `repros/native-budget/` includes immutable hashed input,
settings, expected reports, SDK/library/source provenance and a rerun script.
The packaged script was itself run and reproduced both outcomes. This warrants
core-physics investigation; it does not yet establish the root cause.

Visual comparison: `out/reviews/finish-study/` contains identical-camera renders
at the original, intermediate and finer texture scales. The finer preset was
selected after inspecting the house, grocery and workshop exterior/interior
comparisons. It removes the oversized grain pattern and brings brick/plaster
surface detail closer to these buildings' scale. It uses only the existing
renderer tuning API in the private preview; later main-city integration must
explicitly adopt the preset. Captures now record its name and numeric settings.


Final follow-up checks: all **10 authoring tests**, **nine intact pose audits**,
and **26 capture/video consistency checks** pass. All **26 capture jobs**
completed without rendering errors at the reviewed finer preset. The workshop
wall video includes the impacts, settled opening, and actual capsule crossing;
its closeup and sampled video frames were inspected. No assets were staged,
because the remaining wall/collapse failures still block acceptance.

The 14-piece-chair discrepancy also reproduces with 32 m ground tiles instead
of the 10 km ground box: eight spontaneous breaks at tick one, so large ground
extent is not the sole cause. The control report/provenance is included in the
physics handoff. Another 31 MiB of completed history was compacted losslessly,
with decompressed-content hashes verified; no evidence was discarded.
