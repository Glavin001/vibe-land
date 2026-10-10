# Shared world (wire v2) vs per player (wire 4): the head-to-head

This is milestone 7 of the destruction netcode plan (`docs/netcode-lab.md`).

Both netcodes have the same goal: sync massive destruction to every player
efficiently. Both are judged by one scorecard, computed from each player's
own camera:

1. **Integrity gates** (G1-G5) come first.
2. **Fairness** (F2/F3 sightlines) comes next.
3. **Noticed artifacts** are counted, each weighted by its class's severity,
   and reported as a penalty per client-minute. Lower is better.
4. **Cost** comes last.

**The perceptual model is still the uncalibrated literature seed.** The
calibration study is built (`netlab2 city-study`, the study page,
`scripts/netlab/fit-calibration.py`, `netlab2 city --model`) and waits on
the inspector. Q saturates at 0 in the heavy scenes, so the penalty is the
number to compare.

## Bottom line

- **Per player is better, with confidence.** Across 5 seeds the penalty
  ratio (paired bootstrap, 95% CI) is:

  | capture | shared v2 / per player | at bytes (v2 / per player) |
  |---|---|---|
  | wedge | **3.07x** (2.69-3.53) | 1.05x |
  | sustained | **2.91x** (2.67-3.22) | 0.97x |
  | meteor-volley | **5.52x** (4.17-6.92) | 1.05x |

  It also wins on cable (1.6-6.0x) and on poor-mobile (2.2-3.4x).
- **Integrity.**
  - **Per player** never applies an event early (G2), never resurrects
    settled debris on the standard runs (G5), and holds the budget (G3).
    It draws far less debris inside solid geometry (G4): 0-34 body-frames
    per run against v2's 0-2,925.
  - **Shared v2** applies 99% of fractures before the drawing reaches
    their tick (G2, by design). It shows settled debris moving again under
    load (G5: 9-23 frames on meteor-volley).
  - **Neither has G4 at zero yet.** Per player's remaining frames are rare
    and are what the adversarial search hunts for (below).
- **Fairness is mixed.**
  - F2 (a player's drawn debris blocks a sightline the truth does not, or
    the reverse) is lower for per player on most runs.
  - F3 (two players disagree about the line between them) is often lower
    for v2. Its players receive the same records, while per player tailors
    each stream to each camera.
- **Cost: per player spends 5-6x more server CPU per client.** Parallel
  sends (`pp.send_threads`, byte-identical) bring 64 clients on
  meteor-volley from 16.2 to 3.7 ms per tick.
- **Egress per client is about equal:** both send unicast today. Only v2's
  encode-once records could be fanned out by relays.
- **Per player plays live** in `/city` (`citypp-*` match ids, or
  `VIBE_CITY_WIRE=4`). On Metal: 957 bonds broken, about 270 chunks moving,
  0 of 96 structure hashes mismatched.

**Recommendation: make per player (wire 4) the /city default once the
calibration study has run,** with `pp.send_threads` sized to the server's
cores. Keep v2 for spectator fan-out through relays, and watch F3 as the
fairness number per player still has to win.

## Setup

- **Truth.** Three captures recorded on this tree (`scenarios/netcode/*.json`):
  - wedge: 2,881 ticks, up to 313 bodies;
  - sustained: 4,075 ticks, up to 505 bodies;
  - meteor-volley: 2,897 ticks, up to 1,717 bodies.
- **Players.** 4 per run, generated cameras (walkers on the ground,
  statics), seeds 1-5. Within a seed both strategies see the same cameras
  and the same link draws, so clients pair across strategies.
- **Links.** The lab's QUIC model:
  - **lte:** the default;
  - **cable:** 12 ms, 0.1% loss;
  - **poor-mobile:** 150 ms, 3% loss, 1 Mbit/s.

  Acks go upstream at 30 Hz on the same profile.
- **Budget.** 1024 kbit/s sustained, 3x for 3 s, under production's link
  controller.
- **Clients.**
  - **Shared v2:** the production TypeScript client, headless.
  - **Per player:** its Rust client core. The browser runs the same core
    as WASM behind `PerPlayerCityClient`, and gives the same penalty to the
    decimal (wedge: 145.246 both).
- **Knobs.**
  - **Shared v2:** production defaults.
  - **Per player:** `pp.tolerance_px` 2 (wedge, meteor-volley) or 1.5
    (sustained), with defaults otherwise:
    - 2 event copies within the allowance;
    - acked-baseline deltas;
    - mode backtest with support detection;
    - ground floor;
    - correction cost.

## Head to head (lte, seed 1)

| capture | strategy | kbit/s | penalty/min | debris p99 m | pops/min | contacts late/min | G2 early | G2 late | G4 frames (worst cm) | G5 | F2 / F3 per pair-min | send us/client |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---:|
| wedge | shared-v2 | 154.3 | 467 | 0.168 | 12.8 | 70.6 | 1020 / 1036 | 0 | 3 (5.4) | 0 | 1.60 / 0.00 | 5.5 |
| wedge | per-player | 140.1 | **141** | 0.146 | 10.6 | 10.0 | 0 | 31 / 4340 | 3 (5.6) | 0 | 0.37 / 0.73 | 29.8 |
| sustained | shared-v2 | 283.4 | 1336 | 0.209 | 48.4 | 226.8 | 2128 / 2140 | 0 | 227 (10.5) | 0 | 0.83 / 0.17 | 10.6 |
| sustained | per-player | 284.6 | **432** | 0.128 | 35.6 | 41.6 | 0 | 158 / 7888 | 3 (41.0) | 0 | 1.07 / 1.65 | 66.8 |
| meteor-volley | shared-v2 | 496.3 | 10525 | 15.95 | 1384 | 620 | 2939 / 2940 | 0 | 589 (140) | 23 | 4.29 / 2.69 | 52.1 |
| meteor-volley | per-player | 467.7 | **1333** | 0.322 | 64.9 | 114 | 0 | 1309 / 16428 | 4 (26.7) | 0 | 0.36 / 1.70 | 217 |

Notes on reading it:
- Per player sends bonds-only events, many and small, so its event counts
  are larger.
- "G2 late" means applied after the drawing passed the event's tick. That
  shows as a snap, and it is reported, not a failure.
- Per player also lands bodies on their settle pose 54-447 times per run.
  These are scored as pops, not as G5.

Where the penalty comes from (per client-minute):

| capture | shared-v2 | per-player |
|---|---|---|
| wedge | contact timing 279, screen error 83, pop 50 | contact timing 49, pop 46, screen error 24 |
| sustained | contact timing 895, pop 191, cause-effect 98 | contact timing 168, pop 129, cause-effect 56 |
| meteor-volley | pop 5141, contact timing 2428, cause-effect 808 | contact timing 488, pop 229, cause-effect 156 |

## At equal bytes (rate-quality, seed 1)

Each strategy swept over its own quality knob (0.5 to 8 px), interpolated at
the other's rates (`scripts/netlab/rate-quality.py`):

| capture | at kbit/s | shared-v2 penalty | per-player penalty | ratio |
|---|---:|---:|---:|---:|
| wedge | 151-164 | 413-471 | 122-132 | 3.1-3.6x |
| sustained | 279-305 | 1247-1412 | 471-478 | 2.6-3.0x |
| meteor-volley | 492-505 | 10525-11093 | 1333 | 7.9-8.3x |

- **Shared v2 is one operating point:** its error budget moves its bytes by
  2-9%. Its rate is set by policy, not by error.
- **Per player traces a curve** (about 58 to 525 kbit/s), so its rate can
  be dialled to the link.

## Across links (seed 1)

| link | capture | v2 kbit/s, penalty | per-player kbit/s, penalty | better by |
|---|---|---|---|---:|
| cable | wedge | 154, 425 | 71, 255 | 1.7x |
| cable | sustained | 283, 1298 | 133, 828 | 1.6x |
| cable | meteor-volley | 496, 9779 | 331, 1640 | 6.0x |
| lte | wedge | 154, 467 | 140, 141 | 3.3x |
| lte | sustained | 283, 1336 | 285, 432 | 3.1x |
| lte | meteor-volley | 496, 10525 | 468, 1333 | 7.9x |
| poor-mobile | wedge | 99, 532 | 88, 185 | 2.9x |
| poor-mobile | sustained | 193, 1847 | 173, 832 | 2.2x |
| poor-mobile | meteor-volley | 294, 15178 | 262, 4451 | 3.4x |

On cable, per player sends half the bytes and still wins.

## Adversarial search

`scripts/netlab/adversarial.py` varies the capture, two players' cameras
(flick, pan, strafe, zoom, peek, facing), the link (8 profiles), the budget
(256-1024 kbit/s) and the seed. It runs 24 random trials, hill-climbs on
the worst, then runs the worst with v2 too.

Round 1 found four weaknesses in per player, and each was traced and
fixed:

| finding | cause (traced) | fix | effect |
|---|---|---|---|
| Debris drawn sinking into the ground (G4) | The 6-tick mode backtest scores the past, so a body that just landed was predicted to keep falling | Support detection: no ballistic mode when the last two steps fell short of g by more than half | wedge G4 4 -> 1 |
| Debris drawn 3-4 m through the ground on starved budgets | The bounce keyframe was late and prediction tunnelled | A ground floor in the shared predictor, derived on each side from the chunk boxes (not on the wire; the wire's delta prediction strips it) | meteor-volley G4 128 frames (406 cm) -> 8 (65 cm), penalty -8% |
| Bucket overruns at 256 kbit/s, by 1-2% (G3) | The bucket's window edge under float rounding, unbudgeted datagram headers, and event copies sent with no room | Conservative window edge (fixes v2 too); headers counted; copies only within the allowance | G3 783 -> 767.9 against 768 |
| Losing to v2 when starved (24962 vs 19116) | Screen error saturates, so cheap near-resting records won the bytes over bodies metres off (37% of bytes went to resting keyframes) | Priority adds the pop the correction will make (blended over 9 frames, or snapped past 5 m) | starved case 14983, 22% better than v2; meteor-volley at 1024: 1423 -> 1333 |

Round 2, after the fixes, found the worst cases all on meteor-volley at
256 kbit/s over poor-mobile (3% loss, 1 Mbit/s) with peeking cameras:

| run | per-player | shared-v2 |
|---|---:|---:|
| h2-000 | 37,179 | 34,366 |
| h2-003 | 22,870 | 21,120 |
| r014 | 21,572 | 18,596 |

That is 8-16% worse than v2. At that budget:
- Both strategies fail G3, because fracture events go first by design and
  are not budget-limited.
- Both fail G4.
- Per player had one G5 frame (h2-003).

This is per player's measured weak corner: heavy collapse, a quarter of the
budget, a lossy link.

## Cost

Server CPU is thread CPU time, on a machine shared with other jobs. Send
time per tick, all clients together (one thread, before the last two
changes, which did not change per-client cost materially: wedge 25 to
30 us, meteor-volley 211 to 217 us at 4 clients):

| capture | clients | shared-v2 ms (mean / p99) | per-player ms (mean / p99) |
|---|---:|---|---|
| sustained | 4 | 0.05 / 0.22 | 0.22 / 1.3 |
| sustained | 64 | 0.62 / 2.6 | 4.4 / 23.3 |
| meteor-volley | 4 | 0.18 / 0.65 | 0.63 / 2.4 |
| meteor-volley | 64 | 2.1 / 8.9 | 15.5 / 54.7 |

With `pp.send_threads` on meteor-volley at 64 clients (byte-identical to
one thread):

| threads | mean ms | p99 ms |
|---:|---:|---:|
| 1 | 16.2 | 59 |
| 4 | 5.1 | 19 |
| 8 | 3.7 | 12 |

- **Client CPU** (headless Node, whole capture, per client): per player via
  TS + WASM 0.52-4.3 s, shared v2 0.70-3.8 s. About equal.
- **Egress** is the sum of unicast streams for both. A relayed v2 would
  publish between its busiest client's rate and the total (reported in
  every scorecard).

## Strengths and weaknesses, and why

### Shared world (wire v2)

- **Strengths**
  - **Cheap per client:** 5-50 us per send; records are encoded once.
  - **Relay fan-out:** encode-once records suit MoQ relays, so one origin
    stream serves many viewers.
  - **Consistency between players:** players see the same records, so
    their sightlines disagree less (F3 often lower).
  - **Production-hardened,** and reproduced byte for byte by the lab.
- **Weaknesses**
  - **Policy-bound rate:** 2-9% across its quality knob. When the scene
    outgrows the budget, whole bodies go stale: on meteor-volley, debris
    p99 is 16 m and there are 1,384 pops per client-minute.
  - **Topology ahead of the pose clock (G2):** the break shows before its
    cause. Contact timing is its largest penalty.
  - **Settled debris moves again under load (G5),** and debris is drawn
    inside structures (G4: 227-589 frames on the heavy captures, up to
    1.4 m deep).

### Per player (wire 4)

- **Strengths**
  - **Its priority is the scorecard's own penalty per byte,** from each
    player's camera. That covers the error now, a horizon ahead, and the
    pop its correction will make. With `--model`, a calibrated fit drives
    the netcode as well as the score.
  - **Acked-baseline deltas** (76-93% of keyframes) with mode-aware
    prediction: about 21 B per keyframe. The predictor carries
    physics-derived constraints: support detection, and a ground floor
    from the chunk boxes.
  - **Bonds-only fracture events:**
    - the client derives membership, so the structure hash never
      mismatches;
    - events apply at their tick;
    - datagram copies cut late events.
  - **Dialable rate,** with every gate passing along the 1024 kbit/s curve.
- **Weaknesses**
  - **Server CPU 5-6x per client.** It needs threads at scale, and spatial
    binning is next.
  - **Unicast only:** no relay fan-out.
  - **F3 asymmetry:** per-camera streams make players disagree about
    sightlines more often (0.7-2.5 per pair-minute against v2's 0-1.3 on
    wedge and sustained). A fairness term in the priority (the plan's
    milestone 9) is the lever.
  - **Starved-budget heavy collapse on a lossy link:** 8-16% worse than v2
    at 256 kbit/s on poor-mobile meteor-volley.
  - **Late events on lossy links** show as snaps (4,478 on poor-mobile
    meteor-volley).
  - **Sub-pixel bounces:** a bounce that keeps a piece under the pixel
    tolerance is drawn smoothed. Contact timing is per player's largest
    penalty class. `pp.contacts` ranks unsent contacts by their timing
    penalty and helps 1-7%; the deeper fix is in the drawing.

## Worst clips

`netlab2 city-clips` renders the truth and each run's drawing side by side
from the client's own camera, with a 4x zoom row, for each run's worst
windows by the scorer's event log:

- `target/nds/clips3/{wedge,sustained,meteor-volley}/clip-NN.mp4`
- `clips.md` in each directory.

## What is not measured yet

- **Calibration.** Thresholds and severities are literature seeds. A
  simulated inspector needed about 80 trials per class to land within 10%.
- **Unmeasured metrics:** V8 group error, V9 VDP, V12 audio, and fairness
  F1/F5/F6 (shots through debris, debris damage: opt-in gameplay changes).
- **Scale.** Runs went to 64 players on 1,700 bodies. The converter for the
  owner's 100k-piece recordings is in progress.

## How to reproduce

```bash
CARGO_TARGET_DIR=/Users/glavin/Development/vibe-land/target/nds cargo build --release -p web-fps-server --bin netlab2
N=/Users/glavin/Development/vibe-land/target/nds/release/netlab2
T=/Users/glavin/Development/vibe-land/target/nds/truth
for s in shared-v2 per-player; do
  $N city --capture $T/wedge/capture --out cmp/wedge/$s --strategy $s --knob pp.tolerance_px=2 \
     --clients 4 --link lte --seed 1 --budget-kbps 1024 --burst-kbps 3072 --burst-s 3
done
scripts/netlab/seed-ci.py cmp seeds/s2 seeds/s3 seeds/s4 seeds/s5   # each root: <capture>/<strategy>
scripts/netlab/rate-quality.py run --out rq --budgets 1024 --qualities 0.5,1,2,4,8 --jobs 3
scripts/netlab/adversarial.py --out adv --trials 24 --refine 12 --compare 3
scripts/netlab/ci-quick.py                                             # the merge gate
$N city-clips --capture $T/wedge/capture --runs cmp/wedge/shared-v2,cmp/wedge/per-player --zoom 4
```
