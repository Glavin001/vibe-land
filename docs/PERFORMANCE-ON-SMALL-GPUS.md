# Squeezing a city onto a small GPU

How the server spends a tick, what it costs on a $0.06/hr RTX 3060, and where
the room is — measured, not guessed.

Everything here comes from two sources, and they are labelled throughout:

- **Live `/match-stats` JSON** from a 3060 running `fractured-downtown` at
  `GRID=1`, after a two-player demolition had settled.
- **The in-game overlay** during active demolition on the same box and on an
  RTX 5060 Ti.

Where a number is inferred rather than measured, it says so. Several
conclusions in this document contradict earlier guesses; the corrections are
kept visible on purpose, because the wrong turns are instructive.

---

## 1. What the game is doing, per tick

Vibe-land is a **server-authoritative** destruction shooter. The server owns the
simulation; clients render what they are told and send inputs. A city is a grid
of fractured buildings — thousands of chunks held together by bonds. Shoot a
support and the structure above it has to decide whether it still stands.

One server tick, at a target of 60 Hz (16.67 ms), runs roughly:

```
1. player input, movement, hitscan          ~0.0 ms   (trivial)
2. PhysX rigid-body step  (GPU)              7.0 ms   <- "dynamics"
3. destruction post-step                    13.5 ms   <- "city step"
     a. Blast beginTick   (serial, CPU)      3.4 ms
     b. Blast solveTick   (CUDA)             3.7 ms   (1.2 ms of it on GPU)
     c. Blast endTick     (serial, CPU)      0.0 ms
     d. readback                             1.8 ms
     e. membership diff / filter stamping    0.0 ms   (skipped when quiet)
     f. unaccounted                          3.5 ms
     g. settle policy, encoder ingest        0.5 ms
4. snapshot encode + fan-out                ~0.4 ms
                                            -------
                                       ~20.9 ms  = 48 Hz
```

Two independent physics systems are involved and they are easy to confuse:

- **PhysX** simulates rigid bodies — the chunks flying and piling up.
- **Blast** (NVIDIA's destruction library, with a CUDA stress solver) decides
  which *bonds* break under load. It is what makes buildings fall down like
  buildings rather than exploding into confetti.

---

## 2. The measured baseline

RTX 3060, 12 effective cores @ 4.3 GHz, **$0.061/hr**. City: `fractured-downtown`,
`GRID=1` — 24,105 chunks authored, 9,550 live chunk bodies after demolition.

### At idle — nobody connected, city settled

| Metric | Value |
| --- | --- |
| **tick total avg** | **20.94 ms** |
| tick total p95 | 23.17 ms |
| tick total max | 25.85 ms |
| dynamics (PhysX) | 7.31 ms |
| city step | 13.53 ms |
| player sim | 0.0002 ms |
| snapshot | 0.001 ms |

> **This is the single most important number in the document.** With **zero
> players connected** and the rubble at rest, the server still cannot hold
> 60 Hz. The city costs 20.9 ms a tick to do *nothing*.

### Under active demolition (overlay, same box)

| Metric | Value |
| --- | --- |
| tick avg | 18.5 → 25.6 ms |
| effective hz | 54 → 38 |
| broken bonds | 9,945 → 33,701 |
| solver islands | 2,706 → 9,381 |
| bodies | 2,808 → 9,514 |

Bonds `33,753 / 33,753` between client and server, `desync repairs 0`,
`settle rejects 0`. **The netcode is exact at 33.7k broken bonds** — correctness
is not the problem anywhere in this document.

---

## 3. Five findings that change the picture

### 3.1 PhysX is not computing — it is *waiting*

```json
"physics_last_step_ms": 7.00,
"physics_simulate_ms":  0.010,
"physics_fetch_ms":     6.99,
"physics_gpu_wait_ms":  4.71,
"physics_fetch_copy_ms": 2.28
```

`simulate` — dispatching the work — is **10 microseconds**. The entire 7 ms is
`fetch`: **4.71 ms blocked waiting on the GPU**, then 2.28 ms copying results
back.

The code comment on that field says it plainly: *"A large `gpu_wait` is dead
time the tick could be spending on encode."* Right now the server sits idle for
4.7 ms of every 20.9 ms tick — **22% of the frame, doing nothing at all.**

That is not a physics cost. It is a scheduling cost, and it is free to recover.

### 3.2 The GPU stress solve is tiny

```json
"solve_ms":            3.68,
"gpu_stress_solve_ms": 1.21
```

The CUDA stress solve — the thing a bigger GPU would accelerate — is **1.21 ms**.
The other 2.47 ms of `solve_ms` is CPU work around it.

**A faster GPU buys you almost nothing.** This is the central sizing conclusion,
and it is why a 3060 at $0.061/hr is a sensible host and a 4090 is not.

> **Correction:** earlier in this investigation I concluded from a small-scale
> sample that the 3060 was GPU-bound, because `blast solve` was 5.3 ms of a
> 9.0 ms city step. That was wrong twice over. `blast solve` includes CPU work,
> and it does not scale the way I assumed — see 3.4.

### 3.3 The city never goes to sleep

```json
"chunk_bodies": 9550,
"awake_bodies": 1420,
"frozen_bodies": 7795,
"sleeping_bodies": 202,
"pose_quiet_awake_bodies": 178
```

At idle, **1,420 bodies are still awake** — and only 178 of them are "pose
quiet". Roughly 1,240 bodies are awake and genuinely being simulated in a city
where nothing is happening.

That is the root of the idle cost. Every downstream number — PhysX step, the
serial walks, readback size — scales with this.

### 3.4 The freeze machine is winning, expensively

```json
"freeze_flips":     46344,
"unfreeze_flips":   38395,
"contact_wakes":    33438,
"resettled_wakes":  74127
```

**83% of freezes get undone.** 74,127 resettled wakes. The freezer *is* working —
frozen share climbed 59% → 74% during the session while awake bodies fell from
3,039 to 2,025 — but it is paying enormous overhead to get there.

Each thaw means re-adding a body to the simulation, re-solving it, and
re-freezing it. If a meaningful share of those 38,395 unfreezes are spurious —
freeze and wake criteria disagreeing rather than genuine re-motion — that work
is pure waste with no behavioural difference.

### 3.5 Blast's cost is in the serial walk, not the solve

| | 10k bonds | 33.7k bonds |
| --- | --- | --- |
| solver islands | 2,706 | 9,381 |
| `blast solve` (CUDA) | 5.3 ms | **3.7 ms** |
| `blast begin` (serial CPU) | 1.3 ms | **4.0 ms** |

3.5× more islands and the GPU solve got *cheaper*, while the serial injection
walk **tripled**.

The reason is structural: the stress solver works on **intact** bonds. Break
33,701 of them and there is less left to solve. **GPU cost peaks mid-demolition
and falls as the city pulverises.** Meanwhile the serial per-island work only
ever grows.

This is why a linear extrapolation from a partial demolition was wrong: it
predicted ~25 Hz at 24k bonds; the box actually delivered 38–39 Hz at 33.7k.

---

## 4. Every knob, and what it actually costs you

All are environment variables read **once at process start**. On Vast that means
**each combination needs a fresh instance** — you cannot retune a running box.

### Scene and scale — the blunt instruments

| Variable | Default | Effect | Cost to you |
| --- | --- | --- | --- |
| `VIBE_CITY_SCENE` | `high-rise-3f-local.json` | which pack to build | content |
| `VIBE_CITY_GRID` | `4` | grid edge in buildings (1–16) | content |
| `VIBE_CITY_VARIED_HEIGHTS` | `1` | truncate towers at varying heights | content |
| `MATCHES_PER_BOX` | `6` | scenes per box; VRAM scales with this | capacity |

Scene sizes, measured from the packs:

| Scene | chunks | bonds | colliders |
| --- | --- | --- | --- |
| `fractured-tower` | 204 | 546 | mostly hull |
| `high-rise-3f-local` | 318 | 1,083 | all cuboid |
| `high-rise-10f-local` | 1,032 | 3,624 | all cuboid |
| `fractured-highrise-10f` | 1,096 | 3,451 | 696 box / 400 hull |
| `fractured-district` | 15,918 | 48,670 | 10,478 box / 5,440 hull |
| `fractured-downtown` | 24,105 | 74,543 | 16,945 box / 7,160 hull |

> Hull chunks render as **axis-aligned boxes** on the client, so the two large
> scenes look like interpenetrating slabs even though the colliders are correct
> (`server/src/city.rs:118`). `high-rise-10f-local` is the largest all-cuboid
> pack and the honest choice for scaling up.

### Solver — buys speed by degrading the simulation

| Variable | Default | Effect | Cost to you |
| --- | --- | --- | --- |
| `VIBE_CITY_SOLVER_ITERATIONS` | `8` | stress solve iterations | **convergence** |
| `VIBE_CITY_GRAPH_REDUCTION` | `0` | coarsens the solved graph | **structural fidelity** |
| `VIBE_CITY_MAX_BODIES` | `0` (unlimited) | hard body cap | **breaks the game** |

**Do not use `VIBE_CITY_MAX_BODIES`.** At the cap the adapter "drops EVERY
further fracture command… presented in play as an indestructible severed slab",
with no telemetry. It buys frames by silently making buildings unbreakable.

The other two are legitimate but they are *quality trades*, and at 8 iterations
and no graph reduction the current settings are already modest. Given the GPU
solve is only 1.21 ms, **there is very little to win here anyway** — these knobs
attack the smallest cost in the tick.

### Freeze machine — the interesting ones

| Variable | Default | Effect |
| --- | --- | --- |
| `VIBE_CITY_FREEZE` | `1` | master switch (kill switch is `0`) |
| `VIBE_CITY_FREEZE_AFTER_TICKS` | `30` | ticks at rest before freezing |
| `VIBE_CITY_FREEZE_BATCH` | `256` | bodies frozen per tick |
| `VIBE_CITY_FREEZE_POSE` | `1` | pose freezing (the merged-pile case) |
| `VIBE_CITY_FREEZE_POSE_TICKS` | `60` | ticks before pose freeze |
| `VIBE_CITY_FREEZE_SHELL_M` | `0.02` | freeze shell thickness |
| `VIBE_CITY_FREEZE_CELL_M` | `4.0` | spatial cell size |
| `VIBE_CITY_FREEZE_SUPPORTED` | `1` | require support before freezing |
| `VIBE_CITY_FREEZE_GROUND_EPSILON_M` | `0.6` | ground contact tolerance |
| `VIBE_CITY_FREEZE_MAX_PENETRATION_M` | `0.015` | never freeze an interpenetrating body |
| `VIBE_CITY_WAKE_ABOVE_M` | `2.0` | wake radius above impact |
| `VIBE_CITY_WAKE_RADIUS_SCALE` | `1.0` | wake radius multiplier |
| `VIBE_CITY_FREEZE_SWEEP_TICKS` | `30` | unsupported-frozen sweep interval |
| `VIBE_CITY_FREEZE_SWEEP_BATCH` | `64` | bodies per sweep |

Freezing was turned on by default after measuring *"34% more of the city
destroyed while carrying 57% fewer awake bodies, peak awake 4,041 → 2,591"*. It
is the single most effective thing already in the codebase.

The wake knobs (`WAKE_ABOVE_M`, `WAKE_RADIUS_SCALE`) are the levers on the 83%
churn — but tightening them **changes behaviour**: rubble that should react to a
nearby collapse might not. Treat them as gameplay settings, not free wins.

### Diagnostics — free, no behaviour change

| Variable | Effect |
| --- | --- |
| `VIBE_PHYSX_PROFILE_FETCH=1` | splits `fetch` into `gpu_wait` + `copy` — **how §3.1 was found** |
| `VIBE_CITY_TELEMETRY=<path>` | per-tick JSONL trace |
| `VIBE_CITY_POSE_CENSUS=1` | pose census sweeps |
| `RUST_LOG=info` | the log stream (default `info` since the image sets it) |
| `UDP_VERIFY` / `UDP_WATCHDOG` | boot-time reachability check |

### Tuning that does not touch the simulation

| Variable | Default | Effect |
| --- | --- | --- |
| `VIBE_CITY_WORLD_BUDGET_MBPS` | — | egress cap for the city stream |
| `VIBE_CITY_WIRE` | — | wire protocol version |
| `VIBE_CITY_MAX_EVAL` | — | encoder evaluation budget |
| `VIBE_PHYSX_GPU_MAX_RIGID_CONTACTS` | — | PhysX GPU contact buffer |
| `VIBE_PHYSX_GPU_HEAP_CAPACITY` | — | PhysX GPU heap |
| `VIBE_PHYSX_GPU_COLLISION_STACK_SIZE` | — | PhysX GPU collision stack |

---

## 5. Where the room actually is

Ranked by value, and separated by whether they cost you any simulation quality.

### Quality-neutral — identical physics, identical wire output

**A. Overlap the 4.71 ms GPU wait. (Biggest single win.)**

22% of every tick is the CPU blocked on `fetch`, doing nothing. Snapshot encode,
settle policy, freeze bookkeeping and telemetry all have to happen anyway and
none of them need the new poses. Doing them *during* the wait rather than after
recovers up to ~4.7 ms with **no behavioural change whatsoever**. The code
comment already names this as the intended use of the measurement.

Ceiling: 20.9 → ~16.2 ms. That alone gets an idle city to 60 Hz.

**B. Get the city to actually settle.**

1,420 awake bodies at idle, only 178 pose-quiet. Every other cost scales with
this number. Whatever is keeping ~1,240 bodies awake in a static pile is worth
finding, and settled rubble being asleep is not a quality trade — it is the
correct behaviour.

**C. Kill the spurious thaws.**

83% of freezes undone, 74,127 resettled wakes. To the extent those are
hysteresis artefacts rather than real motion, removing them is free. Needs
investigation before tuning: the fix is in the criteria agreeing with each
other, not in the thresholds.

**D. Attribute the 3.46 ms gap.**

```
stress_solve_ms                12.34
  begin + solve + end + readback 8.88
  ------------------------------------
  unaccounted                    3.46
```

`events_ms` and `filters_ms` are both `0.0` in this sample — the quiet-skip gate
fires when topology stops changing, so at idle the membership diff and filter
stamping cost nothing. **That means the 3.46 ms is something else**, and nothing
currently measures it. It is 17% of the tick. Instrument it before optimising
it.

> These two fields are measured in C++ and published in `/match-stats`, but are
> **not rendered in the overlay** — which is why this gap looked like
> `collect_events`/`register_filters` until the JSON disproved it. Adding two
> rows to `CityStatsOverlay.tsx` would close that blind spot.

**E. Delta the serial injection walk.**

`begin_ms` 3.4 ms and growing (1.3 → 4.0 ms as islands went 2.7k → 9.4k). Serial,
single-threaded, and per-island. Parallelising or making it incremental is
mechanical work with no simulation impact.

### Quality-costing — available, but you are paying in fidelity

- `VIBE_CITY_SOLVER_ITERATIONS` 8 → 4: attacks a 1.2 ms GPU cost. Poor value.
- `VIBE_CITY_GRAPH_REDUCTION` 0 → 1+: cuts island count, which drives the *real*
  costs — but throws away the structural detail the GPU is there to resolve.
- Smaller scene: `high-rise-10f-local` at `GRID=4` ≈ 16.5k chunks, all-cuboid,
  renders correctly. Roughly half the cost for zero engineering.

---

## 6. The budget math

Target for "60 Hz with real headroom" is the same number as 120 Hz: **8.3 ms**.

| Target | Tick budget | From 20.9 ms |
| --- | --- | --- |
| 48 Hz (today, idle) | 20.9 ms | — |
| 60 Hz | 16.7 ms | −4.2 ms |
| 60 Hz with 2× headroom | 8.3 ms | −12.6 ms |

- **60 Hz idle** is reachable with opportunity **A** alone.
- **60 Hz under load** needs A plus progress on B/C, since load adds the
  membership diff and filter stamping that idle skips.
- **120 Hz at 24k chunks** needs A + B + C + E together, and is not obviously
  reachable without the settle problem being solved properly.
- **120 Hz at ~12k chunks** looks achievable with A and B.

---

## 7. How to measure without fooling yourself

Every wrong conclusion in this investigation came from a measurement problem,
not a reasoning problem.

1. **Hand-driven runs are not comparable.** Two demolitions differ in how far
   they got, so per-unit ratios drift. A 3060 at 10k bonds versus a 5060 Ti at
   24k bonds says nothing about the hardware.
2. **The overlay hides fields.** `events_ms` and `filters_ms` are published but
   not rendered. Prefer `/match-stats/<id>` — it has everything.
3. **Idle and loaded are different regimes.** The quiet-skip gate makes idle
   cheaper in a way that vanishes the moment topology starts changing.
4. **Watch what parents what.** `stress_solve_ms` and `tick_ffi_ms` are both
   *parents* of the Blast phases. Summing them with their children double-counts.
5. **`gl.render` on the client is CPU submission time, not GPU execution.** A
   client can be GPU-bound while `gl.render` reads 0.4 ms; the cost lands in
   `off-frame` instead.
6. **`VIBE_PHYSX_PROFILE_FETCH=1` should be on for any perf run.** Without it,
   `fetch` is one opaque 7 ms number and the 4.71 ms of dead time is invisible.

The fix for (1) is a scripted, deterministic demolition. `server/src/city_bench.rs`
already is one — *"fixed rays from fixed points at fixed ticks. No browser, no
network, no walking"* — but it is `#[cfg(test)]`, so it cannot run on a rented
box. Promoting it into the shipped binary behind an env var would make every
comparison in this document reproducible.

---

## 8. Sizing and cost

| Box | $/hr | Verdict |
| --- | --- | --- |
| RTX 3060, 12 cores @ 4.3 GHz | **0.061** | **Right choice.** GPU work is ~1.2 ms |
| RTX 5060 Ti, 16 cores | 0.177 | 2.9× the price, not 2.9× the throughput |
| RTX 3090 / 4090 | 0.25–0.37 | Paying for a GPU that is idle 4.7 ms per tick |

**Egress is a non-issue.** 1.0–1.24 Mbps per client during a full-city
demolition; twelve players ≈ 12–15 Mbps.

**VRAM** scales with `MATCHES_PER_BOX`, not city size — PhysX allocates per
scene and there is one scene per match. A single downtown match fits
comfortably in 12 GB.

What to look for in an offer:

- `direct_port_count >= 256` — **strongly correlated with working UDP
  forwarding** (2/2 working, 3/3 failing below it, n=5). `datacenter` does *not*
  predict it.
- High CPU clock — the serial walks are single-threaded.
- Any CUDA GPU with compute capability ≥ 7.0. The image ships cubins for
  sm_70 through sm_120.

---

## Appendix: raw baseline

RTX 3060, `fractured-downtown` `GRID=1`, idle after a two-player demolition.

```json
"physics_last_step_ms": 7.002839,
"physics_simulate_ms":  0.010154,
"physics_fetch_ms":     6.992151,
"physics_gpu_wait_ms":  4.708619,
"physics_fetch_copy_ms": 2.283487,
"physics_active_dynamic_bodies": 1420,

"timings": { "total_ms": { "avg": 20.944529, "p95": 23.167759, "max": 25.84773 },
             "dynamics_ms": { "avg": 7.3056884, "p95": 8.306972 } },

"city": { "chunk_bodies": 9550, "awake_bodies": 1420, "frozen_bodies": 7795,
          "sleeping_bodies": 202, "pose_quiet_awake_bodies": 178,
          "solver_island_count": 9512, "broken_bonds": 33794,
          "step_ms": 13.530419, "stress_solve_ms": 12.339091,
          "begin_ms": 3.434572, "solve_ms": 3.681011, "end_ms": 0.000413,
          "readback_ms": 1.770983, "events_ms": 0.0, "filters_ms": 0.0,
          "gpu_stress_solve_ms": 1.21184,
          "settle_ms": 0.321025, "ingest_ms": 0.178026, "publish_ms": 1.094571,
          "freeze_flips": 46344, "unfreeze_flips": 38395,
          "contact_wakes": 33438, "resettled_wakes": 74127,
          "bond_utilisation_max": 0.9847152, "overstressed_bonds": 0,
          "city_desync_repairs": 0 }
```
