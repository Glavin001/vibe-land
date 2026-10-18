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

**Per player's defaults** (since this revision): `age_priority`,
`drawn_view` and `solid_gate` are on. The scorecard decides, gates first
(G4: 707 frames against 1,518 on starved meteor-volley; 28 against 58 on
city-100k), then penalty. Each is a `pp.*` knob, and `VIBE_CITY_PP_KNOBS`
turns them off live. Their cost: +2% to +6% on some easy runs, and 0.88 ms
per send on city-100k. With these defaults, every measured case (v2 /
per player):

| case | ratio |
|---|---|
| wedge, 5 seeds | 3.28x (95% CI 2.87-3.69) |
| sustained, 5 seeds | 2.94x (2.69-3.29) |
| meteor-volley, 5 seeds | 6.75x (5.09-8.43) |
| the turning-camera corner, 5 seeds | 1.02-1.20, every seed |
| cable and poor-mobile | 1.6-5.9x |
| 256 kbit/s | 1.3-1.7x, G4 far below v2's |
| city-100k | 5.0x |

The sections below were measured before the flip, with the earlier
defaults.

- **Per player is better, with confidence.** Across 5 seeds the penalty
  ratio (paired bootstrap, 95% CI) is:

  | capture | shared v2 / per player | at bytes (v2 / per player) |
  |---|---|---|
  | wedge | **3.31x** (2.91-3.71) | 1.05x |
  | sustained | **2.99x** (2.71-3.39) | 0.97x |
  | meteor-volley | **5.74x** (4.32-7.26) | 1.04x |

  It also wins on cable (1.5-6.0x) and on poor-mobile (2.3-3.6x).
  On the owner's 100k-chunk city recording it is 5.1x lower (746 against
  3823 penalty per minute) at 10% fewer bytes.
- **Integrity.**
  - **Per player** never applies an event early (G2), never resurrects
    settled debris on the standard runs (G5), and holds the budget (G3).
    It draws far less debris inside solid geometry (G4): 0-9 body-frames
    per standard run against v2's 3-589.
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
- **Cost: per player spends more server CPU per client, and it shows at
  scale.**
  - On the standard captures it is 5-6x v2 per client. Parallel sends
    (`pp.send_threads`, byte-identical) bring 64 clients on meteor-volley
    from 16.2 to 3.7 ms per tick.
  - On the owner's 113k-chunk aerial bombardment (about 97k awake bodies),
    bounded evaluation, parallel ingest and FxHash bring 4 clients from
    352 to about 18 ms per tick.
  - At 64 clients there it is now cheaper per tick than v2: 8.6 ms
    ingest + 8.5 ms send against 8.0 + 13.4 (p99 13.5 + 10.9 against
    21). Per player uses 16 worker threads; v2's send is a single call.
    It sends a quarter of v2's bytes: 2.5 against 10.6 Mbit/s per client.
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
| wedge | shared-v2 | 154.3 | 468 | 0.168 | 12.8 | 70.6 | 1020 / 1036 | 0 | 3 (5.4) | 0 | 1.60 / 0.00 | 5.5 |
| wedge | per-player | 141.1 | **124** | 0.145 | 7.2 | 9.1 | 0 | 33 / 4324 | 0 | 0 | 0.37 / 0.74 | 25.5 |
| sustained | shared-v2 | 283.4 | 1338 | 0.209 | 48.4 | 226.8 | 2128 / 2140 | 0 | 227 (10.5) | 0 | 0.83 / 0.17 | 10.6 |
| sustained | per-player | 285.9 | **418** | 0.129 | 30.9 | 42.0 | 0 | 27 / 7888 | 4 (39.8) | 0 | 1.56 / 2.96 | 56.6 |
| meteor-volley | shared-v2 | 496.3 | 10543 | 15.95 | 1384 | 620 | 2939 / 2940 | 0 | 589 (140) | 23 | 4.29 / 2.69 | 52.1 |
| meteor-volley | per-player | 467.4 | **1261** | 0.314 | 60.0 | 112 | 0 | 1559 / 16428 | 9 (29.5) | 0 | 0.24 / 1.70 | 171 |

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
| wedge | contact timing 279, screen error 83, pop 50 | contact timing 41, pop 26, screen error 23 |
| sustained | contact timing 895, pop 190, cause-effect 98 | contact timing 174, pop 119, cause-effect 51 |
| meteor-volley | pop 5141, contact timing 2428, cause-effect 808 | contact timing 485, pop 214, unexplained acceleration 136 |

## At equal bytes (rate-quality, seed 1)

Each strategy swept over its own quality knob (0.5 to 8 px), interpolated at
the other's rates (`scripts/netlab/rate-quality.py`):

| capture | at kbit/s | shared-v2 penalty | per-player penalty | ratio |
|---|---:|---:|---:|---:|
| wedge | 151-164 | 413-472 | 117-121 | 3.4-3.9x |
| sustained | 279-305 | 1249-1415 | 440-443 | 2.8-3.2x |
| meteor-volley | 492-505 | 10543-11111 | 1261 | 8.4-8.8x |

- **Shared v2 is one operating point:** its error budget moves its bytes by
  2-9%. Its rate is set by policy, not by error.
- **Per player traces a curve** (about 60 to 525 kbit/s), so its rate can
  be dialled to the link.

## Across the five budgets (decision D9, seed 1)

Both strategies at 256 / 384 / 512 / 768 / 1024 kbit/s sustained (3x
burst for 3 s), lte, quality knob 2 px for both
(`scripts/netlab/rate-quality.py run --budgets 256,384,512,768,1024
--qualities 2`). Cells: kbit/s sent, penalty per client-minute (gates
failed).

| capture | budget | shared v2 | per player | v2 / per player |
|---|---:|---|---|---:|
| wedge | 256 | 95, 628 (G2 G3 G4) | 83, 404 (G3 G4) | 1.6x |
| wedge | 384 | 122, 443 (G2 G3 G4) | 105, 161 (pass) | 2.8x |
| wedge | 512 | 140, 459 (G2 G3) | 121, 137 (pass) | 3.4x |
| wedge | 768 | 154, 468 (G2 G4) | 140, 122 (pass) | 3.8x |
| wedge | 1024 | 154, 468 (G2 G4) | 141, 124 (pass) | 3.8x |
| sustained | 256 | 178, 2815 (G2 G3 G4) | 151, 2038 (G3 G4) | 1.4x |
| sustained | 384 | 236, 1633 (G2 G3 G4) | 196, 703 (G4) | 2.3x |
| sustained | 512 | 268, 1349 (G2 G4) | 227, 519 (G4) | 2.6x |
| sustained | 768 | 283, 1338 (G2 G4) | 243, 448 (G4) | 3.0x |
| sustained | 1024 | 283, 1338 (G2 G4) | 243, 448 (G4) | 3.0x |
| meteor-volley | 256 | 163, 20838 (G2 G3 G4 G5) | 146, 13936 (G3 G4) | 1.5x |
| meteor-volley | 384 | 224, 30182 (G2 G3 G4 G5) | 205, 8226 (G3 G4) | 3.7x |
| meteor-volley | 512 | 280, 23985 (G2 G3 G4 G5) | 260, 5680 (G3 G4) | 4.2x |
| meteor-volley | 768 | 390, 14055 (G2 G3 G4 G5) | 366, 2790 (G4) | 5.0x |
| meteor-volley | 1024 | 496, 10543 (G2 G4 G5) | 467, 1261 (G4) | 8.4x |

- **Per player wins at every budget on every capture, at 6-15% fewer
  bytes.** The margin shrinks as the budget starves (1.4-1.6x at
  256 kbit/s), where both are mostly stale.
- **Every per-player G3 failure is its unbudgeted fracture events:**
  `g3_clients_over_budgeted` is 0 in all 15 runs. The selection never
  overspends.
- **Per player never fails G2 or G5 here; v2 fails G2 in all 15 runs
  and G5 in all five meteor-volley runs.**
- **Budget for the bucket (D9):** per player stops improving at
  768 kbit/s on wedge and sustained. Meteor-volley still gains to
  1024 kbit/s. See also `docs/netcode-collapse-costs.md`.

## Across links (seed 1)

| link | capture | v2 kbit/s, penalty | per-player kbit/s, penalty | better by |
|---|---|---|---|---:|
| cable | wedge | 154, 425 | 71, 244 | 1.7x |
| cable | sustained | 283, 1301 | 134, 840 | 1.5x |
| cable | meteor-volley | 496, 9797 | 331, 1633 | 6.0x |
| lte | wedge | 154, 468 | 141, 124 | 3.8x |
| lte | sustained | 283, 1338 | 286, 418 | 3.2x |
| lte | meteor-volley | 496, 10543 | 467, 1261 | 8.4x |
| poor-mobile | wedge | 99, 533 | 88, 194 | 2.7x |
| poor-mobile | sustained | 193, 1849 | 173, 806 | 2.3x |
| poor-mobile | meteor-volley | 294, 15208 | 265, 4181 | 3.6x |

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

That was 8-16% worse than v2. The cause, traced with new counters: per
player spent only 7.6% of the allowance it was offered, and 68% of its
sends ran out of candidates. Its model of each client assumed every
fracture event applied on time. On a lossy link some arrived after the
drawing had passed their tick, so the client was wrong while the model
said it was right. **Fix: application-level event acks** (the spec's
D6). The client's ack carries the first event sequence it has not
received (an optional trailing u32; older acks still decode). The server
re-sends the bodies a late event changed. The same three worst cases
after the fix, at about 14% fewer bytes than v2:

| run | per-player | shared-v2 |
|---|---:|---:|
| h2-000 | **32,034** | 34,760 |
| h2-003 | **20,402** | 21,238 |
| r014 | **18,245** | 18,773 |

Round 3, after event acks (34 trials), found one corner where v2 still
wins: meteor-volley at 256 kbit/s on lte, with one player watching from
71 m and the other flicking 112 degrees. Five seeds of that
configuration:

| seed | per-player | shared-v2 | v2 / per-player |
|---:|---:|---:|---:|
| 131 | 21,407 | 19,987 | 0.93 |
| 132 | 21,919 | 22,693 | 1.04 |
| 133 | 20,623 | 20,215 | 0.98 |
| 134 | 23,021 | 19,915 | 0.87 |
| 135 | 20,854 | 20,289 | 0.97 |

v2 is better in 4 of 5, by 4.5% on the geometric mean. That is per player's
measured weak corner: a heavy collapse at a quarter of its usual rate,
with a camera that turns onto bodies it had deprioritised. Per player
spends its starved budget on what each camera sees, so after the flick the
newly visible bodies are staler than v2's evenly spread ones (the flicking
player: pops 1,801 against 648 per minute, contact timing 902 against 21).
The far static player is a tie (38,906 against 38,510).

In every round-3 trial both strategies failed G4. Every v2 trial also
failed G2, because it applies events early by design. Per player's G3
failures in this corner are its unbudgeted fracture events.
`g3_clients_over_budgeted` separates the two causes. In the worst case
per player's budgeted bytes peak at 756 kbit/s against the 768 cap; the
reliable events push one second to 773. v2 peaks at 943.

### The turning-camera corner, traced, and the ranking experiments

**What the trace found.** In the round-3 corner, 56% of the flicking
player's pops came from 3 pieces. Each was drawn sliding past the player at
about 50 m/s on a stale keyframe: a ballistic prediction clamped to the
ground floor. Each was 70 m from its truth, and none was re-sent for 3 s.

**Why they were never re-sent.**
- Their gain was flat at 5.0, because screen error and the correction pop
  both saturate.
- They ranked about 350th of 850 candidates, with about 30 sent per send.
- The ranking prices one send's worth of penalty. The scorer charges a body
  drawn moving wrongly a pop every frame (V2).

**The experiments** (all `pp.*`, off by default; 18 runs: the corner's 5
seeds, the three captures on lte, cable, poor-mobile and 256 kbit/s, and
city-100k; change against current defaults):

| knob(s) | corner, v2 / per player by seed | single collapses | city-100k | kept as |
|---|---|---|---:|---|
| `motion_cost` (one send's pop for wrong motion) | worse (0.81-0.95) | -12% to +6% | +4% | control |
| `drawn_view` (judge the error where it is drawn too) | unchanged | -4% to +6% | +2% | knob |
| `age_priority` (priority accumulator: penalty per second x time wrong) | 0.92-1.11 | -12% to +3% | +8% | knob |
| `age_priority` + `drawn_view` | 0.95-1.07 (geomean 0.995: a tie) | -12% to +0.4% | +4.6% | candidate default |
| + `contacts` (on-screen, marginal, from landing) | 0.94-1.11 | -15% to +0.7% | +25% | knob |
| `age_priority` with the correction as a cost, waiting when it costs more than it saves | 0.95-1.11 | 2-6x worse | 3.5x worse | reverted |
| `age_priority` accruing only while the body is on screen, + `drawn_view` | **1.05-1.18 (per player wins all five)** | -14% to +3% | **-9.9%** | candidate default |
| the same + `ground_gate` (sunk into the ground: sent first) | 1.05-1.18 | -15% to +8% | -5.4% | knob |
| the same + `solid_gate` (sunk into the ground or a standing structure: sent first) | 1.02-1.20 | -11% to +6% | +1.9% | knob: G4 at 256 kbit/s meteor-volley 1518 -> 707, city 58 -> 28; send 0.88 ms per tick on city-100k (pair 0.15) |

**What these show.**
- **The accumulator fixes the slider:** at most 6 pops per piece, against 86.
- **The candidate default helps where heavy collapses meet bad links or
  small budgets,** by 8-12%, and leaves the corner tied.
- **It costs 4.6% on city-100k,** where it corrects many small, steady,
  distant errors, and each correction is itself a pop.
- **Accruing only while a body is on screen** (the scorer charges V1 and V2
  only for visible items) turned the city result from +4.6% to -9.9%. It
  also made per player win all five corner seeds. Across 5 seeds of the
  standard captures, with both knobs on (paired CI, v2 / per player):

  | capture | ratio |
  |---|---|
  | wedge | 3.21x (2.86-3.53) |
  | sustained | 3.01x (2.71-3.40) |
  | meteor-volley | 6.71x (5.03-8.44); 5.74x with the defaults |

  Its cost: debris inside geometry at 256 kbit/s meteor-volley rises from
  1,518 to 3,730 frames. `ground_gate` brings that to 2,903; the rest is
  inside standing structures. `solid_gate` (G4's own test against standing
  chunks, rebuilt per fractured structure) brings it to 707, below the
  defaults. It costs some penalty on the easy runs (+2% to +6%) and server
  time (0.88 ms per tick on city-100k against 0.15).
- **These numbers are on the corrected scorer.** Box faces crossing the
  camera's near plane are now clipped, not dropped or misdrawn. That moved
  the baselines by under 2%.
- **Making the correction a cost instead held back the pieces about to sink
  through the floor** (G4 in the thousands). The scorer charges those under
  classes the accumulator does not see. The next lever is to put those
  classes into the rate as well, not to hold corrections back.

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

## At 100k chunks: the owner's recordings

`twstate-to-capture` (destruction/src/bin) converts PhysX TWSTATE
recordings into lab captures. It derives bonds, islands, fractures,
crushes, settles and wakes from per-chunk poses. Each rule is documented
in the binary, and derive-check passes: 0 split or merged.

| capture | chunks | bonds broken | islands | peak awake bodies |
|---|---:|---:|---:|---:|
| city-100k (1,600 buildings, 32 s) | 102,400 | 19,753 | 7,529 | 2,631 |
| aerial-113k (256 buildings, 30 s, PhysX sleep off) | 113,664 | 200,249 | 96,825 | about 97,000 |

**Quality, city-100k** (4 clients, lte, 1024 kbit/s bucket):

| strategy | kbit/s | penalty/min | debris p99 m | G3 over | G4 frames | G5 frames | F2 / F3 |
|---|---:|---:|---:|---:|---:|---:|---|
| shared-v2 | 1107 | 3823 | 10.2 | 2 | 1118 | 323 | 2.8 / 5.6 |
| per-player | 999 | **746** | 2.1 | 0 | 58 | 0 | 0 / 0 |

With event acks per player went from 668 to 746 here (G4 142 -> 58, G5
1 -> 0): the re-sent bodies of late events take bytes from elsewhere on a
link that rarely loses one.

**Cost, aerial-113k** (about 97k bodies awake every tick), server ms per
tick:

| | 4 clients, ingest + send | 64 clients: ingest + send (p99) | kbit/s per client | origin egress at 64 |
|---|---|---|---:|---:|
| shared-v2 | 7 + 0.7 wall (13.7 CPU) | 8 + 13.4 (21) | 10,566 | 676 Mbit/s |
| per-player, first run | 35 + 317 | about 39 + 865 | 2,494 | 160 Mbit/s |
| per-player, now (8-16 threads) | **9.1 + 8.5** | **8.6 + 8.5 (13.5 + 10.9)** | 2,510 | 160 Mbit/s |

How per player got there (each change byte-identical below the cap):
- **Never-sent bodies** are ranked by size on screen, and only as many as a
  send can carry are evaluated.
- **Evaluation is bounded** (`pp.eval_cap` 4096). The rest of the bodies
  are covered by a rotating slice of a stable body order, plus last send's
  losers and the freshest contacts. Contacts alone had been 93% of
  evaluations: piles in constant contact.
- **Ingest classifies bodies on worker threads.**
- **The maps keyed by body use FxHash.**

At 64 clients two more changes got it under v2:
- **A fracture updates each client's model only for the bodies it split,**
  with clients on worker threads. It used to recompute every body in the
  structure, for every client.
- **A per-send evaluation budget is shared by all clients**
  (`pp.eval_budget`), and the cap is a true total.

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
  - **More CPU per client on small scenes** (5-6x v2's microseconds). At
    scale, its bounded evaluation, shared budget and worker threads bring
    it under v2's time per tick: 17.1 against 21.4 ms at 64 clients and
    about 97k awake bodies. It needs those threads; v2's send is a single
    call.
  - **Unicast only:** no relay fan-out.
  - **F3 asymmetry:** per-camera streams make players disagree about
    sightlines more often (0.7-2.5 per pair-minute against v2's 0-1.3 on
    wedge and sustained). A fairness term in the priority (the plan's
    milestone 9) is the lever.
  - **Starved budget plus a camera flick:** at 256 kbit/s on meteor-volley
    with a player flicking onto deprioritised bodies, v2 is 4.5% better
    (4 of 5 seeds). Event acks closed the lossy-link corner it had before
    (8-16% worse, now 3-8% better).
  - **Late events on lossy links** show as snaps (1,559 of 16,428 on lte
    meteor-volley). Keyframes for a body whose fracture has not arrived are
    now held until it does (wire 4's incarnation tag). Before, they drew
    the new body with the old body's chunks, up to 1.1 m off.
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
- **Debris damage, opt-in** (`VIBE_CITY_DEBRIS_DAMAGE=1`) is
  server-authoritative and uses the vehicle-strike impulse model. It was
  verified live: a player at a toppled tower's wall was killed by falling
  debris in 3 of 3 runs with the flag on, and lost no HP in 3 runs with it
  off. Walking into a standing wall or settled rubble does no damage.
  Owner's decision pending: the model treats the player as immovable, which
  overstates sideways bumps.
- **Fairness and gameplay.** `VIBE_CITY_CHUNKS_BLOCK_SHOTS=1` (opt-in) makes
  chunks stop shots. With it on, F1 (a shot's outcome on the shooter's
  screen against the server's) is F2 at the shooter's render tick, which
  is measured.
- **Unmeasured metrics:** V9 VDP, V12 audio, and fairness
  F1/F5/F6 (shots through debris, debris damage: opt-in gameplay changes).
- **Quality at full scale:** quality at about 97k awake bodies (aerial)
  needs client stages that big. Cost is measured; quality was measured on
  city-100k.

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
