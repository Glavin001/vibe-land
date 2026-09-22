# Why damaged Bayline houses never settle — 2026-09-22

> **Correction, later the same day.** The "dead GPU body / SDK activity
> bookkeeping" interpretation in this document was wrong. Tracing the stuck
> bodies through the SDK showed every one of them is correctly listed,
> solved and integrated each step; they are **contact deadlocks** — a light
> fragment buried inside the ground with heavier debris buried inside it,
> whose opposing unbounded depenetration biases reach a PGS fixed point
> (pose static, velocity constant) or a two-pose cycle. The measurements
> below stand; the inference in "Interpretation" items 1–2 does not. The fix,
> its qualification and what was ruled out are in
> [bayline-settling-resolution-2026-09-22.md](bayline-settling-resolution-2026-09-22.md).

Follow-up to the [September 22 handoff](bayline-handoff-2026-09-22.md), item 1:
"reproduce the remaining bungalow cannonball case; distinguish persistent rigid
contacts from stress nonconvergence". It is neither. Everything below is from
the private native harness (`house-impact-review`, SDK `d80f5948`, runtime
`f7839f03…`, correction limit 1, 8/2 contact iterations) on the exact deployed
inputs; measurements first, interpretation after.

## What was measured

### 1. One body holds the whole island awake

Deployed bungalow, cannonball (`production-tail-fix-bungalow-cannonball`,
reproduced bit-for-bit as `sleep-audit2-bungalow-cannonball`: 1,799 breaks,
147 awake at 90 s, 5,396 unconverged ticks).

- A contact-proximity graph of the final frame matches the sleep state almost
  exactly: one island of 141 bodies (140 awake), a few small awake islands,
  and every other island asleep, including many that touch the kinematic
  remnant. So this is island sleep, not per-body sleep.
- A new read-only audit (`shot.json` → `"sleepAudit": true`, written to
  `sleep-state.ndjson`) records every native body's wake counter, sleep and
  freeze thresholds, mass, inertia, velocities and pose each sampled tick.
  All 259 dynamic bodies carry the PhysX defaults (sleep 5e-3, freeze 2.5e-3).
  From tick 1,680 to 5,400, **exactly one** awake body has a non-zero wake
  counter: `2147483870` (chunk 783, a 1.05 × 1.0 × 0.14 m bathroom-wall panel,
  141 kg, lying on floor pieces at y = 0.18–0.65). Its energy (~3e-6) is three
  orders of magnitude under the sleep threshold. Every other awake body has
  wake counter 0 — they are awake only because the island is.
- Per-tick sampling (`sampleTicks: 1`) of that body shows an 18-tick limit
  cycle: it creeps ~0.05 mm/tick for 17 ticks, then in one tick its pose
  snaps back 0.5 mm, its velocity is zeroed then spikes to 0.012 m/s, and its
  wake counter reads **0.3833 = 0.4 − dt**: the SDK's internal wake-up value
  (`ScInternalWakeCounterResetValue`) after one GPU decrement. Nothing in the
  bridge writes to native bodies per tick (checked: no wakeUp / putToSleep /
  setGlobalPose / kinematic targets; debris floor is −∞). This is the SDK
  deactivating the body (`BodySim::setActive(false)` zeroes velocity) and
  immediately re-waking it because its island node is still active
  (`Sc::Scene::cleanUpSleepBodies`).

### 2. With stabilization off, that case settles

The scene sets `PxSceneFlag::eENABLE_STABILIZATION`. A diagnostic knob
`VIBE_PHYSX_STABILIZATION=0` (default unchanged) was added to
`physx_bridge.cc` and the four deployed-house cases were rerun with only that
variable changed:

| Case (deployed houses) | Stabilization | Broken | Peak awake | All asleep after impact | Stress converged | Escaped | Gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Bungalow cannonball | on (prod) | 1,799 | 251 | **never** (147 at 90 s) | **never** | 0 | fail |
| Bungalow cannonball | off | 1,831 | 251 | +419 ticks (7.0 s) | tick 3,774 | 0 | pass |
| Bungalow meteor | on (prod) | 1,381 | 117 | +245 ticks (4.1 s) | tick 402 | 0 | pass |
| Bungalow meteor | off | 1,381 | 117 | +964 ticks (16.1 s) | tick 1,129 | 0 | pass |
| Porch house cannonball | on (prod) | 1,616 | 117 | +260 ticks (4.3 s) | tick 419 | 0 | pass |
| Porch house cannonball | off | 1,616 | 117 | +156 ticks (2.6 s) | tick 348 | 0 | pass |
| Porch house meteor | on (prod) | 809 | 34 | +369 ticks (6.2 s) | tick 606 | 0 | pass* |
| Porch house meteor | off | 809 | 34 | +270 ticks (4.5 s) | tick 497 | 0 | pass |

\* production recording truncated by the disk-full event; numbers from `series.json`.

Evidence: `out/reviews/house-cannonball/nostab-deployed-*` and
`production-tail-fix-*`. Same 1,800-tick intact rest gate passed in every run.

### 3. Stress convergence is independent of awake bodies

In the stabilization-off bungalow cannonball run every body was asleep from
tick 424, yet the stress solver reported `converged: false` at the full 16
iterations per tick until tick 3,774, then dropped to 0 iterations. Per-tick
step cost was 5.4 ms while unconverged and 0.57 ms after — for one house. The
gate's "converged" half is a slow warm-started solve of the damaged remnant,
not a symptom of debris motion.

### 4. The experimental profile's failures are dead GPU bodies

`residential-v2` bungalow meteor (`production-panel-fix-bungalow-meteor`,
reproduced as `sleep-audit-v2-bungalow-meteor`: 1,938 breaks, 451 awake).
Again one body carries the wake counter: `2147483846` (chunk 426, a
0.75 × 1.38 × 0.14 m wall-infill panel) reports v = 0.68 m/s, ω = 3.8 rad/s
for 87 s with a pose that does not change.

With stabilization off (`nostab-v2-bungalow-meteor`, 392 awake) the freeze
pass is gone and the signature is unambiguous. Sampled every tick
(`nostab-v2-bungalow-meteor-dense`):

- `2147484275` (fence rail, 2.7 kg): velocity `[0.306, −0.175, 0.071]` m/s,
  angular `[5.96, −1.89, −12.02]` rad/s, **bit-identical every tick for
  80 s**, pose changing < 0.1 mm. Not even gravity alters its velocity.
- `2147484178` (chair post), `2147484322`, `2147484264` (fence): same.
- `2147483937` (ceiling joist, 41.6 kg): alternates between **two exact
  states** on even and odd ticks — poses 7.4 cm apart, velocities both
  pointing up — a chunk teleporting back and forth at 30 Hz.
- `town_kit_collision_snapshot` (direct `readRigidBodyData` on the GPU)
  agrees with the CPU pose for every one of 1,411 shapes to < 1 mm, so the
  CPU mirror is not stale; the GPU slot itself is not being stepped.
- A diagnostic `wakeUp()` on all 79 moving awake bodies at tick 700
  (`shot.json` → `"wakeProbeTick"`, `nostab-wakeprobe-v2-bungalow-meteor`)
  changed nothing for them: 60 ticks later the fence rail still reads
  v = 0.359, ω = 13.55 and has moved 0.07 mm.
- Every such body sits **inside the floor slab or the ground box** (joist
  AABB y = −0.17…0.0; wall panel −0.25…0.24): meteor debris at ~70 m/s
  (1.2 m per tick) tunnelled the 18 cm floor deck. No deployed-house run
  has a body below y = −5 cm; all v2 failures do.

### 5. Ruled out on the way

- Contact-offset touch loss: chunks use the default 0.02 m offset; the 0.5 mm
  snap cannot separate a pair.
- Bridge-side per-tick writes: none exist on native bodies.
- Speculative CCD on fragments: `PxDestructionCorrectionBlocker::eSPECULATIVE_CCD_BODY`
  (bit 128) — the stage refuses fractures.
- Correction limit 0: the stage refuses the meteor impact (status error 8).
- Stabilization as the sole cause: dead bodies persist with it off.
- The four "jittering" siding boards in the production cannonball case are
  real solver oscillation (±2.5 mrad at 30 Hz, values drift tick to tick, thin
  boards in a pile) — visible only while their island is awake.
- Sampling: 12- and 30-tick captures alias a 2-tick flip-flop perfectly.
  Every claim above was re-read at `sampleTicks: 1` before being made.

## Interpretation

1. The settle gate fails for one reason in every failing case: a single
   fragment in a wrong state keeps its contact island awake forever. That
   fragment is either (a) with stabilization on, a body in a CPU
   deactivate → re-wake cycle, or (b) a dead GPU body: the CPU still lists it
   as awake with a frozen velocity, the GPU never steps it, `wakeUp()` is a
   no-op. Both are SDK activity bookkeeping (the destruction fork's trial /
   correction restore paths in `ScPipeline.cpp`, `NpDestructionBodyAllocator.h`),
   not house authoring, contact iterations or stress iterations. No authoring
   change can pass the gate while a dead body is in the island.
2. Dead bodies have so far only appeared after debris tunnelled into the static
   ground, which the penetrating `residential-v2` meteor produces and the
   rebounding deployed roof does not. That is the trigger to hand the SDK
   owner; the app cannot prevent it without capping debris speed (hiding).
3. Stabilization is a freeze pass. On the deployed houses it costs one case
   (never sleeps, 4.5 ms/tick forever) and buys only a faster bungalow-meteor
   settle (4 s vs 16 s). Turning it off is the honest setting and passes all
   four deployed cases; it has **not** been measured on the 36-building scene
   under continuous play, and that bench should precede any deployment.
4. `converged` should be reported separately from `awake == 0`; conflating
   them hid the fact that the stress solver keeps 16 iterations/tick running
   on a fully asleep house for a minute.

## Reproduce

Build the harness as in `structures/town-kit/repros/house-cannonball/README.md`.
Copy `asset.json`, `source.json`, `shot.json` from a production case to a
fresh directory; add `"sleepAudit": true` (and `"sampleTicks": 1`,
`"durationTicks": 1900` for per-tick traces, `"wakeProbeTick": 700` for the
probe, `"collisionAudit": true` for the GPU pose check). Then:

```sh
VIBE_CITY_NATIVE_CORRECTION_LIMIT=1 VIBE_PHYSX_POSITION_ITERS=8 VIBE_PHYSX_VELOCITY_ITERS=2 \
TOWN_KIT_DIAGNOSTIC_RUNTIME=$PWD/.certs/vast-city/engine-d80f5948 \
python3 structures/town-kit/repros/house-cannonball/run.py CASE
```

Add `VIBE_PHYSX_STABILIZATION=0` for the stabilization-off arm. Every run's
settings are in its `provenance.json`. Analysis scripts used for the numbers
above are one-off Python over `sleep-state.ndjson.gz`, `recording.json.gz`
and `series.json`; the island graph is an AABB-overlap union-find with a
2 cm tolerance.

## Not claimed

- No claim about where in the SDK the dead-body state is created; the trial
  restore and fragment ownership paths are named as the place to look, not
  as the cause.
- No claim that stabilization off is safe for the full city under load.
- No change to what the meteor does to the deployed roof: it still rebounds
  (+7 m/s), and `residential-v2` still cannot be qualified until the
  dead-body fault is fixed in the SDK.
