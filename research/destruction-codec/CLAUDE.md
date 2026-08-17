# destruction-codec — orientation for a new session

> **Moved 2026-08-17.** This crate now lives inside the vibe-land repo at
> `research/destruction-codec`, as a workspace member, next to the simulation
> that produces its traces. `target/` is the workspace target. The reference
> traces stay outside the repo under `/root/workspace/codec-results/` — do not
> delete them. Verification is `.claude/skills/codec-verify` at the repo root.
>
> **The live line is now the Blast model, not D6.** `record-city-trace`
> (`server/src/bin/record_city_trace.rs`) records TWTRACE1 from the production
> PhysX GPU + Blast stress solver, where an intact structure is one kinematic
> body and fracture migrates shapes onto child bodies. Chunks sharing an island
> are rigid **by construction** — the property the D6 hierarchy assumed and did
> not have. `debris-codec --island-stream` (default off) streams one record per
> island root and derives the members.
>
> Current state of that line, measured on the 30 s 10-floor reference at the
> 0.5 cm masked contract: **985,445 B against the per-chunk path's 1,203,144
> (1.22x), gates PASS, and err p95 0.380 vs 0.589 cm** — fewer bytes AND tighter
> error. Far tier (20 cm, 2 s) 468,414 -> 336,684 B, 1.39x.
>
> Getting there needed a wire change, because the 32-bit quaternion's 2.77 mrad
> step times a member's lever arm is a floor the fitter cannot cross (8.6 cm at
> 31 m). Island ROOTS now quantize on a 16-bit-per-component grid, selected per
> body from island reach; members never do. Two subtleties are load-bearing and
> documented in the results doc: analytic segments must decode on the grid they
> were written on, and a root others are rebuilt from forgoes masking slack.
>
> Next lever: feed island-stream input into the tracks layer's coarse tier — the
> far-field win is measured and needs no further wire work. Then multi-building
> scenes, where "intact buildings cost nothing" actually shows up.
> Full arithmetic: `docs/destruction-codec-island-stream-2026-08-17.md`.
>
> Everything below this box describes the D6-era work. Those numbers are frozen
> baselines and still gate every change; read them as history plus tripwires,
> not as the current direction.


Streams authoritative rigid-body destruction state (thousands of simultaneously-moving bodies) from
one simulation to many viewers. Read this before proposing work: **most of this project's value is
in what has been ruled out**, and several attractive-sounding ideas have already been measured and
killed at real cost.

## Where things stand (measured 2026-08-13, commit `02dee62`)

Reference scene, 6,121 bodies, one building, 30 s, live `gop250` with masking at cap 20 mm:

| | value |
|---|---:|
| average | **8.82 Mbps** |
| p50 / p95 / peak block | 10.48 / 16.51 / 22.55 |
| end-to-end delay | 350 ms |
| encode | 0.25× realtime (p95 86 ms per 250 ms block) |
| archive baseline | **36,646,007 bytes** (byte-stable; treat as a tripwire) |
| tests | 83 |

From 23.24 avg / ~58 peak at project start: −62% / −61%, ~41× below raw wire. Wire version 8.

**Scaling is worse than that headline suggests** — the reference is one impact plus 25 s of
settling. Sustained multi-building destruction costs ~2.2–3.1 kbps/body:

| scenario | bodies | avg | peak | gate | encode |
|---|---:|---:|---:|---|---:|
| 1 bldg / 30 s | 6,121 | 8.82 | 22.55 | pass | 0.25× |
| 2 bldg / 10 s | 12,242 | 32.48 | 64.83 | **fail** (reversal 2.06 > 2.0) | 1.13× |
| 2 bldg + `--max-span-ticks 20` | 12,242 | 38.02 | 67.05 | pass | 0.98× |
| 3 bldg / 10 s | 18,362 | 40.43 | 65.66 | **fail** (reversal 2.72 > 2.0) | 1.67× |

Two open defects live in that table: **gates fail above ~12k bodies** at default settings (a span
cap fixes it, at +17% bytes), and **encode exceeds realtime above ~10k bodies**.

## Second path: `debris-codec` (per-body, added 2026-08-16)

A separate subcommand, not a change to the live path. Same reference scene, same masked
fidelity contract (`--shell-cm 0.5 --mask-precision --mask-cap-mm 20`), same 350 ms
end-to-end (250 ms encode window + 100 ms interp):

| | live hierarchy | debris-codec |
|---|---:|---:|
| compressed | 33,079,411 | **13,814,930** (2.39×) |
| average / peak | 8.82 / 22.55 | **3.68 / 7.69** |
| bytes/body/tick | 1.50 | **0.627** |
| encode | 0.25× realtime | 0.22× parallel, 0.56× serial |

It streams per-body analytic segments + impulses, a delta-coded sampled fallback, and rest
terminals, with the error bound checked every tick against the pose the client reconstructs.
On the six-scenario suite it **passes all 22 gates everywhere; the live path fails four of
six** (reversal, above ~12k bodies). Scaling: 2.26× at 12k, 1.06× realtime encode at 24k.

Findings: `docs/destruction-codec-debris-{trajectory,suite,precision,continuity,synthesis}-2026-08-16.md`.
Read the synthesis first — it carries the cross-cutting conclusions and the open debt.

**Two things to know before touching it.** (a) It is **continuity-bound, not accuracy-bound**:
every lever that spent the error budget failed on freeze/reversal/excess-step while positional
error sat at p95 0.9 cm against a 5 cm gate. A check that only bounds distance from truth will
not catch those failures. (b) The stream is **stateful across blocks** (segments and sampled
chain tails); keyframes + forced restarts exist (`begin_keyframe`/`force_restart`, built for
the track harness) but out-of-band manifests and loss testing do not.

## Third path: `debris-tracks` (per-viewer delivery, added 2026-08-17)

Splits the debris stream into MoQ-style tracks (pluggable `TrackSplit` × `Subscribe`
strategies, per-tier cadence/stride/grid) and simulates moving viewers, with optional
viewer-POV video recording (`--render-viewer`, `--render-solo`; see the `viewer-video`
skill and `tools/render_viewer_video.sh`).

Headline findings (`docs/destruction-codec-viewer-tracks-2026-08-17.md`,
`docs/destruction-delivery-architecture-2026-08-17.md` — read the second for the fixed
architecture and the pending V2–V5 queue):
- **The far-field floor is physical**: 13.24 → 6.60 Mbps via cadence + coarse grids, and
  no further — the validator refuses long strides on colliding rubble. The floor is set by
  how many bodies are colliding at once. Size-thinning (≥1.4 m) reaches 2.28 Mbps by
  dropping the tile/facade classes; the user viewed the A/B and found it acceptable.
- Detail cell tracks subset cleanly (near err95 0.5–0.6 cm, coverage ≈ 0);
  freshest-record-wins resolves multi-source bodies with no protocol.
- **Content-fidelity caveat, top open item**: the tower generator's all-dynamic-joints
  buildings sway and never sleep (59/55,063 rests in 5 s), inflating every delivery
  number. Next major work is a TWTRACE1 exporter for the blast-stress-solver mini-city
  (static-until-broken), before building far-field aggregate proxies.
- Perceptual decisions get **videos**, not percentiles (standing user instruction) —
  use the `viewer-video` skill.

## Standing rules — these are why the numbers are trustworthy

1. **Measure before committing.** Every mechanism ships behind a flag until adopted. Negatives ship
   default-off as measured controls rather than being deleted.
2. **Entropy coders qualify on achievable coder output against the incumbent, never on entropy
   estimates.** This rule exists because violating it cost a full implementation cycle (see R3/R4).
3. **Byte-stability is a gate.** Any config re-run twice must produce identical `compressed_bytes`.
   The reference archive must stay at 36,646,007 unless the change is *intended* to alter bytes.
4. **Encoder decisions are validated against literally re-parsed wire bytes**, never against
   in-memory fitted values. Serialization quantization is part of the decision.
5. **Artifact gates are the fidelity contract**, not L2 pose error. Freeze, reversal,
   gravity-inconsistency, interpenetration. Positional slack is cheap; these are not.
6. **Masking may only loosen precision, never break continuity.** A body may not borrow masked slack
   while its reconstruction basis is static — that produced stop-motion on moving children of static
   roots (found by L1, would otherwise have shipped).
7. Commit per item with measured numbers in the message; add a `docs/destruction-codec-*.md` per
   item. Diagnostic scaffolding is reverted after use, with its findings preserved in the doc.

## Closed lines — do not re-attempt without new evidence

| line | result | why it fails |
|---|---|---|
| Residual entropy coding (rANS) | +0.52% | residuals are the unpredicted remainder of a good physics predictor — near-noise. Out-of-sample conditioning was net *negative* (memorisation) |
| Root coder v1 (byte transcode) | +0.65% | `encode_uint` ships low bits raw, 3.5× overhead |
| Root coder v2 (direct alphabets, Fenwick) | fixture gate 1.060 | third strike; **the entropy line is closed permanently** |
| Learned trajectory basis (R5) | +2.7pp over Hermite, in-sample | failure shapes need 12 PCA components for 95% variance. No shared low-dimensional structure — mocap compresses because limbs correlate; independent rigid debris does not |
| Budgeted selection (Phase S) | ~2% | 75.3% of repairs are undeferrable; the mechanism runs out of things it is allowed to drop |
| Interior-of-pile occlusion coarsening (P5) | ~2.8% realistic | buried debris is also fast debris, so motion masking already harvested it. The two levers correlate and do not stack |
| Cross-block continuation (R6) | 0.31% | blocks are already ~500 KB; one more block of history is marginal. The −6% seen at larger GOPs is bought with **latency**, not redundancy removal |
| DIS-style heartbeat | worse | made freezes worse |
| Per-member selection on the live path | +6.6% | loses by more after R2's longer spans |

**The standing conclusion: byte-level redundancy in this stream is exhausted.** Four entropy
attempts, a learned basis, and cross-block continuation all landed under 1%. Anything that moves the
number materially now trades *fidelity or latency* for bytes.

Perception levers are similarly picked over on the motion axis: after masking, **49% of residual
bytes go to bodies below 2 m/s** (up from 23% unmasked). Motion silencing has taken what it can;
what remains is slow, visible, surface-level bodies where perception is most acute.

## What is open, in order

1. **P2 — rate-controlled masking (CBR).** The only mechanism that addresses sustained multi-region
   load; would subsume the manual span-cap tradeoff above. Scale bounds toward the calibrated 4×
   cap when a block projects over budget.
2. **P6-Weber — logarithmic velocity precision.** Velocity is on a fixed 1/512 m/s grid, so a body
   at 0.5 m/s gets ~0.4% precision against a ~5–10% discrimination threshold. Targets exactly the
   slow population that now dominates. (The Reitsma anisotropy leg is *weak* — vertical error
   dominates at 43.8%, and vertical is the guarded axis.)
3. **P3 — hard cap + queue.** A spike absorber and ceiling guarantee, *not* a rate control: it earns
   a 15 Mbps ceiling on low-duty-cycle content and nothing on sustained content.
4. **P4 — per-region fairness.** Correctness requirement shipping with P2/P3: a burst in one region
   must not starve another, since viewers watch arbitrary track subsets.
5. **R7 — quintic segment model.** Estimate-only (~5% archive). Must gate on reversal, not just fit
   rate — a quintic has *more* freedom to overshoot than Hermite.
6. **V1/V2 — vibe-land integration.** Arguably should come first: masking is a 25% cut with zero
   wire change and no determinism requirement, and it is not deployed.

Biggest wins are no longer in the codec — they are **track subsetting** (turning "origin publishes
40 Mbps" into "viewer receives ≤15") and **encoder throughput** above 10k bodies.

**Revised 2026-08-16 by the debris-codec line.** Encoder throughput is now addressed on that
path (0.56× realtime serial at 6k, 1.06× parallel at 24k vs the live path's 1.28×), and
representation work there is at diminishing returns — remaining levers are all under ~5%. The
queue in priority order is now:

1. **Resync / statefulness on the debris path** — KEYSTATE records, visibility-transition
   restarts, loss testing, late-join. A correctness hole, and a prerequisite for (2).
2. **Track subsetting / per-viewer relevance** — still the biggest remaining win, and now the
   only route from 3.7–27 Mbps publish-side to vibe-land's ~2.5 Mbps per-client ceiling.
   Precision-degrading rate control was measured and cannot close that gap (spike absorber
   only), so this must reduce *coverage per viewer*, not precision.
3. **Real-time end-to-end** — every measurement so far reads a trace file offline. Live PhysX
   capture/readback, encode inside a 16.67 ms tick, and client-side evaluation cost at 24k
   bodies are all unmeasured.
4. P2/P6-Weber/P3/P4/R7 as before, for the live path.

## Reference commands

Archive (baseline 36,646,007 bytes):
```
archive --trace codec-results/one-building-120hz-30s/collapse-v3-topology.towertrace \
  --out-dir <out> --shell-error-mm 5 --gop-ms 1000 --max-segment-ms 250 \
  --cell-size-m 128 --supercell-size-m 512 --target-tracks 30 --hard-track-cap 50
```

Live (baseline 8.82 avg / 22.55 peak):
```
analyze --trace <same> --out-dir <out> --omniscient --telemetry-only --live-hierarchy \
  --hier-gop-ms 250 --world-shell-budget-cm 0.5 --snapshot-fps 120 --output-fps 30 \
  --mask-precision --mask-cap-mm 20
```

Scenario generation (deterministic per seed; record → measure → **delete**, traces are 2–3 GB):
```
physx-tower/tower-demo: trace --duration 10 --settle 0 --buildings {2,3} \
  --seed {11,23} --shots {6,8} --snapshot-fps 120 --output <path>
```

Default-off measured controls: `--residual-rans`, `--root-rans`, `--budget-mbps`,
`--block-context`, `--max-span-ticks`. Diagnostics: `CODEC_CENSUS=1` (occlusion depth, error
anatomy, root-record continuity).

## Layout

- `src/hierarchy.rs` (~4k LOC) — the codec: island segmentation, trajectory fitting, wire I/O
- `src/mask.rs`, `src/budget.rs`, `src/census.rs`, `src/block_zstd.rs` — mechanisms and diagnostics
- `src/rans.rs`, `src/root_coder.rs`, `src/residual_coder.rs` — measured-and-rejected coders
- `src/evaluate.rs` — live path, visual acceptance gates, `live_blocks.csv`
- `tools/run_hierarchy_regression.sh`, `run_omniscient_regression.sh` — hard gates
- `docs/destruction-codec-*.md` — one per phase, each with its measurements
- `codec-reports-archive/` — 460 archived JSON/CSV reports from cleared run dirs

Disk: traces are 1.5–3 GB. `target/` run dirs are regenerable and get cleared; `codec-results/`
holds the reference trace everything is measured against — **do not delete it**.
