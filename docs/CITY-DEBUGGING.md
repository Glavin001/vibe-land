# Debugging the destructible city

Durable notes on how to investigate a "the city looks wrong" report. Written after the
district corruption campaign (`client/netlab/FINDINGS-district-corruption-2026-08-17.md`);
the specific bugs are recorded there, the transferable method is here.

## The instrumentation that exists

Per-frame detectors live in the client and only run while recording (`isRecording()`), so
they cost nothing in a normal session. Each answers a different question, and knowing which
one fired usually names the layer before any code is read.

| detector | question it answers | where |
|---|---|---|
| `diagnoseFrames()` | are an island's members further apart than it could physically span? | `city/topology.ts` |
| `membershipViolations()` | do `chunkBody[]` and `chunkSlots` disagree? | `city/topology.ts` |
| `countStaleDrawnChunks` | is the drawn pose behind the ledger pose? | `scene/CityChunksLayer.tsx` |
| chunk teleport probe | did a chunk move impossibly far in one frame? | `scene/CityChunksLayer.tsx` |
| `poseSourceOf` / `city_flicker` | was this chunk drawn from the raw writer instead of the interpolated one? | `city/topology.ts` |
| `migrateAnomalies` | did a migration have no valid destination? | `city/topology.ts` |
| `PresentationAnomaly` | was a smoothing correction abandoned (clock rollback, snap)? | `city/presentation.ts` |

The split that matters most: **`diagnoseFrames` / `membershipViolations` are ledger-level**
(what the client believes), **`countStaleDrawnChunks` is render-level** (what reached the
screen). Ledger-level failures mean bad data arriving or being decoded wrong. Render-level
failures mean the data was right and the screen is behind it. They call for completely
different investigations, and the netlab layer attribution (`netlab/attribute.ts`) already
sorts findings into RENDER / NETWORK / SERVER / SYNC on this basis.

## Method

**1. Reproduce in the harness before reading code.**
`npx tsx netlab/run.mts run --scenario city-district-demo --stack dev`. Scenarios live in
`netlab/scenarios/`. If the report is scene-specific, copy the nearest scenario and swap
`serverEnv.VIBE_CITY_SCENE`.

**2. Read the layer attribution first, not the metric table.** It states which layer is
implicated and why. "link and server look healthy, so these artifacts originate in
prediction/reconciliation/clock logic" is worth more than any single number.

**3. Get to distinct entities, not event counts.** 770 `city_frame_diag` events sounded
catastrophic; they were 15 bodies re-reported at 2 Hz for the rest of the run. Fifteen
permanently-broken bodies is a far sharper clue than 770 anything, and the fact that each was
corrupt *from creation onward* immediately ruled out drift and pointed at construction.

```python
ev = [json.loads(l) for l in open(f"{R}/events.client0.jsonl")]
d  = [e for e in ev if e['type'] == 'city_frame_diag']
print(len(set(x['data']['key'] for x in d)), "distinct bodies")
```

**4. Check whether the symptom is even reachable by your hypothesis.** Deferral only applies
beyond 40 m; corruption in a building the player is standing next to cannot be a deferral
bug. Locate the symptom in the code path before committing to a cause.

**5. Confirm the sign of the effect is possible.** Staggering redistributes *when* writes
happen and cannot change *how often* — so it cannot move mean staleness, whatever the
measurement says. Reason about what a change can do before believing an A/B that says it did.

## Measurement discipline

The demolition scenarios are **stochastic** — the GPU physics is not deterministic and total
damage varies ~2x run to run. Count-based metrics scale with damage, so two single runs prove
nothing.

- Always print the workload next to the metrics: `broken_bonds` and `chunk_bodies` from the
  last `server-stats.jsonl` row.
- Normalise before comparing, or match workloads before concluding.
- **Cross-layer sanity check:** if a client-only change appears to move server tick rate, the
  runs are not comparable — that is a workload difference, not a regression. This is the
  cheapest available guard against fooling yourself.
- To attribute a change, run the unmodified code at a comparable workload:
  ```bash
  cp <changed files> /tmp/save/ && git checkout HEAD -- <changed files>   # measure
  cp /tmp/save/* <back>                                                   # restore
  ```
  Do **not** use `git stash` for this.

## Scale assumptions are the recurring bug class

Two independent defects in one campaign came from the same root assumption: **a structure is
one building**. It is not — a structure is one *scene-pack instance*, and a pack may be an
entire authored district.

- `chunk_id` capped nodes at 4096 (12 bits). The district has 15,918. → silent aliasing.
- Batching and the render stagger keyed on `structureId`. At `GRID=1` there is one. → one
  city-wide batch, no culling, lockstep deferral.

When adding a limit or a grouping key, ask what it does when one pack *is* the city. And
prefer a hard `assert!` over `debug_assert!` for any invariant fixed at load time: the server
ships release, so a `debug_assert` on a packing bound buys nothing and costs a whole match of
invisible corruption.

## Ports and stacks

The netlab stack owns **4051** (game server), **4052** (WT UDP), **5599** (vite) and refuses
to start if any is held — reusing a stale stack would silently measure the wrong build, which
has happened. Clear with `fuser -k 4051/tcp 4052/udp 5599/tcp`.

`--stack dev` starts an isolated stack; `--stack attach` (the default) expects a dev server on
5555. Long-lived user servers on 4001/4003/4433/4434 are not netlab's and must be left alone.

After restarting a server, verify the config from the **running process**, not from the launch
command — a launch can die before exec and leave the previous process serving:

```bash
tr '\0' '\n' < /proc/<pid>/environ | grep VIBE_CITY
```
