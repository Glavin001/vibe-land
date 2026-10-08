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

## Fixed: the app no longer runs a GPU keep-alive

- **Cause.** CuMetal's GPU keep-alive, which the bridge turns on for the headless server (`physx_bridge.cc`): a 250 µs heartbeat (`CUMETAL_GPU_KEEPALIVE_US`) and a busy threadgroup (`CUMETAL_GPU_KEEPALIVE_BUSY`). It keeps the GPU from idling between ticks. In a desktop app that shares the GPU with WindowServer, it hung WindowServer 52–68 s after launch, at rest.
- **What the measurements showed:**
  - **Physics GPU use stayed light up to the hang.** A CuMetal commit trace of a hanging run showed ~16% GPU busy and every submission ≤ 1.3 ms. Long physics kernels were not the cause.
  - **Footprint was flat.** It held at 11 GB of GPU memory once rendering started, so it was not a size leak.
  - **GPU allocations grew with the heartbeat on:** 481, then 1,880, then 5,276 at the hang.
  - **The WebGPU timestamp-readback errors** ("already mapped") began 7 s after the hang: a consequence, not the cause.
- **The runs:**

| Keep-alive | Runs | Result |
|---|---|---|
| Heartbeat and busy on | 2 | hung at 52 s and 66 s |
| Heartbeat on, busy off | 2 | hung at 55 s and 66 s |
| Both off (`CUMETAL_GPU_KEEPALIVE_US=0`, `_BUSY=0`) | 1, 120 s | no hang; WindowServer ~55 ms throughout; GPU allocations flat at 1,599 |
| The app's new default (both off, set in `sim-native` `apply_app_defaults`) | 1, 180 s | no hang; WindowServer ≤ 87 ms; GPU allocations flat at ~1,714; no readback errors |

- **The fix.** The app lets the GPU idle between frames, as games do (Apple, Metal Best Practices). The server keeps its keep-alive.
- **Follow-ups:**
  - The client's timestamp readback (three.js WebGPU, a 1,440-byte `mapAsync` every frame) must skip a frame while the previous map is still pending. Otherwise a slow frame turns into a validation error and a rejected submit every frame.
  - Measure what the keep-alive's absence costs in tick time. The server measured idle ticks of 5.4 vs 3.1 ms, but in the app, rendering keeps the GPU active.

## CPU: the player's move computes tight bounds of every dynamic actor

`physx_bridge.cc` `move_player` decides the controller's step offset by testing the swept capsule against `getWorldBounds()` of every dynamic actor in `records_`.

- **Why it costs:** `getWorldBounds` recomputes tight bounds over every shape of the actor (`Gu::computeTightBounds` over the convex points). For 22 destructible cars with hundreds of parts each, that is thousands of hull bounds per player move, every tick. It appeared in the hang stackshot's sim thread.
- **The standard fix:** one `PxScene::overlap` query of the swept box against PhysX's scene-query tree, filtered to dynamic bodies. The answer is the same: an AABB intersection against PhysX's own bounds. The cost is logarithmic.
- **Status:** a performance item; measure before and after (`scripts/native-mac.sh perf`).
