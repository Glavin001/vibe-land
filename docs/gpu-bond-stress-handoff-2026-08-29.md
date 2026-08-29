# Handoff: port `updateBondStress` to a CUDA kernel

You are picking up a performance campaign on a destructible-city FPS. This
document is self-contained. Read it end to end before touching anything —
several of the obvious ideas here have already been tried and refuted with
measurements, and repeating them costs a day each.

---

# 1. The system, and where you are

**Two repos, both on branch `perf/rubble-field-60hz`, both clean:**

| repo | role | HEAD |
|---|---|---|
| `/root/workspace/blast-stress-solver-2` | NVIDIA Blast fork: the stress solver library (CPU + CUDA) | `ca429f43` |
| `/root/workspace/vibe-land-4` | Rust game server + C++ PhysX bridge that drives it | `8fa9834` |

The library is consumed by path, not by version — see
`vibe-land-4/destruction/Cargo.toml` (`blast-stress-solver` points at
`/root/workspace/blast-stress-solver-2/blast/blast-stress-solver-rs`). Editing
the library and rebuilding the server picks it up.

**Build (always these features — see trap 1):**
```bash
cd /root/workspace/vibe-land-4
touch physx-bridge/src/lib.rs   # forces .cc/.cu recompile — see trap 2
cargo build --release -p web-fps-server --features cuda-stress,blast-core
```

**Runtime env** (`LD_LIBRARY_PATH` for PhysX) is set for you by
`scripts/perf/profile.sh`; if you invoke the trace binary by hand, copy the
exports from that script.

**Live server:** `https://209.121.195.117:40617/city`, deployed via
`scripts/deploy-when-idle.sh` (waits for players to leave; does NOT rebuild —
build first). Currently stopped. Local health: `https://127.0.0.1:8384/healthz`.

---

# 2. The target

`SupportGraphProcessor::updateBondStress`, in
`blast-stress-solver-2/blast/source/sdk/extensions/stress/NvBlastExtStressSolver.cpp`
(line ~1914; the real work is `processBondGroup`, line ~1761).

It is **the largest single cost in the tick**: 11–15 ms summed across the four
structures on every live report, ~4.7–6.5 ms of tick wall after the 2.2–3.1×
slot concurrency. At grid 2 the scene is 86,966 chunks / 267,992 bonds.

**It is linear in TOTAL live bonds, not in activity** — 15.15 ms of an 18.33 ms
Blast tick even at 1,501 awake bodies. Halving awake bodies does not move it.
That is why it dominates and why activity-based tricks (below) failed.

Measured scaling: 2.41 ms at 74.5k bonds, 9.90 ms at 268k — 4.10× for 3.60×.

---

# 3. What it computes (this is the port spec)

Per **solver bond group** (a group aggregates 1–4 blast bonds):

1. **Skip test** — group's impulses unchanged AND not overstressed → return
2. **Gather** — per blast bond: `health`, asset `normal`, asset `centroid`,
   both endpoint node positions
3. **Segmented reduce** (segment = group), area-weighted by `health`:
   `totalArea`, `bondNormal`, `bondCentroid`, `averageNodeDisp`
4. **Map** — `bondNormal.normalizeSafe()`; `bondCentroid /= totalArea`;
   `averageNodeDisp /= totalArea`
5. **Stress** — `calcSolverBondStresses(...)` (line ~897):
   ```
   stressNormal  = (impulseLinear · n) / area
   stressShear   = sqrt(|impulseLinear|² − (impulseLinear·n)²) / area
   twist         = |impulseAngular · n| / area
   bend          = sqrt(|impulseAngular|² − (impulseAngular·n)²) / area
   stressShear  += twist · 2 / nodeDist
   stressNormal += copysign(bend · 2 / nodeDist, stressNormal)
   ```
6. **Threshold + emit** — per blast bond, against *its own* material:
   - overstressed → `++count`, `m_groupOverstressed[i]=1`,
     `m_nodeOverstressed[node0]=1`, `m_nodeOverstressed[node1]=1`
   - write `bond.stressNormal`, `bond.stressShear`, `bond.normal`,
     `bond.centroid`
   - `health <= 0` → append blast bond index to the removal list

Steps 2–5 are pure functions of read-only data, no cross-group dependency.

**Write hazards, in order of danger:**
- `bondIndicesToRemove` — **ORDER-SENSITIVE.** Removal order feeds back into
  topology, so "same set" is not sufficient. The serial walk emits ascending
  by group then by blast bond within group. Any parallel version must
  reproduce that exact sequence.
- `m_overstressedBondCount` — a sum; any reduction works.
- `m_nodeOverstressed[]` — set-to-1 only, so concurrent writes agree.
- per-bond stress writes — disjoint across groups (a blast bond belongs to
  exactly one group).

---

# 4. Two findings that shape the port

## 4.1 The stress formula is duplicated verbatim, and only one copy runs

`applyStressDamage` (device kernel,
`blast/source/sdk/extensions/stressgpu/NvBlastExtStressGpu.cu` line 1149)
implements the **same six-line formula** as the host `calcSolverBondStresses`,
term for term.

**But `params.applyDamage` is set true ONLY in the two test harnesses**
(`stressgpu/test/gpu_solve_bench.cpp:174`,
`stressgpu/test/gpu_settled_skip_test.cpp:176`) — **never in production.** In
the live game the GPU solver computes impulses and stops; all damage decisions
come from the host walk feeding `ExtStressSolverImpl::generateStressDamage`
(line ~3476, called from line ~3568).

So: no double-damage, nothing redundant to delete — but one equation with two
implementations, only one of which production exercises.

**Do this first (step 1 below):** collapse them into a single
`__host__ __device__` inline used by both. Pure refactor, gated by the
equivalence harness, and it makes the kernel a much smaller diff.

## 4.2 The device's inputs are NOT the host's — do not reuse them blindly

| | area | normal | nodeDist |
|---|---|---|---|
| host | **live**: Σ `health` over the group, recomputed every tick | area-weighted mean of asset normals | ‖area-weighted mean node displacement‖ |
| device (`m_areas`, `m_normals`, `m_nodeDistances`) | **static**: uploaded once in `uploadTopology()` (line ~2774), never refreshed — verified, only alloc/free/upload/kernel-arg sites exist | static | static |

`health` **is** remaining area ("the current health of a bond is the effective
area remaining"). So as a bond takes damage the host's area shrinks and its
stress rises — same force over less section, correct physics — while the
device's would not. **The host model is the correct one.** The new kernel must
compute area from live health, not read `m_areas`.

---

# 5. What has already been tried and REFUTED — do not repeat

Each was measured, not guessed. Details live in the commit messages named.

| attempt | result | why it failed |
|---|---|---|
| **Skip unchanged groups** (`BLAST_SKIP_UNCHANGED_BOND_STRESS`, lib `19aa5114`) | −6.4% of 1.1 ms = **0.07 ms**. Permanently default OFF. | During demolition 41–98% of groups genuinely re-solve. The settled fraction is smallest exactly when the walk costs most. |
| **Parallel walk inside each slot** (`BLAST_BOND_STRESS_PARALLEL`, lib `df290519`) | −51% at grid **1** only. Opt-in. | At grid 2 the dispatch arrives nested inside a slot-fan-out worker; re-entering that pool **deadlocks** it, so it runs inline there. |
| **Second thread pool + mutex** (vl4 `ae16a17`) | **~2× WORSE** at rest: solve 6.31 vs 2.98 ms. | Mutex converts slot parallelism into serialisation; a second pool of 31 threads beside the first oversubscribes a 32-core box 2:1. |
| **Flat (slot × strip) fan-out** (vl4 `8fa9834`, lib `ca429f43`) | **+44.9%** on solve at rest. Default OFF. | 3 dispatches instead of 1. Priced the barrier: **1.009 ms per dispatch**. |
| **Settle assist** (fewer awake bodies) (`VIBE_CITY_SETTLE_ASSIST`) | 17% **worse** settling. Off. | `setSleepThreshold` is a property write that wakes the actor, exactly as piles form. |

**The load-bearing conclusion:** `StressExecutor`'s barrier costs ~1.01 ms.
All 31 workers wait on one condvar behind one mutex, and take that mutex again
to decrement the done-counter — ~62 serialised lock acquisitions per dispatch
(`vibe-land-4/physx-bridge/src/destruction.cc`, ctor line ~1483, `run` ~1499).
A good pool barrier is 5–20 µs; this is 50–100× too slow. **No CPU fan-out
topology can win until that is fixed**, which is why the answer is the GPU.

---

# 6. What to build

## Step 1 — Unify the formula (do this first, it is small and de-risks the rest)
Extract the six-line stress calculation into one `__host__ __device__` inline
(suggest a new small header under `blast/source/sdk/extensions/stressgpu/` or
alongside `calcSolverBondStresses`). Use it from both `applyStressDamage` and
the host path. Gate: equivalence harness must still print
`357/357/357 broken, 333/333 damaged`.

## Step 2 — Device residency
Already on device: impulses, `health`, materials, static normals/centroids.
Add, rebuilt **only on topology change** (hook `applyTopologyChange`/
`uploadTopology` in `NvBlastExtStressGpu.cu`):
- group CSR: `groupBegin[numGroups+1]`, `groupBlastBond[]`
- per-blast-bond material index
- per-blast-bond asset normal + centroid (if not already resident)

Per tick: node positions (they move). Everything else is static.

## Step 3 — The kernel
One block per group with a warp-level segmented reduction (groups are 1–4
bonds, so a shared-memory tree is overkill). If profiling shows tiny segments
dominating launch cost, fall back to one thread per group — **measure, don't
assume**.

Outputs, sized to what the host actually needs back:
- `stressNormal[]`/`stressShear[]` — **stay on device**; copy back only when
  `getBondStress` is called (diagnostics/fracture queries), not every tick
- `nodeOverstressed[]` — 87 KB bitmask, one copy back per tick (the E1
  fracture walk needs it)
- overstressed count — device integer atomic (deterministic)
- removal list — `cub::DeviceSelect::Flagged` to compact, then **sort by
  index** to restore the serial ascending order (§3 hazard #1). `cub` is
  already a dependency; see the existing use in `NvBlastExtStressGpu.cu`.

This also removes the impulse copy-back that exists *only* to feed this loop.

## Step 4 — Flags
`BLAST_BOND_STRESS_GPU` (default **OFF**) and
`BLAST_BOND_STRESS_GPU_VERIFY` (dual-run audit). Follow the existing pattern
— e.g. `flatBondlessFlags()` in
`blast/source/sdk/extensions/stressphysx/NvBlastExtStressPhysX.cpp`.

## Step 5 — The audit (non-negotiable; see §7)
Under `..._GPU_VERIFY=1`, run **both** paths per tick on identical inputs and
compare: removal list **element by element in order**, overstressed count, and
the node mask. Accumulate `checks`/`mismatches` into `ExtStressPhysXTelemetry`
with **explicit `{0}` initialisers**, plumb to spans, and read them in the
trace CSV. Copy the shape of the existing
`bondStressParallelChecks/Mismatches` (lib `3a62843d`).

Require **≥10⁸ checks, 0 mismatches, at grid 1 AND grid 2**. Zero *checks* is
inconclusive, not a pass.

## Step 6 — Determinism expectation
A warp reduction has a fixed tree, so it is reproducible run-to-run, but it
will **not** be bit-identical to the host's sequential float sum. That is the
same equivalence class as the existing GPU-vs-CPU solver difference. The gate
is the harness's **per-tick broken-bond identity**, not `memcmp`.

---

# 7. Method — this is what made the difference all session

**Audit before flipping any default.** Every broad gate (equivalence harness,
13 bridge tests, 11-scenario suite) passed on a change that had a **0.0975%**
divergence; only a purpose-built dual-run predicate audit caught it (lib
`b405b21a`). Perf numbers plus green gates are not sufficient evidence.

**Use the at-rest control for anything threading-related.** Loaded A/B arms
diverge — one run broke 25.2k bonds, the other 30.8k, which manufactured a
fake "−24% win". At rest (`--shots 0`) both arms have identical scene state.
Normalising per live bond is not enough: it left two control columns
contradicting each other (`support` +1.7% = comparable, `gpu_solve` −51.8% =
impossible for a CPU change).

**Match A/B arms and alternate reps.** Unbalanced arms once reported −24.7%
where the balanced answer was −11.7%.

**`max` does not decompose.** A parent's worst tick and a child's worst tick
are different ticks. `dist.py` computes shares from **sums**; quantiles beside
them are shape only.

**`~`-marked columns are sampled or ring-smoothed** — fine for a 1 Hz report,
wrong per-tick, never valid as a per-unit denominator (`dist.py` raises).

---

# 8. Tooling

```bash
cd /root/workspace/vibe-land-4
scripts/perf/profile.sh                  # full grid-2 hierarchical budget
scripts/perf/profile.sh --quick          # grid 1, 25 s, ~40 s total — use for "did it move?"
scripts/perf/profile.sh --idle           # AT REST: the clean control
scripts/perf/profile.sh --reuse X.csv    # re-analyse without re-running
scripts/perf/profile.sh --ab A.csv B.csv # matched-n comparison
```
`profile.sh` refuses to run while the vl4 server is up (it holds a CUDA
context; tracing beside it inflated the tail 60×). It sets the physics env,
builds with the right features, and excludes ring warm-up.

`hw_bond` is the column this work must move. Note it currently reads ~0 on the
**flat** path because the split moved the walk outside the timers inside
`GraphProcessor::solve` — fix that span before trusting it there.

---

# 9. Gates (server stopped for all of these)

```bash
# library equivalence — expect 357/357/357 broken, 333/333 damaged
cd /root/workspace/blast-stress-solver-2
bash blast/source/sdk/extensions/stressgpu/test/build_and_run.sh

# bridge — 13/13
cd /root/workspace/vibe-land-4
cargo test -p vibe-land-physx-bridge --release \
  --features vibe-land-physx-bridge/cuda-stress \
  --test destruction_smoke --test freeze_wake_semantics --test timing_consistency

# scene gates
bash scripts/check-at-rest.sh      # must be 0 bonds broken
bash scripts/scenario-suite.sh     # 11/11
```
`freeze_wake_semantics` is the canary for contact/pair delivery — if you break
how bonds or contacts reach consumers, it fails first.

---

# 10. Traps that have each cost real time

1. **`--features cuda-stress,blast-core`.** Building with plain `destruction`
   silently uses the CPU solver, whose residual makes the city destroy itself
   at rest. A guard now hard-fails the trace binary, but respect it.
2. **`.cu`/`.cc` edits are silently skipped.** `touch physx-bridge/src/lib.rs`
   and verify the `.o` mtime moved.
3. **Grid-2 runs need ≥900 s timeouts.** A 560 s cap has masqueraded as both a
   hang and a pass in this session.
4. **Never bench while the server serves.** GPU contention; `profile.sh`
   enforces it, manual runs don't.
5. **Uninitialised telemetry counters.** `ExtStressPhysXTelemetry` is declared
   without an initialiser; a field without `{0}` reads garbage. One audit
   reported `4.5e18 checks — MISMATCH` for exactly this reason.
6. **Two classes in `NvBlastExtStressSolver.cpp` share method names**
   (e.g. `calcError` at both 632 and 1175). `grep -n` before anchoring an edit
   — landing in the wrong class has happened three times.

---

# 11. Current budget (grid 2, 3–6k awake) — what "success" changes

| | ms | share |
|---|---|---|
| stress_solve | 15.2 | 42.7% |
| — **hw_bond (this work)** | **10.9 sum** | **30.7%** |
| — solve wall | 7.0 | 2.30× slot concurrency |
| — — gpu kernel | 1.6 | concurrent w/ host |
| cb_drain (deferred contacts) | 5.4 | 15.3% |
| gpu_wait (PhysX's own sim) | ~10 | — |

A successful port should take `hw_bond` from ~10.9 ms summed to well under
1 ms, i.e. roughly **−4 to −6 ms of tick wall** at cascade — the difference
between ~28 Hz and ~35 Hz at 5k awake.

`gpu_wait` is PhysX's own rigid-body sim: not reducible except by having fewer
awake bodies, and both known levers for that are refuted (§5).

---

# 12. After this, in priority order

1. **Fix the `StressExecutor` barrier** (~1.01 ms/dispatch, §5). Spin-then-park
   with an atomic join counter instead of condvar + mutex. Contained, no
   physics risk, verifiable with the at-rest control, and it also taxes
   `support_loads` (2.6 ms) and every future fan-out.
2. **N2 — drain classify/ingest split.** `cb_drain` is 5.4 ms single-threaded.
   Split `process_extracted_pair` (`vibe-land-4/physx-bridge/src/physx_bridge.cc`)
   into pure classify (targets + aggregates, parallel) and ordered ingest
   (queue/events/pair_load/wake, serial in recorded order — float sums make
   append order part of bit-exactness). Pattern to copy:
   `resolve_support_loads` in `destruction.cc`.
3. **N3 — red e2e browser city gate** (walk reaches 49 m from a target needing
   <30 m). The one known-red gate in CI.
