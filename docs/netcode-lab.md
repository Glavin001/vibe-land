# The netcode lab: two ways to stream destruction, one scorecard

Massive-scale destruction is where this game's bandwidth goes. In most
shooters player state is the bulk of what is synced. Here the environment is:
thousands of chunks breaking off, falling, colliding and settling. This lab
answers which way of syncing that state serves players best, and at what cost.
It does so with measurements that hold from build to build, not with opinions.

The plan it serves is the destruction netcode spec (2026-10-10) and its
milestones; the approved plan is `~/.claude/plans/goal-develop-the-best-adaptive-emerson.md`.

## Two approaches, one goal, one yardstick

| | Shared world (wire v2, production) | Per player (wire 4, the spec) |
|---|---|---|
| Records | Encoded once, identical bytes for every client (MoQ-publishable) | Per client, against what that client acknowledged |
| Selection | Per client, under one ceiling | Per client, by the perceptual penalty the record removes per byte |
| Egress | Publish once, fan out | Sum of unicast streams |
| Code | `ChunkStreamEncoder` via `replication::SharedV2` | `replication::PerPlayer` (milestone 6) |

Both implement `vibe_land_destruction::replication::ReplicationStrategy`, and
the live server and the lab drive that same trait. They share one goal:
efficiently sync massive destruction to every player. They are therefore
judged by the same scorecard, computed from **each player's own camera**:

1. **Integrity gates first**, then fairness.
2. **Noticed artifacts**, weighted by what human vision catches: pops,
   contact timing, gravity, energy, smoothness, then steady error.
3. **Cost** last.

A shared stream gets no credit for representing parts of the world that no
player is looking at.

## What the lab holds fixed

`netlab2 city` (`server/src/bin/netlab2/city_lab.rs`):

- **Truth.** One city capture: the encoder tape (every awake island's pose
  every tick, every fracture, settle and wake), the manifest and the encoder
  checkpoint. The physics is not deterministic, so it is recorded once and
  every comparison replays the same tape.
- **Players.** N clients, each with a camera: a recorded player's track or a
  generated script (`destruction/src/netlab/cameras.rs`: static, walker,
  orbit, `facing` a target, `flick`, `pan`, `strafe`, `zoom`, `peek`).
  Scripted cameras run on the run's own clock (seconds from the capture's
  first tick).
- **Links.** netlab2's QUIC model per client (`link::LinkSim`, seeded per
  client; docs/netlab-v2.md "The link model"). The downlink is queued as
  production's sender queues it. An uplink on the same profile carries the
  client's datagram acks (newest ordinal plus a 64-bit mask, 30 Hz), so a
  strategy that listens learns what arrived when a real server would.
- **Budget.** Production's per-link rate controller (`link_rate.rs`), and
  optionally the spec's burstable token bucket
  (`replication::TokenBucket`, `--budget-kbps`). A client gets the tighter of
  the two (decision D9). Every byte spends from the bucket, reliable ones
  included, and records get what the trailing second leaves of the peak.
- **Client.** The production client, headless (`client/netlab/v2/clientStage.mts`),
  on a tape of exactly what arrived. It draws at 60 frames/s and writes every
  chunk as the city layer draws it (`drawn-chunks.bin`).
- **Score.** Every chunk drawn vs truth (`chunks.rs`), per client and pooled,
  plus bytes per client and the gates.
- **Clock.** Ideal: ticks exactly 1/hz apart. Every client joins cold at the
  first tick with the strategy's join message.

Runs are deterministic: the same inputs give byte-identical tapes.

```bash
CARGO_TARGET_DIR=/Users/glavin/Development/vibe-land/target/nds \
  cargo build --release -p web-fps-server --bin netlab2
N=/Users/glavin/Development/vibe-land/target/nds/release/netlab2
# a capture dir (VIBE_CITY_TAPE_OUT) or a session bundle's server/city
$N city --capture <dir> --out <run> --clients 4 --link lte --seed 1
$N city --bundle <session bundle> --out <run> --camera 'facing:target=0,10,0;dist=30' \
   --camera 'flick:eye=0,1.6,40;look=0,10,0;at=5;turn=180;ms=100' \
   --budget-kbps 512 --burst-kbps 1536 --burst-s 3
# --no-client: the server stage and links only (seconds); --jobs N client stages at once
```

A run directory holds `scorecard.json` / `scorecard.md`, and per client `cNN/`:
`lab.vltape`, `stream.json`, `timeline.json`, `drawn-chunks.bin`,
`client-stats.json`.

## Gates measured so far

| Gate | Status |
|---|---|
| G1 structure hash | Measured: the client's hash mismatches across every client, 0 to pass |
| G2 event ordering | Pending: needs the client's applied-event log (milestone 3) |
| G3 bandwidth cap | Measured with a bucket: no client's busiest trailing second over the peak |
| G4 solid geometry | Pending: needs the static occupancy grid |
| G5 resurrection | Pending: settle-aware chunk scoring. A body moving after its SETTLE without a later WAKE fails (D13) |
| G6 server time | Pending: strategy timing in the lab (milestone 8) |

## Decisions (from the plan, with the owner)

- **D2: both approaches.** Per player is built new, beside the shared stream,
  squeezing every per-player advantage. Neither is mutated toward the other.
  The lab compares them.
- **D3: large corrections snap** (over 5 m). The owner judged the glide in play:
  "not really better" (`presentation.ts` `GLIDE_LARGE_CORRECTIONS`). Small
  corrections follow the spec's rules.
- **D8: body ids.** Per player uses the lowest chunk id with bonds-only
  fracture events, checked by a server-side derive-and-compare. v2 keeps its
  serials.
- **D9: budget.** The spec's bucket is an extra cap under the link controller.
  Production's 2.5 Mbit/s ceiling stays the default until the scorecard says
  otherwise.
- Repo lessons carried as the per-player starting defaults, each a lab
  parameter:
  - D1: 60 Hz;
  - D4: debris drawn ahead within received data;
  - D5: present-time only for blocking bodies near a player;
  - D6: topology datagram copies, stopped once acked;
  - D7: acked baselines;
  - D10: group keyframes last;
  - D11: no hidden-body trickle without a measurement;
  - D13: G5 respects WAKE;
  - D14: no client-only pieces;
  - D15: adaptive delay off.
- **Physics-driven deviations from the spec:**
  - contact keyframes are tick-aligned (PhysX resolves contacts at step
    boundaries);
  - spin is constant-ω (the server has no gyroscopic forces);
  - crushes, missed-frame rebuilds and floor retirements get explicit events.

## Bodies from broken bonds alone (D8, measured)

`derive-check --capture <dir>` (`destruction/src/bin/derive-check.rs`)
replays a capture's structural truth from its checkpoint ledger. After every
fracture batch it derives the structure's bodies the way a bonds-only client
would:

- flood fill over intact bonds;
- a component holding a support chunk is the standing structure;
- every other component is one body named by its lowest chunk.

It then compares the result with the islands the physics made
(`CityLedger::derive_check`).

On the systematic-2c-d1342419 capture (native backend, 314 s, 397 batches,
2,110 bodies at the end):

- **Split or merged: 0. Islands inside a standing structure: 0.** Every
  dynamic body PhysX made is exactly one connected component of the intact
  bond graph (35,897 matched checks).
- **Removed: 242 component-checks (22 components, 25 chunks at the end).**
  These are chunks the physics took away (crushed, retired at the floor)
  without breaking their bonds, so a bonds-only client would keep drawing
  them. The per-player wire carries them as an explicit removed-chunks event,
  as the plan's deviation 3 said.

## Truth and calibration

- **Server stage.** Captures from before binary manifest format 2 (2026-10-07)
  load through `DestructionManifest::matches_hash`, which also accepts the
  format-1 hash of a manifest with no centre-of-mass offsets. On the current
  tree, `netlab2 calibrate` on the 2026-09-24 systematic bundle reproduces the
  live city stream exactly: 12,077/12,077 datagrams and 3,085/3,085 topology
  messages byte-identical.
- **Client.** Its checks fail on that bundle because its live client is the
  2026-09-24 one. A bundle recorded on the current tree re-establishes them
  (`client/netlab/v2/record-bench.sh`).
- **Recording.** Fresh truth comes from scenario files (`scenarios/netcode/`)
  through `scripts/netlab/record-truth.py`: the live server with
  `VIBE_CITY_TAPE_OUT`, one parked bot to open the match, events fired over
  HTTP (`/city-demolish`, `/city-meteor`), and `/city-capture-stop`.

## First measurements

These are on the systematic-2c-d1342419 city capture (314 s, two recorded
players), with shared-v2:

| Link | Clients | Budget | kbit/s mean | Busiest 1 s | Debris p99 @render / @now | G1 |
|---|---|---|---:|---:|---:|---|
| loopback | 2 recorded | link only | 211.5 | 1963 | 0.179 / 0.85–0.88 m | 0 / 314 |
| lte | 2 recorded + 2 walkers | 512/1536 kbit/s bucket | 203.8 | 1536.9 | – | – |

## Limits

- **City traffic only on the link.** The player snapshot stream (about
  64 kbit/s idle) is not modelled beside it.
- **One link profile per run**, seeded per client.
- **Scoring is in world space.** Screen-space, visibility-aware, gravity,
  energy, contact and fairness metrics are milestone 3.
- **Resyncs a client asks for** are not yet served in the lab: a hash
  mismatch is counted, not repaired.
