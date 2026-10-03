# Repro bundles (flight recorder, version 1)

Every server keeps a flight recorder (`server/src/flight_recorder.rs`,
`server/src/tick_recorder.rs`, `server/src/invariants.rs`), on unless
`VIBE_FLIGHT_RECORDER=0`. It costs about 1 µs a tick (measured
2026-10-03, median `capture_ms`). It writes a `repro/` folder into:

| Folder (under `VIBE_DEBUG_REPORTS_DIR`, default `debug-reports/`) | When |
|---|---|
| `report-<unix>-<match>-tick<N>/` | A player pressed SEND REPORT, or the client's hotspot watch fired. Holds `client.json` and `server.json` beside `repro/`. |
| `spike-<unix>-<match>-tick<N>/` | A tick exceeded `VIBE_SPIKE_DUMP_MS` (33). Holds ±120 ticks in `ticks.jsonl` and `meta.json` beside `repro/`. |
| `anomaly-<unix>-<match>-tick<N>-<kind>/` | An invariant fired (`invariants::WATCHED`, or stage error bits). |

## `repro/`

| File | Contents |
|---|---|
| `meta.json` | `version`, `kind` (report / spike / anomaly), `reason`, `match_id`, `server_tick`, `players`, `fingerprint` (build, both repos' revisions), `server_build`, `env` (every `VIBE_*`, `PX_*`, `BLAST_*` variable), and `anomaly` for anomaly dumps. |
| `events.jsonl` | `{"tick", "event"}`: every city event since the server started, up to 20,000. Event kinds:<br>• `join` (player)<br>• `shot` (weapon, shooter, origin, direction)<br>• `meteor` (start, velocity, target, mass_kg, radius_m, flight_s, shooter, body_id)<br>• `demolish` (centre, radius_m, below_y)<br>• `reset`<br>These are the city tape's capture events, so `city/events.jsonl` in a session bundle has the same shape. |
| `inputs.jsonl` | Every input frame the server applied in the last 60 s. Fields: `tick`, `player`, `seq`, `buttons`, `move_x`, `move_y`, `yaw`, `pitch`, `in_vehicle`. |
| `poses.jsonl` | Every 6 ticks in the last 60 s, per player: `tick`, `player`, `position`, `velocity`, `yaw`, `pitch`, `hp`, `in_vehicle`. |
| `ticks.jsonl` | The last 600 ticks' `TickTiming` records, the session-capture format: brackets, PhysX phases, stage counts, engine zones when profiled, `abs_end_s`. |

## Limits

- **No physics state.** The simulation is not bit-reproducible (see
  `docs/determinism-and-measurement.md`). A replay re-applies the events in
  order on a fresh city and reproduces the damage regime, not the exact
  fracture. `scripts/vl repro` therefore runs N repetitions and reports a
  rate.
- **Inputs cover only the last minute.** Damage events cover the whole
  session since the server started.
- **City matches only.** Events are recorded only there; inputs, poses and
  ticks are recorded for every match.
