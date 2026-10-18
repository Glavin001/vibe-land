# Netlab scenarios

Reproducible named scenarios for the netcode measurement harness. When the
user reports a symptom, start from this table, run the scenario baseline and
under an impairment profile, then compare.

| Symptom reported | Scenario | What the detectors look at |
|---|---|---|
| "everything is smooth" (sanity) | `idle-baseline` | noise floor; every gate must pass |
| "I rubber-band when I move" | `city-strafe` | `presOffMag` tails, correction onsets, intent reversals |
| "I teleport / snap around" | `stop-start` | hard_snap/resync/stale_drop events, excess-step tail |
| "other players stutter/warp" | `observer-remote` | observer's `remote*` columns: freeze %, jerk, teleport steps |
| vehicle jitter | (use `npm run benchmark` vehicle suites for now) | `vehicleAccumulator` RMS battery |

## Running

```bash
cd client
npm run netlab -- list-scenarios
npm run netlab -- run --scenario city-strafe                       # baseline
npm run netlab -- run --scenario city-strafe --impair lte          # deterministic in-process impairment
npm run netlab -- run --scenario city-strafe --impair lte --impair-mode netem   # real QUIC-level impairment (root)
```

The stack must already be running (`make dev`), or pass `--stack dev` to have
the runner spawn server+vite itself. Results land in `netlab/results/`.

## Scenario JSON fields

- `path`: page path+query; `{iter}` is replaced with the iteration number.
  `autostart=1` joins without a click (`join: "auto"`).
- `matchId`: per-iteration match (`{iter}` placeholder keeps iterations independent).
- `clients[]`: `role`, optional `watch` (keep aiming at another role's player),
  `drive[]` timeline of `{at, cmd, args}` mapped onto `window.__VIBE_DRIVE__`
  (`look`, `lookAt`, `faceCity`, `move`, `stop`, `setSprint`, `jump`, `fire`, ...).
- `impairment`: default `{profile, mode, seed}`; CLI flags override.

Impairment profiles live in `../netemProfiles.json` — one table for both the
in-process (seeded, deterministic, post-QUIC) and netem (kernel-level, affects
real QUIC loss recovery/congestion control) modes.
