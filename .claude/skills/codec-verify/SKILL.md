---
name: codec-verify
description: Run the destruction-codec verification protocol after any encoder or wire change — tests, both legacy regression gates, the two byte tripwires, live rate measurement, byte-stability, and the Blast island-stream checks. Use before committing any change under research/destruction-codec/src, and to confirm a default-off mechanism is inert.
---

# destruction-codec verification protocol

Run this after **any** change under `research/destruction-codec/src/`. It is the
procedure that makes this project's numbers trustworthy; skipping a step has
previously let a real defect through.

Work from the **workspace root** `/root/workspace/vibe-land-2`. The crate moved
into this repo on 2026-08-17, so `target/` is the workspace target, not a
per-crate one — that is the only path change from the old protocol.

The reference traces live outside the repo and must not be deleted:

```
D6 (legacy):   /root/workspace/codec-results/one-building-120hz-30s/collapse-v3-topology.towertrace
Blast:         /root/workspace/codec-results/blast-one-building-60hz-30s/collapse.towertrace
```

---

## Part A — legacy D6 path (frozen: these numbers must not move)

These measure the incumbent wires against D6-joint content. They are **frozen
baselines**. No new work goes into these paths, but every number below is a hard
gate: it is how we know a new mechanism is inert when its flag is off.

### 1. Tests

```bash
cargo test --release -p destruction-codec
```

Expect **103 passing** (96 before the island line added 7). A new mechanism
should add its own tests.

### 2. Regression gates

```bash
bash research/destruction-codec/tools/run_hierarchy_regression.sh
bash research/destruction-codec/tools/run_omniscient_regression.sh
```

Both are hard gates and regenerate their own synthetic fixtures.

### 3. Archive byte tripwire

```bash
./target/release/destruction-codec archive \
  --trace /root/workspace/codec-results/one-building-120hz-30s/collapse-v3-topology.towertrace \
  --out-dir target/verify/archive --shell-error-mm 5 --gop-ms 1000 --max-segment-ms 250 \
  --cell-size-m 128 --supercell-size-m 512 --target-tracks 30 --hard-track-cap 50
```

`hierarchy.compressed_bytes` in `archive_report.json` **must equal 36,646,007**
unless the change is *intended* to alter bytes. This is the single most useful
check in the protocol.

### 4. Live rate measurement

```bash
./target/release/destruction-codec analyze \
  --trace /root/workspace/codec-results/one-building-120hz-30s/collapse-v3-topology.towertrace \
  --out-dir target/verify/live --omniscient --telemetry-only --live-hierarchy \
  --hier-gop-ms 250 --world-shell-budget-cm 0.5 --snapshot-fps 120 --output-fps 30 \
  --mask-precision --mask-cap-mm 20
```

Baseline: **8.821 avg / 16.510 p95 / 22.551 peak / 0.254x encode / gate true**.

### 5. Byte-stability

Re-run step 3 into a different `--out-dir`; `compressed_bytes` must be identical.

### 5b. Debris-codec byte tripwire

```bash
./target/release/destruction-codec debris-codec \
  --trace /root/workspace/codec-results/one-building-120hz-30s/collapse-v3-topology.towertrace \
  --out-dir target/verify/debris --shell-cm 0.5 --mask-precision --mask-cap-mm 20 --flush-ms 250
```

**Must equal 13,814,930** compressed bytes.

---

## Part B — Blast island path (the live line)

### 6. Island stream is guarded and passes

```bash
./target/release/destruction-codec debris-codec --island-stream \
  --trace /root/workspace/codec-results/blast-one-building-60hz-30s/collapse.towertrace \
  --out-dir target/verify/blast-island --shell-cm 0.5 --mask-precision --mask-cap-mm 20 --flush-ms 250
```

`gates` must read **PASS**. Island streaming derives a member chunk from its
island root, and a root's rotation quantum is amplified by the member's lever
arm — so a regression here shows up as shell violations on *members*, not on
roots. If violations appear, check `IslandView::derivable` before suspecting the
fitter: at a 0.5 cm bound the largest derivable island is 1.81 m, and that
threshold is derived from the wire's 2.77 mrad quaternion step, not tuned.

Reference (2026-08-17): 1,235,439 B total, gates PASS, max error 2.30 cm,
4 residual violations, peak 519 islands of 1032 chunks.

### 7. Per-chunk comparison on the same trace

Same command without `--island-stream`: **1,203,144 B**, gates PASS. Island mode
being slightly *larger* at this bound is the expected, documented result — see
`docs/destruction-codec-island-stream-2026-08-17.md`.

### 8. Recorder invariants (only when the recorder changed)

```bash
LD_LIBRARY_PATH=/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.clang/release:$LD_LIBRARY_PATH \
./target/release/record-city-trace --scene destruction/assets/scenes/high-rise-3f-local.json \
  --grid 1 --hz 60 --seconds 8 --settle-ticks 30 --shots 24 --shot-interval-ticks 8 \
  --output /tmp/smoke.towertrace
```

Two invariants must hold in the summary, and neither is cosmetic:

- **broken bonds == the adapter's own count.** A mismatch means topology events
  are being dropped.
- **membership mismatches == 0.** The recorder's per-body chunk ledger is
  checked against the adapter's `node_count` every tick. Non-zero means chunk
  membership has drifted, and every pose composed against a wrong centre of mass
  is wrong for the rest of the run.

Needs a GPU. Traces are 0.5–3 GB: record, measure, delete.

---

## Standing rules this protocol enforces

1. New mechanisms ship behind a flag, default off, until adopted; negatives stay
   as measured controls rather than being deleted.
2. **Byte-stability is a gate.** Re-running a config must reproduce
   `compressed_bytes` exactly.
3. Encoder decisions are validated against literally re-parsed wire bytes.
4. **Artifact gates are the fidelity contract**, not L2 pose error. Freeze,
   reversal, gravity-inconsistency, interpenetration. Positional slack is cheap;
   these are not.
5. Perceptual decisions get **videos**, not percentiles — use the `viewer-video`
   skill.
