# Vehicle netcode quality: an adversarial qualification plan

The deliverable is a repeatable hill to climb, not a faster implementation. No
new GPU simulation or browser performance benchmark is needed to run the fixed-tick
suite. The existing live lab retains timing diagnostics, but neither frame time nor
wall-clock input-processing time determines its quality verdict now.

## Research and implications

Psyonix's Rocket League talk distinguishes responsive local control from correct
interaction with moving objects. A predicted car and an interpolated collision target
can occupy different timelines. Their solution and input-buffer tradeoffs are useful
precedents, not a promise that our simpler predictor behaves equivalently. Our tests
must include two drivers, changing input, contact disagreement and stale input after
recovery; a smooth spectator alone cannot demonstrate good driving.
[Primary source: Jared Cone, GDC 2018, networking slides 88–177](https://media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf).

Glenn Fiedler describes buffering to absorb snapshot jitter and the limits of
extrapolating physics without matching its simulation. His state-synchronization
article also distinguishes simulation corrections from visual smoothing and explains
how state quantization affects subsequent extrapolation. Our tests therefore gate
trajectory accuracy and correction continuity separately, include sparse snapshots,
and prevent unlimited observer buffering from buying a pass.
[Snapshot interpolation](https://gafferongames.com/post/snapshot_interpolation/),
[state synchronization](https://gafferongames.com/post/state_synchronization/).

Epic's networked physics documentation treats prediction, history and resimulation
as coordinated facilities, with latency and fast motion making interaction harder.
This supports testing complete state/history and recovery rather than only interpolated
body position. We are not switching engines or claiming to implement that architecture.
[Primary source: Networked Physics Overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/networked-physics-overview).

NVIDIA documents conditional PhysX determinism: scene construction, step sequence,
release and platform matter. Consequently, an identical seed is not a guarantee of
identical GPU re-simulation across machines. We pin recorded authority and replay
presentation on a logical clock, recording candidate source/WASM provenance.
[Primary source: Simulation / Enhanced Determinism](https://nvidia-omniverse.github.io/PhysX/physx/5.7.0/docs/Simulation.html).

Vehicle2's road queries, suspension load and tire forces are coupled; a chassis pose
alone does not describe all behavior. A detached wheel must not keep supplying
traction, and mismatched wheel/body timelines can look wrong even when body position
passes. Wheel and topology evidence are explicit requirements, not inferred from
visual tread meshes.
[Primary source: PhysX Vehicles](https://nvidia-omniverse.github.io/PhysX/physx/5.1.0/docs/Vehicles.html).

The numeric budgets below are **our provisional product choices**, not thresholds
claimed by those sources. Player review must eventually calibrate them.

## Three layers of evidence

1. **Deterministic presentation replay — available now.** A committed, compressed
   720-frame native Vehicle2 tape contains the course and authority. The shipping
   driver predictor, observer interpolator and CPU/WASM static queries consume it.
   All input, receive and evaluation steps use integer 60 Hz ticks. Eight link cases
   × three seeds × two roles produce 48 verdicts. Each run is repeated, comparing
   full output poses, schedules and corrections byte-for-byte before scoring.
2. **Canonical physical/functional evidence — evaluator available; most captures
   still missing.** `QualityEvidence` supports independent collider clearance,
   four-wheel contact/travel/traction, entity generation, membership/owner state,
   and confirmed events with visible response ticks. Scenario contracts block until
   these channels and actual events exist. A command named “landing” is not proof
   of a landing. No destruction/traction capability is being faked into today's tape.
3. **Live closed-loop multiplayer — existing lab.** This covers real input delivery,
   server scheduling, interest management and browser presentation. Its raw timing
   is useful for context but not a reliable performance comparison under shared
   GPU load. Closed-loop multi-driver impacts and uplink starvation still require
   native captures and live integration; the replay suite cannot substitute for them.

The fixed trace freezes server behavior. Its link cases impair **snapshot reception**,
not round-trip latency; the original server has already consumed the source inputs.
This cannot establish what the server would do under input packet loss. We expressly
avoid relabeling these cases as a complete LTE/QUIC or congestion simulation.

## Executable contracts and coverage

The authoritative catalog is `client/netlab/vehicle/scenarios.ts`, also inspectable
in the Garage's Quality scenario contracts dropdown. Choosing a contract explains
the evaluation; it does not secretly change the test course.

| Scenario | Failure to expose | Evidence needed beyond body poses |
| --- | --- | --- |
| recorded-course | wrong trajectory, correction bursts, stalls | Available pinned tape |
| garage-fast-heightfield | high-speed washboard/crest drift, vertical pops, slow reconciliation | Available pinned tape plus embedded terrain/speed coverage; contact correctness still unqualified |
| idle-slope | jitter or invented support at rest | clearance, wheel support/travel |
| throttle-release | stale throttle, sluggish or inverted brake response | sampled/applied input ids, response onset |
| slalom-grip | yaw disagreement through fast reversals | wheels, input onset; FWD/RWD/AWD |
| handbrake-release | stuck braking or wrong axle response | wheel force, input onset |
| crest-landing | tunnelling, double landing, snap after impact | confirmed landing, clearance, wheels |
| bridge-gap | phantom floor, bad underpass contact | clearance, wheels |
| wall-glance | pass-through or wrong deflection | confirmed impact pair, clearance |
| crossing-vehicles | predicted car hits delayed target on another timeline | two-driver contact oracle, clearance |
| cannon-wheel-loss | invisible traction, resurrected wheel | impact, detach, topology, per-wheel forces |
| meteor-wreck | inconsistent wreck and functional state | impact, topology, wheels; chunk-island checks also needed |
| outage-recovery | frozen steering, obsolete input burst on recovery | recovery event and applied-input evidence |
| ownership-transfer | previous driver's queued inputs take effect | generation/owner epochs and input evidence |
| late-join-damaged | intact car flashes back or wrong drivetrain after re-entry | bootstrap/topology and wheel evidence |

Coverage is separate from quality: a body-only tape cannot turn these last thirteen
rows green. Missing instrumentation is `blocked`; measured bad behavior is `fail`.
The full release bar remains unmet until both problems are addressed.

### Fast driving on the garage heightfield

Run `npm run netlab:vehicle:heightfield -- --out /tmp/vehicle-heightfield --check-measured`
from `client/`. This uses the existing native garage recording and the shipping
predictor/interpolator with CPU/WASM static collision queries. It starts no GPU
simulation and does not optimize the predictor. The scenario also appears in the
Garage Quality scenario contracts selector.

The course must prove three continuous seconds at >=15 m/s (54 km/h), one continuous
second at >=20 m/s (72 km/h), at least 60 fast samples inside the washboard lane,
and at least 1 m of elevation change along the fast path. Its high-speed crest must
have a fast uphill approach and downhill departure, each changing elevation by at
least 0.25 m. Missing, flat, slow, out-of-bounds or truncated evidence cannot pass.
The pinned tape actually reaches 80.4 km/h horizontally, contains 281 consecutive
ticks above 54 km/h and 83 above 72 km/h, and traverses 3.63 m of terrain elevation
change during the fast segment. It is not a top-speed or long-duration qualification.

Measurements are broken out for fast terrain, the washboard lane, a one-second
window centered on the high-speed crest, and the following two seconds of descent
and reconciliation. All windows are chosen from authority, never from candidate
errors. Each reports vertical error p95/max (0.10/0.30 m budgets), 3D position error
p95/max (0.15/0.50 m), body-up tilt disagreement (10 degrees), excess vertical movement
per tick (0.15 m), and reconciliation magnitude (0.35 m). Every metric has a witness
tick. Spectator terrain samples and windows follow the prescribed delayed timeline.

Two extra seeded receive schedules drop arrivals for 18 ticks (300 ms), centered
around the measured washboard and crest features. Together with the original eight
schedules and three seeds they yield 60 role verdicts, each replayed twice. After
each scripted outage, settling must begin within 30 ticks of the first usable
snapshot and remain within position, vertical and tilt bounds for 30 consecutive
ticks, with fresh accepted authority and no prediction freeze. A single lucky
corrected frame is insufficient. This measures recovery of presentation; it does
not measure closed-loop uplink recovery.

The terrain hash and coverage measurements are saved in `quality.json`. Height
samples use the existing world-document triangle sampler on the embedded garage
terrain. They select and verify the course; **they are not signed collider clearance
or proof of landing/contact**. Native wheel/contact capture is still needed for
the `crest-landing` contract. New baseline: [fast-heightfield results](reports/vehicle-heightfield-v1/README.md).

Receive schedules: clean 60 Hz; jitter/loss at 30 Hz; mobile-like receive delay;
long-haul receive delay; stragglers with duplicates and input sequence wrap;
loss during the initial descent; a 48-tick turning outage; and sparse 10 Hz updates.
Every packet's source tick, arrival tick, copy index and drop decision is exported.
The outage is based on arrival time, so packets already in flight are affected too.
These synthetic schedules probe failure modes; they are not an empirical model of
all cellular networks. Future closed-loop schedules must add independent uplink,
ack delay, correlated bursts, MTU/fragmentation and reliable/datagram contention.

## What constitutes success

Pinned constants live in `contracts.ts`, version `vehicle-quality/1`.

| Criterion | Initial limit | Why |
| --- | ---: | --- |
| Position error p95 | 0.15 m | persistent drift/lag |
| Worst rolling one-second position p95 | 0.25 m | a bad maneuver must not disappear in an aggregate |
| Position error maximum | 0.50 m | brief severe failures still matter |
| Orientation error maximum | 10° | yaw, roll and pitch affect control/camera |
| Extra visual displacement per tick versus oracle motion | 0.20 m | correction pops, independently of real impacts |
| Reconciliation magnitude maximum | 0.35 m | sudden corrections |
| Hard corrections | 1/minute | repeated interruptions |
| Longest prediction freeze | 12 ticks | duration, not only average percentage |
| Held rendering while oracle moves | 6 ticks | stalls masked by an otherwise smooth trace |
| Source older than 30 ticks, longest run | 12 ticks | prolonged stale authority |
| Accepted-source rollback | zero ticks | reordered packets must not reverse history |
| Missing rendered vehicle | zero ticks | disappearance is a failure, not a sample to omit |
| Observer's prescribed extra buffer | 12 ticks | cannot gain smoothness through unlimited delay |
| Independent geometric penetration | 0.03 m / 2 ticks | brief real numerical tolerance, not wheel sinking |
| Detached wheel traction | 1 N | numerical noise tolerance, no functional ghost wheel |
| Wheel travel disagreement | 0.05 m | coherent suspension presentation |
| Attachment / topology mismatch | 2 ticks | bounded convergence; no indefinite resurrection |
| Wheel contact mismatch | 3 ticks | body and wheel support must agree |
| Response to a confirmed event | 3–12 ticks, by contract | intended behavior must actually become visible |

One tick is 1/60 simulated second. These are quality delays in a controlled logical
timeline, not CPU execution times. Catastrophic outages are stress cases: failure
there does not mean we should fabricate unlimited motion to keep driving. Preserve
bounded behavior and improve recovery; distinguish supported-network release cases
from graceful degradation cases when making a shipping decision.

Driver truth is the recorded current tick. Observer truth is the externally
prescribed buffered tick. Do **not** compare a spectator to current server position,
or let the candidate choose whichever reference tick minimizes its error. The
harness selects truth from the immutable tape. Current body height minus old server
height is **not penetration**; that requires independent signed collider clearance.

Real impact displacement appears in both oracle and presentation, so the error-step
metric subtracts oracle displacement before judging a pop. A camera artifact still
needs its own camera orientation/position channel; body smoothness cannot certify it.

## Determinism and anti-cheating rules for the benchmark

- Keep the fixture, source hash, geometry, proxy, candidate revision, threshold
  version, seed and schedule in every report. Deliberate fixture changes require
  a new baseline and a reason. Do not silently regenerate a source to suit a fix.
- The pinned fixture has both compressed and decompressed SHA-256 checksums.
  `provenance.json` records candidate source hash, revision/dirty state, WASM hash
  (also in `quality.json`), runtime and platform. Cross-platform bit identity is
  not promised; compare within a controlled toolchain or investigate divergence.
- Every evaluation tick is present exactly once, in order. Missing records, NaN,
  future source times, invalid quaternions and missing required channels block.
  Explicit `actual: null` means the vehicle was not rendered and is scored as failure.
- All failing metrics identify a witness tick. Inspect ±30 ticks around that witness
  in the exported evidence instead of arguing from an aggregate number.
- Compare every seed/case/role independently. Do not average the driver and observer,
  or let many easy seeds cancel one unsafe failure. Run the same candidate twice.
- No frame-time, replay-cost or wall-clock input delay enters deterministic quality.
  `--timing` writes a separate diagnostic file. Do not hide lag by increasing smoothing,
  bypassing collisions, changing the vehicle tune, dropping bad samples, or widening
  the buffer without recording an explicit product decision.
- Analytic test fixtures verify the **detector**, not shipping Vehicle2 physics.
  Mutation tests must fail for smooth lag, short landing spikes, oscillating small
  corrections, dropped rendering, false wheel traction, old topology and missing events.

## Run and hand off

From `client/`, with the existing generated WASM available:

```sh
node --import tsx scripts/qualify-vehicle-netcode.mts --out /tmp/vehicle-quality
# One seed for focused iteration:
node --import tsx scripts/qualify-vehicle-netcode.mts --seeds 42 --out /tmp/vehicle-quality-focus
# Fail on measured targets; --check additionally requires full scenario coverage:
node --import tsx scripts/qualify-vehicle-netcode.mts --check-measured
node --import tsx scripts/score-vehicle-quality.mts /tmp/vehicle-quality/mobile-30hz-42.json --check
npx vitest run netlab/vehicle/qualification.test.ts src/netlab/vehicleLab.test.ts
npx tsc --project tsconfig.vehicle-quality.json
```

`quality.json` contains cases, role verdicts, limits, hashes and blocked coverage.
Each case JSON includes both canonical evidence streams and the complete schedule.
An imported canonical evidence file can be scored separately with the same evaluator.
For imported files the producer is responsible for an independent, correctly aligned
oracle; a JSON field naming a native source is not authentication of its contents.

The senior developer's loop: pick one failing case → inspect witness ticks → fix
prediction/replication behavior → replay all seeds → reject regressions → capture
missing physical channels → qualify those scenarios → finally profile and optimize
on an otherwise idle machine. Rendering/camera and real multiplayer validation
remain necessary after deterministic replay passes.

For eventual coverage, record short/long wheelbase and small/large tires, FWD/RWD/AWD,
soft/stiff suspension, high/low grip and pre-/post-damage variants. Use the exact
serialized build and material/bond setup in provenance. This initial pinned tape
covers one stock vehicle, not all customized vehicles.

Compare candidates without changing the examination:

```sh
node --import tsx scripts/compare-vehicle-quality.mts baseline/quality.json candidate/quality.json --check
```

This rejects incompatible source, proxy, thresholds, seeds, schedules or metric
coverage, and lists every regression with a witness tick. A no-regression result
means only that the candidate is no worse on this matrix; it does **not** mean it
passes quality gates. Use `--check-measured` for that and `--check` for the full
coverage bar. The comparison has a 1e-6 numerical tolerance and does not incorporate
wall-clock timing. Keep the source-capture suite and candidate implementation
provenance together when handing results to another developer.
