# Bayline destruction handoff — 2026-09-22

## Objective

Make Bayline houses destroy naturally: cannonballs breach walls/beams, meteors
cause substantial collapse, and detached pieces fall and settle without floating,
jittering, or stop-motion. Keep structural frames separate from cosmetic panels.
Do not hide failures with freezing, altered gravity, or suppressed destruction.
The engine fix is deployed; **overall destruction quality is not finished**.

## Current deployment

- Public URL: https://209.121.195.117:40613/city
- Scene: `structures/town-kit/out/bayline-framed-36.vlsp` — 36 buildings,
  70,546 chunks, 189,492 bonds. Existing geometry unchanged.
- Native destruction correction limit **1**; contact iterations **8 position / 2 velocity**.
  Contact iterations and stress iterations are different settings.
- App commit: `202f6403` on `claude/netlab-overnight`.
- SDK commit: `d80f5948` on `claude/qualified-sdk-471ea8a5` in sibling `../physx-2`.
- Pinned GPU/runtime libraries: `.certs/vast-city/engine-d80f5948/`.
- Last deployment passed public HTTPS, GPU health, browser WebTransport,
  bootstrap/render, and running binary/library hash checks. External UDP was
  not independently verified; browser verification bypasses NAT hairpin.
- Detailed results, artifact hashes, and exact redeploy command:
  [deployment report](native-tail-ownership-deployment-2026-09-21.md).

Read `AGENTS.md` and `.claude/skills/vastai-deploy/SKILL.md` before deploying.
Use `python3 scripts/vast-city.py status` to discover current ownership.
The deploy helper clears unspecified tuning settings: explicitly supply **8/2**
again. Preserve the pinned runtime path; a bare deployment can otherwise select
older saved settings. Prior user authorization includes public deployment and
player disconnection, but avoid unnecessary disruption.

## Confirmed fixes

1. **SDK collision ownership handoff:** fracture on the final correction pass
   installs new shape owners. The next ordinary collision pass previously missed
   that notification, so formerly same-body overlapping shapes could miss contact
   filtering. Forward pending generations to ordinary passes; clear generations
   after consumption. Collision detection still precedes fracturing.
2. **Application settings:** native construction parents previously ignored the
   existing contact-iteration knobs. A shared parser now applies them to parents;
   the SDK inherits settings onto fragments. Defaults remain 4/1 unless configured.

SDK regression fails on the original engine and passes on the fix. Eleven native
checks pass, including PGS/TGS and natural sleep. Frozen wall audit retains the
exact golden result. Evidence:
`../physx-2/qualification/tail-ownership-20260921/{README.md,evidence.json}`.
Do not revive the earlier broad private patch: it changed the frozen result.

## Remaining failures

All four existing-house cases passed 30 simulated seconds of intact rest and
convergence, zero spontaneous damage. At 90 simulated seconds after impact:

| Case | Broken bonds | Escaped bodies | Awake | Settled |
| --- | ---: | ---: | ---: | --- |
| Bungalow cannonball | 1,799 | 0 | 147 | **No** |
| Bungalow meteor | 1,381 | 0 | 0 | Yes |
| Porch house cannonball | 1,616 | 0 | 0 | Yes |
| Porch house meteor | 809 | 0 | 0 | Numerically; recording truncated |

Experimental `impactProfile: 'residential-v2'` uses thinner roofing, separate
ceiling joists/panels, timber joints, and single-skin siding. **Not deployed.**
Production-path 8/2 checks still failed settling for its bungalow cannonball,
bungalow meteor, and porch meteor; only porch cannonball passed. Earlier successful
isolated diagnostic shots do not qualify the full profile. Raising stress
iterations to 32/64 previously caused spontaneous furniture damage; do not assume
it is a safe remedy. The requested >50% meteor destruction target remains unproven.

## Files and workflow

- WIP saved in the handoff commit under `structures/town-kit/`: authoring in `src/parts/`
  and `src/framed-houses.mjs`; investigation in `repros/roof-response/`; native
  harness in `warm-start/native/`; runner in `repros/house-cannonball/run.py`.
- Other developers' untracked `client/tools/_replay-*.mjs` and `_tape-record.mjs`
  must remain untouched. SDK also has an unrelated untracked CUDA keyring `.deb`.
- Raw reports, inputs, settings, recordings:
  `structures/town-kit/out/reviews/house-cannonball/production-{tail,panel}-fix-*`.
- Screenshots: `structures/town-kit/out/reviews/roof-response/production-tail-fix-*`.
  Bungalow before/after captures were inspected.
- Native binary: `structures/town-kit/native/target/release/house-impact-review`.
  Separate Cargo workspace: `structures/town-kit/warm-start/native/Cargo.toml`.
  Build with CUDA 12.8, kit `out/cargo-home`, and kit `native/target`.
- Run GPU cases sequentially in fresh directories. Runner defaults to correction
  **2** and an old runtime: explicitly set `VIBE_CITY_NATIVE_CORRECTION_LIMIT=1`,
  `VIBE_PHYSX_POSITION_ITERS=8`, `VIBE_PHYSX_VELOCITY_ITERS=2`, and
  `TOWN_KIT_DIAGNOSTIC_RUNTIME` to the qualified runtime directory.
  Shot `expectedContactIterations:[8,2]` verifies parents/fragments read-only;
  do not substitute the diagnostic iteration setter for production verification.

## Next steps / cautions

1. Reproduce the remaining bungalow cannonball case; distinguish persistent rigid
   contacts from stress nonconvergence using its per-tick reports and native poses.
2. Fix and qualify settling before promoting experimental authoring. Re-test both
   houses, cannonball/meteor, intact stability, and actual images/recordings.
3. Rebuild against matching SDK artifacts, deploy, and verify mapped library hashes.

Only **533 MB disk free** at handoff. Some inactive deployment executables were
losslessly compressed, preserving newest releases/rollback copies. Do not truncate
live logs or delete others' caches. Porch meteor's truncated recording is explicitly
marked by `recording-integrity.json`; numerical success is not a complete recording
pass. A recovery copy also remains under `/dev/shm/town-kit-deployment-recovery/`.
