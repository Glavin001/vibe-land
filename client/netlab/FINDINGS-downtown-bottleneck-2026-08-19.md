# Downtown lag / rubber-banding: the CPU stress solver (2026-08-19)

Reported: heavy multi-building destruction on the live downtown server felt laggy and
rubber-bandy. Five overlay captures plus the server log identify the cause, and a controlled
A/B confirms it.

## What the evidence said

Overlay, across the collapse: bodies 7,082 → 10,355, broken bonds 26,331 → 38,205, tick avg
32 → 52 ms, **effective hz 31 → 19**, physx step 7.1 → 24.9 ms, city step 11.3 → 38 ms,
`stress solver: CPU` (red) throughout. Client 40 fps. Network trivial: ≤1.5 Mbps, topo gaps
0, ping 0.

Server log, the decisive part — **with `players=0`**:

```
city stream players=0 chunk_bodies=10366 awake_bodies=9331 broken_bonds=38250
             resettled_wakes=42506 encode_ms=20.8 solve_ms=5.0
```

9,331 of 10,366 bodies awake with nobody in the game, bonds still climbing (38,205 → 38,250
in 3 s), and 4,475 `city stress fracture (queueContact → broken bonds)` events in the log
tail. `resettled_wakes` — bodies that settled and were woken again
(`destruction/src/runtime.rs:482`) — stood at **42,506**.

That is a self-sustaining loop: rubble contacts → `queueContact` → unconverged CPU stress
solve → residual reads as overstress → fracture → bodies wake → new contacts → repeat.

## Controlled A/B

`city-downtown-cascade` vs `city-downtown-cascade-cpustress`: **same binary, same scenario,
same pack**, differing only by `VIBE_CITY_GPU_STRESS=0`. That isolates the solver from build,
content and scripting.

| | CUDA solver | CPU solver |
|---|---|---|
| peak bodies | 2,372 | 5,770 |
| peak awake | 638 | **4,266** |
| bonds broken | 8,100 | 20,783 |
| re-wakes, settle window | 381/min | **5,049/min** |
| re-wakes total | 3,241 | 17,326 |
| tick p95 peak | 31.5 ms | 50.7 ms |
| **real-time pace** | **59.69 Hz (0.5% deficit)** | 53.91 Hz (10.2% deficit) |
| over-budget seconds | 104 | 179 |

The CPU solver produces 6.7x the awake bodies and 13x the settle-window churn, and that is
what drags the tick. On CUDA the server holds 60 Hz on this scene; on CPU it does not.

## Why this is the rubber-banding

At 19–20 Hz effective the server delivers snapshots at a third of the rate client prediction
expects, so every reconciliation stretches over a longer gap and lands as a visible
correction. The client's 40 fps is a separate, secondary thing — the netlab client renders
this same scene at 60–67 fps, so 40 fps is the local render ceiling, not the cause of
position snapping.

Ranked:
1. **Server sim below real time** (19 Hz vs 60) — the direct cause.
2. **~9.3k bodies never sleeping** — what makes the tick expensive. Splitting the user's
   worst frame: physx step 24.9 ms (rigid-body sim, scales with awake count) + city step
   19.8 ms, of which blast begin 9.3 + solve 4.9 + end 0.0 = **14.2 ms is the stress solver**.
3. **The CPU solver is why they never sleep** — established by the A/B above.

## Not the bottleneck (checked, ruled out)

- **Network.** ≤1.5 Mbps, 0 topo gaps, 0 ping. Never close to a limit.
- **The encoder.** `encode_ms` of 10–20 ms with `players=0` looked like waste worth removing,
  but the overlay splits it: encoder ingest 1.1 ms + stream encode 1.5 ms + per-client pack
  0.2 ms = **2.8 ms**, against 14.2 ms of stress solve inside the same city step. The
  `encode_ms` figure spans the whole 60 Hz city step, not just encoding.
- **Skipping encode when the room is empty** was planned and then dropped as unsafe *and*
  low-value: `ingest_tick` maintains the ledger (`encoder.rs:314`, `ledger.apply_batch`) that
  a late joiner bootstraps from, so it cannot be skipped without letting topology drift out
  of sync with physics. It would also have saved ~1 ms of a ~52 ms tick.

## Action taken

The live server (127.0.0.1:4053 / WT 4435) was restarted on the `--features cuda-stress`
binary. Expect roughly half the breakage of the CPU build — that half was solver residual,
not physics — and a server that holds 60 Hz through a collapse this scene can produce.

## Still open

- Client 40 fps under heavy debris: local render ceiling, not addressed here.
- `cityClockRollbacksPerMin` SYNC defect (`presentation.ts:307-317`), unchanged and not
  scene-specific.
- The dense downtown merges rubble fields by design (see the pack's own header): if a future
  scene needs both density and independent settling, that trade has to be revisited on its
  own terms rather than by de-tuning the solver.
