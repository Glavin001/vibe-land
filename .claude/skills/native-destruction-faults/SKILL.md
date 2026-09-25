---
name: native-destruction-faults
description: Diagnose the PhysX-native destruction backend's runtime faults — settled bodies ejected at kilometres per second, bodies leaving the world, CUDA error 700 restarts (and Metal page faults on the Mac), and a stage stuck at frame zero. Includes the forensics already built, the hypotheses already killed and the evidence that killed them. Use when the city server restarts under load, when debris teleports or vanishes, or before spending a night on a theory this project has already tested.
---

# When the native destruction stage misbehaves

Read the "already ruled out" section before forming a theory. Three separate
sessions have chased the same wrong idea because the evidence that killed it
was never written down.

## The crash half is solved: a heightfield edge (2026-09-20)

**`CUDA error 700` after a body crosses x or z = ±256 m is an upstream PhysX
5.6 GPU bug at the heightfield's outer edge, and the city no longer has a
heightfield.** Read this before treating any 700 as the ejection fault.

`sphereHeightfieldNarrowphaseCore` (`gpunarrowphase/src/CUDA/convexHeightfield.cu:470-495`)
handles a sphere whose closest feature is a triangle edge by fetching the
adjacent triangle to test convexity — `getTriangle(..., triAdjTriIndices.x, ...)`
— **without checking for `BOUNDARY` (0xffffffff)**. On the field's outer edge
there is no adjacent triangle, the sample array is indexed with 0xffffffff,
and the context is gone. `compute-sanitizer --tool memcheck` names it:

```text
Invalid __global__ read of size 1 bytes ... 5,459,017,223 bytes after the nearest allocation
  isZerothVertexShared        heightfieldUtil.cuh:92
  getTriangleVertexIndices    heightfieldUtil.cuh:111
  getTriangle                 heightfieldUtil.cuh:275
  sphereHeightfieldNarrowphaseCore  convexHeightfield.cu:472
  sphereHeightfieldNarrowphase      convexHeightfield.cu:888
```

The city floor was two coincident colliders: the 2 km slab and, on top of it
at y=0, the benchmark template's flat 129×129 heightfield over ±256 m. Every
body that slid across that edge while in contact took the GPU down — a 2 m
meteor rolling at a constant 31 m/s was at x = −256.1 and x = −254.6 on the
faulting tick in two traced runs, and the rubble ejected at km/s in earlier
sessions crosses the same edge within a few ticks. `city_world()` no longer
lays the heightfield; the slab is the floor. Reproducer, forty lines, no
city: `physx-bridge/tests/heightfield_edge.rs`. SDK fix for physx-2: guard
the three `getTriangle` calls with `!= BOUNDARY`.

What this does NOT explain is why settled rubble is ejected in the first
place; that remains below. It does explain why an ejection crashed the
server (it crossed ±256 m at km/s) rather than merely flying off. A 110 t
meteor ploughing through its own rubble ejects settled chunks on demand
(arm P: 25 ejections in 4 launches; ~10 t never ejects anything), which
makes it the fastest reproducer that fault has had.

**How to get a real stack trace out of a 700, instead of guessing** (Linux and
NVIDIA; on a Mac see [On a Mac](#on-a-mac)). The
error is asynchronous: the kernel that faults never reports, the next stream
sync does, so every log line says `SynchronizeStreams` or `Synchronizing
GPU Narrowphase` — the sync site, not the culprit. Build the smallest
reproducer as a bridge test and run it under the sanitizer with the SDK's
libraries on the path:

```bash
export CUDA_HOME=/usr/local/cuda-12.8 \
  LD_LIBRARY_PATH=/usr/local/cuda-12.8/lib64:/root/workspace/physx-2-deployed/physx/bin/linux.x86_64/release
compute-sanitizer --tool memcheck --print-limit 3 \
  target/release/deps/heightfield_edge-<hash> --ignored --nocapture --test-threads=1 a_ball_rolling
```

The SDK's kernels carry `-lineinfo`, so it prints file:line on the device
side and a host backtrace to the launch. `CUDA_LAUNCH_BLOCKING=1` is the
cheaper, cruder alternative: it makes every launch synchronous so the first
error is the faulting kernel. `VIBE_CITY_BALL_TRACE=1` on the server logs
every fired ball's position and speed at 10 Hz (`physx_runtime.rs`), which
is how the ±256 m line was found — the chunk-side detectors only watch
fragments.

## The fault, as currently understood

A body **at rest, lying on the ground, is ejected at up to 83,000 m/s in one
tick**. It clears the 1 km world bound within a second, and a GPU broadphase
holding it is what raises `CUDA error 700` (illegal address), which poisons the
context for the life of the process. The server detects the lost context and
exits 70; the supervisor restarts it in about seven seconds and the match state
is gone.

So "the server keeps crashing" and "debris flies off to infinity" are the same
fault seen from two ends.

## The forensics that already exist

All in `destruction/src/native_runtime.rs`, on by default, bounded to 32
reported bodies each so a bad scene cannot flood the log.

| line in the server log | what it means |
|---|---|
| `velocity explosion at age N ticks` | caught at source: a one-tick speed jump past 250 m/s, with the position and speed it left FROM |
| `N bodies born this tick; nearest is …` | what was created near the victim, and how far away |
| `stage frame … correctionPasses … converged …` | the stage's own account of the step that did it |
| `left the world at age N ticks` | the world-bound refusal, which fires long after the cause |

Spans: `native_velocity_explosions`, `native_worst_velocity_jump_mps`,
`native_escaped_bodies`, `native_escape_age_ticks_{min,avg,max}`,
`native_bodies_outside_world`.

**Read the explosion, not the escape.** The world bound only fires when a body
crosses 1 km, which in one session happened a median of **1,237 ticks** after
it was already travelling at a median of **1,275 m/s**. The escape log reports
a consequence; the explosion log reports the moment.

## Already ruled out, with the evidence

**Fragments are thrown at creation by depenetration.** The standing hypothesis
for months, written into the code comments. Dead twice over:

- Ages at escape: min 44, median 1,819, max 3,535 ticks, and **none under two
  ticks**. Every body that flies is old and settled.
- The cause detector then asked the right question — what was *created* near
  the victim — and answered 39.75 m, 39.06 m, 40.71 m, 78.48 m, and on several
  explosions **"0 bodies born this tick, none near it"**.

Note the first bullet alone is *not* sufficient, and reading it as sufficient
was a mistake made here: the detector reports the body that FLIES, which is the
victim. A fragment created inside a settled pile would eject the pile while
itself being new. Only the second bullet actually closes it.

**The cannonball is the trigger.** Only 4 of the last 12 explosions followed a
shot, and a batch of six followed none — just heavy fracture, 90 bonds in one
tick with 3,905 bodies awake.

**Overload / capacity.** A crash was captured at 1,648 bodies, 1,339 awake,
8,390 broken bonds, 1.3 Mbps. 45,884 bonds and 11,911 awake have survived. It
is not scale.

## What the evidence currently points at

Victims come in **tight spatial clusters**, all at rest, all within 2 m of the
ground, ejected on the same tick with nothing arriving:

```
(-23.5, 0.2, 55.3) (-23.4, 0.3, 53.4) (-24.5, 1.2, 56.1) (-24.6, 0.2, 53.8)
(-17.1, 0.1,  8.8) (-15.6, 0.3,  9.4) (-16.0, 0.3, 11.0)
```

One pile, one tick, nothing new near it. That makes it internal to the step.
The step's levers are the internal rigid correction (`internalCorrectionLimit=1`
restores and re-resolves the whole rigid scene once) and the stress solve,
which in one capture **did not converge on 2,752 of 38,700 frames with zero
converged structures**. The stage-status line exists to tell those apart.

## A related fault, already fixed, worth knowing

The cannonball was a 0.3 m sphere of 10,650 kg — **94,167 kg/m³, four times the
density of osmium**. Mass and radius were independent settings that had drifted
into an impossible object, making every ball-vs-chunk contact a ~100:1 mass
ratio. The radius is now derived from mass and steel density
(`city_ball_density_kg_m3`), so the two cannot drift again; mass and speed are
untouched, so the momentum a shot delivers is unchanged.

This did not stop the explosions. It was still worth fixing, and the test
`the_cannonball_is_made_of_something_that_exists` keeps it honest.

## House rule: no clamps

`maxDepenetrationVelocity` was added and then reverted on the owner's call. The
legacy Blast path does cap it at 1 m/s (`destruction.cc`) and the native path
does not, so reaching for it is tempting. Do not: it hides a consequence and
leaves the cause in the scene, and a simulation that needs a limiter to stay
stable is not simulating. Removing a body that has left the world is a world
boundary and is acceptable; clamping a physical quantity inside the world is
not.

`PxDestructionScene` has **no removal entry point** today, and fragment bodies
are scene-owned private actors — deleting one behind the stage's back risks its
chunk/slot bookkeeping. The GPU side is ready for it: `PxgDestructionEditKind::
DestroyChunk` is already validated in `validateTransaction`, applied in
`editTransaction`, and flows through the topology rebuild. It is the stage's own
crush path. What is missing is a CPU-side producer, and the insertion point is
clean — each frame `PxgDestructionRuntime.cu` does `memset(count,0)` then
`emitTopologyEdits` appends with `atomicAdd`, so CPU edits can pre-seed the
buffer and the count.

## A stage stuck at frame zero

Different fault, same family, and the quietest one in the system. A stage that
never reaches frame 1 publishes nothing ever: the city cannot be broken,
`clearStress` refuses because of that state so it cannot be reset either, and
tick rate, player count and client agreement all look healthy. It ran for
4,560 and 19,590 consecutive ticks on the live server before a human noticed
the buildings had stopped falling down. `stuck_at_frame_zero` counts it. A
reset no longer gives up when `clearStress` refuses: since 98bf2285
`CityRuntime::reset` rebuilds the city anyway and leaks what the stage kept.

## On a Mac

The forensics above live in `destruction/src/native_runtime.rs` and the bridge,
so the log lines, spans and `stuck_at_frame_zero` are the same on Metal. The
CUDA tooling is not.

**What a GPU fault looks like.** A bad device address on Metal is a command
buffer page fault. CuMetal prints `cumetal: MTL command buffer error: ...` on
stderr and maps it to `cudaErrorIllegalAddress` (700), so PhysX's
"previous CUDA errors" lines, the bridge's lost-context detection and exit 70
follow as on Linux. The failure is reported when the command buffer
completes, which is usually a later wait, not the launch of the kernel that
faulted. There is no supervisor on the Mac: `play-server.sh` does
not restart the server; it exits and releases the GPU lock.

**Absence of a fault proves less on Metal.** `heightfield_edge`'s
`a_ball_rolling_off_a_heightfield_edge_faults_the_gpu` prints "no fault: the
heightfield edge did not reproduce it here" on Metal (2026-09-25, package
b5b18ecb), yet the fork's `convexHeightfield.cu` still calls `getTriangle` on
the boundary index unguarded. The out-of-range read presumably still happens
and just did not land on an unmapped page (inferred, not traced). A
reproducer that passes on Metal does not clear a kernel.

**Instead of `compute-sanitizer` and `CUDA_LAUNCH_BLOCKING`** (neither exists
here), CuMetal has:

- `CUMETAL_SYNC_EACH_LAUNCH=1`: synchronize after every launch, so an error is
  reported at the launch that caused it. The analogue of
  `CUDA_LAUNCH_BLOCKING=1`, and just as slow. (Read from the cuda-metal
  source; not exercised on a fault while writing this.)
- `CUMETAL_TRACE_COMMITS=1`: a line per command buffer with the kernels in it,
  so the buffer that failed names its candidates.
- `CUMETAL_TRACE_SYNC=1`: a line per host wait that blocked, with its reason:
  which sync reported the error.

**Reproducers** are bridge tests, run under the GPU lock with
`-- --ignored --nocapture --test-threads=1`; no library path is needed (the
binary has an rpath into the package). `VIBE_CITY_BALL_TRACE=1` works the
same. `VIBE_PHYSX_FAKE_CONTEXT_LOST=1` exercises the exit-70 path without a
fault.
