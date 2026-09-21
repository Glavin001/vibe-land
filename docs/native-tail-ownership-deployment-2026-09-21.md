# Native collision ownership fix: public deployment, September 21

Public scene: https://209.121.195.117:40613/city

Deployed the physx-2 collision ownership fix `d80f5948` to the existing
36-building `bayline-framed-36.vlsp`. The scene remains byte-identical
(SHA-256 `1c0dbd909ba29b68a7d15455548a7a08d069563a855482ca01f80eba8895f31d`):
70,546 chunks and 189,492 bonds. Experimental residential roof/wall authoring
was **not** promoted.

The bridge now applies the existing `VIBE_PHYSX_POSITION_ITERS` and
`VIBE_PHYSX_VELOCITY_ITERS` settings to native construction parents as well as
ordinary bodies. Native fragments inherit them. Parsing is shared and rejects
values outside PhysX's 1–255 range; absent/invalid settings retain 4/1 defaults.
This deployment uses 8/2 contact iterations. Destruction correction limit remains
1. No sleep, stabilization, depenetration, damping, or gravity workaround was
introduced.

## Verification and limits

The SDK fix passed eleven selected native tests, including a regression that
fails on the original engine, both PGS/TGS contact paths, and natural sleep after
final-pass fracture. The frozen rendered wall audit retained its exact golden
result. SDK evidence: `../physx-2/qualification/tail-ownership-20260921/` from the
workspace root.

Application qualification used the production environment variables, without the
diagnostic setter. A read-only check verified **zero parent or fragment iteration
mismatches**. Each of four isolated existing-house cases first passed 1,800
consecutive quiet/converged intact steps at normal gravity, with no spontaneous
damage. Ninety simulated seconds of impact observation produced:

| Existing asset / weapon | Broken bonds | Escaped bodies | Final awake | Final convergence/rest |
| --- | ---: | ---: | ---: | --- |
| Bungalow / cannonball | 1,799 | 0 | 147 | **Fail** |
| Bungalow / meteor | 1,381 | 0 | 0 | Pass |
| Two-storey porch house / cannonball | 1,616 | 0 | 0 | Pass |
| Two-storey porch house / meteor | 809 | 0 | 0 | Pass numerically; recording incomplete |

Disk exhaustion truncated the last recording. Its numerical report survives, but
it is explicitly excluded from complete artifact acceptance. The truncated bytes
are preserved in `recording.json.partial.gz`, with `recording-integrity.json`.
Inactive deployment backups were compressed and verified byte-for-byte; the
newest releases and running executables were preserved.

The first three recordings are complete. Bungalow cannonball and meteor captures
were rendered and visually inspected. The cannonball breaches a side wall; the
meteor removes much of the roof. This does **not** demonstrate the requested
50% whole-building destruction target. Full-town destruction/settling quality
is not certified. In particular, the cannonball bungalow remains a known failure.
Separate production-path tests of the experimental panel profile also retain
settling failures, which is why those assets were not promoted.

Raw checks and provenance are under
`structures/town-kit/out/reviews/house-cannonball/production-tail-fix-*` and
`production-panel-fix-*`. Image captures are under
`structures/town-kit/out/reviews/roof-response/production-tail-fix-*`.
The native harness checks production contact settings with the optional shot
field `expectedContactIterations: [8, 2]` before simulation and after fracture.
GPU tests ran sequentially; timings are diagnostic, not exclusive-GPU benchmarks.
Both existing and experimental authoring regression suites passed.

## Deployed artifacts

- Server SHA-256: `2d05e5ffbd7c9baf19e0ea2e0f060856b7dc2efc0cae6b42620b44c5737d2289`
- GPU module SHA-256: `10b9fa6ee1fe701cd75c7b96efae3a013a9c37bb88cacbde3854714b6786c79d`
- Destruction runtime SHA-256: `f7839f0318e3b6f4e0c7273106562e7fcb96af57906a8da875c28ec3610cfd60`

Both shared libraries are immutable deployment copies under
`.certs/vast-city/engine-d80f5948/`. `/proc` mappings and the running executable
hash matched these artifacts after deployment. Private receipts are
`.certs/vast-city/tail-fix-live-provenance.json`, `verification.json`, and
`browser.json` (never commit environment files, keys, or binaries).

Live verification passed GPU health, isolation headers, the binary manifest,
external public HTTPS, and a browser WebTransport join/bootstrap/render with all
70,546 chunk poses resolved, no missing chunks, no ledger mismatches, and no
JavaScript errors. The browser uses a loopback NAT-hairpin workaround: external
UDP reachability was **not independently verified**.

To reproduce this deployment, after building the qualified SDK artifacts:

```sh
VIBE_CITY_DESTRUCTION=native \
VIBE_CITY_SCENE="$PWD/structures/town-kit/out/bayline-framed-36.vlsp" \
VIBE_CITY_NATIVE_CORRECTION_LIMIT=1 \
VIBE_PHYSX_POSITION_ITERS=8 VIBE_PHYSX_VELOCITY_ITERS=2 \
PHYSX_DESTRUCTION_SDK=/root/workspace/physx-2 \
PHYSX_DESTRUCTION_RUNTIME_DIR="$PWD/.certs/vast-city/engine-d80f5948" \
CUDA_HOME=/usr/local/cuda-12.8 \
python3 scripts/vast-city.py up --browser --public
```

The deployment helper preserves scene selection but intentionally clears tuning
settings absent from the invocation. Include 8/2 explicitly on future deployments.
