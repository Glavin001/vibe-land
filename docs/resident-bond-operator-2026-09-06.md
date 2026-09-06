# Resident physical bond operator

Solver commit `f2ef3999` adds a reusable CUDA operator that retains the original
node/bond coupling and changes exact live-bond membership on fracture or rollback.
The current city still serves the qualified rooted-fragment repair, game
`ed9c2ad` / solver `646a0f41`, with Direct GPU enabled. This new operator is
linked into the standalone qualification harness, **not the game damage path**.

## What changed

`GpuBondOperator` computes `A x = B diag(live) B^T x` in double precision.
Every original bond keeps six output coordinates and a stable ordinal. Removal
sets its response to exact zero; restoration reinstates its original coupling.
No repeated subtraction from the assembled stiffness matrix occurs. Other
bonds, node masses, lever arms and normalization remain unchanged. A removed
bond's former response cannot survive in reused scratch memory.

Both sparse directions, the membership mask and intermediate responses remain
on the GPU. The caller supplies the CUDA stream/context; the operator creates
neither. Host membership updates validate the mask and finish its transfer;
device membership updates enqueue a device-to-device copy with no readback,
allocation or synchronization. The caller must order producers on other streams
with events. Applications are compatible with CUDA graph capture and the
existing solver's completion flag. Shared scratch means one instance requires
ordered calls; separate instances can use separate streams.

The class does **not** decide which bonds break, omit interactions, freeze
fragments or limit forces/velocities. It also does not maintain the current
component partition or rigid-motion projector. Those are separate, mandatory
integration work: a new physical operator alone cannot justify stale island
labels or reusing an obsolete free-body basis.

## Tests and measurements

All GPU commands ran in exclusive windows after compilation finished. The
wrapper stopped only the healthy, empty city and restored its exact binary and
settings afterward. No player session was interrupted.

The final kernel passed:

- **24 topology states** across small and building graphs: anchor removal,
  splitting, removal of every bond, restoration, partial damage, repeated
  transitions, zero input, and inputs scaled by 1e30/1e-30.
- Fresh CPU assembly after each transition, comparing both node response and
  original-order bond force/couple outputs. Stale-membership and half-response
  negative controls fail as required. Removed outputs are exactly zero.
- **16 resident CUDA solves**, plus **16 assembled-operator controls**, covering
  anchored/free buildings and float/double preconditioners. Independent physical
  force/moment residual and bond-response checks pass. A deliberately incomplete
  one-iteration resident solve fails.
- CUDA Compute Sanitizer on the small transition sequence: **zero errors and
  zero leaked bytes**. Completed-solve graph writes and empty/unbonded operators
  also pass. This is not a large-world concurrency stress test.

The building has 5,936 dynamic nodes and 18,627 original bonds. Transitions
include 1, 2, 8 and 5,936 exact components in the independently rebuilt CPU
reference. The GPU operator persists across every transition without recapture
or reallocating its 10,903,907 bytes. Membership updates transfer **18,627 bytes**,
not the coupling matrices. The reference still rebuilds components on the CPU;
this test does not demonstrate a production component-update algorithm.

The initial full-warp-per-row implementation passed correctness but added
about 1.1–1.2 ms to a solve. Most bond-transpose rows contain only a few nonzeros.
Selecting 4/8/16/32 threads per row from its maximum nonzero count removes wasted
lanes while retaining every coefficient. Both initial exploratory logs and
final source/binary hashes are retained; final qualification uses the narrower
thread groups.

Final RTX 4090 warm medians (last three of four zero-initial-guess solves):

| Graph / preconditioner | Assembled operator | Resident operator | Iterations |
| --- | ---: | ---: | ---: |
| Anchored / float | 5.918 ms | 6.004 ms | 34 |
| Free / float | 6.281 ms | 6.353 ms | 31 |
| Anchored / double | 10.668 ms | 10.752 ms | 34 |
| Free / double | 10.638 ms | 10.691 ms | 31 |

Force/moment residuals remain below 1.7e-11 in these solves. The resident path
still has a small solve-time cost; its benefit is updating the physical operator
without rebuilding/uploading it. These small timing differences are one-window
measurements, not statistically established universal overheads. They exclude
initial setup, topology tracking, load projection, hierarchy updates, game
damage/replay and streaming. **No city/full-tick speedup is claimed.**

## Reproduction and next work

Configure the solver's `demos/blast-stress-demo/build-gpu-activity` build; build
`resident_bond_operator_test` and `multilevel_gpu_test`. The former runs a small
fixture with no argument or accepts a BLSTPG01 physical graph input. The latter
adds `--resident-operator` to the preceding native physical graph qualification.
The committed evidence runner records all commands and expected exit statuses;
run it only through the existing exclusive GPU wrapper. Input generation is
recorded in `physical-graph-integration-2026-09-06.md` and
`multilevel-cuda-proof-2026-09-05.md`. The evidence verifier needs no GPU or server.

Next, pair resident membership changes with exact current components and
rigid-motion projections, then qualify reuse/update of the numerical hierarchy
against changing physical topology. The earlier 201–206 ms hierarchy setup
cost is still unresolved. The current full-solve harness builds an initial
hierarchy per process and does not yet run an end-to-end fracture solve sequence.
Production damage, same-tick replay, settling and streamed heavy-load tests
remain required before deploying this path.

The report inventory was also corrected: the later 23:45/23:48 captures were
local headless verification with missing city telemetry. They are not new user
play evidence. Schema 2 preserves that missing data and the actual release
identity; every measurement from the six earlier public-play reports is unchanged.
See the update in `city-player-reports-2026-09-05.md`.

Evidence is under `bench-results/simulation-frontier/resident-bond-operator/`.
The final restored city hash is
`9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1`.
No new server/frontend artifact was deployed. Both repositories have local
commits; the earlier private-source push approval rejection was not retried.
