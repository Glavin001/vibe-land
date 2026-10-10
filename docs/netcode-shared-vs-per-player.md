# Shared world (wire v2) vs per player (wire 4): the head-to-head

Milestone 7 of the destruction netcode plan (`docs/netcode-lab.md`). The goal
is the same for both: sync massive destruction to every player efficiently.
Both are judged by one scorecard, computed from each player's own camera.

The perceptual model is still the literature seed, uncalibrated. Its
calibration study is built (`netlab2 city-study`, the study page, and
`scripts/netlab/fit-calibration.py`) and waits on the inspector. Q saturates
at 0 in the heavy scenes, so the number to compare is the **penalty per
client-minute** (noticed artifacts, each weighted by its class's severity;
lower is better). Integrity gates come before it, and cost after.

## Bottom line

- **Per player is better on every capture and link measured.** At equal
  bytes its penalty is:
  - 3.0x lower on wedge (one tower toppled);
  - 2.9x lower on sustained (three buildings, no lull);
  - 6.8x lower on meteor-volley (1,700 bodies).
- **Per player passes every integrity gate; shared v2 passes none.**
  - v2 applies 99% of its topology before the drawing reaches the tick
    (G2 early). That is by design, but the break shows before its cause.
  - On meteor-volley, v2 also shows settled debris moving again (G5).
- **Per player costs about 5x more server CPU per client.** That was its one
  disqualifying weakness at scale: 15.5 ms per tick for 64 clients on
  meteor-volley. It is fixed by sending clients in parallel: 3.7 ms on 8
  threads, inside the 16.7 ms tick.
- **Egress is the same per client, because both send unicast today.** v2's
  encode-once records could be fanned out by MoQ relays, which would cut the
  origin's egress. Per player cannot be fanned out. That is v2's one
  structural advantage, and it only pays where many viewers share one
  stream.
- **Per player plays live.** A real `/city` match on wire 4 (`citypp-*`
  match ids or `VIBE_CITY_WIRE=4`) ran on Metal: 957 bonds broken, about 270
  chunks moving, 0 of 96 structure hashes mismatched.

**Recommendation: make per player (wire 4) the default for /city once the
calibration study has run,** with `pp.send_threads` sized to the server's
cores. Keep v2 for spectator fan-out, where one stream serves many viewers
through relays. Every number below is reproducible from the commands in
"How to reproduce".

## Setup

- **Truth.** Three captures recorded on this tree (`scenarios/netcode/*.json`
  via `scripts/netlab/record-truth.py`):

  | capture | ticks at 60 Hz | bodies at most |
  |---|---:|---:|
  | wedge | 2,881 | 313 |
  | sustained | 4,075 | 505 |
  | meteor-volley | 2,897 | 1,717 |

- **Players.** 4 per run, generated cameras (walkers and statics), seed 1.
  Since 327d310f the walkers stand on the ground. Before that fix they were
  1.3 m under it, in both strategies alike.
- **Links.** The lab's QUIC model with netem-like profiles:
  - **cable:** 12 ms one-way, 0.1% loss;
  - **lte:** the default for every table below;
  - **poor-mobile:** 150 ms, 3% loss, 1 Mbit/s.

  Acks go upstream at 30 Hz on the same profile.
- **Budget.** The spec's bucket under production's link controller:
  1024 kbit/s sustained, 3x for 3 s.
- **Clients.**
  - Shared v2 runs on the production TypeScript client, headless.
  - Per player runs on its Rust client core in the lab. The browser runs the
    same core as WASM behind `PerPlayerCityClient`, and gives the same
    penalty to the decimal on all three captures (155.0 / 425.1 / 1547.1).
- **Knobs.**
  - Shared v2 runs at production defaults.
  - Per player runs at `pp.tolerance_px` 2 (wedge, meteor-volley) or 1.5
    (sustained), with 2 event copies, acked-baseline deltas and mode
    backtests.

## Head to head (lte, 1024 kbit/s bucket, cmp3)

| capture | strategy | kbit/s | penalty/min | debris p99 m | pops/min | contact/min | G2 early | G2 late | G5 | gates | send us/client |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| wedge | shared-v2 | 154.3 | 467 | 0.168 | 12.8 | 70.6 | 1020 / 1036 | 0 | 0 | fail (G2) | 5.5 |
| wedge | per-player | 137.5 | **155** | 0.145 | 12.8 | 11.9 | 0 | 386 / 4324 | 0 | pass | 25.2 |
| sustained | shared-v2 | 283.4 | 1336 | 0.209 | 48.4 | 226.8 | 2128 / 2140 | 0 | 0 | fail (G2) | 10.6 |
| sustained | per-player | 276.2 | **425** | 0.127 | 34.3 | 38.9 | 0 | 38 / 7888 | 0 | pass | 99.1 |
| meteor-volley | shared-v2 | 496.3 | 10525 | 15.95 | 1384 | 620 | 2939 / 2940 | 0 | 23 | fail (G2, G5) | 52.1 |
| meteor-volley | per-player | 465.8 | **1547** | 2.76 | 96 | 127 | 0 | 975 / 16428 | 0 | pass | 211 |

Where each strategy's penalty comes from (per client-minute, the largest
classes):

| capture | shared-v2 | per-player |
|---|---|---|
| wedge | contact timing 279, screen error 83, pop 50 | contact timing 49, pop 46, screen error 24 |
| sustained | contact timing 895, pop 191, cause-effect 98 | contact timing 168, pop 129, cause-effect 56 |
| meteor-volley | pop 5141, contact timing 2428, cause-effect 808 | contact timing 549, pop 350, cause-effect 167 |

## At equal bytes (rate-quality, rq4)

Each strategy swept over its own quality knob (0.5 to 8 px), interpolated at
the other's byte rates (`scripts/netlab/rate-quality.py`):

| capture | at kbit/s | shared-v2 penalty | per-player penalty | ratio |
|---|---:|---:|---:|---:|
| wedge | 152-164 | 413-471 | 126-139 | 3.0-3.4x |
| sustained | 279-305 | 1247-1412 | 445-460 | 2.8-3.1x |
| meteor-volley | 492-505 | 10525-11093 | 1547 | 6.8-7.2x |

- **Shared v2 is one operating point.** Its error budget moves its rate by
  only 2-9%. Its bytes are set by policy (send cadence, ceilings, strides),
  not by error.
- **Per player traces a curve,** from 58 to 525 kbit/s. It passes every gate
  at every point of the curve. The rate can be dialled to the link, with
  quality degrading smoothly.

## Across links

| link | capture | shared-v2 kbit/s, penalty | per-player kbit/s, penalty |
|---|---|---|---|
| cable | wedge | 154, 425 | 71, 264 |
| cable | sustained | 283, 1298 | 132, 898 |
| cable | meteor-volley | 496, 9779 | 329, 2023 |
| lte | wedge | 154, 467 | 138, 155 |
| lte | sustained | 283, 1336 | 276, 425 |
| lte | meteor-volley | 496, 10525 | 466, 1547 |
| poor-mobile | wedge | 99, 532 | 88, 173 |
| poor-mobile | sustained | 193, 1847 | 172, 967 |
| poor-mobile | meteor-volley | 294, 15178 | 264, 10069 |

Per player wins everywhere, by 1.5x to 6.8x. On poor-mobile meteor-volley
(1 Mbit/s, 3% loss) neither strategy is good. There, per player's 4,345 late
events are its weakest number.

## Cost

Server CPU is thread CPU time (`CLOCK_THREAD_CPUTIME_ID`, since 67230b4d),
measured on a shared machine whose load average was 50-65 from other
sessions. Send time per tick, for every client together:

| capture | clients | shared-v2 ms (mean / p99) | per-player ms (mean / p99) |
|---|---:|---|---|
| sustained | 4 | 0.05 / 0.22 | 0.22 / 1.3 |
| sustained | 16 | 0.17 / 0.72 | 0.95 / 5.1 |
| sustained | 64 | 0.62 / 2.6 | 4.4 / 23.3 |
| meteor-volley | 4 | 0.18 / 0.65 | 0.63 / 2.4 |
| meteor-volley | 16 | 0.55 / 2.2 | 3.4 / 12.7 |
| meteor-volley | 64 | 2.1 / 8.9 | 15.5 / 54.7 |

- **The CPU gap.** Per player costs 5-6x more per client: 59-243 us against
  10-38 us. Each client's selection evaluates every awake body against that
  client's own model of what it is drawing.
- **The fix.** `pp.send_threads` (eaee67f7) splits one send's clients across
  threads. The result is byte-identical to one thread. On meteor-volley with
  64 clients, wall time per tick:

  | threads | mean ms | p99 ms |
  |---:|---:|---:|
  | 1 | 16.2 | 59 |
  | 4 | 5.1 | 19 |
  | 8 | 3.7 | 12 |

- **Ingest.** The shared per-tick truth ingest is 0.06-0.28 ms for per player
  and under 0.04 ms for v2.
- **Egress per client is about equal** (table above). Total egress is the sum
  of unicast streams for both. With MoQ relays, v2 could publish once: the
  scorecard reports the bound, for example "a relayed shared stream
  publishes between 164.6 and 617.4 kbit/s" for 4 clients on wedge.
- **Client CPU** (headless Node, whole capture, per client):
  - per player through the browser path (TS + WASM): 0.52-0.58 s on wedge,
    1.6 s on sustained, 4.0-4.3 s on meteor-volley;
  - shared v2: 0.70-0.77 s, 1.7-1.8 s and 3.7-3.8 s.

  About equal.

## Strengths and weaknesses, and why

### Shared world (wire v2)

- **Strengths**
  - **Cheap per client:** 5-50 us per send; encode once, select per client.
  - **Encode-once records** suit relay fan-out (MoQ), where one origin
    stream serves many viewers. Nothing else here does that.
  - **Production-hardened,** and calibrated byte for byte against live send
    logs (`netlab2 calibrate`).
- **Weaknesses**
  - **Its rate is set by policy, not by what the player sees.** Sweeping its
    error budget from 0.5 to 8 px moves its bytes by 2-9%. When the scene
    outgrows the budget (meteor-volley's 1,700 bodies), selection under the
    ceiling leaves whole bodies stale: debris p99 16 m, 1,384 pops per
    client-minute.
  - **Topology arrives ahead of the pose clock and applies on arrival.**
    99% of fractures are shown before the drawing reaches their tick: the
    break comes before its cause (G2). Contact timing (71-620 per minute)
    is its largest penalty on two of three captures.
  - **Settled debris moves again on meteor-volley** (G5: 23 frames).

### Per player (wire 4)

- **Strengths**
  - **Its priority is the scorecard's own penalty per byte,** from each
    player's camera. Bytes go where that player would notice.
  - **Acked-baseline deltas:** 76% of keyframes are deltas on lte, 93% on
    cable. With mode-aware prediction (ballistic, sliding, friction,
    resting, chosen by a 6-tick backtest), a keyframe averages 20.7 bytes on
    wedge.
  - **Bonds-only fracture events with lowest-chunk ids:**
    - the client derives membership, so it cannot disagree (G1: 0
      mismatches in every run, live included);
    - events apply at their tick (G2 early: 0);
    - two datagram copies of each events packet cut late events by
      35-96% for 2-4% more bytes.
  - **Dialable rate** with smooth degradation (58-525 kbit/s), and every
    gate passing across the curve.
- **Weaknesses**
  - **Server CPU: 5-6x per client.** Needs the parallel send at 64 clients.
    The next levers are the plan's milestone 8: spatial binning, and
    skipping bodies whose believed error cannot reach the tolerance.
  - **No relay fan-out:** every stream is unicast.
  - **Late events on lossy links.** Even with copies: 386 of 4,324 events on
    lte wedge, and 4,345 on poor-mobile meteor-volley. A late settle or
    fracture shows as a snap. On the seed-1 runs, every G5 frame was a
    landing on the settle pose (56-441 settle snaps, scored as pops).
  - **Contacts below the pixel tolerance are drawn smooth.**
    - The cause: priority is position error. A bounce on a distant piece
      can change its direction visibly while its position stays under
      2 px (traced: a 3.4 m/s sideways impulse at 96 m left the drawing
      0.13 px off, and no keyframe went out).
    - Its effect: on cable, where nothing makes the server's model of the
      client pessimistic, contact timing is its largest penalty, at 41 per
      minute against 12 on lte.
    - `pp.contacts` ranks unsent contacts by their timing penalty. It
      helps 1-7%, so it is opt-in. The real fix is in the client's drawing:
      a keyframe at a contact should start a new segment instead of being
      blended into the old one.

## Worst clips

`netlab2 city-clips` renders the truth and each run's drawing side by side
from the client's own camera, with a 4x zoom row, for each run's worst
windows by the scorecard's own event log:

- `target/nds/clips3/{wedge,sustained,meteor-volley}/clip-NN.mp4`
- `clips.md` in each directory: the penalty in each window, by run and class.

On meteor-volley, the 15-19 s window carries 6,101 penalty points for v2
(pop 3,773) against 456 for per player.

## What is not measured yet

- **Calibration.** Every threshold and severity is a literature seed.
  `netlab2 city-study` and the study page are ready. Each class needs
  several rounds (a simulated inspector needed about 80 trials per class to
  land within 10%).
- **G4, fairness and audio:** G4 solid geometry, fairness (F1-F6: shots
  through debris, sightlines), V8 group error, V9 VDP and V12 audio.
- **Statistics:** one seed and 4 players per run, so no paired-bootstrap
  confidence intervals yet. The scale runs went to 64 players on 1,700
  bodies, not 30-50k.
- **Scale datasets:** the user's 100k-piece datasets need a twstate
  converter.

## How to reproduce

```bash
CARGO_TARGET_DIR=/Users/glavin/Development/vibe-land/target/nds cargo build --release -p web-fps-server --bin netlab2
N=/Users/glavin/Development/vibe-land/target/nds/release/netlab2
T=/Users/glavin/Development/vibe-land/target/nds/truth
# head to head (cmp3)
$N city --capture $T/wedge/capture --out cmp/wedge/shared-v2 --strategy shared-v2 \
   --clients 4 --link lte --seed 1 --budget-kbps 1024 --burst-kbps 3072 --burst-s 3
$N city --capture $T/wedge/capture --out cmp/wedge/per-player --strategy per-player --knob pp.tolerance_px=2 \
   --clients 4 --link lte --seed 1 --budget-kbps 1024 --burst-kbps 3072 --burst-s 3
# rate-quality curves (rq4)
scripts/netlab/rate-quality.py run --out rq --budgets 1024 --qualities 0.5,1,2,4,8 --jobs 3
# scale: --clients 64 --no-client, and --knob pp.send_threads=8
# clips
$N city-clips --capture $T/wedge/capture --runs cmp/wedge/shared-v2,cmp/wedge/per-player --zoom 4
```
