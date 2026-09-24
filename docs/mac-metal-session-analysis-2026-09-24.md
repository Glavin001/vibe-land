# Mac/Metal play session analysis, 2026-09-24

One 101.4 s play session on the M3 Max, with the PhysX GPU server and the
Chrome client on the same machine. The owner reported two symptoms:

- **Meteors rewind.** Trajectories were not smooth; meteors jumped back and
  rubber-banded.
- **Slow motion.** As destruction accumulated, everything became slow-motion
  and jittery.

The tape explains both. The server simulated at 0.59x real time because a
PhysX GPU step took 13–55 ms (60-tick window means), against a 16.7 ms
budget. That is the slow motion. The client's server-clock estimator assumes
server time advances at wall-clock rate. It ran ahead of the slowed server,
extrapolated up to 250 ms, then hard-reset backwards: 297 times, 20.5 s in
total. That is the rewinding. The server's own meteor motion is clean.

The session also showed four smaller problems: debris falling through the
ground, structure state diverging with no packet loss, client CPU spikes when
fracture starts, and match stats on the ordered reliable stream. The ranked
[to-do list](#to-do-ranked-by-impact) is at the end, followed by
[how to reproduce](#reproduce).

Labels used in this document: **measured** means read from the tape, the
server's match stats (carried on the tape) or the server log. **Inferred**
means a conclusion drawn from correlations or timing, not observed directly.

## Setup and data

| Item | Value |
|---|---|
| Machine | M3 Max; server and client on the same GPU |
| Server | vibe-land release build, commit `36e54a94` (match-stats fingerprint), `target/play/release/web-fps-server`, `VIBE_PHYSICS_BACKEND=physx_gpu`, `cuda_stress=false` |
| Physics | PhysX GPU through CuMetal/Metal: PhysX `07dbb8c9`, cuda-metal `26251a2` package |
| CuMetal env | `CUMETAL_USE_METAL_DEVICE_ADDRESSES` on. Its startup warning says it "removes cross-stream concurrency" |
| Client | Chrome 153, WebTransport (datagrams + reliable stream), same machine |
| City | 16 structures, 3,258 chunks, 10,373 bonds |
| Tape | `debug-reports/tape-1790237324-city-default/city.vltape`: client-only VLTAPE02, captured 2026-09-24T08:08:43.986Z, 101.4 s, 15,056 packets, 8.2 MB, 7,226 frames with per-frame clock data. The paired server capture did not exist yet |
| Server log | `target/mac-server-play.log` (gitignored run output) |
| Analysis output | `target/tape-analysis/` (gitignored). All numbers below come from `summary.json`, its CSV tables or the server log |

Times are **tape seconds**: 0 = 08:07:02.613 UTC, which is `capturedAt` minus the duration.

## Session timeline

![Session timeline: server sim rate, client fps, server tick cost, world load](mac-metal-session-analysis-2026-09-24/timeline.png)

*Panels, top to bottom: server ticks per wall second, client fps, server tick
cost, world load. Orange lines mark meteor launches; purple lines mark
structure-repair bootstraps.*

Measured:

- **Movement.** The player was on foot throughout. They walked from
  (−63, 0) east to x ≈ +30 (around 60 s), via z ≈ −38, and back to
  (−54, 19). Median ground speed was 6.0 m/s in simulation time. They were
  moving in 92% of snapshots.
- **Meteors.** The player fired 21 meteor shots and nothing else. Launches
  were at 1.9, 3.6, 10.9, 12.5, 22.0, 23.2, 24.3, 34.7, 35.6, 36.6, 43.8,
  57.2, 58.6, 59.6, 63.3, 63.4, 73.1, 74.4, 75.1, 87.3 and 88.1 s.
- **Destruction.** The server logged 645 `city stress fracture` events in the
  tape window. Broken bonds went from 0 to 9,056 (87% of 10,373). Chunk
  bodies went from 26 to 2,358. Active dynamic bodies peaked at 1,429
  (72.8 s window).
- **Quiet periods.** The server ran near 60 Hz at 0–4, 85–90 and 95–101 s.

## Finding 1: meteors rewind because of the client clock

The server slows down. The client clock does not model that, so meteors jump
backwards on screen. The server's meteor trajectory itself is clean.

![Client server-clock: extrapolation lead and rewinds](mac-metal-session-analysis-2026-09-24/render_clock.png)

### The render clock steps backwards (measured)

- **Server time on the wire is `tick × 16.67 ms`.** When ticks take longer
  than 16.7 ms, server time runs slower than wall time: 59.5 s of simulation
  in 101.4 s.
- **The estimator assumes rate 1.0.** `netcode/src/clock_sync.rs` smooths the
  offset and hard-snaps when the error exceeds 10 ticks (167 ms). Against a
  server running at 0.23–0.97x, the estimate drifts ahead until it snaps back.
- **Size of the rewinds.** The dynamic-body render time stepped backwards 297
  times, −20.5 s in total. 106 steps exceeded 100 ms. The worst were −675 ms
  at 5.2 s, −613 ms at 20.1 s, −363 ms at 71.3 s, −349 ms at 81.3 s and
  −338 ms at 16.6 s.
- **Every meteor rewound.** All 21 meteors moved backwards on screen, in 982
  frames. The largest single-frame jump was 93 m: meteor 26 on its arc at
  5.19 s, during the −675 ms snap. The next largest was 49 m (meteor 28 at
  12.5 s); later flights peaked at 10–35 m.
- **The launch arc rewinds too.** 477 of the 982 backward frames came while
  the meteor was drawn from its launch arc alone. The arc is evaluated at
  the render time, so it has no network samples involved.
- **The clock alone is enough.** 4 meteors never streamed a body (36.6, 63.3,
  63.4, 75.1 s) and still rewound. Only the clock can cause that.

### Interpolation delay collapsed, so the client almost always extrapolates (measured)

- **The delay is at its floor.** The adaptive delay was 5.0 ms for dynamic
  bodies and 8.33 ms for players for the whole session. Loopback jitter is
  about 0, so `jitter × 4 + 5 ms` stays at the floor.
- **Snapshots arrive much more slowly than that.** The gap between arrivals
  was 21.4 ms median, 46.9 ms p90, 142.9 ms p99 and 557 ms max. 78 gaps
  exceeded 100 ms.
- **Extrapolation is the normal case.** 90.7% of frames rendered dynamic
  bodies past the newest snapshot. The lead was 49 ms median, 131 ms p90 and
  251 ms p99; 21% of frames were more than 100 ms ahead.
- **The extrapolation is linear.** `client/src/net/interpolation.ts`
  extrapolates with velocity for up to 250 ms. When the next snapshot
  arrives the body snaps back.
- **Meteors are drawn underground after impact.** The server had them above
  ground, but 228 body-sourced frames across 17 flights drew them below
  y = 0, down to y = −19.8 m.

### The arc-to-body handover jumps (measured)

A meteor is drawn on its arc at render time. When its body first streams, a
body with a single sample is drawn at that sample's server time, because one
sample cannot be extrapolated. The jump is therefore about the lead before
the handover × speed.

- There were 17 handovers. The jump was 7.8 m median and 24.3 m max.
- **Largest (24.3 m):** meteor 26 at 78.8 s. A −158 ms clock snap landed on
  the handover frame; the lead before it was 180 ms.
- **Clearest example (22.1 m):** meteor 30 at 64.9 s, with 162 ms lead ×
  147 m/s.

### The stale rule holds, then jumps (measured)

`MeteorLayer` treats a body sample older than 250 ms as stale. The age is
measured against the client's server-time estimate. During server stalls the
meteor is then held in place and jumps when samples resume. There were 35
hold→body jumps, up to 33 m.

### The server's meteor motion is clean (measured)

- **Positions match velocity.** Consecutive server positions agree with
  integrating the reported velocity: p50 2 mm, p99 0.08 m (trapezoidal
  integration), max 1.26 m at impact.
- **The flight follows the arc.** In flight, server positions are 0.14–0.41 m
  from the launch arc at the same server time (450 samples).
- **Flights take longer on the wall clock.** Planned flights took 1.1–3.4x
  their planned time on the wall clock, median 1.7x. Meteor 30 (59.6 s) was
  planned at 2.57 s and took 6.7 s from launch tick to landing tick.

![Meteor 30 at 59.6 s: drawn vs arc vs server](mac-metal-session-analysis-2026-09-24/meteor_30_59s.png)

*Red is drawn, blue is the arc at render time, green is the newest server
sample. The sawtooth after 65 s is extrapolation followed by snap-back.*

## Finding 2: slow motion is the server tick (PhysX GPU step)

### The whole game ran slow (measured)

- **Snapshot rate.** Snapshots arrived at 35.2 Hz on average: one per tick,
  tick deltas all 1, none lost.
- **Simulation speed.** Game time ran at 0.587x real time. In 5 s windows it
  ranged from 0.23x (65–70 s) to 0.97x (95–100 s).
- **The client followed the server.** The client's render-clock rate matched
  the server rate window by window, so the client did not stretch time.
- **The server log agrees.** Match-health ticks per wall second were 40.6,
  36.5, 30.5, 26.4 and 33.4 over the tape, then 58–60 when quiet.

### The tick is PhysX GPU time (measured)

- **Over budget almost everywhere.** The mean tick exceeded 16.7 ms in 50 of
  59 match-stats windows. The other 9 were the quiet start (4 windows), the
  last 4 windows, and the window containing the first impact (mean 15.1 ms,
  but a 646 ms max).
- **Size of the tick.** Once destruction started, window means were 12.6–
  55.2 ms (median 28.2 ms). Window p95 reached 145 ms. The worst single tick
  was 646 ms, in the window at the first meteor impact (about 5 s).
- **Where the time goes.** 98.4% of tick time is the dynamics step. City
  encode, stream and fracture bookkeeping peak at 0.98 ms per tick.
- **GPU wait.** The last-step PhysX GPU wait samples were 5.7–142 ms (median
  25 ms) once destruction started.

### The tick scales with active bodies (measured fit, inferred cause)

- **Fit.** The tick is about 14.9 ms + 0.0197 ms × active dynamic bodies
  (r = 0.67). At the observed peak of about 1,430 active bodies the tick was
  55 ms, above the fit's 43 ms.
- **Weaker correlates.** Correlation is weaker with broken bonds (r = 0.36)
  and chunk bodies (r = 0.35). Awake bodies matter more than accumulated
  rubble.
- **The baseline does not match the benches.** The ~15 ms intercept is far
  above the bench measurements in
  [mac-metal-performance-2026-09-23](mac-metal-performance-2026-09-23.md):
  idle 1.8 ms paced, and 5–7 ms with 100–370 rubble bodies awake.
  - Candidate 1 (unproven): `CUMETAL_USE_METAL_DEVICE_ADDRESSES`, which
    serialises streams.
  - Candidate 2 (inferred): the client rendering on the same GPU.
- **It stayed slow after the tape.** For about 55 s after the tape, with only
  16–51 bodies awake, the server ran at 42.6–59.5 ticks/s (08:08:47–08:10:18
  UTC). After that it held a steady 60.

### The player's own motion stuttered (measured, thresholds matter)

The camera was compared with the server's player speed. These numbers come
from an ad-hoc pass in the analysis run that was not saved as a script, and
they depend on thresholds.

| Measure | Result |
|---|---|
| Camera frozen while the player moved | 6.7% of frames. A 5 mm/frame threshold reproduces 6.2% |
| Of those, frames > 100 ms ahead of the newest snapshot | 81–85% |
| Frames that jumped > 3x the expected distance | 205 in the original pass; 316–372 depending on definition |
| Frames that reversed direction | 274 in the original pass; 500–770 depending on definition |

The server hit its input cap (`MAX_INPUT_FRAMES_PER_TICK` = 8 input frames
applied in one tick) in 31 of 59 windows. Window p95 was 8 at 70–75 s. At
66.4 s, 12 inputs were pending. The player's inputs are applied in bursts,
because the server consumes a backlog when a slow tick finishes.

## Finding 3: the client renders slower while sharing the GPU (inferred)

- **Live frame rate (measured).** The live client averaged 71.3 fps. Frame
  times were 10.4 / 23.3 / 51.2 ms (p50/p90/p99) against main-thread CPU of
  2.1 / 3.7 / 5.5 ms. 22.8% of frames exceeded 16.7 ms.
- **It follows the server.** Per-second client fps correlates with server
  ticks per second (r = 0.90), not with awake chunks (r = −0.20).
- **Long frames with idle CPU line up with server stalls.** There are runs
  of ~93 ms frames at 2–3 ms CPU at 16.0–16.7 s, 21.2–21.4 s and
  82.0–83.1 s. The 428 ms frame at 20.05 s falls in the match-stats window
  whose worst tick was 514 ms.
- **Replay without a server (measured).** The same tape and recorded camera
  were replayed in headless Chromium (ANGLE/Metal, 1512×945 @2x) with no
  server running:

  | | Live (server on the same GPU) | Server-less replay |
  |---|---|---|
  | Average fps | 71.3 | 113.4 |
  | Frame p50 / p90 / p99 | 10.4 / 23.3 / 51.2 ms | 8.3 / 9.1 / 18.4 ms |
  | Frames > 16.7 ms | 22.8% | 2.1% |
  | Worst 5 s windows | 43 fps (15–20 s), 44 (45–50 s), 45 (65–70 s) | 92 fps (15–20 s), 87 (80–85 s) |

  The replay's fps also correlates with the live server tick rate (r = 0.49).
  The heaviest scenes cost the renderer too, but far less than the live gap.
  The replay decodes and renders everything the live client did. Decode cost
  is not on the tape, but the replay shows it fits within 113 fps.

## Finding 4: the network is not the limit (measured)

- **Bandwidth.** Inbound averaged 648 kbps, peaking at 1.83 Mbps.
- **By stream:**

  | Stream | Size |
  |---|---|
  | City chunks (datagrams) | 6.12 MB |
  | Match stats | 889 kB |
  | Baselines | 608 kB |
  | Snapshots | 291 kB |
  | Topology | 222 kB |
  | Structure repairs | 48 kB |
  | Energy | 18 kB |

- **Chunk sends.** 1,651 chunk sends (one per sent tick) had median size
  3,063 B. 75 (4.5%) hit the 10,400-byte per-send cap, at 65–75 s and around
  90 s.
- **Sends follow ticks.** Chunk sends per second follow the tick rate:
  30/s when the server is at 60 Hz, 4–13/s in the slowest windows (65–70 s,
  80–82 s).
- **No loss.** There were 0 datagram sequence gaps and 0 topology sequence
  gaps.

## Other problems found

### (a) Debris and meteors fall through the ground (measured)

- **14 chunk bodies went below y = −3 m.**
  - They crossed −3 m moving down at 7.8–9.8 m/s; two crossed at 19.7 and
    28.5 m/s.
  - These are slow crossings, not high-speed tunnelling.
  - They kept streaming as they fell, reaching as low as −337 m.
- **The server log has 15 "left the world" lines.**
  - 14 are these bodies, logged at y ≈ −999 m at 140–160 m/s, aged 706–898
    ticks. That is about 14 s of free fall from ground level
    (√(2·1000/9.81) = 14.3 s, 140 m/s).
  - The 15th left sideways at z ≈ +1000 m at 39 m/s.
  - The velocity-explosion counter stayed 0, so these were not explosions.
  - The bodies stayed awake and simulated until the 1 km bound. The kill
    floor `VIBE_CITY_NATIVE_DEBRIS_FLOOR_M` in
    `physx-bridge/src/native_observation.cc` is disabled (−∞) unless set.
- **Two meteor balls also sank through the ground on the server.**
  - Meteor 25 (launched 1.9 s) went below −1 m at 20.9 s and was at −47.9 m,
    falling at 31 m/s, when it stopped streaming (24.1 s).
  - Meteor 28 (launched 87.3 s) went below −1 m at 99.9 s and was at −23 m
    at the end of the tape.
  - Both had been on the ground for a while first: meteor 25 for about
    15 s, meteor 28 for about 9.5 s.

### (b) Structure state diverged nine times with zero loss (measured)

- **Repairs.** The server sent targeted structure-bootstrap repairs at 29.9,
  32.7, 46.1, 61.2, 86.8, 89.8, 92.8, 95.8 and 100.8 s. They covered
  structures 8, 9+13, 0, 5, 7, 7, 11, 3+9 and 13: 48 kB in total. Match
  stats count 9 desync repairs.
- **No gaps.** There were no datagram or topology sequence gaps, and every
  snapshot tick was consecutive.
- **Inferred cause.** Divergence without loss points to a client/server
  bookkeeping bug in topology or promotion handling, not the network.
- **Cause (measured, item 6).** Nothing diverged. Every repair was asked for
  by the client's settle check, which took a settle far from the body's last
  streamed pose for a membership disagreement. The bodies were debris thrown
  out of the client's interest: the encoder stops streaming them, and their
  settle (reliable, sent to everyone) lands 11-174 m from the last pose the
  client was sent. The ledger hashes, which compare bonds and membership,
  matched at every check.

### (c) Client CPU spikes at fracture onset (measured)

- **Spikes.** CPU-bound frames of 50–118 ms occurred at 4.6, 5.3, 9.1,
  48.1 and 90.4 s (plus 5.4, 9.6 and 90.7 s).
- **Timing.** Each coincides with a fracture starting.
- **Inferred cause.** One-time setup cost on first use.

### (d) Match stats and energy crowd the ordered reliable stream (measured)

- **Match stats are large.** Each match-stats packet is about 15 kB of JSON,
  sent once per 60 ticks: 59 packets, 889 kB. That is 10.8% of all inbound
  bytes, more than topology and repairs combined (270 kB).
- **It shares a stream with topology.** It is on the same ordered reliable
  stream, so a 15 kB write can delay the topology behind it (inferred).
- **Energy is sent every tick.** The local-player energy packet went reliably
  every tick: 3,570 messages, 68% of reliable-stream messages. The value
  changes every tick, and `maybe_send_local_player_energy_update` sends on
  any change.

## To-do (ranked by impact)

Items are checked off by whoever lands the fix. Each needs a tape (preferably
paired) showing the acceptance criterion.

- [ ] **1. Server physics: tick < 16.7 ms p95 at ~1,500 active bodies with a
  client rendering on the same GPU.**
  - *Layer / owner:* server physics; PhysX fork and cuda-metal (also being
    worked in those repos).
  - *Do:*
    - Profile PhysX GPU wait with and without
      `CUMETAL_USE_METAL_DEVICE_ADDRESSES`.
    - Explain the ~15 ms intercept against the 1.8 ms paced idle bench.
    - Confirm GPU contention with a paired capture: server GPU timeline plus
      client GPU timer, with the client on and off.
  - *Accept:* tick p95 < 16.7 ms in every 60-tick window of a session like
    this one, and server rate ≥ 59 ticks/s.
  - *Evidence:*
    - 50 of 59 windows over budget.
    - The tick is 98.4% dynamics.
    - Fit: 14.9 ms + 0.0197 ms per active body.
    - Client fps vs server rate r = 0.90.
    - Replay without a server: 113 fps; live: 71 fps.
- [x] **2. Client clock: model the server-time rate.**
  - *Done (2026-09-24):* `netcode/src/clock_sync.rs` estimates the rate
    (from the item 4 wall stamps, else arrivals), never advances past the
    newest snapshot by more than one interval, and slews; `RenderClock`
    never steps back. Replayed through the new code
    (`scripts/perf/tape-analysis/replay-clock.ts`): 296 → 0 backward steps,
    playout rate equal to the server rate in every 5 s window. Live bench
    (quick, 3 clients): 269–283 → 0 per client.
  - *Layer / owner:* client netcode, `netcode/src/clock_sync.rs`.
  - *Do:*
    - Estimate the server-time rate instead of assuming 1.0.
    - Slew instead of hard-snapping.
    - Never let render time go backwards.
  - *Accept:* 0 backward render-clock steps on this tape replayed through
    the new estimator (`meteors.ts` computes this). Playout rate still
    tracks the server rate.
  - *Evidence:* 297 backward steps, −20.5 s in total, up to −675 ms. 4
    meteors that never streamed a body still rewound.
- [x] **3. Client interpolation and meteor drawing.**
  - *Done (2026-09-24):* the delay is the p95 of sim time between arrivals,
    at least one snapshot interval, at most 250 ms; meteor placement is one
    function (`client/src/vfx/meteorPlacement.ts`) used by the layer and the
    tools; ballistic extrapolation for bodies in free fall; staleness in
    server ticks. On this tape: extrapolating 90.7% → 0%, meteors moving
    backwards 21 → 0, hold jumps 35 → 0, below-ground frames 215 → 0. The
    arc→body frame-to-frame step is 1.1 m median / 2.2 m max, over the 1 m
    criterion, because it includes one frame of flight at 150 m/s; the gap
    to the arc at the same render time (the actual discontinuity) is
    0.29 m median / 0.45 m max. Cost: body delay 5 ms → ~20 ms on loopback.
  - *Layer / owner:* client, `client/src/net/netcodeClient.ts`,
    `client/src/net/interpolation.ts`, `client/src/vfx/MeteorLayer.tsx`.
  - *Do:*
    - Keep the body delay ≥ one observed snapshot interval; don't trust ~0
      loopback jitter.
    - Extrapolate single-sample meteor bodies so the handover doesn't jump.
    - Use gravity-aware meteor extrapolation, or keep the arc until contact.
    - Base the stale rule on server ticks, not the estimated wall clock.
  - *Accept:* on this tape, arc→body jumps < 1 m, hold→body jumps < 2 m, no
    meteor drawn below ground while its server sample is above, and
    extrapolating frames < 10%.
  - *Evidence:*
    - Delay floor 5 ms against 21/47/143 ms snapshot gaps.
    - 90.7% of frames extrapolating.
    - Handover jump median 7.8 m, max 24.3 m.
    - 35 hold jumps up to 33 m.
    - Drawn down to y = −19.8 m.
- [x] **4. Server stream: let clients tell slow motion from network delay.**
  - *Done (2026-09-24):* SnapshotV2 carries a 4-byte trailer with the
    server's wall clock (µs mod 2^32), detected by length so older clients
    are unaffected; `PROTOCOL_VERSION` unchanged. Sim rate from the stamps
    vs the server tick log over 120 one-second windows: 0.0006% median,
    0.023% max error.
  - *Layer / owner:* server stream and protocol (`server/src/main.rs`,
    `shared/src`).
  - *Do:* send a wall-clock server time alongside the tick, or a "simulation
    running slow" rate signal.
  - *Accept:* the client can compute the sim rate within 5% per second
    without inferring it from arrival times.
  - *Evidence:* sim rate 0.23–0.97x in 5 s windows; the client could only
    see ticks.
- [x] **5. Server physics: debris and meteors tunnel through the ground.**
  - *Fixed (2026-09-24) in the PhysX fork, commit 0ece3f22 on
    fix/correction-vehicle-ground, promoted as 63a60440 on
    codex/cumetal-destruction and in the installed package.* Two
    fork GPU kernels (`setRigidDynamicGlobalPose`, used by the native sleep
    commit, and `refreshReboundShapeBounds`, run by the corrected re-solve)
    flagged every shape of a body as bounds-changed, including a Vehicle SDK
    car's wheel shapes, which never enter the broad phase. The GPU SAP then
    rewrote endpoint slots through those never-inserted handles (slot 0, the
    ground slab's x start), the ground's box sorted to the far end of the x
    axis, and the corrected pass never rediscovered resting bodies' ground
    pairs. Fix: flag and write bounds only for broad-phase shapes, as
    upstream does. Not CuMetal (every CuMetal toggle left it unchanged).
    Measured with the fixed package: ground_contact repros pass, systematic
    bench 0 bodies below -3 m in two runs (baseline 40), meteors drawn below
    ground 150 -> 0. The car repro tests run in the default suite. CUDA was not run; the faulty code is backend
    independent (inferred to affect CUDA too).
  - *Status (2026-09-24, not fixed):* the cause is in the PhysX fork's
    native destruction stage (or CuMetal's execution of it), not in
    vibe-land; reported to its owner.
    - *Measured, bench world truth* (`20260924-081316-baseline-systematic`):
      25 of the 27 below-ground balls were resting or rolling on the slab
      (vy 0.000) and lost all support in one tick (vy -0.164 = -g*dt); the
      other two went in while in flight. Of 46 ticks on which a resting ball
      lost support, 42 were ticks whose physics step took 20-100 ms instead of
      ~7 (a fracture's corrected re-solve; 2.9% of all ticks are that slow),
      and balls hundreds of metres apart
      often lost support on the same tick. No contact-buffer overflow (high
      water 10,916 of 8.4 M contacts), no PhysX warnings.
    - *Measured, isolated* (`physx-bridge/tests/ground_contact.rs`): the
      city's slab, six hull walls, balls 30 m clear. With the city's two
      parked cars present every awake ball on the slab loses support on
      exactly the first corrected tick and falls to y = -300 m; sleeping
      balls follow on later corrected ticks. Same with the stage's reference
      pair lifecycle (`preserve_unchanged_contact_pairs = false`), which also
      drops 20 fragments. Without the cars: six corrected ticks, nothing lost.
      A player capsule alone does not trigger it; parked or driving cars do.
    - *Measured, production scale* (systematic bench, same build): with the
      cars (`20260924-100646-item5`) 55 bodies went below -3 m (27 balls, 28
      chunk bodies); with `VIBE_CITY_VEHICLES=0`
      (`20260924-101511-item5-nocars`) 0. So the chunk bodies are the same
      fault. (Without cars the drive step does not run, so its settled-phase
      numbers are not comparable.)
    - *Measured, settled cost:* bodies retired at the floor are still
      simulated by the stage. With `VIBE_CITY_NATIVE_SLEEP_THRESHOLD=0.05`
      (`20260924-102225-item5-sleep005`) the idle phase has 12 awake bodies,
      exactly the 12 retired below the floor, against 636 at the default;
      still 0% of idle ticks with nothing awake, and idle tick p50 7.05 ms
      against 7.74. The fallers are what stops the city sleeping completely;
      whether the stage would then skip its pipeline is unmeasured.
    - *Landed here:* the first below-ground tick of every chunk body and
      fired ball/meteor is logged with velocity, the tick before, support,
      static contact reports (balls) and the stage's frame/corrected passes;
      bodies are retired at a floor 5 m under the lowest ground
      (`VIBE_RETIRE_FLOOR_DEPTH_M`): chunk bodies as a retired island,
      balls as an expired ball. The PhysX chunk body is left to the stage.
  - *Layer / owner:* server physics and native destruction.
  - *Do:*
    - Find why resting bodies sink at 8–10 m/s.
    - Retire escaped bodies at a floor near the ground, not at 1 km.
    - Log the first below-ground tick with the body's contact state.
  - *Accept:* 0 bodies below y = −3 m in a session like this one.
  - *Evidence:* 14 chunk bodies and 2 meteor balls went below ground; 14
    "left the world" lines at y ≈ −999 m after about 14 s of free fall.
- [x] **6. Destruction sync: find why structure state diverges with zero loss.**
  - *Done (2026-09-24):* the state did not diverge. Every repair was asked
    for by the client's settle check (`CityTopology.apply`,
    `client/src/city/topology.ts`), not by the ledger hash. The check refuses
    a settle more than 10 m from the body's pose and asks for a structure
    repair, on the theory that the two sides disagree about the body's
    members. That theory assumes the stream has been showing the body. The
    encoder's per-client interest filter (view plus 120 m proximity) stops
    streaming a body that leaves the client's interest, and the settle, which
    the reliable stream sends to every client, then lands wherever physics
    took the body. The check now compares the settle with the newest pose the
    server sent (not the presented pose, which trails it) and applies a far
    settle when that pose is older than the settle and was taken while the
    body was moving more than 30 ticks earlier (`settleVerdict`; counter
    `settlesAfterSilence`). A settle older than a pose the stream has already
    shown (on a slow link the reliable message can arrive after newer
    datagrams) keeps the newer pose (`settlesSuperseded`). A body last shown
    at rest, or shown recently, is still checked as before. Membership is
    still compared exactly by the ledger hash every 120 ticks.
  - *Evidence, before (measured):* both sessions replayed through the client
    (`client/netlab/v2/clientStage.mts` on the recorded tapes, with per-settle
    logging): baseline systematic 5 settle rejects, 5 repair requests; owner
    session 12 settle rejects, 8 requests (the tape has 9 repairs). All 17
    rejects were single-chunk debris (one 3-chunk), last streamed in
    ballistic flight 155-537 ticks before the settle, 11-174 m from it. Ledger
    hash checks: 163 and 30, 0 mismatches. No settle with a record in the 30
    ticks before it moved more than 0.45 m (2,394 settles).
  - *Evidence, after (measured):*
    - Recorded tapes through the fixed client: 0 settle rejects and 0 repair
      requests on both (baseline 6 and owner 12 settles applied after
      silence); hash mismatches 0.
    - Netlab v2 on the baseline systematic capture (legacy capture: the
      encoder starts fresh, so city bytes are not live-identical), with the
      recorded repairs withheld (`--knob lab.recorded_repairs=0`), 337 s:

      | Link | Datagrams lost | Repairs asked, before | Repairs asked, after | Hash mismatches (163 checks) |
      |---|---:|---:|---:|---:|
      | recorded, loopback, lan | 0 | 72 | 0 | 0 |
      | wifi-good | 164 | 72 | 0 | 0 |
      | lossy-wifi | 1,053 | 72 | 0 | 0 |
      | lte | 1,016 | 72 | 0 | 0 |
      | loss-burst | 1,591 | 72 | 0 | 0 |
      | poor-mobile | 1,019 | 80 | 0 | 0 |

      Before, the unrepaired structures re-ask every 3 s, hence 72. With the
      recorded repairs replayed (open loop) the before client asks 5 on
      every lossless link; the after client 0 on every link except lte and
      poor-mobile, 1 each, where a recorded repair the client never asked
      for arrives at a different stream position and falls back to the full
      path (inferred from the counters: 5 replayed, 3 applied). City chunk
      error is unchanged on every link (lever p99 0.292 m lossless).
    - `netlab2 calibrate` on rec1 with this client change on the client that
      recorded it: PASS, bytes 100%, lab vs recorded tape 0.000 m.
    - City bench systematic, 1 client, live
      (`target/structure-sync/city-bench/runs/20260924-103738-item6` against
      `target/city-bench/runs/20260924-081316-baseline-systematic`): structure
      repairs 5 → 0 (`net.repairs_without_loss` passes), 0 lost packets, 0
      datagram and topology gaps, 166 hash checks with 0 mismatches; the one
      resync request is the join bootstrap (`last_topo_seq=0`), as in the
      baseline. Destruction reached 84.7% vs 84.3% of bonds. The run's
      samples predate the `settlesAfterSilence` counter in the e2e export.
  - *Tests:* `destruction/tests/settle_after_silence_wire.rs` drives the
    production encoder with a fragment thrown out of the client's interest
    and pins that its last streamed pose is 65 m from its settle; it writes
    `client/src/city/fixtures/settle-after-silence.json`, which
    `client/src/city/settleAfterSilence.test.ts` replays through `CityClient`
    (0 requests, ledger at the settle pose, hashes equal to the server's).
    `topology.test.ts` covers the verdicts. Mutation-checked: with the old
    rule the fixture test and five of the new unit tests fail.
  - *Netlab:* `--knob lab.recorded_repairs=0` withholds the recorded
    repairs, and each run reports a `city sync` line (repairs asked, hash
    checks and mismatches, settle rejects, settles after silence).
  - *Risk (inferred):* a body last streamed at rest that is pushed more than
    10 m while out of interest, without a wake, still costs one repair; none
    occurred in either session. A genuine membership disagreement on a body
    out of interest is now caught by the ledger hash instead of the settle,
    up to 2 s later.
  - *Layer / owner:* server city encoder and client topology.
  - *Do:*
    - Capture per-structure hashes per update; the paired capture can carry
      them.
    - Diff client and server at the first divergent update.
  - *Accept:* 0 structure-bootstrap repairs in a lossless session.
  - *Evidence:* 9 repairs (48 kB) with 0 datagram, topology or snapshot gaps.
- [x] **7. Server stream: move match stats off the ordered reliable stream,
  and stop sending energy reliably every tick.**
  - *Done (2026-09-24):* match stats are a ~246-byte binary frame of only
    the ~57 fields the stats overlay and the tape analysis read
    (`shared/match-stats-frame.json`, shared by `server/src/match_stats_frame.rs`
    and `client/src/net/matchStatsFrame.ts`), sent once a second as a
    datagram; the full snapshot stays on `GET /match-stats/:id`. Same kind
    (124): clients still read old servers' JSON (`{` after the kind), and
    `PROTOCOL_VERSION` is unchanged. Energy (`server/src/energy_stream.rs`)
    goes when the HUD's integer changes, on a gain and on reaching zero, at
    most every 6 ticks (10/s), with the exact value within 1 s; the client
    (`client/src/net/energyDisplay.ts`) follows the measured drain between
    messages without dropping below the integer the server sent. City bench
    (quick, 3 clients, `target/stream-stats/city-bench/runs/20260924-090926-item7`
    against `20260924-081934-fanout-quick`): match stats 31.3-34.4% of bytes
    (1,779 kB, 111 reliable packets) -> 0.93-1.03% (26 kB, 106 datagrams);
    energy 54.5 msg/s -> 1.3-1.9 msg/s (at most 5 in any second); the
    reliable lane 18.1-18.2 kB/s and 63.8 packets/s -> 2.1-2.3 kB/s and
    8.3-8.9 packets/s.
  - *Layer / owner:* server stream (`server/src/main.rs`).
  - *Do:*
    - Move match stats to their own stream, or compress them, or send them
      less often.
    - Rate-limit or quantise energy.
  - *Accept:* match stats < 2% of bytes and not ahead of topology on the
    same ordered stream; energy messages ≤ 10/s.
  - *Evidence:* 889 kB (10.8%) of match stats; 3,570 energy messages.
- [ ] **8. Client: pre-warm what fracture onset builds on first use.**
  - *Layer / owner:* client city and destruction rendering.
  - *Do:* profile the 50–118 ms CPU frames; build those resources at load.
  - *Accept:* no CPU-bound frame > 33 ms at the first fracture of a session.
  - *Evidence:* CPU-bound frames at 4.6, 5.3, 9.1, 48.1 and 90.4 s.

- [x] **9. Client clock: lag grows with jitter and with how often it is read.**
  - *Done (2026-09-24):* the output of `ServerClockEstimator`
    (`netcode/src/clock_sync.rs`, and its TypeScript twin
    `client/src/net/serverClockModel.ts`) is now a function of the snapshots
    received and the local time only. At each snapshot it is anchored where
    it stands and given a speed (the rate, plus the error to the uncapped
    model over `SLEW_TAU_US`, between a stop and 1.5x); until the next
    snapshot it runs at that speed and stops at the ceiling (newest sample +
    one snapshot interval + RTT/2). The root cause was that the old output
    re-slewed per read towards a model that stops at that ceiling between
    snapshots: every read during a late snapshot's wait gave up ground that
    only the 300 ms decay won back, so more reads and more jitter meant more
    lag. `RenderClock` now takes the new target delay at the snapshot's
    arrival (`retarget`), so its slew is per unit of server time too.
    Kept from 0eb6f3fd: never steps back, never more than one snapshot
    interval past the newest sample, rate from the wall-clock trailer,
    a stall freezes it.
  - *Evidence (Netlab v2, rec1, recorded pace, measured):* clock lag p50
    (server tick now minus the clock's estimate) on a 90 ms link: no jitter
    82.1 → 83.7 ms; ±10 ms 137.8 → 86.0 ms; ±35 ms 275.0 → 87.9 ms (4.2 ms
    over the jitter-free lag, within one 16.7 ms interval). Read rate:
    ±35 ms at 60 Hz / 120 Hz / recorded frames 190.1 / 278.1 / 275.0 ms
    before, 89.2 / 87.9 / 87.9 ms after (the residue is where the frames
    sample, not the clock: unit tests show identical outputs at 60 Hz,
    240 Hz and on arrival only). lte 274.4 → 87.9 ms, poor-mobile 340.6 →
    149.0 ms; bodies drawn behind the server p50 332.7 → 146.7 ms on lte.
    Back-steps 0 on every link before and after. Cost: +1.6 ms clock lag
    p50 on loopback/lan (12.4 → 13.9 ms behind the server), where the
    server's own tick jitter now occasionally stops the output at its
    ceiling; p99 falls 45.3 → 36.5 ms.
  - *Layer / owner:* client netcode, `netcode/src/clock_sync.rs` (item 2's
    estimator).
  - *Found by:* Netlab v2 (`docs/netlab-v2.md`), in the lab; not yet
    confirmed live.
  - *Evidence (measured in the lab):* on a 90 ms link the clock lags the
    server by 84 ms with no jitter (expected), 141 ms with ±10 ms jitter read
    every frame, 276 ms with ±35 ms (108 ms if read only on arrival). The
    catch-up and hold are applied per read, not per unit of time.
  - *Do:* make the slew and hold time-based so the result does not depend on
    the read rate; re-run the Netlab jitter sweep.
  - *Accept:* lag within one snapshot interval of the jitter-free lag at
    ±35 ms jitter, independent of read rate; still 0 back-steps.
- [x] **10. Client: retired and out-of-range bodies stay drawn.**
  - *Done (2026-09-24):* the root cause was the client's only rule for a
    body the stream stops carrying: drop it after 240 ticks (4 s) whatever
    it was doing. The server never says a body is gone, so
    `client/src/net/bodyPresence.ts` now reads its absence against the
    snapshot builder's contract: a body last seen moving faster than 2 m/s
    is in every snapshot while in interest, so it is dropped after 15
    snapshot ticks without it (the meteor layer's stale window, now shared);
    a body at rest is re-sent once a second, so it is dropped when the
    snapshot that should have carried its refresh arrives without it
    (deferred by one refresh when a snapshot in that window was lost).
    `NetcodeClient` removes it from `dynamicBodies` and the interpolator,
    so every renderer stops drawing it.
  - *Evidence (Netlab v2, rec1, measured):* body frames drawn after the body
    left truth or the recipient's 80 m interest radius, loopback: 6,017 of
    9,294 (up to 3,983 ms after it left; 732 of them with no body in truth)
    → 321 of 3,600 (up to 233 ms, 0 with no body in truth). lte 5,673
    (3,767 ms) → 235 (200 ms); poor-mobile 5,681 (3,767 ms) → 230 (217 ms).
    Fast projectiles: err@render p99 188.6 → 0.026 m and 66% → 11% of frames
    extrapolated (loopback). rec1 has no resting body that is retired or
    leaves interest, so the resting rule is covered by unit tests only.
  - *Live check (city bench quick, 3 clients,
    `target/clock-fix/city-bench/runs/20260924-101426-clock-fix` against
    `target/netcode-clock/.../20260924-084654-netcode-clock-quick-3c-r2`,
    measured):* stale body draws 298 / 148 / 112 → 20 / 9 / 6 per client;
    render-clock back-steps 0 on every client; render lead p95 -5.3 →
    -6.6 ms. The server budgets failed in both runs and were worse in this
    one (tick p95 18.1 → 35.8 ms, peak active bodies 289 → 429, broken bonds
    20.8 → 27.6%): a heavier destruction outcome, not this change, which
    touches no server code (inferred).
  - *Layer / owner:* client entity lifetime (`netcodeClient.ts`, the
    dynamic-body renderers).
  - *Evidence (measured, live renderer samples):* retired or out-of-range
    cannonballs stay drawn at their last pose for up to 4 s; 60 of 759 live
    body samples were bodies the server no longer had.
  - *Accept:* no body drawn more than one staleness window after the server
    stops having it.
- [x] **11. Client: a meteor's body after impact.**
  - *Done (2026-09-24):* `placeMeteor` no longer holds a rock whose body has
    left the stream where it was last drawn: it returns `hidden`, and the
    netcode client drops the body by the same rule (item 10), so once the
    flight is forgotten there is no stale body left to draw as a plain ball.
    While the body is streamed the rock is drawn from it as before.
  - *Evidence (Netlab v2, rec1, measured):* meteor err@render p99 43.3 →
    0.18 m (loopback; lte 44.3 → 0.18 m, poor-mobile 42.8 → 0.29 m); meteor
    body drawn as a plain ball after its flight: 366 frames at 138 m p50 →
    0; meteor frames drawn from a body out of truth or interest 117 (up to
    983 ms) → 26 (up to 233 ms, the detection window).
  - *Layer / owner:* `client/src/vfx/meteorPlacement.ts`, `MeteorLayer.tsx`.
  - *Evidence (measured):* after impact the body rolls out of range while
    the meteor layer holds it (43 m p99 from truth); once its flight is
    forgotten the same body is drawn as a plain ball, 138 m p50 from truth.
  - *Accept:* the post-impact meteor body is drawn within 1 m of truth
    until it leaves interest, then removed.

- [x] **12. Client: chunks stay on the body they left while topology is late.**
  - *Done (2026-09-24):* the root cause was the city render clock, not the
    topology lane. `CityClient` extrapolates its render tick from the newest
    datagram at a measured tick rate, and that rate was an EMA of the ratio
    between consecutive arrivals. Under jitter the mean of that ratio is
    biased high (short gaps dominate): Netlab LTE 69.3 ticks/s p50 (p90 81.9)
    against a server at 55.9. The clock's pull then held it ahead of its
    anchor, so the presented city (render tick minus the 6-tick playout
    delay) ran 2.9 ticks behind the server instead of about 10, ahead of the
    newest datagram on most frames and ahead of the server's own tick on
    18.2% of LTE frames (7.4% on loopback, where the server stalls at
    fractures). Topology, however fast it travelled, arrived after the
    presentation had passed it (252 of 285 promotion/migration messages
    late on LTE, p50 6 ticks). Three changes in `client/src/city/cityClient.ts`
    (wire v2 only, v3 untouched):
    - the tick rate is ticks over time across a 2 s window of arrivals
      (`observeSimTick`), which the jitter only enters at the ends;
    - the render clock stops one playout delay past the newest streamed tick
      for up to 300 ms after it (a slow tick is 20-100 ms), so the presented
      tick never passes the pose stream during a server stall; a clock left
      behind by a quiet stream jumps forward only while nothing is moving;
    - a record for a body the ledger does not know is proof of a promotion in
      flight (first record tick minus promotion tick: p50 0, p90 1), so the
      presentation holds one tick before it until the promotion lands, at
      most 1 s and 30 ticks of delay, released at the usual shrink rate
      (`HOLD_FOR_MISSING_TOPOLOGY`; `topologyHold*` counters). Held records
      now wait for their own promotion instead of being dropped by the next
      unrelated topology message.
    The playout delay constant is unchanged (6 ticks); the change restores
    the delay the rate bias ate, and adds delay only while evidence says a
    promotion is missing. `/city?leadCap=0` and `/city?topologyHold=0` turn
    the last two off.
  - *Rejected, with evidence:* holding records alone (the first try) moved
    LTE wrong identity only 61,092 -> 59,979, because the presentation was
    already past the records when they arrived (measured). Carrying
    membership in the datagram would not help either: the presentation ran
    ahead of the datagrams themselves, and 88 of the late promotions left
    after the rate fix were passed a p50 39 ms before the server had
    finished simulating their tick (measured). Adapting the delay to the
    topology lane's latency would have raised it for every body on the link.
  - *Evidence (Netlab v2, measured; `netlab2 compare` of the 3f3d891a client
    against this one via `--client-root`, production knobs, seed 1):*
    all-draws wrong-identity chunk-frames, systematic-2c-d1342419 c1:
    loopback 0 -> 0, lan 227 -> 0, lte 61,092 -> 448, poor-mobile 139,139 ->
    26,193. Attribution on LTE: rate fix alone 27,259, plus the hold 19,649,
    plus the lead cap 58 (uncapped in time) / 448 (as landed, 300 ms bound).
    heavy-quick3-v2 c1: lan 83 -> 0, lte 33,772 -> 122, poor-mobile
    751,832 -> 631,125 (a 1 Mbit/s link whose reliable lane starves behind
    the datagrams for seconds; 1,839 holds expired). Debris pos@render p99
    lte 0.677 -> 0.114 m, loopback 0.332 -> 0.088 m.
  - *Cost (measured):* the city is drawn later on jittery links: presented
    tick minus server tick p50 loopback -4.8 -> -5.2, lte -2.9 -> -10.2,
    poor-mobile -7.1 -> -14.1 ticks, so debris pos@now p99 rises (lte 1.136
    -> 2.393 m, loopback 0.966 -> 1.521 m; p50 unchanged at 8-9 mm). The old
    figure was bought by drawing ticks the stream had not delivered.
  - *Tests:* `cityClient.test.ts` "CityClient presentation clock (item 12)":
    unbiased rate and presentation behind the stream on a 90 +- 35 ms link,
    no lead past the newest tick through a 250 ms server stall, the hold
    behind a promotion delayed 400 ms. All three fail on 3f3d891a.
  - *Found by:* Netlab all-body scoring (docs/netlab-v2.md), bundle
    `systematic-2c-d1342419`, c1.
  - *Evidence (measured):* wrong-identity chunk draws 0 (loopback),
    61,092 (LTE), 139,139 (poor-mobile). 1,995 moving body-frames on LTE were
    for bodies whose topology had not arrived (1-17 ticks late). Inferred
    cause: topology rides the reliable stream (LTE p90 297 ms) while the
    city playout delay (100 ms) only covers the datagrams.
  - *Accept:* wrong-identity chunk draws near 0 on LTE without raising the
    playout delay for everything.
- [x] **13. Client: a real structure repair brings retired chunks back.**
  - *Done (2026-09-24):* the server's ledger drops a retired island's nodes,
    and a bootstrap lists only islands, so a retired chunk and an intact one
    look the same on the wire: in no island. `applyStructureBootstrap` (and
    `applyBootstrap`) put both on the support body. `client/src/city/topology.ts`
    now marks a retired island's chunks (`isChunkRetired`) and, after a
    bootstrap or repair, takes a chunk in no island off the support body when
    this client saw it retired or when no alive bond path joins it to one of
    its structure's anchor nodes (the manifest's zero-mass `support` nodes;
    structures without anchors are left alone). The second rule covers a
    joiner, who saw no retire. Either rule alone gives the same result on
    the 0a7d6ae5 bundle (measured).
  - *Evidence (Netlab v2, systematic-2c-0a7d6ae5 c1, recorded repairs
    replayed, 21 applied on loopback/lan, 13 lte, 8 poor-mobile; measured):*
    chunk_intact extra 247,773 -> 0 (loopback, lan), 166,275 -> 0 (lte),
    159,400 -> 0 (poor-mobile); chunk_intact missing 0 on every link (no
    standing chunk hidden); hash mismatches 0.
  - *Tests:* `topology.test.ts` "retired chunks across bootstraps and
    repairs" (6 tests; all fail on 3f3d891a).
  - *Evidence (measured):* on the 0a7d6ae5 bundle a repair redrew retired
    chunks on the intact building (247,773 chunk-frames, 0.66% of intact
    draws). Item 6 removed the spurious repairs; a genuine one after loss
    still does this.
  - *Accept:* after a repair, no chunk the server retired is drawn.
- [x] **14. Client: floor-retired chunks stay drawn below ground.**
  - *Done (2026-09-24):* a retired island's chunks were orphans the pose
    tables kept drawing at their last pose by design ("drawn at its last pose
    until it is adopted"). `writeChunkRecordInto`
    (`client/src/city/cityPoseStore.ts`) now hides a retired chunk (record
    index -1, which the shader collapses) once the presentation reaches the
    retire tick: wire v2 applies topology a playout delay early, and hiding
    at arrival turned the draws into missing ones (loopback missing 174 ->
    308 on the first try, measured).
  - *Evidence (Netlab v2, systematic-2c-d1342419 c1, measured):*
    chunk_debris extra loopback 199,951 -> 152, lan 199,950 -> 153,
    poor-mobile 61,316 -> 497; lte 31 -> 348 (a later presentation meets
    the -4 m hide depth later; the item-12 clock). The remaining ~150 are
    chunks sinking through -4 m, drawn a few frames above it.
  - *Tests:* `cityClient.test.ts` "CityClient retired chunks (item 14)"
    (fails on 3f3d891a).
  - *Evidence (measured):* chunks retired at the 5 m escape floor (item 5)
    stay drawn 3.5-3.75 m below ground, above the -4 m hide depth; most of
    the loopback "extra" draws (5 chunks).
  - *Accept:* 0 draws of retired chunks.
- [x] **15. Meteor orientation is not streamed.**
  - *Decision (2026-09-24): not streamed; a local spin, made continuous.*
    Measured on systematic-2c-d1342419 c1 (9,224 body-drawn frames, 8
    flights):
    - the server's ball does not spin in flight: its orientation at the
      first body sample is the launch orientation on every flight;
    - the client integrates the streamed angular velocity from that start
      (`predictSphereQuaternion`), so the drawn orientation error is p50
      8.4 deg; p99 169 deg is drift, which grows with the rolling time;
    - the drawn spin, which is what the eye reads off the rock, matches
      truth: spin-vector error p50 0, p90 4.9, p99 8.4 rad/s at 30-40 rad/s.
      Part of that is the wire's per-axis clamp at 32.767 rad/s (28% of
      sampled frames exceed it); a rolling-spin fallback for clamped samples
      changed none of these percentiles and was not kept;
    - bytes are not the obstacle: a 32-bit orientation for meteor bodies is
      roughly 5-6 B x 60 Hz over ~80 s of body-drawn time, ~28 kB per client
      per 337 s session (~0.3% of netcode bytes; inferred from the frame
      count). What it would buy is agreement between clients on the absolute
      orientation of a sphere, which no player can compare, at the price of
      a SnapshotV2 extension and capture gating for calibration.
    The visible defect was a jump at contact: the layer's tumble accumulated
    from spawn and the body starts at the launch orientation, so the rock
    turned 47-83 deg (median ~64) in the handover frame (inferred from the
    layer's rule on the recorded timeline). The tumble is now
    `meteorPlacement.ts` `arcTumble`, a function of flight time phased to
    pass through the launch orientation at the planned landing, and
    `placeMeteor` returns it on the arc (so Netlab sees it). Measured
    handover step 0.2-17.7 deg, median ~1.3 deg (larger where contact comes
    before the planned landing: 0.45 rad/s times the difference).
    Rotation error vs truth (p99 ~172 deg) is unchanged by design, and the
    wire is unchanged.
  - *Tests:* `meteorPlacement.test.ts` "the arc tumbles, and meets the
    body's orientation at the planned landing" (fails on 3f3d891a).
  - *Evidence (measured):* a meteor drawn from its body has rotation error
    p99 172 degrees.
- [x] **16. Meteors whose body never streams stay on their arc.**
  - *Done (2026-09-24):* the two flights never streamed to the spectator
    (their landing points were outside its 80 m interest) were drawn exactly
    on the arc (<= 0.4 m) to the aimed point and then held there for the
    flight's 3 s linger while the real rock rolled 100-157 m away (measured,
    per flight). `placeMeteor` now leaves a never-streamed rock at its aimed
    point for one staleness window (250 ms) and then hides it; a body that
    starts streaming later is drawn from it as before.
  - *Evidence (Netlab v2, heavy-quick3-v2 c1, measured):* meteor pos@render
    p99 155.9 -> 18.4 m (loopback, lan, poor-mobile), 155.9 -> 19.0 m (lte);
    meteor missing 0 -> 0. The new live capture (below): 132.6 -> 13.7 m.
  - *Tests:* `meteorPlacement.test.ts` "a rock that never streamed is not
    drawn once its arc has ended" (fails on 3f3d891a) and "... starts
    streaming after its arc ended is drawn from the body".
  - *Evidence (measured):* heavy-quick3-v2, spectator: two meteors held on
    the arc, p99 157 m from truth.

**Items 12-16, live check** (city bench quick, 3 clients,
`target/sync-fidelity/city-bench/runs/20260924-131437-quick-3c-syncfix`,
measured): the capture recorded with this client calibrates PASS on every
`netlab2 calibrate` check (c1: bytes 100%, live debris chunks p99 5.8 cm,
drawn/not drawn 0 mismatches), so the lab reproduces the live client. Scored
through both clients (c1, `netlab2 compare`): wrong identity lan 100 -> 0,
lte 23,654 -> 749, poor-mobile 160,096 -> 68,161; chunk_debris extra loopback
41,537 -> 129; meteor pos@render p99 loopback 132.6 -> 13.7 m. Bench budgets:
0 render-clock back-steps, 0 repairs without loss; the failing budgets are
server tick/sim rate, below-ground (item 5), and meteor arc jump (11.2 m) and
backward frames (5). The 3f3d891a client on the same server binary, run right
after (`20260924-132210-quick-3c-base`), fails the same two meteor budgets
(21.7 m, 2), so they predate this change; the two runs' destruction differs
(33.3% vs 44.2% of bonds broken), so live counters are only indicative: city
presented jumps over 4 m 84 / 147 / 90 -> 38 / 29 / 55 per client, correction
snaps 37 / 53 / 38 -> 17 / 13 / 13.

### Transport policy

The WebSocket fallback is to be disabled: WebTransport only, unless
explicitly enabled. This is being implemented separately. This session was
WebTransport throughout: the tape header says `webtransport`, and the log
shows `websocket_players=0` and `datagram_fallbacks=0`.

## Next data: paired capture

Commit `c65aa1e4` makes RECORD TAPE also record the server into
`debug-reports/session-<id>/`: client tape, send log, per-tick world truth
and clock samples. Inspect a bundle with `scripts/perf/session_bundle.py`.
The next paired recording of a session like this one should confirm:

- **GPU contention (item 1).** Server tick and GPU wait from the tick log,
  against the client's GPU timer and frame times on one clock.
- **Server tick vs client clock (items 2 and 4).** Each received packet
  joined to its send record gives true send time and latency. That separates
  server stalls from the client clock running ahead.
- **Ground contact (item 5).** World truth per tick shows the first tick a
  body is below ground. It needs the contact state added to the capture.
- **Structure hashes (item 6).** Done without new capture fields: the
  per-structure ledger hashes already go to every client every 120 ticks
  (`city-topo-hash` on the tape), and the client stage's counters (Netlab's
  `city sync` line) say which check asked for a repair.
- **Input bursts.** Send-to-apply time for inputs during slow ticks.

The [city bench](city-bench.md) (`scripts/perf/city-bench.sh`) produces such
a paired recording repeatably: scripted headless players destroy the whole
city building by building, and its report measures every symptom above
(server tick and sim-rate, client frames, render-clock rewinds, extrapolation
lead, meteor handovers, repairs without loss, match-stats and energy
traffic, bodies below ground) against budgets taken from the to-do list's
acceptance criteria, per phase and against destruction level. Use it to
accept or reject each to-do item, and `--baseline` to compare runs.

## Reproduce

The scripts are in `scripts/perf/tape-analysis/`; see its `README.md`. In
short, from `client/`:

```bash
TAPE=../debug-reports/tape-1790237324-city-default/city.vltape
OUT=../target/tape-analysis
npx tsx ../scripts/perf/tape-analysis/decode.ts    $TAPE $OUT
npx tsx ../scripts/perf/tape-analysis/dumpstats.ts $TAPE $OUT/match_stats.json
npx tsx ../scripts/perf/tape-analysis/meteors.ts   $TAPE $OUT
npx tsx ../scripts/perf/tape-analysis/below.ts     $TAPE
cd .. && python3 scripts/perf/tape-analysis/analyse.py target/tape-analysis target/mac-server-play.log \
  --meteors 30@59.57,31@63.33,25@73.13
```

- **Outputs.** Everything is written to `target/tape-analysis/`
  (gitignored). The charts in this document were rendered from its
  `timeline.svg`, `render_clock.svg` and `meteor_30_59s.svg`.
- **Reproducibility.** Re-running on this tape reproduces `summary.json`
  exactly, except `server_log_health`, which grows with the server log.
- **The replay uses the GPU** (`run-replay-perf.sh` under
  `scripts/perf/gpu-run.sh`, no game server running). Caveats for the
  numbers above:
  - Headless Chromium at 1512×945 @2x, ANGLE/Metal. The dynamic resolution
    scale stayed 1.
  - Dust and other settings were the replay defaults, not necessarily the
    live client's.
  - A cargo build ran concurrently during the replay, so it is if anything
    pessimistic.
  - The replay's GPU timer values (p50 20 ms) are not consistent with its
    8.3 ms frames and were not used.
- **Manifest.** The replay used the manifest saved by an earlier recorder
  run (`target/tape-replay/run1/manifest-391bacd0….bin`), which has the
  same hash as the tape.

## Corrections to the first report

The first report of this analysis had some figures that the data does not
support. The figures in this document are the corrected ones:

| First report | Data |
|---|---|
| Walked at ~7 m/s | Median 6.0 m/s (simulation time) |
| Meteors moved back up to 35 m in one frame | Up to 93 m (meteor 26 at 5.19 s, on the arc during the −675 ms snap). Later flights peaked at 10–35 m |
| Largest handover 24 m was meteor 30 at 64.9 s | Largest was 24.3 m, meteor 26 at 78.8 s (clock snap on the handover frame). Meteor 30 at 64.9 s was 22.1 m, the clearest lead × speed case |
| Meteors drawn below ground to y ≈ −3 m | Down to −19.8 m by extrapolation. Two meteor balls also sank to −23 and −48 m on the server |
| Meteor 30 took ~5.4 s against 2.57 s planned | 6.7 s from launch tick to landing tick. About 5.3 s was launch to the first body sample |
| 5 s sim-rate windows 0.23x to 0.89x | 0.23x to 0.97x |
| 16 "left the world" lines | 15. 14 fell through the ground; 1 left sideways at z ≈ +1000 m |
| After the tape, 16 bodies awake, 42–55 Hz for ~50 s | 42.6 Hz was with 42 awake. With 16 awake it was 47–59.5 Hz, until about 08:10:18 UTC |
| Match stats ≈ 1/s | Once per 60 ticks: 59 packets in 101 s |
| ~1,400 active bodies → ~55 ms from the fit | 55 ms is the observed window mean. The fit gives 43 ms |
| Server motion p99 0.12 m, 0.2–0.46 m from the arc | p99 0.08 m and 0.14–0.41 m with the saved method. The difference is the integration method; the conclusion is unchanged |
| Camera frozen 6.7%, 205 jumps, 274 reversals | Definition-sensitive; see the table in Finding 2 |
