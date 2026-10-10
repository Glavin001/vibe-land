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

## Fixed (root cause): no GPU code that waits on another threadgroup

- **Cause.** The keep-alive below was not it: with both keep-alive switches off, Vibe Town still hung WindowServer in the owner's runs. CuMetal's resident cooperative grids (Blast's stress hierarchy construction and cycle) lower `grid.sync()` to a device-atomic spin barrier. Metal does not promise that a grid's threadgroups are resident together; with WindowServer and the app's rendering holding GPU cores, a peer never starts, the others spin, and the GPU deadlocks. Killing the app cannot stop work already on the GPU (cuda-metal `docs/known-gaps/runtime.md`).
- **The fix.** `CUMETAL_COOPERATIVE_RESIDENT_GRID=0` in `sim-native` `apply_app_defaults`: each cooperative launch is one threadgroup, which waits only on itself. `scripts/verify/lint-harness.sh` requires it. No watchdog or kill switch in the app.
- **Confirmed (2026-10-09).** `scripts/verify/native-soak.sh` (Vibe Town, high profile, garage-clean on CuMetal 8943f10): 121 s, WindowServer worst 77.7 ms, GPU memory 11 GB in 2,278 allocations after a 20 s load ramp, flat to the end.

## Recurred (2026-10-10): a hang the cooperative-grid fix does not explain

- **What happened.** Two owner launches of Vibe Town hung WindowServer and logged the owner out. One ran on `garage-clean@b3af5a772`, the other on `garage-clean@95cf7c300.1`, the SDK that passed the soak. Both hung about 15–18 s after launch, about 1 s after the first frames. Reports: `WindowServer_2026-10-10-030839`, `WindowServer_2026-10-10-032148`.
- **The stackshot (second report).**
  - The app's main thread is in Dawn `Queue::SubmitPendingCommandBuffer` → `PrepareNextCommandBuffer`, blocked in IOGPU because the queue is full.
  - The kernel is in `IOGPUFamily` `CommandQueueDispatch`.
  - The sim thread is in `NpScene::fetchResults` → `PxSyncImpl::wait`.
  - Together these mean a GPU compute kernel did not complete.
- **Ruled out:**
  - cooperative grids: the app runs with resident grids off;
  - waits on the CPU side;
  - memory pressure: 128 GB, 94% free;
  - the zero-iteration convergence fix: the older SDK hangs too;
  - large or heavy-on-light components: Vibe Town has none above 8,192 chunks, and its largest mass ratio is 5e3.
- **What differed from the soak:** background CPU load, from another session's FP64 oracle runs and OrbStack. The soak ran on an idle machine.
- **Diagnostic SDK** `garage-diag@af81bb521`, PhysX branch `fix/bounded-root-walk`:
  - The three union-find root walks (`PxgDestructionTopology.cu`, `NvBlastExtStressGpuTopology.cuh`, `PxgPreSolveIslands.cuh`) assert that labels only point downward. On a violation they `__trap()` instead of looping.
  - CuMetal (`diag/submit-trace`) prints `CUMETAL_SUBMIT` with each command buffer's kernels when it is committed. The last `SUBMIT` without a matching `CUMETAL_COMMIT` names the kernel that never finished.
  - Results: destruction gate 116/116; quick tier 0 failing; answer drift 287 identical.
- **Open.** The root cause is not found. A reproduction needs the owner's consent, because every hang so far has logged them out. Never relaunch after an unexplained quit; read `/Library/Logs/DiagnosticReports` first.

## Superseded: the app no longer runs a GPU keep-alive (kept off, but not the root cause)

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

### What the keep-alive was buying (measured)

`scripts/native-mac.sh perf` on the default city, high profile: one run each, so read the differences as indicative. The table gives the worst one-second average tick and the maximum PhysX step per phase.

| Phase | Tick, off | Tick, on | PhysX, off | PhysX, on |
|---|---|---|---|---|
| idle | 13.1 ms | 10.3 ms | 4.7 ms | 2.4 ms |
| building meteor | 12.7 | 6.6 | 13.7 | 5.9 |
| cannonballs | 15.2 | 7.8 | 19.3 | 6.9 |
| car meteor | 16.1 | 11.3 | 15.8 | 16.9 |
| triple meteor | 17.9 | 16.0 | 40.4 | 24.8 |

- **Rendering is unchanged:** median 16.7 ms, a steady 60 FPS.
- **The physics is about 1.5–2× slower without the keep-alive:** the GPU idles between short 60 Hz ticks and runs them at a lower clock (see the `apple-gpu-clock` memory: a paced server runs kernels ~2.3× slower).
- **Not a fix:** holding the clock with permanent background GPU work. That is what hung the desktop.
- **The responsible levers:**
  - less GPU time per tick: fewer, longer-running dispatches per command buffer and no host waits mid-tick, so a tick is one dense burst;
  - the performance work proper, on the solver and the narrowphase.
- **Game Mode** (macOS 14, fullscreen) is the platform's own way to prioritise a game's CPU and GPU; worth measuring when the app runs fullscreen.

## CPU: the player's move computes tight bounds of every dynamic actor

`physx_bridge.cc` `move_player` decides the controller's step offset by testing the swept capsule against `getWorldBounds()` of every dynamic actor in `records_`.

- **Why it costs:** `getWorldBounds` recomputes tight bounds over every shape of the actor (`Gu::computeTightBounds` over the convex points). For 22 destructible cars with hundreds of parts each, that is thousands of hull bounds per player move, every tick. It appeared in the hang stackshot's sim thread.
- **The standard fix:** one `PxScene::overlap` query of the swept box against PhysX's scene-query tree, filtered to dynamic bodies. The answer is the same: an AABB intersection against PhysX's own bounds. The cost is logarithmic.
- **Status:** a performance item; measure before and after (`scripts/native-mac.sh perf`).
