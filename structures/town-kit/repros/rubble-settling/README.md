# Native rubble settling reproduction

The unfurnished Victorian shell is stable under its own weight, but debris continues moving after support-loss collapse. This case contains no loose furniture or fencing. All above-ground pieces are dynamic after separation; only buried foundation pieces are anchored. It uses standard ScenePack v2 and the existing read-only physx-2/bridge interfaces.

Run from the town-kit directory:

```sh
node repros/rubble-settling/reproduce.mjs
```

The script verifies the archived asset hash, writes a separate diagnostic asset under `out/`, and runs the kit-owned native harness sequentially. It requires the same local native dependencies and at least 512 MiB of free disk space. No main application files or services are changed.

Recorded result: 5,734 chunks and 13,297 bonds; stress budget 64, rigid contact iterations 16/4, gravity 9.81 m/s², no contact-margin override, no sleeping/freezing/parking assists. Intact equilibrium passed with zero breaks and 30 seconds of subsequent observation. Support-loss damage broke 10,875 bonds and dropped all 3,058 tested upper architectural chunks. At the 60-second deadline, 3,658 dynamic bodies remained awake and the solver had not converged. The test therefore fails.

`review-provenance.json` records SDK/library/source hashes and shared GPU conditions. `result-summary.json` retains solver/status measurements; the complete recording, events and projectile log remain under `out/reviews/diag-shell-stress64-collapse/`. This is a shell-only reproduction, not a claim that the engine is the sole cause. It shows that removing loose furnishings and raising the stress budget does not resolve this asset's rubble settling.
