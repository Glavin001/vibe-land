# Direct GPU motion with native sleeping: implemented prototype

A later [city integration checkpoint](direct-gpu-city-integration-2026-09-05.md)
adds host observation and contact routing. The measurements below describe this
earlier prototype and do not establish the later adapter's performance.

The narrow engine extension proposed in [the sleeping analysis](direct-gpu-sleep-2026-09-05.md)
is implemented and tested in the dependency repository. It retains GPU motion
and native sleeping, including contact, support-loss and joint wake propagation.
The current `/city` deployment still uses its ordinary GPU path. Enabling Direct
GPU there requires the remaining query, stress-support and full rollback work
listed below.

## What changed

The dependency packages an opt-in PhysX 5.10 source patch, a pinned SDK builder,
a GPU activity command adapter, logical activity support in the device motion
checkpoint, correctness tests, and a fifth arm in the activity benchmark. This
repository adds `scripts/gpu-activity-campaign.py` and strict result-parser tests.
Both repositories use branch `codex/simulation-frontier`. The dependency
implementation is commit `bf171e5e930f56a1c619981bd46a8e2714c8ae38`.

The engine reads back eight bytes of native sleep metadata per solved body at
an existing fence while keeping poses and velocities on device. For that body
readback path, ordinary GPU copies 32 bytes of velocities, 32 bytes of aligned
pose and eight bytes of sleep state: 72 → 8 bytes, an 88.9% payload reduction.
This is source-derived accounting for those arrays, not measured total PCIe
traffic. Other activity, topology and bounds transfers remain.

Native sleeping already computes eligibility on the GPU. The extension reconnects
that metadata to CPU island bookkeeping so sleepers leave active solver work.
It imports only sleep flag bits, prevents stale CPU pose/cache writes, and skips
scene-query freeze arrays that Direct GPU does not copy. Sparse transition work
zeros device velocities/forces and restores the existing pre-step solver pose
when island deactivation overlaps integration. Device pose setters refresh GPU
shape bounds. These corrections preserve the native wake response; they do not
approximate sleepers as permanently immovable objects.

Testing also exposed a removed-body lifetime defect. A pending metadata update
could retain a pointer to freed `BodySim` storage. Reusing that storage for a
fragment let the stale update consume the fragment's first-upload flag, yielding
NaN motion in Direct GPU. Removal now invalidates that pointer; a single upload
compaction pass drops retired entries. Insertion preserves first-upload state
even when an index already has a queued entry.

The patched CPU engine loads a distinct `libPhysXGpuActivity_64.so`, preventing
accidental loading of a stock GPU module. The original SDK is untouched. The
builder records the pinned NVIDIA base, patch hash, toolchains and library hashes.

## Correctness evidence

Five GPU CTests pass: activity/native equivalence, device motion checkpoints,
GPU contact-to-stress, device stress inputs, and CUDA stress equivalence. The
activity suite additionally passes Compute Sanitizer memcheck with zero errors.

The native comparisons cover 221 body samples: commands/metadata, impact wake,
support removal, joint wake, repeated explicit sleep/wake and actor replacement.
Maximum position difference is `3.58129e-7 m`; impact, support removal, explicit
cycles and replacement match exactly in these fixtures. Independent assertions
check zero sleeping velocities, cancellation of pending force/torque, producer
CUDA-event ordering, batch rejection before wake, actor reinsertion/replacement,
logical checkpoint activity, and rejection of unsupported articulations.

The existing contact-to-stress test completes 27 submissions with momentum error
at most `2.68247e-7 kg m/s`. A separate 5,000-body motion checkpoint run averages
0.0420 ms capture / 0.0463 ms restore over 100 repetitions. The adapter and
benchmark also compile against the stock SDK. Six Python tests verify complete
samples, missing/duplicate rejection, finite timings, population consistency,
percentile calculation and command-cost accounting. The engine patch applies
cleanly to a fresh checkout of its pinned base.

## Matched performance

RTX 4090, driver 595.71.05, CUDA 12.8.93, PhysX 5.10 base
`3ca45ad36e9755f7c8c5bea9f7c57d308d9f0c54`. All five arms use the same patched
SDK build, fresh scenes, identical unit cubes/masses/inertias, TGS, stabilization,
zero aerodynamic damping, and a 1/60-second timestep. Three trials rotate mode
order. Each trial measures 300 airborne, 300 resting and 60 mass-wake steps after
warmup. Every body's motion and expected activity are validated outside timing.
The verified all-awake control uses the existing long-counter fixture; the
flag-only arm remains diagnostic because of the stock disable-sleep inconsistency.

| Mode | Moving mean / p99 ms | Resting mean / p99 ms | Wake interval mean / p99 ms |
|---|---:|---:|---:|
| Ordinary GPU, native sleeping | 0.4586 / 0.5454 | 0.1030 / 0.1509 | 0.5723 / 2.0118 |
| Ordinary GPU, verified awake | 0.4672 / 0.5679 | 0.4000 / 0.4509 | 0.4794 / 1.2896 |
| Stock Direct GPU behavior | 0.3945 / 0.4650 | 0.4031 / 0.4609 | 0.4368 / 1.2447 |
| Ordinary GPU, flag-only diagnostic | 0.4629 / 0.5446 | 0.3401 / 0.4892 | 0.4983 / 1.4581 |
| **Direct GPU with native sleeping** | **0.4162 / 0.4970** | **0.1080 / 0.1464** | **0.5278 / 1.7885** |

The extension saves 9.2% of mean moving-step time versus ordinary native sleeping
and 10.9% versus the verified awake control. Resting work is 3.73 times cheaper
than stock Direct GPU, with a roughly 0.005 ms mean overhead versus ordinary
native sleep. It retains an activity-management cost versus all-awake Direct GPU.

Command submission is excluded from table step timings and recorded separately.
The first mass-wake tick **including** submission costs 2.419, 2.481 and 2.139 ms
for the extension versus 2.295, 2.542 and 2.006 ms for ordinary native sleep.
These are three events, not a tail distribution. The table pools nearest-rank
p99 across 900 moving/resting samples and 180 wake samples per arm. No whole-city,
dense-pile, vehicle, networking or destruction-throughput improvement is claimed.

Artifacts are in `bench-results/simulation-frontier/gpu-sleep-prototype-v2/`:
raw `frames.csv`, per-trial logs, CTest and memcheck logs, build logs and
`summary.json`. CSV SHA-256:
`28f8f5a84a977d4cc4c7a8a0e938d0232e907a05eb22da7b264f7c24ffcee30f`.
Engine patch SHA-256:
`98a99c6d708e0bdbe59183634fb9926c7b492dff2719ceb372d940f025bc72a7`.
An earlier campaign stopped at the actor-replacement correctness failure before
benchmarking; its directory is retained separately and is not a performance result.

## Reproduce and production boundary

Build the SDK with the dependency's
`tools/scripts/build-physx-gpu-activity.py`; its `patches/physx/README.md` specifies
the ownership and API contracts. Then, from this repository on an idle GPU:

```sh
python3 scripts/gpu-activity-campaign.py \
  --dependency /root/workspace/blast-stress-solver-2 \
  --sdk /root/workspace/physx-gpu-activity/physx \
  --output bench-results/gpu-sleep-run --bodies 4096 --trials 3 --memcheck
```

The runner refuses competing compute clients and existing output directories.
It verifies SDK artifact hashes and never manages the live deployment. This
campaign paused only the healthy, idle checkout-owned server and restored its
same executable/environment afterward. Public HTTPS and a local browser
WebTransport check pass; the browser renders 96,420 chunks with no hash mismatches
or orphaned chunks. This verification does not establish external public UDP
reachability.

Before `/city` can opt in, its CPU motion/query consumers, kinematic freeze path,
GPU contact ownership, persistent structural support evidence, and commit-only
streaming need integration tests on the new ownership model. Motion plus logical
sleep counters are not a complete checkpoint: force accumulators, sleep-energy
history, contact caches, generation-bearing actor identity, fracture topology and
support relationships must participate in full replay. Public GPU indices can
be reused; callers must invalidate the current helper around topology changes.

Articulations are rejected by the prototype. Kinematic transitions, vehicles,
fast projectiles, dense contact piles, full support cascades and matched city
whole-tick p99/backlog remain production qualification gates. Fully GPU-owned
islands may improve the remaining activity cost, but that is a further engine
architecture change. This prototype establishes a measured intermediate path
with native sleeping and GPU-owned motion at unchanged solver/material settings.
