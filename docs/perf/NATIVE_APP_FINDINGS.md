# Native app on Vibe Town: findings for the performance work (2026-10-08)

## Hangs: the desktop loses the GPU

- **What happened.** Three times, the app on Vibe Town with the high-fidelity pack (57,087 chunks, 149,098 bonds, 22 cars) hung WindowServer. Each time it was 52–66 s after the app started, with the town at rest (0 awake bodies, 2 broken bonds). macOS's watchdog then logged the owner out.
- **The stackshots** (`/Library/Logs/DiagnosticReports/WindowServer_*.spin`) show:
  - WindowServer and the app's render thread both waiting in the GPU driver;
  - the sim thread in `World::step` → `NpScene::fetchResults` → `PxSyncImpl::wait`, waiting for PhysX's GPU simulation;
  - the app's footprint at 7.5–12.6 GB.
- **Not the cause:** CuMetal's busy keep-alive. With it off in the app (`sim-native` `apply_app_defaults`), the third hang still happened.
- **The lab doesn't hang:** it ran for many minutes.
- **Next: measure.** Run Vibe Town headless for 40 s, ending before the ~55 s hang point, with:
  - `CUMETAL_TRACE_COMMITS=1`, summarised by `scripts/perf/gpu-submission-summary.py` (GPU time per command buffer and its kernels);
  - the app's footprint sampled once a second.
- **The aim** is responsible GPU use, as Apple's guidance describes:
  - short command buffers;
  - physics within a per-frame budget;
  - unconverged solves carried to the next tick (already the product setting);
  - no permanent compute in flight.

## CPU: the player's move computes tight bounds of every dynamic actor

`physx_bridge.cc` `move_player` decides the controller's step offset by testing the swept capsule against `getWorldBounds()` of every dynamic actor in `records_`.

- **Why it costs:** `getWorldBounds` recomputes tight bounds over every shape of the actor (`Gu::computeTightBounds` over the convex points). For 22 destructible cars with hundreds of parts each, that is thousands of hull bounds per player move, every tick. It appeared in the hang stackshot's sim thread.
- **The standard fix:** one `PxScene::overlap` query of the swept box against PhysX's scene-query tree, filtered to dynamic bodies. The answer is the same: an AABB intersection against PhysX's own bounds. The cost is logarithmic.
- **Status:** a performance item; measure before and after (`scripts/native-mac.sh perf`).
