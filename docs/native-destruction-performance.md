# Where a native-destruction tick actually goes

Measured on an RTX 4090, CUDA 12.8, `fractured-downtown` at grid 1
(24,105 chunks, 74,543 bonds), physx-2 SDK `sdk-converge`. Every number here
came from a run, not from reading the code. Set `VIBE_PHYSX_PROFILE=1` to get
the engine's own instrumentation as `destruction/*` spans in match stats and in
debug reports.

## The one number that matters

`GpuDestruction.cuda.stress` is the stress solve on the GPU, timed by CUDA
events straddling that phase inside `PxScene::simulate()`. From a live session
under heavy fire, a 40.37 ms step:

| phase | ms | share |
|---|---:|---:|
| PhysX step, host wall | 40.37 | 100% |
| GpuDestruction.finishAndReserve | 37.95 | 94% |
| ↳ finishDetail.waitForGpu | 37.94 | 94% |
| ↳ cuda.stress, device | 37.89 | 94% |
| task.prepareIslandRepair | 1.13 | 3% |
| our own observation work | 0.99 | 2% |

The host wait and the device phase agree to 0.05 ms: the CPU is doing nothing
but blocking on one kernel. The stage's other four CUDA phases together are
0.15 ms:

| device phase | ms |
|---|---:|
| stress | 10.828 |
| commitAndStressTopology | 0.045 |
| topologyAndCandidates | 0.035 |
| contactLoads | 0.033 |
| materials | 0.032 |

Fracture evaluation, topology edits and commit are free. Rigid-body physics is
free. Only the solve costs anything.

## The cost model

For a single impact, with the whole tick measured:

| iteration cap | iterations used | stress ms | ms per iteration |
|---:|---:|---:|---:|
| 8 | 8.0 | 2.31 | 0.289 |
| 16 | 16.0 | 2.67 | 0.167 |
| 64 | 56.5 | 6.85 | 0.121 |
| 128 | 99.6 | 11.59 | 0.116 |

That fits `1.5 ms fixed + 0.101 ms per iteration`. One iteration touches roughly
5 MB, which the card should stream in about 6 microseconds, so the solve is
nowhere near bandwidth bound. It is dominated by per-iteration synchronisation
in the cooperative kernel, and the marginal iteration is therefore expensive out
of all proportion to its arithmetic.

Per-iteration cost also rises about 4.5x as the city fragments, at a constant
bond count: 0.121 ms at 41 components against 0.548 ms at 859. The mechanism is
not identified. See the dead ends below for what it is *not*.

## Reproducing the bad case

`VIBE_CITY_BENCH_CANNONBALL=1` on `sustained_fire_survives_a_rejected_step`
fires the heavy ball instead of the rifle. The rifle settles the city into
sleeping rubble quickly; the ball keeps hundreds of bodies moving, which is the
regime a player actually produces and the only one that reproduces the live
40 ms ticks headlessly.

```bash
VIBE_CITY_BENCH_CANNONBALL=1 VIBE_CITY_BENCH_SHOTS=160 VIBE_PHYSX_PROFILE=1 \
  cargo test --release -p web-fps-server \
  --features cuda-stress,blast-core,native-destruction \
  -- --ignored --nocapture --test-threads=1 sustained_fire_survives_a_rejected_step
```

In that regime, the whole server tick against the iteration cap:

| cap | whole tick | stress | bonds broken |
|----:|-----------:|-------:|-------------:|
| 16 | 10.3 ms | 7.3 ms | 4,359 |
| 24 | 15.3 ms | 12.2 ms | 4,245 |
| 32 | 20.2 ms | 16.0 ms | 5,792 |
| 48 | 28.2 ms | 24.8 ms | 4,940 |
| 64 | 29.0 ms | 25.5 ms | 5,971 |

16 is the shipped default: the only measured point that holds 60 Hz while the
city is coming apart. Bond counts are chaotic rather than monotone, because a
slightly different force field sends the collapse somewhere else.

## Dead ends, so they are not tried twice

**Settled-island skipping is already on.** `ExtStressGpuSolveParams::skipSettledIslands`
looks like the obvious fix and is not: `solveDeviceAsync` rejects any call with
it set, so enabling it fails the solve from the first frame with stage error bit
4. But the resident path already has a strictly stronger device-side equivalent,
`NativeSettledCache` with `beginNativeSettledReuse`, which runs unconditionally
whenever device topology is enabled and which the persistent kernel honours. The
flag only adds the *host* half, the compacted active lists, which the resident
path cannot build without a host sync it exists to avoid. The flag is left in
place, off, behind `PHYSX_DESTRUCTION_SKIP_SETTLED`.

**The independent-component grid is not the bottleneck.** Small components go
through `componentStressSolve` with a work-stealing cursor, at two blocks per
SM. That looked like an arbitrary cap serialising 859 components through 256
blocks. It is not arbitrary: it is the kernel's measured residency. Sweeping 1,
2, 8 and 32 blocks per SM against a city at 859 components moved the stress
phase by less than 0.2% (33.40 / 33.25 / 33.28 / 33.25 ms). The fragmented
city's time is in the large-component cooperative solve, not here.

**Iteration budget above 64 buys nothing.** The solve converges before the cap,
so a larger budget costs more only on the ticks that fail to converge. 256 and
1,024 produce identical destruction to 64 and cost twice as much.

## Known engine defects hit along the way

- A solve that ran out of iterations used to fail the whole simulation step.
  Removed (`requireNativeConvergence` in `PxgDestructionRuntime.cu`). A tick
  that runs out of budget now keeps its warm-started iterate and refines it next
  tick, which is what makes a low cap safe.
- Scene queries could dereference a null hash entry when a chunk shape migrated
  onto a stage-owned fragment body, segfaulting inside `fetchResults`. Fixed in
  `GuActorShapeMap` and `ScSqBoundsManager`.
- On `skyline-stable` the first solve must converge or the resident stress
  topology update fails with error bit 64 and never recovers. Which iteration
  caps start that scene is erratic (16 starts, 32 and 64 do not), so re-measure
  rather than reasoning about it.

## QA without a human

Two tools, because they answer different questions and neither can answer the
other's. The headless runner is the authority on what the physics did; the
browser tool is the only thing that can say whether any of it reached a screen.

**Headless scenarios.** `scripts/qa.sh` drives production's own entry points --
the same player tick, shot routing and arena step the server runs -- from a
line-based script. Vocabulary in `server/src/city_qa.rs`.

```bash
scripts/qa.sh scenarios/impact.qa
scripts/qa.sh -e 'look 0.8 0; probe; report'    # inline, ';' separates lines
```

The command that matters is `verify-aim <structure> <node>`: it fails unless a
ray from the player's eye actually reaches that chunk. Shots that reach nothing
still produce excellent frame times, which is how a broken aim survived for
hours. `probe` names whichever chunk the current aim reaches, which is how you
find a target id without guessing at one. A run reads:

```text
  ok   line 11  aim 0 5810              chunk 0:5810 at [-59.8, 1.6, -28.5], 40.6 m away
  ok   line 12  verify-aim 0 5810       ray reaches 0:5810 at 40.5 m
  ok   line 14  fire ball               cannonball away
  ok   line 17  expect-detached 0 5810  chunk 0:5810 changed owner 2147483648 -> 2147483649
  ok   line 18  expect-bonds 1          71 bonds broken since the last check, wanted 1
```

**Browser.** `client/e2e/qa-shot.mjs` joins, aims, fires and photographs the
result, on the shared join helper in `client/e2e/helpers/qaSession.mjs`. Use it
whenever the claim involves rendering: a projectile can be perfectly correct on
the server and never drawn, which happened, because the client learns a dynamic
body's shape from one metadata packet sent at join.

```bash
node client/e2e/qa-shot.mjs --cannonball --look 0.8,0 --shots 2 --out /tmp/qa
```

**Known gap.** The browser cannot yet name the chunk under its own crosshair,
so client and server cannot be compared directly on where a chunk is. The
client has the data (`CityTopology.chunkWorldPoseInto`), but the city client is
not reachable from the e2e bridge; it needs a small module-level registry set
where the layer already holds it. That comparison is what would turn "desync
repairs 29" from a number into a diagnosis.
