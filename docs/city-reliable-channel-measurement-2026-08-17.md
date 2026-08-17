# Where the city's bytes actually go: the reliable channel is 15%, not 57%

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
