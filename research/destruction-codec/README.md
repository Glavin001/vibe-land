# destruction-codec

Offline, deterministic rate-distortion evaluator for authoritative rigid-body
motion. It reads the exact little-endian `TWTRACE1` contract, runs codec
ablations and packet-loss simulations, and writes reports plus a decoded
`TWSTATE1` replay accepted by `tower-demo render`.

## Quick validation

```sh
cargo run --release -- synthetic --output /tmp/fixture.towertrace
cargo run --release -- analyze \
  --trace /tmp/fixture.towertrace \
  --out-dir /tmp/codec-results \
  --pixel-budgets 1,2,4 \
  --loss-rates 0,1,5 \
  --seed 42 \
  --snapshot-fps 60 \
  --output-fps 30 \
  --distance-scales 0.5,1,2,4 \
  --chase-projectile \
  --interpolation-delay-ms 100 \
  --max-extrapolation-ms 125 \
  --correction-ms 100

cargo run --release -- replay \
  --trace /tmp/fixture.towertrace \
  --output /tmp/codec-results/ground-truth.towerstate \
  --output-fps 30

cd /root/workspace/physx-tower/tower-demo
cargo run --release -- render \
  --state /tmp/codec-results/reconstructed.towerstate \
  --output /tmp/reconstructed.mp4 \
  --chase-projectile
```

Use `--bitrate-budget-mbps 3` to evaluate a constrained sender. Periodic global
baselines and stateful mode transitions use the modeled reliable channel and
may exceed the datagram cap: bounded recovery is treated as correctness, not
optional traffic.

Add `--strict-total-budget` to apply the cap over each trailing one-second
window, including scheduled reliable baselines. Immediate class-transition
messages remain correctness traffic and can cause a small overshoot.
`--chase-projectile` replaces the fourth evaluation camera with a 70-degree
view 12 m behind and 4 m above the moving projectile.

## Reusable responsibilities

- `scheduler.rs`: pure urgency computation and budget-ceiling selection. Update
  age, projected error, contact motion, velocity innovation, wake/contact/joint
  events, and moving-body deadlines determine ordering. The ceiling is never a
  fill target.
- `presentation.rs`: timestamped snapshot buffering, cubic Hermite translation,
  shortest-path quaternion interpolation, bounded class-aware extrapolation,
  and critically damped late-path reconciliation.
- `metrics.rs`: numeric detection of freezes, stop/start episodes, linear and
  angular reversals, velocity error, and excess acceleration relative to the
  authoritative path.
- `codec.rs`: classification, prediction, quantization, packetization, and
  perceptual-error primitives.

## Input contract

All integers and floats are little-endian. The reader retains actor definitions
and one tick only. It validates magic/version, limits counts before allocation,
requires contiguous actor and tick order, checks exact actor counts, finite
values and quaternions, requires monotonic time, rejects unknown flags/shape
kinds, requires the end marker, and rejects trailing bytes.

```text
"TWTRACE1"
u32 version=1..3, physics_hz, tick_count, pane_w, pane_h, actor_count
f32 gravity[3]
u32 camera_count=4
camera[4] = f32 eye[3], direction[3], fov_degrees
actor[actor_count] =
  u32 id, u8 part, f32 linear_damping, f32 angular_damping, u32 shape_count
  shape[] = u8 kind, f32 params[3], f32 local_pose[7]
tick[] =
  u8 marker=2, u32 index, f32 time, u32 actor_count
  state[] = f32 pose[7], linvel[3], angvel[3],
            u16 contacts, u16 intact_joints, u8 flags
  version>=2: sorted active contact pairs
  version>=3: topology epoch, broken edge IDs, changed actor/root IDs
u8 marker=255
```

Version 3 also places a shared topology manifest after actor definitions:
deterministic global actor IDs and durable joint/bond edges with global edge
IDs, endpoint actor IDs, and an edge-kind tag. Both peers can therefore resolve
pre-created fracture pieces and baked local transforms without sending full
island membership every frame.

Flags are sleep=1, kinematic=2, contact_begin=4, contact_end=8,
joint_break=16, sleep_event=32, wake_event=64. Native sleep is recorded but is
never used to classify quiescence.

## Physical classes and wire choices

Physical state is separate from representation:

- **Quiescent:** application-level low linear/angular speed with stable
  contacts for a configurable hysteresis window. A final pose is reliable.
- **Ballistic:** only zero contacts, zero intact joints, and non-kinematic.
  Reconstruction uses discrete semi-implicit gravity, rational linear/angular
  damping, and angular integration.
- **Contact-active:** everything else.
- **Impact burst:** short hysteretic state entered on contact-begin, joint-break,
  or wake events.

At a tick, hold or ballistic reconstruction is omitted when its worst-camera
error fits the pixel budget. Otherwise an eligible quantized delta or absolute
is chosen. The full variant prioritizes accumulated error and impact/contact
activity. Baselines are global and periodic.

The perceptual metric is projected center displacement plus the
rotation-induced silhouette displacement of the actor bounding sphere:

```text
focal_px = viewport_height / (2 tan(vertical_fov / 2))
error_px = focal_px / depth * (center_distance + radius * |sin(angle)|)
```

The reported value is the worst of all four recorded cameras. Position
centimeters and quaternion angular degrees are reported independently.

## Explicit byte model

No entropy ratio is guessed. The record sizes below are the logical sizes with
a fixed 4-byte actor ID:

| Item | Bytes |
|---|---:|
| Datagram header (sequence, global baseline, tick, count) | 16 |
| Raw state record | 61 |
| Region-relative quantized absolute | 21 |
| Global-baseline delta | 15 |
| Motion absolute (pose + linear/angular velocity) | 33 |
| Motion delta (pose delta + linear/angular velocity) | 27 |
| Ballistic anchor | 33 |
| Reliable-message framing | 12 |

Within each datagram, the first sorted actor ID is encoded as unsigned LEB128
and later IDs are packet-local unsigned LEB128 gaps. Packet sizing replaces the
logical 4-byte ID with that exact encoded length. This keeps every datagram
independently decodable while exploiting sparse sorted IDs without an assumed
compression ratio.

Datagrams are greedily packed to at most 1,150 bytes. Globally scheduled
absolute baselines for currently relevant bodies are modeled as reliable stream
objects, matching the architecture's reliable baseline-reset rule; ordinary
deltas remain unreliable. A body that re-enters a view without a usable
baseline receives a self-contained absolute record.
Absolute positions use a signed 16-bit region coordinate per axis, a 320 m
region, and signed 1 cm local coordinates. Rotation is 32-bit smallest-three:
2-bit omitted component plus three signed 10-bit values; the quaternion sign is
canonicalized. Delta positions are signed 16-bit centimeters relative to a
known global baseline.
Ballistic anchors add signed 16-bit linear velocity at 1 cm/s and angular
velocity at 0.001 rad/s; values outside the representable ranges saturate.

The evaluator currently accounts record payloads and application framing; it
does **not** claim captured QUIC bytes. QUIC/TLS/IP overhead, ACKs, stream
retransmission, jitter, and congestion-control behavior are outside this
offline experiment.

## Outputs and pass/fail

- `summary.json`: primary metrics, limitations, and boolean criteria.
- `per_variant.csv`: six ablations and all loss scenarios.
- `per_mode.csv`: primary full-codec accounting by physical class.
- `rate_distortion.csv`: clean sweep over pixel budgets.
- `distance_sweep.csv`: bandwidth and error as camera distance is scaled.
- `timeline.csv` and `timeline.svg`: one-second raw-versus-reduced bitrate.
- `raw_frame_telemetry.csv` and `presentation_frame_telemetry.csv`: values
  synchronized to each rendered frame, measured in the exact displayed chase
  camera. Includes visible-body pose/pixel error, active reconciliation,
  freeze/reversal rates, excess displayed displacement, moving-body staleness,
  and chase-camera divergence.
- `video_metrics.json`: configuration, bitrate, aggregate codec metrics, and
  strict frame-level `visual_acceptance` values plus their thresholds.
- `reconstructed.towerstate`: primary decoded replay at output FPS.
- `README.md`: self-contained output instructions.

`summary.json` and `per_variant.csv` also report freeze percentage/event count,
maximum freeze duration, motion-direction reversals, velocity errors, excess
acceleration, update innovation, moving-body deadline misses, and the original
pose/rotation/screen-space errors. Real collision impulses are removed from the
excess-acceleration metric by comparing presentation acceleration against
authoritative acceleration.

For a fast two-pass video diagnostic without all ablations, add
`--telemetry-only` to `analyze`. Add `--primary-only` while sweeping to skip the
invariant raw pass. `--telemetry-loss-rate 0.01` evaluates the same visual gates
with 1% random datagram loss. Create a synchronized A/B video with:

```sh
python3 tools/render_telemetry_overlay.py \
  --raw-csv /tmp/results/raw_frame_telemetry.csv \
  --buffered-csv /tmp/results/presentation_frame_telemetry.csv \
  --raw-video /tmp/raw.mp4 \
  --buffered-video /tmp/buffered.mp4 \
  --output /tmp/raw-vs-buffered-telemetry.mp4 \
  --label "OPTIMIZED 65 Mbps CEILING"
```

The hard visual gate rejects excessive screen/pose error, active correction,
excess per-frame displacement, freeze, reversal, moving-body starvation, and
chase-camera divergence. It deliberately evaluates frame-tail and worst-frame
values rather than allowing a good global average to hide a visible lurch.

Rank completed telemetry sweeps with:

```sh
python3 tools/rank_visual_sweeps.py \
  --results-root /tmp/codec-results \
  --pattern "opt-*" \
  --output-prefix /tmp/codec-results/optimization-ranking
```

The current one-building 30-second reference trace needs a 45 Mbps ceiling
(44.93 Mbps average) on a lossless path. With 1% random datagram loss, the first
passing safety configuration uses a 65 Mbps ceiling and 55.88 Mbps average.
These are measured trace-specific boundaries, not general constants.

### Per-client adaptive interest

`--single-view-interest` changes the full codec from the conservative union of
four demo cameras to a player/chase-camera interest policy. It includes:

- expanded-frustum hysteresis to avoid edge churn;
- linear body and camera-motion lookahead for prefetch;
- a recently-visible grace period;
- a proximity sphere for bodies that can affect the viewer physically; and
- reliable absolute anchors when a body re-enters interest.

The safety controls are `--interest-fov-margin-deg`,
`--interest-lookahead-ms`, `--interest-grace-ms`, and
`--interest-proximity-m`. On the reference trace, a 5-degree margin, 200 ms
lookahead, 250 ms grace period, and 10 m proximity radius reduce the
loss-aware result to **45.03 Mbps peak / 8.12 Mbps average**, while preserving
all frame-level acceptance gates at 1% random loss. After active destruction,
the stream falls to roughly 40 Kbps because no relevant bodies need updates.
This is still frustum interest, not depth-buffer occlusion.
See `../docs/destruction-codec-optimization-research.md` for sources and the
ranked packet, entropy, occlusion, cluster, and transport-feedback experiments.

## Synthetic fixture

`synthetic` writes deterministic free flight, impact/contact, constrained
grinding, settling, and wake motion for four actors. Its cameras include near,
mid, far, and overhead distances. It is intended to validate evaluator
plumbing, not to prove production bitrate.

## Tests

```sh
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Unit tests cover centimeter quantization, quaternion round trips, conservative
ballistic eligibility, packet size, damped predictor behavior, loss
determinism, projection distance scaling, and binary pose layout.

## Omniscient world archive

`archive` is a separate camera-independent path. It encodes exact lifecycle
events and bounded rigid-shell motion into hold, linear, ballistic, and Hermite
segments. Segments split at events, discontinuities, maximum lookahead, and
independent GOP boundaries. Spectator routes are loaded only after
`omniscient.twarchive` is written and hashed.

```sh
cargo run --release -- archive \
  --trace /root/workspace/codec-results/one-building-120hz-30s/collapse.towertrace \
  --out-dir /tmp/omniscient-5mm \
  --shell-error-mm 5 \
  --gop-ms 1000 \
  --max-segment-ms 250 \
  --cell-size-m 128 \
  --supercell-size-m 512 \
  --target-tracks 30 \
  --hard-track-cap 50 \
  --routes benchmarks/spectator-routes.json \
  --require-pass
```

Outputs include the uncompressed and independently zstd-compressed
`TWARCH1` GOP containers, byte-identical per-track zstd blocks, GOP and track
CSVs, spectator metrics, transport-cap queue simulations, and
`archive_report.json`. The default route suite covers close, chase, orbit,
distant, boundary-crossing, teleport, hotspot-switching, and seeded free-flight
views that did not participate in encoding.

On the 30-second/6,119-body trace:

- 20 mm: 23.27 Mbps seekable archive; chase route fails the freeze/max-pixel
  gate.
- 10 mm: 30.80 Mbps seekable archive; chase p99 narrowly exceeds the strict
  one-pixel gate.
- 5 mm: **45.80 Mbps seekable archive**, 57.56 Mbps total shared track publish
  with independently compressed 250 ms relay objects and literal post-zstd
  decoding; every whole-world and spectator gate passes.
- The passing 5 mm distant spectator downloads 9.67 Mbps; the close views need
  37.14–57.56 Mbps. Track routing cannot remove bytes for detail that is
  actually visible.

Rank full sweeps with `tools/rank_omniscient_sweeps.py`. Run the deterministic
small regression with:

```sh
bash tools/run_omniscient_regression.sh
```

`tools/render_omniscient_proof.py` composes the raw and decoded chase views with
frame-synchronized active-track, rolling-Mbps, screen-error, and shell-error
plots. The reference artifact is
`omniscient-world-5mm-proof-final/raw-vs-omniscient-5mm-telemetry.mp4`.

`TWTRACE1` version 2 optionally appends a sorted active contact-pair list to
every tick. Version 3 adds the shared global-ID topology manifest plus
per-tick island epochs, break events, and changed roots. The native exporter
now writes version 3; the reader remains backward-compatible with versions 1
and 2. A six-second PhysX contact-graph ablation
measured 11,532,366 pair-tick samples, of which 8,316,246 met a strict
linear/angular velocity-coherence prefilter. Cluster transforms remain
unadopted because coherence alone does not prove a net byte win under the shell
gate.

## Hierarchy-aware archive

The archive evaluator also writes `TWHIER1`: batched topology events on the
global event tier, bounded island-root trajectories on spatial root tracks, and
sparse literal leaf repairs on detail tracks. Child local transforms live in a
shared manifest addressed by stable global IDs. Every GOP is independently
zstd-compressed and decoded before the 5 mm all-body shell gate is evaluated.
Wire version 4 uses 32 m cell-local `u16` positions, bounded `i16` velocities,
variable-length actor/tick references, compact epoch-local poses with literal
float fallback, and prediction-relative `i16` residual position deltas with
high-precision packed rotations. Encoder decisions use the literal decoded
representation, so quantization cannot bypass the shell gate.
Topology changes split trajectories exactly. Approximate D6 islands re-bake
child locals at each epoch; exact Blast-style bonds keep manifest rest locals.
Each island/epoch selects the cheaper hierarchy or independent representation,
and the final compressed archive falls back to the independent baseline if
needed, so delivered hierarchy mode cannot increase bandwidth.
Each run also writes `hierarchy-reconstructed.towerstate` from those literal
decoded GOPs and `hierarchy_frame_telemetry.csv` with frame-synchronized shell
and four-camera projected error. These can be rendered and composed with
`tools/render_omniscient_proof.py`.

The 30-second benchmarks separate exact rigid topology from approximate D6
connectivity:

- A 48-piece Blast-style fixture with six eight-piece pre-fractured islands
  produced 38,153 bytes versus 390,902 bytes for independent seekable motion,
  a **90.24% reduction**. It passed at 4.999 mm maximum shell error, omitted
  15,144 child poses, used nine tracks, and was adopted.
- The fresh 6,119-body tower v3 trace produced 73.43 MB versus 171.74 MB,
  **57.25% smaller** and was adopted. It passed the literal post-zstd 5 mm and
  exact-event gates, omitted 8,223,298 child poses, and used 2,611,806 repairs
  (24.11% of child samples). Average/p50/p95/peak one-second rates were
  19.58/9.98/45.67/52.50 Mbps. Relative to the previous float-heavy hierarchy
  wire, compact v4 reduced delivered bytes by **40.43%**.
- Contact-only clusters remain measured but unadopted.

Shell-bound sweep on the same tower (compact hierarchy):

| Bound | Independent | Hierarchy | Close chase gate |
|---|---:|---:|---|
| 5 mm | 45.80 Mbps | **19.58 Mbps** | PASS (max 1.11 px) |
| 10 mm | 30.80 Mbps | **15.24 Mbps** | FAIL (p99 1.000, max 2.04 px) |
| 20 mm | 23.27 Mbps | **10.44 Mbps** | FAIL (max 4.26 px) |

Keep **5 mm** as the canonical proof gate. 10–20 mm are useful as
distance-adaptive tiers, not as a global substitute: close debris becomes
noticeable around 2 cm / ~4 px. Encode wall time does not improve at looser
bounds (~37–51 s for 30 s).

Whole-world compact hierarchy (**19.6 avg / 52.5 peak Mbps**) fits the soft
WebTransport WAN band (~50–80 Mbps/client) but not the planned ~5 Mbps/client
product budget. The separate interest-managed live sender already reaches
~7.4 Mbps average for one chase view; production still needs hierarchy +
interest + paced datagrams + ack/rate control. Full write-up:
`docs/destruction-codec-hierarchy-results-2026-08-10.md`.

Offline follow-ups (same tower):

- `ack-baseline` — same three wire policies on the **adaptive** scheduler
  (classify + priority + optional interest/ceiling). Omniscient uncapped at 1%
  loss: acked deltas **48.5 avg / 86.7 peak Mbps** vs always-absolute 60.3/108;
  interest+45 Mbps cap: **30.2 / 40.6**. Without acks, lost Absolutes still
  desync deltas. Maps to WT unreliable pose datagrams + reliable ack control.
- `exact-island-proxy` — rewrite unbroken durable components to kind=2 exact
  compounds and re-run hierarchy. Residuals drop (24% → 8% of children) but
  bitrate does not beat D6 compact hierarchy on this soft tower (22.8 vs
  19.6 Mbps). Changes ground truth; use for upside measurement only.

```sh
bash tools/run_ack_and_exact_experiments.sh
```

Artifacts: `codec-results/one-building-120hz-30s/ack-exact-experiments/`.

Low-risk measurements are included in `advanced_ablations`: topology timing
headers are batched, root fields use sparse model/field selection, measured
residual entropy favors zstd, and settled root updates are suppressed. The
tower run measured a 27,807,605-byte timing-header upper bound and suppressed
56,710 static root updates.

Run the deterministic hierarchy regression with:

```sh
bash tools/run_hierarchy_regression.sh
```
