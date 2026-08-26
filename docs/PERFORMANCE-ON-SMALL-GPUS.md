# Server performance on small GPUs — investigation handoff

**Audience:** a developer picking this up to debug and fix.
**Status:** measured, not fixed. Every task below has evidence, file:line anchors,
a verification method, and a stated risk.

**Box under test:** RTX 3060, 12 effective cores @ 4.3 GHz, **$0.061/hr** (Vast).
**Scene:** `fractured-downtown.json`, `VIBE_CITY_GRID=1` — 24,105 authored chunks.
**Image:** `ghcr.io/glavin001/vibe-land-server:sha-0a449cb69864`

---

## TL;DR — the queue

| # | Task | Evidence | Est. gain | Risk |
| --- | --- | --- | --- | --- |
| **T1** | Overlap CPU work with the GPU wait — use the existing `begin_step`/`end_step` split | CPU blocked **6.43 ms/tick** | **up to 6.4 ms** | medium |
| **T2** | Re-baseline with `VIBE_PHYSX_PROFILE_FETCH=0` | profiling **busy-polls a core** | unknown — may invalidate T1's size | none |
| **T3** | Find why 2,126 bodies are awake in settled rubble | only **161** are pose-quiet | large, indirect | medium |
| **T4** | Kill spurious thaws | **83%** of freezes undone | large, indirect | medium |
| **T5** | Instrument the unattributed **4.06 ms** inside `stress_solve_ms` | 25% of the city step | unknown | none |
| **T6** | Make `begin_ms` incremental — serial, single-threaded, growing | 1.3 → **4.72 ms** | ~3 ms | medium |
| **T7** | Prove the `0.0` in `events_ms`/`filters_ms` — run with `VIBE_CITY_QUIET_SKIP=0` | both exactly `0.0`; `quiet_slot_ticks_` **never exposed** | none (diagnostic, but gates T5) | none |
| **T8** | Explain `physics_contact_pairs: 0` with 2,126 awake bodies | looks unpopulated | none (diagnostic) | none |

**Do T2 first.** It is free and it determines whether T1's 6.4 ms is real or partly
an artefact of how we measured it.

---

## 0. Data sources and provenance

Everything in this document derives from four collections. Nothing else was
used; where a number is inferred rather than read, it is marked **[inferred]**.

| # | Source | When | Config | What it gives |
| --- | --- | --- | --- | --- |
| **S1** | `/match-stats/city-default` JSON | `server_tick 468840` | 0 players, rubble settled | the idle baseline |
| **S2** | `/match-stats/city-default` JSON | `server_tick 478020` | 1 player, standing still | the loaded baseline |
| **S3** | In-game overlay screenshots | during active demolition | 1–2 players, desktop + iOS Safari | scale progression 10k → 33.7k bonds |
| **S4** | Source code at `b5eddaa` | — | — | file:line anchors, defaults, contracts |

**Both JSON samples came from the same box and the same process**
(`server_started: 20:50:20` in both), so they differ only in load and elapsed
time. That is what makes the idle→loaded comparison in §3 meaningful.

**Known limitations of this dataset, stated up front:**

1. **n = 1 box.** All timings are one RTX 3060 with 12 effective cores at
   4.3 GHz. Nothing here establishes how these costs scale across CPU or GPU
   models. The 5060 Ti comparison in S3 is not scale-matched (see §4.5) and is
   used only for direction, never for ratios.
2. **Both JSON samples had `VIBE_PHYSX_PROFILE_FETCH=1`**, which busy-polls a
   core by design. See §4.1 and T2 — this may inflate every number in §3.
3. **No scripted run.** Every demolition was hand-driven, so S3's samples reach
   different extents and cannot be compared to each other quantitatively.
4. **`structures: 1`.** The scene is one Blast structure, so any per-structure
   behaviour (notably the quiet-skip in T7) is all-or-nothing here. A
   multi-structure scene may behave differently.
5. **Instantaneous vs windowed.** `step_ms` is last-tick; `timings.total_ms` is
   a rolling average; `window_step_ms` is a 60-sample window. Comparing them
   directly is a category error.

**How to challenge any of this:** every claim below is written as
*Claim / Evidence / Assumptions / How to disprove*. If an assumption is wrong,
the claim it supports should be discarded, not patched.

---

## 1. Context: what one tick does

Server-authoritative destruction shooter. The server owns simulation; clients
render and send input. A city is a grid of fractured buildings — thousands of
chunks joined by bonds. Shoot a support and the structure above decides whether
it still stands.

Two physics systems, easily confused:

- **PhysX** (GPU) simulates rigid bodies — chunks flying and piling up.
- **Blast** (NVIDIA, with a CUDA stress solver) decides which **bonds** break
  under load. It is what makes a building fall like a building.

Per tick at 60 Hz (16.67 ms budget), measured under load with one player:

```
player input / movement / hitscan             0.02 ms
PhysX rigid-body step                         9.78 ms   <- "dynamics_ms"
  simulate()  dispatch                        0.007
  fetch: waiting for GPU                      6.43      <- CPU BLOCKED, T1
  fetch: copying results back                 3.59
destruction post_step                        17.48 ms   <- "step_ms"
  Blast beginTick   serial CPU                4.72      <- T6
  Blast solveTick                             3.43      (1.11 of it on GPU)
  Blast endTick     serial CPU                1.66
  readback                                    2.09
  membership diff / filter stamp              0.00      <- T7
  UNATTRIBUTED                                4.06      <- T5
  settle + ingest + host readback             1.03
snapshot encode + fan-out                     0.50 ms
                                             --------
                                        26.79 ms  = 37 Hz
```

`dynamics_ms` + `step_ms` ≈ `total_ms`, so the accounting closes.

---

## 2. Reproducing the measurements

```bash
# 1. Rent a box. direct_port_count >= 256 correlates with working UDP (see §7).
vastai create instance <offer_id> \
  --image ghcr.io/glavin001/vibe-land-server:sha-0a449cb69864 \
  --disk 25 \
  --env '-p 4001:4001 -p 4443:4443 -p 4433:4433/udp \
         -e MATCHES_PER_BOX=1 \
         -e VIBE_CITY_SCENE=fractured-downtown.json \
         -e VIBE_CITY_GRID=1 \
         -e VIBE_PHYSX_PROFILE_FETCH=1' \
  --args

# 2. Confirm it booted and UDP is reachable
vastai logs <instance_id> | grep -E 'reachability|listening'

# 3. Play at https://<ip>:<web_port>/city and demolish

# 4. THE DATA. Do not read the overlay -- it hides fields (see T7).
curl -sk https://<ip>:<web_port>/match-stats/city-default | jq
```

Knobs are read **once at process start**, so every configuration needs a fresh
instance. You cannot retune a running box.

---

## 3. Two measured baselines

Same box, same scene. The only difference is load.

| Field | **Idle** (0 players, settled) | **Loaded** (1 player) |
| --- | ---: | ---: |
| `total_ms.avg` | **20.94** | **26.79** |
| `total_ms.p95` | 23.17 | 29.04 |
| `total_ms.max` | 25.85 | 35.14 |
| `dynamics_ms.avg` | 7.31 | 9.78 |
| `physics_last_step_ms` | 7.00 | 10.03 |
| `physics_simulate_ms` | **0.010** | **0.007** |
| `physics_fetch_ms` | 6.99 | 10.02 |
| `physics_gpu_wait_ms` | **4.71** | **6.43** |
| `physics_fetch_copy_ms` | 2.28 | 3.59 |
| `city.step_ms` | 13.53 | 17.48 |
| `city.stress_solve_ms` | 12.34 | 15.96 |
| `city.begin_ms` | 3.43 | **4.72** |
| `city.solve_ms` | 3.68 | 3.43 |
| `city.end_ms` | **0.0004** | **1.66** |
| `city.readback_ms` | 1.77 | 2.09 |
| `city.events_ms` | **0.0** | **0.0** |
| `city.filters_ms` | **0.0** | **0.0** |
| `city.gpu_stress_solve_ms` | 1.21 | 1.11 |
| unattributed in `stress_solve_ms` | **3.45** | **4.06** |
| `chunk_bodies` | 9,550 | 10,669 |
| `awake_bodies` | 1,420 | 2,126 |
| `frozen_bodies` | 7,795 | 8,175 |
| `sleeping_bodies` | 209 | 209 |
| `pose_quiet_awake_bodies` | **178** | **161** |
| `solver_island_count` | 9,512 | 10,627 |
| `broken_bonds` | 33,794 | 37,964 |
| `freeze_flips` | 46,344 | 49,349 |
| `unfreeze_flips` | 38,395 | 41,018 |
| `contact_wakes` | 33,438 | 35,604 |
| `resettled_wakes` | 74,127 | 80,949 |
| `city_desync_repairs` | 0 | 0 |

**The idle row is the headline.** With **zero players connected** and the rubble
at rest, the server still needs 20.9 ms a tick. It cannot hold 60 Hz doing
nothing.

> **Both columns are probably lower bounds.** `events_ms` and `filters_ms` are
> `0.0` in both, which (per T7) most likely means the quiet-skip gate took the
> cheap path on the sampled tick. Under sustained fracturing that gate cannot
> fire, so real demolition costs **more** than the loaded column shows. Do not
> treat 26.79 ms as the worst case.

**Correctness is not a problem anywhere.** `city_desync_repairs: 0`,
`settle_deferred_penetrating: 0`, `unmapped_body_skips: 0`,
`duplicate_body_records: 0`, and the overlay showed `bonds cli/srv
33,753 / 33,753` — exact agreement at 33.7k broken bonds. Do not "fix" the
netcode.

---

## 4. Measurement caveats — read before trusting anything above

**4.1 `VIBE_PHYSX_PROFILE_FETCH=1` busy-polls a core.**
`physx-bridge/src/physx_bridge.cc:874-887`:

```cpp
if (profile_fetch_) {
  while (!ready) { ready = scene_->fetchResults(false); }   // spin
```

The comment says *"Polling burns a core, so it is opt-in and off by default."*
Both baselines were taken **with it on**. The spin competes with the Blast
serial walks for CPU, so `total_ms` may be inflated and `begin_ms`/`end_ms` may
be pessimistic. **T2 exists to quantify this.**

**4.2 The overlay hides fields.** `events_ms` and `filters_ms` are published in
`/match-stats` but have no row in `client/src/city/CityStatsOverlay.tsx`. Reading
the overlay led to a wrong root-cause hypothesis. Use the JSON.

**4.3 `stress_solve_ms` and `tick_ffi_ms` are *parents*** of the Blast phases —
see the field docs at `server/src/main.rs:261-300`. Never sum them with their
children; you will double-count.

**4.4 Idle and loaded are different regimes.** The quiet-skip gate
(`physx-bridge/src/destruction.cc:1341-1357`) makes idle cheaper in a way that
disappears the moment topology changes.

**4.5 Hand-driven runs are not comparable.** Two demolitions reach different
extents. A 3060 at 10k bonds vs a 5060 Ti at 24k bonds says nothing about
hardware. `server/src/city_bench.rs` is a deterministic harness — *"fixed rays
from fixed points at fixed ticks. No browser, no network, no walking"* — but it
is `#[cfg(test)]` and cannot run on a rented box. Promoting it behind an env var
would make all of this reproducible.

---

## 5. The tasks

### T1 — Overlap CPU work with the GPU wait

**Symptom:** the CPU is blocked 6.43 ms of a 26.79 ms tick — **24% of the frame.**

**Important framing:** during `gpu_wait` the **GPU is busy**; it is the **CPU**
that is idle. This is not "the GPU is oversized" — it is a scheduling problem.

**Evidence:**
```json
"physics_simulate_ms":  0.007,   // dispatch only
"physics_gpu_wait_ms":  6.43,    // CPU blocked here
"physics_fetch_copy_ms": 3.59
```

**Root cause — the API already exists and is unused.**

- `physx-bridge/src/physx_bridge.cc:903-906`
  ```cpp
  void step() { begin_step(); end_step(); }   // fused: no gap to fill
  ```
- `physx-bridge/src/lib.rs:741-742` documents the split:
  *"work before calling `end_step`. Every `begin_step` must be paired with
  exactly one `end_step` before the scene is read or mutated."*
- **The only callers of the split are a benchmark:**
  `physx-bridge/tests/gpu_step_bench.rs:100-101`.
- **Production uses the fused call:** `server/src/physx_runtime.rs:633`
  ```rust
  self.world.step().expect("PhysX GPU simulation step failed");
  ```

**Fix:** in the match loop, call `begin_step()`, do work that does not read the
scene, then `end_step()`. Candidate work — all of it already runs every tick and
none of it needs the new poses:

- snapshot encode / per-client packing (`encode_shared_ms`, `client_datagrams_ms`)
- the 1 Hz stats publish (`publish_ms` 1.26 ms — currently lands on one tick as a spike)
- freeze bookkeeping and the unsupported-frozen sweep
- telemetry writes

**Verify:** `physics_gpu_wait_ms` stays the same (the GPU still takes as long)
while `timings.total_ms.avg` falls by roughly the amount of work you moved.

**Risk (medium):** the contract in `lib.rs:741` is strict — **nothing may read or
mutate the scene between the two calls.** Anything touching body poses,
raycasts, or contacts must stay after `end_step()`. A violation is unlikely to
be caught by a type error; it will surface as corrupted or stale poses.

**Ceiling:** 26.79 → ~20.4 ms if fully overlapped. That is 60 Hz for an idle
city and a large step toward 60 Hz under load.

---

### T2 — Re-baseline without fetch profiling (do this first)

**Why:** §4.1. The spin loop burns a core that the Blast serial walks want.

**Method:** boot two identical instances, one with `VIBE_PHYSX_PROFILE_FETCH=1`
and one with `=0`, run the same demolition, compare `timings.total_ms` and
`city.begin_ms`.

**What it tells you:** with profiling off, `gpu_wait` and `fetch_copy` report
`0.0` (see `physx_bridge.cc:891-892`) and `fetch_ms` is one opaque number — so
you lose the split, but you get the true tick cost. If `total_ms` drops
materially, T1's headroom is smaller than 6.4 ms and the priority order changes.

**Risk:** none. Diagnostic only.

---

### T3 — The city never goes to sleep

**Symptom:** 2,126 bodies awake under load, 1,420 awake **with zero players and
the rubble at rest**. Only **161** are `pose_quiet_awake_bodies`.

So roughly **1,250–1,950 bodies are awake and actively simulated in a city where
nothing is happening.** Every other cost scales off this: PhysX GPU time, the
result copy, the serial walks, readback size.

**Evidence:**
```json
"awake_bodies": 1420,  "pose_quiet_awake_bodies": 178,  "sleeping_bodies": 209,
"frozen_bodies": 7795, "min_body_y": -0.0759
```

**Where to look:** `destruction/src/freeze.rs`. Config defaults at
`freeze.rs:195-225`: `after_ticks: 30`, `pose_ticks: 60`, `shell_m: 0.02`,
`require_supported: true`, `max_penetration_m: 0.015`, `ground_epsilon_m: 0.6`.

**Hypotheses worth testing, in order:**

1. Bodies are jittering just above the freeze threshold and never accumulate
   `after_ticks` at rest. `min_body_y: -0.0759` shows the pile is slightly
   interpenetrating the ground, and `max_penetration_m: 0.015` **refuses to
   freeze an interpenetrating body** — so a pile settled 7.6 cm below ground may
   be structurally unfreezable. This is the single most promising lead.
2. `require_supported: true` — rubble that never proves support never freezes.
   Check `unsupported_resting_bodies` (was `0`, which argues against this).
3. The freeze batch (`batch: 256`/tick) cannot keep up with the wake rate.

**Verify:** `awake_bodies` at idle should fall toward `pose_quiet_awake_bodies`.
Watch `dynamics_ms` and `fetch_copy_ms` fall with it.

**Risk (medium):** freezing bodies that should react makes rubble look glued.
`VIBE_CITY_FREEZE=0` is the kill switch.

---

### T4 — 83% of freezes are undone

**Symptom:**
```json
"freeze_flips": 49349, "unfreeze_flips": 41018,
"contact_wakes": 35604, "resettled_wakes": 80949
```

41,018 of 49,349 freezes get reversed. Each thaw re-adds a body to the
simulation, re-solves it, and re-freezes it.

**The freezer is winning but paying too much:** frozen share climbed 59% → 74%
across the session while `awake_bodies` fell 3,039 → 2,025. So the policy is
correct; the churn is the waste.

**Where to look:** the freeze criteria and the wake criteria in
`destruction/src/freeze.rs` — specifically whether they are consistent. If a
body meets the freeze test and then immediately meets the wake test without
having moved, that is a hysteresis bug, and removing it is **free** — identical
behaviour, less work.

**Knobs that change behaviour (treat as gameplay settings, not free wins):**
`VIBE_CITY_WAKE_ABOVE_M` (2.0), `VIBE_CITY_WAKE_RADIUS_SCALE` (1.0),
`VIBE_CITY_CONTACT_WAKE_RATIO`.

**Verify:** `unfreeze_flips / freeze_flips` should fall well below 0.83 with no
visible change in how rubble reacts to a nearby collapse.

---

### T5 — 4.06 ms unattributed inside `stress_solve_ms`

**Symptom:**
```
stress_solve_ms                        15.96
  begin 4.72 + solve 3.43 + end 1.66
  + readback 2.09 + events 0 + filters 0 = 11.90
  --------------------------------------------
  unattributed                          4.06   (25% of the city step)
```

Idle shows the same shape: 12.34 − 8.89 = **3.45 ms**. It **grows with scale**
(3.45 → 4.06 as islands went 9,512 → 10,627).

**What it is NOT:** the field doc at `server/src/main.rs:269-273` attributes the
gap to *"per-slot dispatch and the topology-diff decision"*. But `events_ms` and
`filters_ms` are both `0.0`, so `collect_events` and `register_filters` are not
in it — see T7.

**Where to look:** `physx-bridge/src/destruction.cc:1133` (`destruction_tick`)
and the per-slot loop through `:1385`. The measured phases are bracketed
individually; the gap is whatever sits between them — per-slot dispatch,
`refresh_shape_snapshots`, `resolve_support_loads()` at `:1396`, and the
telemetry reads.

**Action:** add timers, publish them, then decide. **Do not optimise this
blind** — it is 25% of the city step and nobody currently knows what it is.

**Risk:** none. Instrumentation only.

---

### T6 — `begin_ms` is serial and growing

**Symptom:** the serial injection walk was 1.3 ms at 2,706 islands and is
**4.72 ms at 10,627**. It is now larger than the entire `solve_ms`.

The field doc at `server/src/main.rs:277-279` already flags this:
*"reporting them as one 'stress solve' number hid that the serial injection walk
costs more than the GPU solve."*

**Context — Blast's cost is not where you would guess:**

| | 10k bonds | 33.7k bonds | 38k bonds |
| --- | ---: | ---: | ---: |
| solver islands | 2,706 | 9,512 | 10,627 |
| `solve_ms` (CUDA) | 5.3 | 3.68 | 3.43 |
| `begin_ms` (serial CPU) | 1.3 | 3.43 | 4.72 |

The GPU solve gets **cheaper** as the city pulverises, because the stress solver
works on **intact** bonds and 38,000 of them are gone. The serial walk only
grows. **GPU cost peaks mid-demolition; CPU cost peaks at the end.**

**Where to look:** `beginTick` / `beginTickFromSnapshot` around
`physx-bridge/src/destruction.cc:1167-1240`. The comment at `:1167` notes
*"beginTick() used to be serial because parallelising it segfaulted"* — so
parallelising has been tried. Making it **incremental** (only new/changed
islands) is the alternative and is quality-neutral.

**Risk (medium):** history says parallelising this crashes. Prefer the
incremental approach.

---

### T7 — Are `events_ms`/`filters_ms: 0.0` real? (traced, not proven)

**Why this got scrutiny:** "exactly zero" is the signature of *both* a working
skip and a broken pipe, and the two are indistinguishable from the value alone.
What follows is the trace, so the next person can attack the assumptions rather
than repeat the work.

#### Claim

The zeros are **consistent with the quiet-skip firing** — i.e. most likely
correct — but this is **not proven**, and one decisive test remains unrun.

#### Evidence for the plumbing being sound

1. **Assignment is by name, not by offset.** `destruction.cc:2187-2188` does
   `stats.events_ms = last_events_ms_`. `FfiDestructionStats` is a `cxx` shared
   struct (`physx-bridge/src/lib.rs:1385-1400`), so C++ and Rust layouts are
   generated from one definition. A field-order mismatch is not possible here.
2. **Neighbouring fields assigned in the same block report non-zero.**
   `begin_ms` (4.72), `solve_ms` (3.43), `end_ms` (1.66) and `readback_ms`
   (2.09) are all set on adjacent lines from the identical `last_*_ms_` pattern.
   A broken struct would break those too.
3. **The Rust hop is direct:** `destruction/src/runtime.rs:771,774` copies
   `bridge_stats.events_ms` / `.filters_ms` straight through, and
   `server/src/main.rs:283,333` serialises them.

#### Evidence for the skip being the explanation

Both accumulators live **after** the `continue` in the per-slot loop:

```cpp
// destruction.cc:1355-1357
if (!topology_changed && quiet_skip_enabled()) {
  ++quiet_slot_ticks_;
  continue;                    // <- everything below is skipped
}
...
collect_events(slot);   events_ms  += ms_since(phase);   // :1380
register_filters(slot); filters_ms += ms_since(phase);   // :1384
```

`quiet_skip_enabled()` (`destruction.cc:159-165`) is **on unless
`VIBE_CITY_QUIET_SKIP=0`**, and `structures: 1` means one slot — so a single
quiet structure zeroes both fields for that tick.

In S2 the player was stationary (`vel_ms: [-7.1e-7, -0.5, -5.7e-7]`,
`on_ground: true`), so no new fracture was being caused at the sampled instant.
Topology plausibly *was* quiet.

#### A test I tried that does NOT work — and why

It is tempting to argue: `readback_ms` also accumulates after the `continue`
(`:1366`), so `readback_ms: 2.09` proves the slot was **not** skipped, which
would make the zeros a bug.

**That argument is wrong.** `readback_ms` accumulates in *two* places:

| line | in loop? | conditional? |
| --- | --- | --- |
| `:1194` | own loop at `:1191-1193`, **before** the topology loop | **no — every tick** |
| `:1366` | inside the topology loop | yes — after the `continue` |

So 2.09 ms can come entirely from the unconditional pre-solve pass at `:1194`,
with `:1366` contributing nothing. **No contradiction.** Recorded here because
it looks like a proof and is not.

#### The observability gap — the actual defect

`quiet_slot_ticks_` is incremented at `destruction.cc:1356` and declared at
`destruction.h:286`, but is **never read, never exposed in
`FfiDestructionStats`, never published.** It is the one counter that would
settle this instantly, and nothing can see it.

#### How to disprove the claim (decisive, ~5 minutes)

Boot one instance with the skip disabled:

```
-e VIBE_CITY_QUIET_SKIP=0
```

The `continue` can then never fire, so `collect_events` and `register_filters`
**must** run on every tick for every live slot.

- `events_ms` / `filters_ms` become **non-zero** → plumbing is fine, the zeros
  were the skip working. Claim holds.
- They stay **exactly 0.0** → **plumbing bug.** Start at
  `destruction.cc:1380,1384`, then the `last_*_ms_` assignment at `:1390-1391`,
  then `:2187-2188`.

A weaker but cheaper check: sample `/match-stats` *while actively shooting*
rather than standing still. Non-zero values there also confirm the claim,
though a zero result would be inconclusive.

#### Regardless of outcome — do these

1. **Expose `quiet_slot_ticks_`** in `FfiDestructionStats` and the JSON. Without
   it there is no way to know what fraction of ticks take the cheap path, which
   makes every idle-vs-loaded comparison in §3 partly guesswork.
2. **Add `events_ms` / `filters_ms` rows** to
   `client/src/city/CityStatsOverlay.tsx`. They are already plumbed all the way
   to JSON; the overlay simply has no row. That omission is what sent this
   investigation down a wrong path once already (see Appendix C.3).

#### What this changes about T5

If the skip is firing, then the **4.06 ms unattributed gap is *not* explained by
the membership diff**, and it is also **measured on ticks that took the cheap
path**. Under sustained fracturing — when the skip cannot fire — the true city
step is **higher than 17.48 ms**, and T5's gap may be larger still. §3's loaded
sample is therefore probably a *lower bound* on cost during real demolition.

---

### T8 — `physics_contact_pairs: 0` with 2,126 awake bodies

Almost certainly not populated for the PhysX GPU backend. Several sibling fields
are also suspiciously zero: `dynamic_body_count: 0`, `chunk_count: 0`,
`awake_dynamic_bodies_total: 0`, `dynamic_contacts_raw_per_tick: 0`.

Contact count is the natural driver of both `gpu_wait` and `fetch_copy`, so
without it there is no way to tell whether PhysX cost tracks bodies or contacts.
Worth wiring up before sizing decisions.

---

## 6. Every knob

Read once at process start. **Each combination needs a fresh instance.**

### Scene and scale

| Variable | Default | Effect |
| --- | --- | --- |
| `VIBE_CITY_SCENE` | `high-rise-3f-local.json` | which pack to build |
| `VIBE_CITY_GRID` | `4` | grid edge in buildings (1–16) |
| `VIBE_CITY_VARIED_HEIGHTS` | `1` | truncate towers at varying heights |
| `MATCHES_PER_BOX` | `6` | scenes per box; VRAM scales with this |

| Scene | chunks | bonds | colliders |
| --- | ---: | ---: | --- |
| `fractured-tower` | 204 | 546 | mostly hull |
| `high-rise-3f-local` | 318 | 1,083 | all cuboid |
| `high-rise-10f-local` | 1,032 | 3,624 | all cuboid |
| `fractured-highrise-10f` | 1,096 | 3,451 | 696 box / 400 hull |
| `fractured-district` | 15,918 | 48,670 | 10,478 box / 5,440 hull |
| `fractured-downtown` | 24,105 | 74,543 | 16,945 box / 7,160 hull |

> Hull chunks render as **axis-aligned boxes** client-side, so the two large
> scenes look like interpenetrating slabs even though colliders are correct
> (`server/src/city.rs:118-124`). `high-rise-10f-local` is the largest
> all-cuboid pack.

### Solver — these trade simulation quality for speed

| Variable | Default | Effect | Cost |
| --- | --- | --- | --- |
| `VIBE_CITY_SOLVER_ITERATIONS` | `8` | stress solve iterations | convergence |
| `VIBE_CITY_GRAPH_REDUCTION` | `0` | coarsens the solved graph | structural fidelity |
| `VIBE_CITY_MAX_BODIES` | `0` (unlimited) | hard body cap | **breaks the game** |

**Never use `VIBE_CITY_MAX_BODIES`.** Per `destruction/src/city_config.rs:74-80`,
at the cap the adapter *"drops EVERY further fracture command… presented in play
as an indestructible severed slab"* — with no telemetry.

**Both solver knobs are poor value now.** `gpu_stress_solve_ms` is **1.11 ms**;
halving it wins ~0.5 ms against a 26.8 ms tick. They attack the smallest cost in
the frame.

### Freeze machine — where the real room is

| Variable | Default | Effect |
| --- | --- | --- |
| `VIBE_CITY_FREEZE` | `1` | master switch (`0` = kill) |
| `VIBE_CITY_FREEZE_AFTER_TICKS` | `30` | ticks at rest before freezing |
| `VIBE_CITY_FREEZE_BATCH` | `256` | bodies frozen per tick |
| `VIBE_CITY_FREEZE_POSE` | `1` | pose freezing (merged-pile case) |
| `VIBE_CITY_FREEZE_POSE_TICKS` | `60` | ticks before pose freeze |
| `VIBE_CITY_FREEZE_SHELL_M` | `0.02` | freeze shell thickness |
| `VIBE_CITY_FREEZE_CELL_M` | `4.0` | spatial cell size |
| `VIBE_CITY_FREEZE_SUPPORTED` | `1` | require support before freezing |
| `VIBE_CITY_FREEZE_GROUND_EPSILON_M` | `0.6` | ground contact tolerance |
| `VIBE_CITY_FREEZE_MAX_PENETRATION_M` | `0.015` | never freeze an interpenetrating body — **see T3** |
| `VIBE_CITY_WAKE_ABOVE_M` | `2.0` | wake radius above impact |
| `VIBE_CITY_WAKE_RADIUS_SCALE` | `1.0` | wake radius multiplier |
| `VIBE_CITY_FREEZE_SWEEP_TICKS` | `30` | unsupported-frozen sweep interval |
| `VIBE_CITY_FREEZE_SWEEP_BATCH` | `64` | bodies per sweep |
| `VIBE_CITY_POSE_CENSUS` | `0` | pose census sweeps |

Freezing was defaulted on after measuring *"34% more of the city destroyed while
carrying 57% fewer awake bodies, peak awake 4,041 → 2,591"*
(`destruction/src/freeze.rs:195-201`). It is the most effective thing already in
the tree.

### Diagnostics — no behaviour change

| Variable | Effect |
| --- | --- |
| `VIBE_PHYSX_PROFILE_FETCH=1` | splits `fetch` into `gpu_wait` + `copy` — **burns a core, see T2** |
| `VIBE_CITY_QUIET_SKIP` | `1`. Skips the membership diff when topology did not change (`destruction.cc:159`). Set `0` for the T7 test — **not documented anywhere else** |
| `VIBE_CITY_TELEMETRY=<path>` | per-tick JSONL trace |
| `RUST_LOG` | `info` by default in the image |
| `UDP_VERIFY` / `UDP_WATCHDOG` | boot-time reachability check (`fatal` on Vast) |

### Tuning that does not touch simulation

| Variable | Effect |
| --- | --- |
| `VIBE_CITY_WORLD_BUDGET_MBPS` | egress cap for the city stream |
| `VIBE_CITY_WIRE` | wire protocol version |
| `VIBE_CITY_MAX_EVAL` | encoder evaluation budget |
| `VIBE_PHYSX_GPU_MAX_RIGID_CONTACTS` | PhysX GPU contact buffer |
| `VIBE_PHYSX_GPU_MAX_RIGID_PATCHES` | PhysX GPU patch buffer |
| `VIBE_PHYSX_GPU_HEAP_CAPACITY` | PhysX GPU heap |
| `VIBE_PHYSX_GPU_COLLISION_STACK_SIZE` | PhysX GPU collision stack |
| `VIBE_PHYSX_GPU_FOUND_LOST_PAIRS_CAPACITY` | PhysX found/lost pair capacity |

---

## 7. Sizing and cost

**Budget math.** "60 Hz with 2× headroom" and "120 Hz" are the same number: 8.3 ms.

| Target | Budget | From 26.79 ms (loaded) |
| --- | ---: | ---: |
| 37 Hz — today | 26.79 | — |
| 60 Hz | 16.67 | −10.1 ms |
| 120 Hz | 8.33 | −18.5 ms |

T1 alone is worth up to 6.4 ms. T1 + T3 + T6 plausibly reach 60 Hz under load.
120 Hz at 24k chunks is not credible without T3 landing properly.

**Does a bigger GPU help?** Partly, and my earlier advice here was too
absolute. The GPU is genuinely busy ~6.4 ms per tick doing rigid-body work — a
faster card would cut that. But the **CUDA stress solve is only 1.11 ms**, and
the cheaper fixes (overlap the wait, reduce awake bodies) do not need new
hardware. Land T1–T4 before buying a bigger card.

| Box | $/hr | Note |
| --- | ---: | --- |
| RTX 3060, 12 cores @ 4.3 GHz | **0.061** | current test box |
| RTX 5060 Ti, 16 cores | 0.177 | 2.9× price, not 2.9× throughput |
| RTX 3090 / 4090 | 0.25–0.37 | only worth it if PhysX GPU time is the proven wall |

**Egress is a non-issue.** 0.5–1.24 Mbps per client during full-city demolition
(`bytes_per_sec: 60,021`). Twelve players ≈ 12–15 Mbps.

**VRAM** scales with `MATCHES_PER_BOX`, not city size — PhysX allocates per
scene, one scene per match. A single downtown match fits in 12 GB.

**Picking a host:** `direct_port_count >= 256` strongly predicts working UDP
forwarding — 2/2 working above it, 3/3 failing below (n=5). `datacenter` does
**not** predict it. The image self-tests at boot and exits 78 if the advertised
endpoint is unreachable, so a bad host announces itself in `vastai logs` within
~12 seconds.

---

## Appendix A — raw loaded sample

RTX 3060, `fractured-downtown` `GRID=1`, 1 player connected, `server_tick 478020`.

```json
"physics_last_step_ms": 10.029252, "physics_simulate_ms": 0.007437,
"physics_fetch_ms": 10.020497, "physics_gpu_wait_ms": 6.42858,
"physics_fetch_copy_ms": 3.591889, "physics_active_dynamic_bodies": 2126,
"physics_contact_pairs": 0,

"timings": { "total_ms": { "avg": 26.786127, "p95": 29.036299, "max": 35.14137 },
             "dynamics_ms": { "avg": 9.780339, "p95": 10.493155 },
             "player_sim_ms": { "avg": 0.019819913 },
             "snapshot_ms": { "avg": 0.011661339 } },

"city": { "chunk_bodies": 10669, "awake_bodies": 2126, "frozen_bodies": 8175,
          "sleeping_bodies": 209, "pose_quiet_awake_bodies": 161,
          "solver_island_count": 10627, "broken_bonds": 37964,
          "step_ms": 17.480183, "stress_solve_ms": 15.95949,
          "tick_ffi_ms": 15.960449, "post_step_ms": 17.231041,
          "begin_ms": 4.721424, "solve_ms": 3.433818, "end_ms": 1.65722,
          "readback_ms": 2.09155, "events_ms": 0.0, "filters_ms": 0.0,
          "gpu_stress_solve_ms": 1.111072, "readback_ms_host": 0.368038,
          "settle_ms": 0.410103, "ingest_ms": 0.248407, "publish_ms": 1.2563109,
          "encode_shared_ms": 0.34087703, "client_datagrams_ms": 0.16136499,
          "freeze_flips": 49349, "unfreeze_flips": 41018,
          "contact_wakes": 35604, "resettled_wakes": 80949,
          "overstressed_bonds": 1, "bond_utilisation_max": 1.0150833,
          "min_body_y": -0.07414248, "city_desync_repairs": 0,
          "window_step_ms": { "avg": 16.885843, "p95": 18.61073, "max": 23.139204 },
          "window_awake": { "avg": 2124.3333, "max": 2133.0 } }
```

## Appendix B — raw idle sample

Same box, 0 players, rubble at rest, `server_tick 468840`.

```json
"physics_last_step_ms": 7.002839, "physics_simulate_ms": 0.010154,
"physics_fetch_ms": 6.992151, "physics_gpu_wait_ms": 4.708619,
"physics_fetch_copy_ms": 2.283487, "physics_active_dynamic_bodies": 1420,

"timings": { "total_ms": { "avg": 20.944529, "p95": 23.167759, "max": 25.84773 },
             "dynamics_ms": { "avg": 7.3056884, "p95": 8.306972 } },

"city": { "chunk_bodies": 9550, "awake_bodies": 1420, "frozen_bodies": 7795,
          "sleeping_bodies": 202, "pose_quiet_awake_bodies": 178,
          "solver_island_count": 9512, "broken_bonds": 33794,
          "step_ms": 13.530419, "stress_solve_ms": 12.339091,
          "begin_ms": 3.434572, "solve_ms": 3.681011, "end_ms": 0.000413,
          "readback_ms": 1.770983, "events_ms": 0.0, "filters_ms": 0.0,
          "gpu_stress_solve_ms": 1.21184, "settle_ms": 0.321025,
          "ingest_ms": 0.178026, "publish_ms": 1.094571,
          "freeze_flips": 46344, "unfreeze_flips": 38395,
          "contact_wakes": 33438, "resettled_wakes": 74127,
          "bond_utilisation_max": 0.9847152, "overstressed_bonds": 0,
          "min_body_y": -0.075858146, "city_desync_repairs": 0 }
```

---

## Appendix C — corrections made during this investigation

Kept because each was a plausible reading of partial data, and the correction is
the useful part.

1. **"The 3060 is GPU-bound."** Based on `blast solve` 5.3 ms of a 9.0 ms city
   step at 10k bonds. Wrong: `solve_ms` includes CPU work, and the actual GPU
   portion (`gpu_stress_solve_ms`) is ~1.1 ms.
2. **"Blast solve scales with islands, so a large city will be ~25 Hz."** Wrong:
   the solver works on intact bonds, which *fall* as the city breaks. Measured
   38–39 Hz where 25 was predicted.
3. **"The unattributed gap is `collect_events`/`register_filters`."** Wrong:
   both report `0.0`. The follow-up reasoning ("`readback_ms` is non-zero and
   also sits after the `continue`, so the slot cannot have been skipped") was
   **also wrong** — `readback_ms` has a second, unconditional accumulation site
   at `destruction.cc:1194`. See T7 for the full trace and the decisive test
   that has not yet been run.
4. **"The GPU is idle 4.7 ms per tick."** Imprecise: the **CPU** is idle; the GPU
   is busy. The opportunity is overlap (T1), not a smaller GPU.
