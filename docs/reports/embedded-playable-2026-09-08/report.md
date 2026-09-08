# Playable embedded GPU destruction — 2026-09-08

**Scope:** one RTX 4090, CUDA 12.8, native PhysX with Direct GPU API off,
sleeping on, 1/60 s timestep, at most one correction/tick. Functional integration
qualification, **not** an isolated performance or endurance campaign.

| Check | Workload and evidence | Result |
|---|---|---|
| ✅ Native ordinary-scene suite | Seven tests: queries, sleeping, wake/late impact, commands/device graph | All passed |
| ✅ Rust/C++ gameplay | 36 chunks, 60 bonds, moving CCT, one 100 kg sphere at 30 m/s, 125 steps | 42 unique broken bonds, 2 corrected ticks, 19 promotion/redefinition events; mapping/query and no-duplicate checks passed |
| ✅ Frozen native penetration | 444 chunks, 896 bonds, prescribed native projectile, 10 simulated seconds | 398 retained, 46 detached, 199 broken bonds, correction ≤1, exact topology signature and convergence passed; [quality JSON](native-penetration-quality.json) |
| ✅ Browser gameplay | 444 chunks, 896 bonds, eight accepted shot commands using 18,000 kg spheres at 40 m/s; moving player | 289 broken bonds, 71 motion groups (70 detached), 7 corrected ticks; WT, rendering, movement and native marker passed; [capture](browser.json) |
| ✅ Settling | Same browser scene, 30 one-second samples covering ticks 780–2520 | No degraded step; minimum observed body COM y=0.479996 m; 46 of 70 detached bodies sleeping at final sample; [samples](settling.json) |
| ✅ Reset | Connected browser using RESET CITY | Fresh 444-chunk, 896-bond city, zero broken bonds/detached groups, no hash mismatches; [capture](reset.json) |
| ⚠️ Earlier debris escape | Earlier five-shot run of the same asset; different browser-timed input sequence | Later below-ground bodies observed. Cause not established; retained in `/tmp/vibe-embedded-city/server-escape.log`. Not declared fixed |
| ⚠️ Rendering freshness | Gameplay snapshot | No hash mismatches/orphans; one stale-drawn-chunk diagnostic observed. Needs targeted follow-up |
| ⚠️ Public reachability | Actual local browser QUIC handshake; advertised mapped public URL; UDP reachability self-test | Server is deployed; this instance's own public HTTPS hairpin timed out, so external-browser connectivity is not independently verified |

Server release and client production builds passed. Engine revision `80e9ac77`.
The engine patch restores ordinary CPU-authored kinematic start poses before
native correction, allowing the moving character controller to coexist with a
fracturing scene. This does not claim support for all joints/CCD/articulations.

The embedded backend's old separate stress timing fields remain zero placeholders;
read the whole physics step for current native cost. Browser rendering here used
CPU SwiftShader and was concurrent with the server: these captures must not be
used as an isolated GPU performance comparison. No timing table is fabricated.

Local screenshots: `/tmp/vibe-embedded-city/browser/{before,after,settled}.png`.
Build/test logs: `/tmp/vibe-native-server-build.log`,
`/tmp/vibe-native-player-final.log`, `/tmp/physx-native-standard-results.log`,
`/tmp/vibe-kinematic-penetration.log`.
