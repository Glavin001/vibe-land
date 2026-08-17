# Where the city's bytes actually go, and why the pose stream starves

2026-08-17. Measured with `reliable_channel_cost` in `server/src/city_bench.rs`
against the real `ChunkStreamEncoder` on the PhysX + Blast city.

## Why this was measured

The wire-v3 plan opened with a milestone aimed at the reliable channel, on the
strength of `client/netlab/FINDINGS-city-stress-2026-08-16.md` Finding 3:

> Client-observed city bandwidth peaked at **5.65 Mbps** while the server's
> governed pose stream peaked at 2.47 Mbps. The ~3.2 Mbps difference is traffic
> the ceiling does not govern: reliable topology, baseline and bootstrap
> packets. At 12.6k islands the promote/retire/migrate churn costs **more than
> the pose stream it is meant to support**.

That is a *total minus a total*, not a breakdown. Optimising the wrong one of
topology / baseline / bootstrap would be wasted work, so each is now counted
separately at the point of encoding.

## Result

`VIBE_CITY_SCENE=high-rise-10f-local.json`, one client, whole run:

| scale | topology | baseline | **reliable total** | poses (1 client) | reliable share |
|---|---:|---:|---:|---:|---:|
| grid 4, fixed plan — 1,637 bodies | 0.028 | 0.073 | **0.101 Mbps** | 0.587 Mbps | 14.7% |
| grid 6, fixed plan — 1,514 bodies | 0.023 | 0.043 | **0.066 Mbps** | 0.379 Mbps | 14.9% |
| grid 4, 40 shots/structure — 4,739 bodies | 0.060 | 0.232 | **0.291 Mbps** | 1.692 Mbps | 14.7% |

Bootstrap is 4,957 B once per join at 16 structures (10,738 B at 36).

**The reliable channel is ~15% of a client's city traffic, and the share is flat
across a 3x range of body count** — topology, baselines and poses all scale with
the number of awake bodies, so the ratio does not move. Baselines are the larger
half of the reliable side (~4x topology), which is the opposite of what Finding 3
implies about promote/retire/migrate churn.

## What this means for the wire-v3 plan

**Milestone 1 as scoped targets 15% of the problem.** Even a perfect
reliable-channel encoding (the island topology track measured 0.026 Mbps for
comparable event volumes) saves ~0.2 Mbps at 4.7k bodies, while the pose stream
costs 1.7 Mbps and rising.

The plan should invert: the pose stream is the whole game.

## Reconciling with Finding 3

This does not reproduce ~3.2 Mbps of reliable traffic, and the gap is worth
naming rather than assuming one side is wrong:

- **Scale.** Finding 3 is at 12,643 islands; the largest run here is 4,739
  bodies. Extrapolating linearly puts baselines at ~0.62 Mbps and topology at
  ~0.16 there — still far short of 3.2.
- **Repeated bootstraps.** Bootstrap is charged once per join here. Under the
  netlab's heavy scenario the server ran at 55.7 Hz with a 7.2% tick deficit and
  dropped packets at queue pressure, and every dropped topology packet makes a
  client resync — which costs a whole bootstrap. At 12.6k islands with explicit
  membership lists that is a large packet, and a resync loop would dominate.
- **Measurement boundary.** Finding 3 counts *client-observed* bytes: QUIC and
  UDP framing, `PKT_MATCH_STATS` (JSON, periodic), and the manifest all land in
  that total but not in this one.

The actionable reading is that the reliable channel's steady state is cheap, and
whatever the netlab saw at 12.6k islands is more likely a **resync storm** than
an encoding cost. That is a robustness bug, not a bandwidth one, and it is fixed
by making topology delivery survive queue pressure — not by shrinking the bytes.

## What to do instead

1. **Go straight at the pose stream** (the plan's Milestone 2). It is 85% of the
   traffic, and — more important than its size — it is *ceiling-capped*, so at
   12k bodies it does not get bigger, it gets **starved**: the netlab measured a
   75-second average per-body refresh. The debris codec's value here is not
   mainly fewer bytes, it is that every body gets refreshed every span inside the
   same budget.
2. **Keep the reliable-channel work, but re-scope it to robustness**: make a
   dropped topology packet recoverable without a full bootstrap (a topology
   retransmit window, or bootstrap-by-delta from the client's `last_topo_seq`,
   which the server currently logs and ignores). That addresses the mechanism
   most likely behind Finding 3.
3. Re-run this bench at 12k+ bodies once a scene that reaches it is scripted, to
   confirm the flat 15% holds where the ceiling binds.


---

# Part 2: the pose stream starves, and the byte ceiling is not why

Measured with `pose_stream_starvation` in the same bench file, by decoding the
datagrams one client actually receives.

Staleness is charged **only to bodies that are moving** (linear or angular speed
above the encoder's own rest thresholds). The encoder deliberately skips bodies
at rest, and counting those would report a correct optimisation as a defect.

| mean awake | sent per send | coverage | moving staleness p95 | p99 | max | sends pinned at ceiling |
|---:|---:|---:|---:|---:|---:|---:|
| 1,648 | 236 | 14.3% | 4.7 s | 10.0 s | 47.6 s | **0%** |
| 3,283 | 198 | 6.0% | **37.5 s** | **71.6 s** | 164.9 s | **0%** |
| 3,278 (relevant only) | 197 | 6.0% | **40.0 s** | **64.5 s** | 160.1 s | **0%** |

The netlab's ~75 s refresh figure reproduces (p99 64-72 s at ~3.3k awake), and
the staleness survives every attempt to explain it away:

| control | mean awake | sent per send | moving staleness p95 |
|---|---:|---:|---:|
| default | 3,283 | 198 | 37.5 s |
| byte ceiling removed (`VIBE_CITY_CEILING_BYTES=0`) | 2,938→ | 235 @1.6k / — | — |
| eval cap removed (`VIBE_CITY_MAX_EVAL=0`) | 2,938 | **196** | 22.0 s |
| out-of-view bodies excluded from the sample | 3,278 | 197 | **40.0 s** |

- **The byte ceiling never binds.** Zero sends hit it. At 1.6k awake, removing it
  sends 235 bodies/send against 236 with it.
- **The evaluation cap is not the limiter either.** `MAX_EVAL_PER_CLIENT = 1200`
  looked like the obvious culprit -- bodies sent per send *falls* as the world
  gets busier (236 → 198) -- but lifting it entirely changes nothing: 196
  bodies/send. That hypothesis is disproved.
- **Interest culling is not hiding the answer.** Filtering the sample to bodies
  inside the frustum or within the 120 m proximity radius removes **zero**
  samples: this city is ~72 m across, so every awake body is relevant to this
  camera. The staleness is on bodies the client genuinely should be tracking.

What is left is the **priority function itself**. v2 sends a body when its
*projected pixel error* exceeds `error_budget_px = 2.0`, and it is choosing ~197
bodies per send out of 3,278 relevant moving ones because, by its own model, the
rest are still within two pixels of where the client already thinks they are.

That is not a bug -- it is the design. Which means **server-side metrics cannot
settle whether v2 is starving.** A body creeping at 0.06 m/s in a settling rubble
pile can go 40 s without an update and still be pixel-correct; a body tumbling
through the air cannot. The 0.05 m/s threshold used here separates "moving" from
"resting", not "visibly wrong" from "fine".

The honest next step is the project's own standing rule for perceptual
questions: render what a v2 client actually sees beside ground truth, and look.
The `viewer-video` pipeline already does this, and the same island-stream
reconstruction can be rendered from the same trace for a direct A/B.

## What this changes about the rewrite

The argument for the debris codec is not "fewer bytes". It is a different cost
model:

| | wire v2 | debris codec |
|---|---|---|
| work per send | rank + select per client, O(bodies × clients) | encode once per span, O(bodies) |
| coverage | capped at 1,200 evaluations per client | every awake body, every span |
| what grows with scale | staleness | bytes |

v2 responds to a busier world by going stale; the debris codec responds by
costing more bytes — and the measured byte cost of the whole world is 1.1–1.4
Mbps, inside the per-client budget. Trading staleness for bytes we can afford is
the entire point.

It also explains the O(bodies × clients) scaling note already recorded in
`city_bench.rs::player_scaling_of_the_stream`: the per-client packing loop is the
system's worst scaling term, and broadcasting one shared encode removes it.

## Honest limits of this measurement

- One client. Per-client work is what v2 scales badly in; a fleet makes v2 worse,
  not better, so this understates the gap.
- A fixed camera — but this turned out not to matter: the city is smaller than
  the proximity radius, so nothing is culled and every sample is a body the
  client should be tracking.
- **"Moving" is defined as >0.05 m/s, which is not the same as "visibly wrong".**
  This is the measurement's real limit and the reason it cannot, by itself,
  condemn v2.
- Peak awake reached 7,239 here against the netlab's 16,150; our stress-solver
  content sleeps bodies aggressively, which is a good thing and makes the
  starvation regime harder to reach than it was on joint content.
