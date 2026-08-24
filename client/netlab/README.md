# netlab — netcode quality measurement harness

Turns "I see rubber-banding" into a reproducible run with numbers and a layer
verdict: **frontend/render**, **network transport**, **backend/server sim**, or
**client↔server sync logic**.

```bash
cd client
npm run netlab -- list-scenarios
npm run netlab -- run --scenario city-strafe --stack dev                 # baseline
npm run netlab -- run --scenario city-strafe --stack dev --impair lte    # impaired
npm run netlab -- compare <baselineIterDir> <impairedIterDir>
```

Each run writes `netlab/results/<ts>_<scenario>_<profile>/iterN/` containing
`report.md` (read this first), `verdict.json`, `frames.clientK.csv`,
`events.clientK.jsonl`, `server-stats.jsonl`, `run.json`, `console.clientK.log`.

## How it works

1. **Recorder** (`src/netlab/recorder.ts`) installs `window.__VIBE_RECORDER__`
   and captures ~40 columns *every frame* into a preallocated ring, drained in
   bulk by the runner. The existing `__VIBE_E2E__` bridge returns one
   instantaneous sample, so polling it at 200 ms walks straight past the
   few-frame spikes that cause these complaints.
2. **Runner** (`netlab/run.mts`) launches headful Chrome (real Chrome, GPU flags
   shared with the e2e config), drives deterministic input through
   `window.__VIBE_DRIVE__`, and taps the server's 1 Hz `WS /ws/stats`.
3. **Analyzer** (`netlab/analyze.ts`) computes per-defect metrics and
   **`attribute.ts`** ranks the four layers with the evidence for each.

## Reading a report

Attribution comes first, then per-client gate tables, then server pace. Gates
follow the destruction-codec rule: **tail and worst-frame, never global means**,
because a good average hides a visible lurch.

| Symptom | Metrics that fire |
|---|---|
| jitter / stutter | `hitchesPerMin`, `frameGapP99Ms`, `snapshotGapP95Ms`, `microReversalPct` |
| rubber-banding | `correctionP95CmP99`, `correctionMaxCm`, `correctionOnsetsPerMin` |
| teleporting | `hardSnaps`, `teleportSteps`, `excessStepP95CmP99`, `clockJumps` |
| freezing | `freezePct`, `freezeRunMaxMs` |
| laggy controls | `pendingInputsP95`, server `input_jitter_ms` |
| other players warp | observer client's `remoteTeleportSteps`, `remoteFreezePct` |

Two measurement subtleties worth knowing, both learned the hard way here:

- **Frame gaps are computed from the recorder's own timestamps**, not the app's
  `frameDeltaMs`. `GameWorld` clamps that value to 100 ms, so a 200 ms stall
  reads as 100 ms — a real stall would have been under-reported by half.
- **A stalled server leaves no server-side trace.** Its tick timings stay
  healthy because a frozen process cannot measure its own absence. The signal is
  `tickDeficitPct`: `server_tick` advance versus wall-clock time.

## Impairment

Profiles live in `netemProfiles.json` and drive both modes:

| Mode | Flag | What it models | Privileges |
|---|---|---|---|
| in-process | `--impair-mode inproc` (default) | seeded, deterministic, reproducible delay/jitter/loss applied *after* QUIC delivers | none |
| kernel | `--impair-mode netem` | real QUIC behaviour: loss recovery, pacing, congestion control | **CAP_NET_ADMIN** |

`scripts/netem.sh` touches `dev lo` only and diverts just UDP traffic on the
game ports into an impaired band, so SSH and every other loopback service are
structurally unaffected. `netem.sh dry-run <profile>` prints the exact `tc`
commands without running them. Chrome's CDP throttling is not an option here —
it does not apply to WebTransport/QUIC at all.

> On a container without `CAP_NET_ADMIN` (including this dev box), `netem` mode
> fails fast with instructions rather than silently producing a run labelled
> "impaired" whose link was never impaired. Use `inproc` there.

## Calibration and trust

Gate thresholds are calibrated against a measured A/A noise floor — see the
CALIBRATION comment in `thresholds.ts`. Re-derive them if the movement mode or
snapshot rate changes, since full-prediction (Rapier) and thin-authoritative
(PhysX GPU) have different correction mechanics.

The harness is verified by injecting known faults and checking that each one
flips its own channel and nothing else:

```bash
npm run netlab -- run --scenario city-strafe --stack dev --fault render-stall  # -> RENDER
npm run netlab -- run --scenario city-strafe --stack dev --fault server-stall  # -> SERVER
npm run netlab -- run --scenario city-strafe --stack dev --impair lte          # -> NETWORK
npx vitest run netlab/analyze.test.ts src/netlab/recorder.test.ts              # detector math
```

Measured results of that matrix (30 s `city-strafe`, Rapier, RTX 4090):

| Condition | Verdict |
|---|---|
| clean ×3 | 0 fail, no channel degraded (reproducible) |
| `--impair lte` | NETWORK + SYNC |
| `--fault render-stall` | RENDER (25 hitches, worst 209 ms) |
| `--fault server-stall` | SERVER (56.8 Hz vs 60 Hz, 5.4% tick deficit) |

SYNC appearing beside another channel is expected, not a bug: corrections
genuinely rise when the link, renderer, or server misbehaves. The report says so
explicitly and the per-event table tags each artifact with its proximate cause.

## Stack modes

- `--stack dev` (recommended): spawns an **isolated** server + Vite on ports
  4051/4052/5599 so a run cannot disturb — or accidentally measure — a stack you
  already have on 4001/4002/5555. Set `NETLAB_PHYSICS_BACKEND=physx_gpu` to
  measure the thin-authoritative path.
- `--stack attach`: measures whatever is already running. Note that an
  orchestrated server advertises its external address in `/session-config`,
  which QUIC cannot hairpin back to from inside the box; the client then falls
  back to WebSocket and you are no longer measuring WebTransport. The runner
  records a `transport_change` event and the report flags it.
