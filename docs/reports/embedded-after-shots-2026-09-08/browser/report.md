# Live browser reproduction after a few shots

Deployed PhysX embedded destruction: **27 buildings, 24,105 chunks, 74,543 bonds**, Direct GPU off, sleeping on, correction limit one. This used the playable client and actual accepted projectile commands.

5 trigger actions produced **6 server-accepted physical projectiles** during 256.9 seconds of observation. The software-rendered browser predicted 15 shots; client trigger counts are not authoritative projectile counts.

The existing scene was reset before shooting. Previously spawned ordinary bodies remained, so this is a reset-structure idle observation, not a pristine isolated-world benchmark. The first aborted attempt aimed incorrectly from a different spawn and is not used as successful evidence.

| Observed phase | Unique cached server samples | Physics min ms | Physics median ms | Physics max ms | Max fragments / awake | Max stress iterations |
|---|---:|---:|---:|---:|---:|---:|
| intact-idle | 15 | 4.216 | 4.424 | 4.536 | 0 / 0 | 3 |
| two-shots | 54 | 4.357 | 4.447 | 4.542 | 0 / 0 | 3 |
| two-shot-aftermath | 29 | 4.384 | 4.459 | 5.477 | 0 / 0 | 3 |
| five-shots | 55 | 4.375 | 5.197 | 613.577 | 16 / 13 | 115 |
| settling | 55 | 4.407 | 4.498 | 8.679 | 16 / 13 | 56 |

Phase names mark browser actions, not exact server command application. Slow software rendering delays input delivery. Server status is cached periodically: physics samples can miss peaks and are not independent repeated trials. The archived tick ring preserves the full server tick timings separately.

The worst sampled physics step is **613.577 ms**, tick 96240: 9 fragments / 9 awake, 170 broken bonds, 21 ordinary dynamic bodies; 104 maximum stress iterations, 2 stress evaluations and 1 correction.

Archived 15,540 unique server ticks, 0 gaps and no conflicting duplicate values. Total-tick peak over the entire captured ring (including reset/history) is 617.543 ms; it must not be conflated with the sampled physics peak.

## Findings

- A small local break is sufficient to reproduce a large simulation hitch.
- Quiet simulation returns near its improved idle cost after settling. The problem is active destruction/impact peaks, not uniformly slow quiet simulation.
- Rendering membership remained valid: no hash mismatches or orphaned chunks. All captured server statuses remained non-degraded.
- This live evidence does not attribute the hitch among stress, hierarchy rebuild and correction; use the separate native phase replay for that.

[Machine-readable summary](summary.json). Raw server observations, deduplicated tick history, browser actions and accepted projectile launch logs are archived alongside this report.
