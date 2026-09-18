# Minas Tirith rebuild — status and TODO

Updated: 2026-09-18. The final scene has 64,213 chunks. The game server and its automatic restart supervisor were stopped at the user’s request after the successful September 13 checks; this checkpoint does not restart them. The user accepts the current physics for now and has authorized a focused stair/landing design fix. Broader realism and destruction work below remains deferred; the older physics evidence is historical.

## Completed — defensive perimeter and protected gateways

- [x] Closed the accidental front cutout in the two outer rings. The rock prow stops inside those rings and no longer removes their paving or wall.
- [x] Restored walls around bottom stair courts and replaced low outer stair guards with defensive walls following the tread/landing height (7 m on the outer ring, 3.8 m on the inner stair routes).
- [x] Preserved both stair routes and their intentional tier entrances. Added exported-hull checks for both full ascents, outer-wall coverage, all inner tier walls, and a missing-front-wall regression.
- [x] Replaced broad ground-level wall openings with four-metre gateways, 3.2 m of headroom, stone lintels and continuous battlements above them.
- [x] Final pack validation and all nine geometry checks passed (64,213 chunks). Saved front-perimeter, enclosed-city and stair-defences screenshots in `docs/structures/minas-tirith-rebuilt/`.
- [x] Loaded the final 64,213-chunk scene. Browser verification confirms WebTransport, the correct chunk count, no missing geometry or JavaScript errors, and successful public HTTPS verification.
- [x] Final live walking passed on both sides: ordinary server-authoritative movement through each protected gateway, all six flights and every tier entrance to the 54 m summit courtyard. No jumping or flying; no browser errors. Saved `docs/structures/minas-tirith-rebuilt/wall-walking-results.json`.

## Completed — connected stairs on both sides

- [x] Identified the missing landing: the last tread reached the upper tier, but the next angular section dropped to the lower street. Only one stair flight existed per tier, alternating sides.
- [x] Replaced that layout with two mirrored switchback routes, each containing six flights and broad flat landings. Upper landings align with the next tier's open entrance and lower landing.
- [x] Cleared houses and gatehouses out of the turns; added low destructible guards along exposed stair edges and landing ends.
- [x] Replaced paving that lost small fracture slivers with fully covering flagstones. Each flagstone contains two bonded, positive-mass chunks; no architectural surface is fixed.
- [x] Added exported-hull traversal checks: 7,109 samples per route, all seven tier heights reached, 0.25 m maximum rise, 0.8 m body clearance and 1.8 m headroom. Missing-landing and blocked-gate regressions are detected on both sides (six passing checks on the final exported pack).
- [x] Final geometry validation passed: 56,825 chunks, below the 65,536 limit. Deployed and verified 56,825 rendered chunks, WebTransport, one bootstrap, no missing chunks/hash mismatches or JavaScript errors; public HTTPS verification passed.
- [x] Captured final left/right landings and an overview of both routes.
- [x] Walked both routes with server-authoritative players: each passed the base, all six ascending flights and tier entrances, and the 54 m summit court using ordinary walking, without jumping or flight. No browser errors. Evidence: `docs/structures/minas-tirith-rebuilt/walking-results.json`.

Deployment uses `VIBE_DESTRUCTION_ASSET_DIR` pointing to a scene snapshot under `.certs/vast-city/aerial-20260913/scene`. Updated that active copy as well as the authored source, saved `minas-tirith-rebuilt.before-stairs.json`, and restarted only this checkout’s empty managed server. The checked public city is https://209.121.195.117:40613/city.

Authoring tests: `blast/blast-stress-solver/structures/tests/minas-routes.test.mjs` in the sibling repository. Live traversal: `client/tools/minas-route-walk.mjs`. Repeatable screenshot cameras: `docs/structures/minas-tirith-rebuilt/stair-cameras.json`.

## Agreed goal

Build an original, film-inspired seven-tier Minas Tirith in Vibe Land, roughly 240 metres across. Prioritize playable realism on a gaming GPU, connected streets and ramparts, and key interiors. All architecture, including roads, roofs, gates and citadel, must be destructible; natural mountain and ground remain fixed. Preserve the original scene for comparison.

## Completed

- [x] Located the existing `destruction/assets/scenes/minas-tirith.json` and researched scene authoring, rendering, physics, launch and capture workflows.
- [x] Read the repository’s `vastai-deploy`, `city-stack-run`, `city-physics-tuning` and `diagnose-structure-failure` skills. Reviewed Wētā image references: https://www.wetanz.com/us/minas-tirith.
- [x] Created an independent `minas-tirith-rebuilt.mjs` generator in the sibling authoring repository and registered it as an opt-in build target.
- [x] Authored seven terraces, breakable paving, ramparts and merlons, stair routes between tiers, houses with door/window gaps, gatehouses, Hall of Kings, a hollow staged tower, spire and natural rock prow.
- [x] Separated fixed foundation/rock pieces from construction with positive mass. Added a structural assertion against permanently fixed architecture.
- [x] Added a flagstone fracture/material profile and an early guard for the runtime’s 65,536-node-per-structure limit.
- [x] Generated an earlier physics-audit pack: **64,734 nodes, 238,714 bonds, 15 materials, approximately 79.59 MB JSON**. The final wall/gateway pack above supersedes this geometry. Exported it into both repositories.
- [x] Passed the current generator’s geometry validation, including collider overlap checks and paths to support. Static load warnings remain; this is not a dynamic stability pass.
- [x] Added procedural limestone, slate and timber texture layers and a repeatable bake script. Existing texture indices 0–11 are preserved; the new layers are excluded from the default building-material hash.
- [x] Updated preview material lookup to prefer the same per-node material index as the live renderer. Updated top-surface texture selection for the new materials.
- [x] Added an `--origin` option to the static screenshot tool and captured baseline and intermediate rebuilt views.
- [x] Built the GPU destruction server and client. Added the scene to authored-pack tests and created a focused stability/gameplay-damage test.

## Acceptance criterion — revised by user

Success is a state transition, not survival for a duration:

1. The solver explicitly reports convergence for every live structure.
2. No bonds remain overloaded or accumulating damage, no nodes remain at crush yield, and no dynamic bodies remain awake.
3. All solver groups are skipped. Across an actual idle update, cumulative active-island work, broken-bond count and topology stay unchanged.
4. A gameplay shot invalidates the cached solve, resumes structural work and causes damage.
5. The damaged structure returns to stable, inactive equilibrium.

`MINAS_MAX_UPDATES` is only a failure bound for non-convergence. There is no minimum quiet duration or 20-minute success threshold. Numerical convergence alone is insufficient: a converged overloaded structure must fail the gate.

- [x] Added explicit convergence and cumulative active-island-update diagnostics to the native adapter and existing named-span channel; no new manifest or network message schema.
- [x] Replaced the Minas timed test with converge → skip → disturb → resettle checks.
- [x] Added pure-Rust regression tests that reject missing/invalid telemetry, unconverged or overloaded states, pending crush, awake bodies, topology changes and continued idle computation. Six tests pass; the native GPU gate compiles, but has not been executed against the live scene.
- [ ] Execute the new native gate with exclusive GPU access. It is deliberately opt-in (`--ignored --test-threads=1`) to avoid competing with the running city. The old scene failures below are historical and have not been cleared by changing the test.

## Test results and unresolved failures

| Check | Result |
| --- | --- |
| Current pack geometry validation | Passed; no collider interpenetration or unsupported pieces reported |
| Earlier, less-dense draft: 30 simulated seconds at rest | Passed with zero broken bonds |
| Earlier draft: gameplay shots into six architectural categories | Passed; 778 bonds broken after the sequence |
| Current pack: requested 20-minute simulated soak | **Historical failure after 6 seconds: 3 spontaneous broken bonds**; the old full soak did not complete and has now been replaced by state-based acceptance |
| Current pack: structural audit | Failed intact/stability verdict; small joints identified among reported failures |
| Existing original scene: current 30-second idle baseline | Zero spontaneous breaks observed; historical collapse was not reproduced in this short run |
| Original-scene run of the new combined test | Later failed because the old scene lacks a new architectural role; the test was amended to return after its baseline idle phase, but that amendment has not been rerun against the old scene |
| Authored parser/manifest test command without physics features | Failed to compile an existing `structure-audit` binary whose imports require `physx`; rerun with the appropriate features |
| Deployment | **Not verified playable**; first encountered another checkout’s ports, then failed startup with an incompatible saved Direct GPU setting |
| Captures | Static intermediate images exist; browser reported `Unexpected identifier 'a'`, still unexplained |
| Performance and full demolition | Not validated |

The audit reported small contacts around road/pier, wall/wall, pier/cornice, parapet/merlon and lintel/cornice joints, roughly 0.017–0.050 m². Its inferred list of disappeared stress rows is not a precise one-to-one list of the three broken bonds; reconcile it with authoritative break events before assigning causality.

A proposed change to give pale limestone the existing structural-stone mechanics **was rejected/interrupted and was not applied**. Current generator source still changes the white material’s appearance only. Do not assume the stronger profile exists or is the correct fix.

## TODO — implementation and validation

### 1. Re-establish a safe working state

- [ ] Inspect current repository diffs and running processes; temporary previews or a failed deployment supervisor may still be alive. Process state has not been rechecked for this handoff.
- [ ] Discover current mapped ports and ownership. A `vibe-land-2` server occupied port 8384 during the work; do not stop or replace unrelated services.
- [ ] Preserve unrelated pre-existing edits to `AGENTS.md`, skills, `.gitignore`, deployment scripts and other documentation.
- [ ] Confirm the pack was generated from the current authoring sources before interpreting another test result.

### 2. Fix physical stability

- [ ] Reconcile failing bond IDs with actual chunk roles, contact geometry and break events. Check sliver contacts and load paths before changing strengths.
- [ ] Fix the demonstrated structural issue; do not mask it with fake bond areas, fixed architecture, or a relaxed zero-break assertion.
- [ ] Review the legacy white-stone strength profile versus structural stone. Any material change needs a documented physical rationale and a new damage test.
- [ ] Repeat geometry validation, then pass the explicit convergence/inactivity gate with zero spontaneous breaks in the pristine city. Demonstrate skipped work across an idle update and correct wake-up/resettling after damage; exhausting the update budget is failure.
- [ ] Resolve or measure PhysX warnings that oblong convex hulls fall back to CPU collision.
- [ ] Schedule GPU audits without a competing live city. The diagnosis skill explicitly says not to benchmark while `/city` is serving and to run GPU tests with one test thread.

### 3. Finish visual and exploration quality

- [ ] Improve the silhouette and architectural variety beyond concentric bands and repeated houses. **The current screenshots do not yet establish the requested hyper-realistic quality.**
- [ ] Refine roof shapes, natural rock, gate architecture, citadel detail and street-level materials against the references. Revalidate geometry after edits.
- [ ] Add/verify the planned arches and tunnels; the current draft mainly uses piers, rectangular openings and stepped roads.
- [x] Tested actual player traversal from both outer gates through all seven tiers to the citadel court; stairs, landings and tier entrances passed.
- [ ] Separately check wall-walk access and selected interiors as part of the deferred broader exploration work.
- [ ] Investigate the browser syntax error and verify texture readiness and actual GPU renderer before capturing final images.

### 4. Complete integration and destruction proof

- [ ] Rerun authored parser/manifest checks with `blast-core,cuda-stress` features and run relevant client type checks/tests on final changes.
- [ ] Verify deterministic generation and repeatable texture baking, including unchanged legacy layer indices and correct new material mappings.
- [ ] Retry deployment with the validated scene/settings. Saved `VIBE_PHYSX_DIRECT_GPU=0` was applied, but a successful retry has not been recorded.
- [ ] Verify the binary VLCM manifest, WebTransport, bootstrap, rendered chunks, zero missing chunks/hash mismatches and no JavaScript errors.
- [ ] Implement a live capture driver with configurable origin, UDP port and scene-specific cameras. The old live screenshot script still contains hardcoded ports and neighbourhood cameras.
- [ ] Exercise gate breaches, support loss, roofs, tower failure and cascading damage through gameplay. Measure actual movement/collapse, not just an increase in broken-bond count.
- [ ] Run a complete demolition scenario and check that no construction remains permanently anchored or visually floating. The current category test is not proof of complete demolition.
- [ ] Measure load time, frame time, draw calls and server simulation time. Targets: 60 FPS intact and 30 FPS during destruction at 1080p on a declared gaming GPU; these targets have not been demonstrated.
- [ ] Capture matching intact, damaged and demolished live views. Deliver the verified playable URL, images, measured limitations and final reproduction instructions.

## Where the work lives

**Authoring repository:** `/root/workspace/blast-stress-solver-2`

- `blast/blast-stress-solver/structures/minas-tirith-rebuilt.mjs`
- `blast/blast-stress-solver/structures/build.mjs`
- `blast/blast-stress-solver/structures/lib/{materials,fracture}.mjs`
- `blast/blast-stress-demo-rs/assets/scenes/minas-tirith-rebuilt.json`

**Game repository:** `/root/workspace/vibe-land-4`

- `destruction/assets/scenes/minas-tirith-rebuilt.json`
- `destruction/tests/{authored_structures,minas_rebuilt}.rs` and `destruction/src/equilibrium.rs`
- `client/scripts/bake-authored-city.py` and the existing `build-city-textures.py`
- `client/public/textures/city/{city-albedo,city-surface}.webp`
- `client/src/scene/{cityTextureSets.generated,cityTextures}.ts`
- `client/src/structures/structurePack.ts`, `client/src/pages/StructureViewer.tsx`
- `client/tools/structure-shot.mjs`

**Convergence diagnostics added after resumption:**

- `blast/include/extensions/stressphysx/NvBlastExtStressPhysX.h` and its `NvBlastExtStressPhysX.cpp` implementation in the authoring/SDK repository
- `physx-bridge/src/destruction.cc` and `destruction/src/lib.rs` in the game repository
- `/tmp/minas-equilibrium-unit.log` and `/tmp/minas-equilibrium-build.log` record verification of the revised gate; a compile-only native check is not a physical pass

**Evidence and temporary state:**

- `/tmp/minas-build.log`, `/tmp/minas-physics.log`, `/tmp/minas-soak.log`, `/tmp/minas-audit.log`
- `/tmp/minas-old-physics.log`, `/tmp/minas-parser-test.log`, `/tmp/minas-deploy.log`
- `/tmp/minas-baseline/corner.png`, `/tmp/minas-rebuilt/{corner,front,street,aerial}.png` — intermediate captures, not certified final-pack images
- `.certs/vast-city/` — deployment state and build/server logs; contains private environment data, do not commit or dump it
- `/tmp/minas-deployment-before.json` — saved deployment state before task changes; also private

Saved deployment settings at handoff: scene `minas-tirith-rebuilt.json`, grid 1, strength scale 1, Direct GPU 0, web port 1111, API 4016, UDP 4433. These are **saved settings, not proof of active listeners**. The previously discovered candidate public URL was `https://209.121.195.117:40613/city`; rediscover and verify before sharing it as playable.

## Commands for when work resumes

Generate and validate from the authoring package directory:

```bash
cd /root/workspace/blast-stress-solver-2/blast/blast-stress-solver
node structures/build.mjs minas-tirith-rebuilt --emit-vibe-land /root/workspace/vibe-land-4
```

Focused physics gate, only when the GPU can be used without competing live simulation:

```bash
cd /root/workspace/vibe-land-4
BLAST_ROOT=/root/workspace/blast-stress-solver-2/blast \
VIBE_PHYSICS_BACKEND=physx_gpu VIBE_PHYSX_DIRECT_GPU=0 \
VIBE_CITY_STRESS_LIMIT_SCALE=1 VIBE_CITY_SOLVER_ITERATIONS=32 \
MINAS_MAX_UPDATES=4096 \
cargo test --release -p vibe-land-destruction --features blast-core,cuda-stress \
  --test minas_rebuilt -- --ignored --test-threads=1 --nocapture
```

Read the repository deployment skills before restarting services. Use `python3 scripts/vast-city.py status` for discovery. The existing static capture supports `--origin http://127.0.0.1:6006` when a Vite preview is running there.

## Reproduce the stair checks

After rebuilding the pack, run in the authoring package:

```bash
node --test structures/tests/minas-routes.test.mjs
```

From the game repository, using the current local deployment ports:

```bash
node client/tools/minas-route-walk.mjs https://127.0.0.1:1111 4433 /tmp/minas-live-routes.json
node client/tools/structure-shot.mjs minas-tirith-rebuilt --origin http://127.0.0.1:6006 --poses docs/structures/minas-tirith-rebuilt/stair-cameras.json --out /tmp/minas-stairs
```

The screenshot command needs the standalone preview running on the specified origin. The walking test creates two disposable players, uses only ordinary movement, checks the deployed chunk count against the local pack, and closes both players when finished. Static route checks inspect the exported convex hulls, including the actual shape library, instead of trusting generator waypoint metadata.
