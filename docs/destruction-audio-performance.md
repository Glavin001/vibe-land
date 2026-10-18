# Destruction audio: CPU control performance

Measured September 26, 2026 on an Apple M3 Max, macOS arm64, Node v22.1.0.
These measurements cover event selection, motion tracking and destruction activity aggregation only. They do **not** measure browser audio rendering, the audio thread, sound quality, asset decoding, occlusion raycasts, networking, or GPU physics. The machine was not reserved exclusively for this benchmark.

## Reproduce

From `client/`:

```sh
node --import=tsx/esm scripts/benchmark-destruction-audio.mts --json
```

The script preallocates inputs, then measures 21 director runs after five warmups. Each run enqueues 10,000 events and drains once. The motion workload measures 600 bodies over 360 frames after 30 warmup frames. `--samples=N` and `--frames=N` adjust those counts. Wall-clock percentiles include allocation and garbage-collection costs within the measured calls; fixture generation is excluded.

## Finding and change

The original director scanned all 256 pending entries whenever an incoming event displaced the weakest one. A burst ordered from least to most important forced that scan for nearly every event: **111.6 ms median for 10,000 enqueues**.

An indexed min-heap now maintains the weakest event in logarithmic time. Scores are cached, and moving the listener rebuilds priorities once before the next operation. Updating an existing spatial group repairs its heap position. Cached positions are copied so later caller mutation cannot change a pending sound.

| 10,000-event enqueue workload | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| Mixed materials and spatial positions | 14.90 / 19.09 ms | 3.17 / 4.40 ms |
| Increasing protected priorities | 111.61 / 116.20 ms | 2.67 / 4.55 ms |
| Decreasing protected priorities | 0.74 / 1.21 ms | 0.84 / 1.45 ms |

The increasing-priority case improved about **42×**; the mixed burst improved about **4.7×**. The decreasing case was already cheap and remains below 1 ms median. All cases retained at most 256 pending events and selected 12 sounds. The highest-priority late events remained selected, and grouping/drop counts matched the baseline.

After the change, drain medians ranged from 0.039 to 0.088 ms. Drain p95 ranged from 0.125 to 0.901 ms; the largest observed drain was 1.542 ms. These are observations from this run, not timing guarantees.

## Motion workload

The unchanged motion tracker took **0.313 ms median / 1.174 ms p95 per 600-body frame** (2.173 ms maximum). The workload deliberately slows all bodies periodically, producing 7,200 detected events. This verifies that the bounded history retains prior samples across repeated 600-body frames instead of continually evicting them.

This is a stress test of the control code. Live physics contacts are reduced on the server before transmission; 10,000 raw contacts are not sent to the browser as 10,000 independent sound events.

## Regression coverage

Tests verify the selected strongest events, bounded score-evaluation count, listener movement between insertions, grouping updates, copied positions, deterministic ties, partial drains, clearing, and agreement with a simple sorted reference over 2,000 events and repeated listener moves. Engine and game-layer integration tests exercise playback budgets, suspension, material/entity mapping, replay scheduling, and lifecycle cleanup separately.

## Heavy-collapse revision: activity cost

The richer mix adds at most four spatial material-debris loops. A fixed 64-region
field accumulates energy from impact and fracture events before the director
groups or drops individual sounds. It has 2,048 bounded duplicate-history entries,
32 scheduled energy bins per region, and constant-cost two-choice admission.
The loops share the existing playback-voice budget.

Measured in the same environment at 05:02 on September 26:

| Workload | Median | p95 |
| --- | ---: | ---: |
| Activity: 10,000 events in one burst plus selection | 5.273 ms | 6.120 ms |
| Activity: 10,020 events/second, 167 per 60 Hz frame | 0.110 ms/frame | 0.353 ms/frame |
| Director: 10,000 mixed events, enqueue only | 2.546 ms | 3.185 ms |

The burst includes aggregation only; director and renderer costs are additional.
Do not interpret the sustained result as a promise that 10,000 events arriving
in one frame cost 0.11 ms. Both cases produced at most four active beds and
64 retained regions. Browser checks separately showed four beds and no more
than 52 ordinary voices with the default 64-voice budget.
