# Closing the span-timing gap, and what it says about freezing

2026-08-25. Written after auditing a performance handoff report against the
source, closing every unattributed span in the destruction tick, and running a
live freeze-on / freeze-off A/B on downtown.

Two outcomes. The tick is now **fully accounted** — parent minus children is
+0.0006 ms at 66 ms ticks, against a previously-reported 4.06 ms unattributed
gap. And the measurements that gap was hiding **overturn the premise the freeze
machine was built on**.

## What was wrong with the instrument

Five defects, all of which made the old numbers misleading rather than merely
incomplete:

1. **`VIBE_PHYSX_PROFILE_FETCH` was presence-checked, not value-checked**
   (`physx_bridge.cc`). `=0` still busy-polled, so the obvious A/B for "is the
   polling costing a core?" compared two identical polling builds and read the
   null result as "profiling is free". In production (unset) `gpu_wait` and
   `fetch_copy` are hardcoded `0.0` — the panel was showing zeros, not a
   measurement.
2. **The 1 Hz publish is harmonically locked to the 30-tick bond sampler.**
   `SERVER_PING_INTERVAL_TICKS = 60`, `bond_sample_interval_ = 30`, so
   `60 % 30 == 0` and the published tick is *always* one of the expensive ones.
   Measured: `bond_sample_ms` read **25–34× high** in the flat field on 6 of 6
   consecutive snapshots, for a scan that runs 1 tick in 30. Every per-tick cost
   read off the endpoint inherited that bias.
3. **Five of the Blast adapter's six phase timers were computed every tick and
   discarded** — only `gpuStressSolveMilliseconds` was surfaced. That left
   2–3.5 ms inside `solve_ms`, the largest phase in the tick, unaccounted.
4. **`dynamics_ms` was one bracket** around the step *plus* three FFI readbacks
   *plus* the player refresh, and `vehicle_ms` was hardcoded `0.0` — a
   real-looking zero for a cost nobody had measured.
5. **Three fields cited as evidence are structurally always zero**:
   `unsupported_resting_bodies` (census-gated, off by default),
   `settle_deferred_penetrating` (**no increment site anywhere in the tree**),
   `physics_contact_pairs` (GPU narrowphase does not fill it).

## What the report got wrong

The handoff report's diagnoses did not survive the source. Recorded because the
corrections are the useful part:

- **"`begin_ms` is a serial injection walk"** — stale. It is dispatched across
  `stress_executor_` by default (`VIBE_CITY_SNAPSHOT_BEGIN`); only the `wakeUp`
  apply is serial. The comment it came from says *"used to be serial"*, past
  tense, and `server/src/main.rs` repeated the stale wording.
- **"83% of freezes are undone" as a CPU cost** — the flip counters are
  cumulative since boot. Differenced, that is **0.33 flips/tick** at idle. The
  churn is real; its cost was not.
- **"Penetration blocks freezing"** — the bound is
  `max(0.015, reach * 0.03)` (typically 45 mm), `min_body_y` is a body-origin
  minimum unrelated to contact separation, and the repo's own gate tolerates
  2 m. Live, `min_body_y` was **positive** for a whole session.
- **"Overlap the GPU wait, worth up to 6.4 ms"** — the mechanism is real and
  production genuinely uses the fused `step()`, but of the four candidate work
  items, three cannot move (they read poses, raycast the scene, or mutate it).
  The movable set is ~0.3–0.5 ms.

## What was added

Every span inside `destruction_tick` now has a timer, and every phase is
windowed (min/avg/p95/max over 60 ticks) rather than sampled once:

- the five discarded adapter timers, deltaed per-tick like the GPU one:
  `blast_contact_processing_ms`, `blast_gravity_ms`,
  `blast_stress_solve_cpu_ms`, `blast_fracture_topology_ms`,
  `blast_mapping_validation_ms`
- `ccd_ms`, `support_loads_ms`, `support_pair_loads`, `shape_readback_ms`,
  `slot_dispatch_ms`, `bond_sample_ms`, `quiet_slot_ticks`
- the `dynamics_ms` interior: `physics_readback_ms`,
  `physics_refresh_players_ms`, `physics_vehicle_control_ms`
- `city.phase_windows` — all 16 phases, drained in the same pass as
  `window_step_ms` so they cover identical ticks

The adapter timers **cross-validate the bridge's own brackets to sub-microsecond**
(`begin_ms` 0.114794 vs contact+gravity 0.114374; `solve_ms` 2.248245 vs cpu+gpu
2.247935) — two independent clocks agreeing, which is what makes the
decomposition trustworthy rather than merely plausible.

`resolve_support_loads` also stopped rebuilding a whole-population
`unordered_map` every tick; the body cache is already sorted by `bodyId`
(`refresh_snapshots` documents it, and now verifies it), so it binary-searches
with a linear fallback if the invariant ever breaks. A/B'd in one binary via
`VIBE_CITY_SUPPORT_ROW_MAP`, normalised by contact pairs: **0.456 → 0.322
µs/pair, −29%**.

## The freeze A/B

Downtown, GRID=1, 1 player, profiling on. Freeze-on and freeze-off sessions.

**At matched damage (~44–46k broken bonds):**

| | awake | tick | Hz |
|---|---:|---:|---:|
| freeze ON | 4,542 (36%) | 35.7 ms | 28.0 |
| freeze OFF | 12,026 (89%) | 65.2 ms | 15.3 |

Freezing buys a uniform ~2× on every awake-scaled phase — `gpu_wait` 2.16×,
`copy` 2.26×, `support_loads` 1.98×. The mechanism is visible in
`support_pair_loads`: **5,858 vs 22,487 (3.84×)**, because kinematic bodies
generate no contact pairs against each other.

**At rest, freeze OFF:**

```
53,613 bonds · 15,542 bodies · awake 839 (5%) · sleeping 14,366
13.28 ms = 75.3 Hz    gpu_wait 1.83 ms
```

Damage stops, and PhysX drains **93% of the awake population within 60 s**
unaided. Freeze-on never got below 4,283 awake in any sample.

**This contradicts the founding measurement of the freeze campaign.**
`city-scale-next-sleeping-piles-2026-08-22.md` states *"Awake never comes down
under sustained play"* and that past ~22k broken bonds the pile stops recovering
at all. At **53k** bonds it settled to 5%. The upstream Blast work that doc
lists as already landed (`a5b859d` debris damping, `bc06138` sleep threshold
restored) appears to have fixed the problem freezing was built for — and
freezing was never re-evaluated against it.

## There is no GPU body-count cliff

A single freeze-on sample showed `gpu_wait` at 31.79 ms and looked like a knee.
It is not. Normalised per awake body, `gpu_wait` is flat at **~1.1–1.4 µs**
across both runs and both configurations:

| run | awake | gpu_wait | µs/awake |
|---|---:|---:|---:|
| OFF | 6,047 | 8.47 | 1.40 |
| OFF | **11,744** | **13.44** | **1.14** |
| ON | 4,542 | 5.92 | 1.30 |
| ON | 7,632 | **31.79** | **4.17** ← lone 3× outlier |

**11,744 awake cost 13.44 ms; 7,632 awake cost 31.79 ms.** More bodies, less
than half the time. The outlier coincides exactly with a mass thaw (1,810 bodies
released in one interval, 90% `contact_wakes`) and with
`bond_utilisation_max: 1,431` — a bond at 1,431× its elastic limit, which is not
a physical load. Both point at a transient, not a threshold.

**The diagnostic that would settle it already exists and is not published:**
`gpu_rigid_contact_high_water` and `gpu_rigid_patch_high_water` are in
`FfiWorldStats` (`physx_bridge.cc`) and dropped on the floor. A GPU
contact-buffer spill would explain the 3× and the impossible utilisation
together, and would be a config fix
(`VIBE_PHYSX_GPU_MAX_RIGID_CONTACTS`) rather than a physics one.

## Verdict

**Freezing defaults off** (`VIBE_CITY_FREEZE=0` in `scripts/run-city-server.sh`,
one line to flip back). The trade is asymmetric in favour of off:

- at rest — the state a server spends most of its life in — OFF gives 839 awake
  at 75 Hz; ON never beat 4,283 awake
- under demolition ON wins 28 vs 15 Hz, but that is transient, OFF degrades
  smoothly, and **ON's worst case (13.6 Hz, post-cascade) is worse than OFF's
  worst case (15.1 Hz)**

The kill switch was verified complete, not assumed: both freeze paths gate on
`config.enabled`, `pose_enabled` is ANDed with it, and with nothing frozen the
release paths are inert by construction. Confirmed live —
`frozen_bodies`/`freeze_flips`/`unfreeze_flips`/`contact_wakes` all 0.

## Next, in order

1. **Publish the GPU high-water counters.** Already in the bridge. Confirms or
   kills the contact-spill hypothesis for the 3× outlier.
2. **`begin_ms` + `support_loads`** — 13.8 ms combined at load, both O(awake),
   both in code we own. `addGravityFromSnapshot` iterates *all* bodies with a
   hash lookup each before skipping sleeping ones.
3. **Re-open freezing as a measured question**, with a release rule that is not
   "impulse vs the striker's own weight" — that test holds for one body resting
   on a pile and fails for a stack, where a load-bearing striker transmits the
   weight of everything above it.

## Caveats

One session per configuration, hand-driven, single-player, not damage-matched by
construction. The at-rest result (5% awake at 53k bonds) is dramatic enough that
noise does not explain it; the 28-vs-15 Hz under-load comparison rests on one
sample pair and should be hardened with `city_bench` before it is load-bearing.
Absolute numbers are an RTX 4090 and do not transfer to the 3060 the original
report used — only the ratios and the shapes do.
