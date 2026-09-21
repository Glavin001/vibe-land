# Deployed framed houses: cannonball and meteor motion review

2026-09-21. Reproduced native motion failures in isolated buildings. This is **not** a passing destruction qualification, and no live service or production physics settings were changed during this review.

The exact first bungalow and first two-storey house templates were extracted from deployed `bayline-framed-36.vlsp` (SHA-256 `1c0dbd909ba29b68a7d15455548a7a08d069563a855482ca01f80eba8895f31d`) and recentered. Each fresh native scene passed equilibrium plus 1,800 consecutive converged/resting steps at 60 Hz with zero spontaneous damage, before receiving a projectile. Gravity stayed 9.81 m/s². Raw recorded poses bypass networking, client body admission, interpolation, and sleep visualization.

| Isolated case | Chunks / bonds | Broken bonds | Awake bodies at 30 s | Converged at 30 s | Escaped bodies |
|---|---:|---:|---:|---|---:|
| Bungalow, cannonball | 1,645 / 4,318 | 934 | 0 | Yes | 0 |
| Bungalow, meteor | 1,645 / 4,318 | 1,807 | 128 | **No** | **1** |
| Two-storey house, cannonball | 2,643 / 7,458 | 668 | **44** | **No** | 0 |
| Two-storey house, meteor | 2,643 / 7,458 | 739 | 0 | Yes | 0 |

These are one fixed impact per case, not evidence that every impact on either building works. The selected meteor clips visibly have different damage patterns because the same target height and seeded trajectory encounter different roofs.

## Confirmed failures

1. **Persistent native contact jitter.** In the two-storey cannonball case, detached wall-infill chunk 822 (body 2147483672) travels 0.2915 m over seconds 20–30 but has only 0.00119 m net displacement. Its peak-to-peak translation during that window spans 3.26 × 1.56 × 7.91 mm; final linear speed is 0.158 m/s and angular speed 0.343 rad/s. It remains a dynamic, awake body near y=2.25 m. Nearby wall/skin pieces also jitter. This is not a sleeping-body debug-color error.
2. **Floor collision loss after detachment.** In the bungalow meteor case, floor chunk 8 becomes body 2147483655 at about 2.5 s. Its x/z stay constant and it accelerates downwards from near rest at gravity: y=0.0818 m at 2.533 s, -0.0599 m at 2.667 s, -0.866 m at 2.933 s, and -3711.54 m at 30 s. Its speed reaches 269.77 m/s because it continues falling. The ground occupies y=-1.5..0 and the floor is initially at y=0..0.18. This is not a projectile flinging the piece through the floor at high speed. Recorded chunk geometry follows the same falling body.
3. **Unconverged damaged state.** The failed cases remain unconverged for 1,796 and 1,651 of the 1,800 aftermath steps respectively. Observed/accepted native steps alone therefore do not imply a correct settled state.

A conservative final-pose AABB gap search found no complete above-ground body isolated by more than 5 cm from all other geometry in these two cases. That does **not** prove valid support (AABBs overestimate convex shapes), but prevents us from calling every visually suspended panel an unsupported floating body. Some pieces remain attached or lodged against other construction. The measured jitter and floor collision failure above are independently established.

## Controlled collision probe

Repeated the identical bungalow meteor input with only the static test ground top lowered by 6 cm, so the detached floor encounters a new ground overlap rather than beginning in an existing contact region. Initial gravity/rest still passed. Outcome: **zero escaped bodies and zero awake bodies at 30 s**, with 1,790 breaks. The original had one escape and 128 awake bodies. The stress solver still did not converge, so this probe **fails qualification**.

This is evidence that initial contact configuration and the anchored-to-dynamic transition matter. The leading engine investigation is preservation/recreation of contacts and broad-phase ownership when an anchored chunk detaches. Current source routes this through `NpDestructionBodyAllocator`, `NpShapeManager::rebindShapeInternal`, and `Sc::ShapeSimBase::rebindRigidOwner`. That path includes refiltering, contact retirement and GPU ownership updates; which specific operation is faulty is **not yet established**. Lowering production ground or increasing bond strengths is not the proposed fix.

## Recordings and reproduction

Evidence is in `out/reviews/house-cannonball/video-{bungalow,porch-house}-{cannonball,meteor}/`:

- `asset.json`, `source.json`, `shot.json`, `provenance.json`, `report.json`;
- `recording.json.gz`: lossless native chunk/body poses at least every four physics ticks, including linear/angular velocities, membership and sleeping/kinematic status;
- `series.json`, `events.json`, `impact.mp4`, before/after and filmstrip images.

Four MP4s were decoded and verified: 960×640, 480 frames at 15 fps, 32 s each (one-second intact hold, 30 s simulated motion, final hold). `video-review.json` records four successful exports with no rendering errors; `video-verification.json` records ffprobe results. Videos use the kit viewer/materials with shadows and SSAO disabled for software export, no network interpolation or invented motion. The projectile actor itself is **not rendered** in these offline debris replays. Actual physical impacts use `World::launch_dynamic_ball`: cannonball 10,650 kg / 60 m/s / radius 0.68675 m / TTL 360 ticks; meteor uses the **server's own** `MeteorTuning`, seeded `plan`, and gravity-corrected trajectory, radius 2 m / density 3,300 kg/m³ / nominal speed 140 m/s / TTL 900 ticks. `build.rs` extracts the pure planner from `server/src/meteor.rs`; its source is not duplicated.

`motion-analysis.json` contains per-body measurements; `probe-bungalow-meteor-ground-gap/` contains the controlled probe. The public server continued running: timings are diagnostic, not exclusive-GPU performance qualification. Runtime hash: `d4284d2da42a4751e30548fb30f2ac44f7503efb75a9b40e6db017353327e36e`. Per-case provenance records hardware, SDK revision, binary hash and settings (16 iterations, tolerance 1e-3, correction limit 2, no added damping, default native sleep/depenetration/stabilization settings).

From repo root, after building `house-impact-review` using the private Cargo command in README:

```sh
node structures/town-kit/repros/house-cannonball/prepare-video.mjs
python3 structures/town-kit/repros/house-cannonball/run.py video-bungalow-cannonball video-bungalow-meteor video-porch-house-cannonball video-porch-house-meteor
node structures/town-kit/repros/house-cannonball/video.mjs video-bungalow-cannonball video-bungalow-meteor video-porch-house-cannonball video-porch-house-meteor
python3 structures/town-kit/repros/house-cannonball/analyze-motion.py
python3 structures/town-kit/repros/house-cannonball/check-suspension.py
```

Preparation/run refuse to overwrite existing raw evidence; choose fresh case names when repeating. GPU cases run sequentially behind the kit lock. Renderer locking prevents overlapping exports.
