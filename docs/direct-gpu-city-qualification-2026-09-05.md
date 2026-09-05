# Direct GPU city qualification and next priority

Direct GPU is the intended architecture to qualify for the city. The next
milestone is a playable Direct GPU city with correct destruction and acceptable
cost; it does not require finishing every GPU migration first. CPU snapshot
layout tuning is paused in favor of that milestone. The deployed lazy impulse
readback and arithmetic fixes remain useful on both physics paths.

The Direct GPU candidate already runs the actual city. This checkpoint rebuilds
it with solver `bdd356712f8bc9298ed60d8a8dc170300017182a` and game simulation
source `535a230` (same simulation code as `05c2319`). It uses the existing isolated
PhysX 5.10 sleeping/host-access SDK, whose patch and ABI manifest are unchanged.
No new solver or SDK implementation is introduced in this checkpoint. The game
changes allow the scenario suite and its nested idle check to select the same
isolated trace binary and preserve idle evidence.

**Deployment:** Direct GPU has not been promoted. The public city remains on
ordinary PhysX GPU with lazy impulse readback enabled. The qualification windows
restored its exact executable/environment and checked health. The candidate has
an unresolved variable retirement result and substantial reference-path CPU
cost. No threshold was relaxed and no speedup is claimed.

## What the candidate passed

- All 22 bridge tests, including character-controller interaction, fracture
  raycasts, force thresholds, freeze/wake semantics and timing consistency;
  10 existing tests remain ignored.
- 149 destruction tests in the debug run, plus the four authored-structure
  tests in a separate optimized run. The debug run's authored target was
  interrupted, so its overall exit is 101, not a pass. Its 17 existing ignored
  tests remain ignored. All 153 cases have passing coverage across these runs;
  this is not one successful full debug-suite invocation.
- The optimized authored target passes dropped-building breakup, bounded
  facade damage, rest stability and frame-versus-cladding strength. It took
  213.4 seconds. Ordinary cooking warnings for CPU-fallback convex geometry
  remain visible in its log.
- The grid-2 city audit completes 900 ticks, captures all 900 and performs 418
  full same-tick physics/destruction replays. Capture errors, membership
  mismatches, threshold/count, fracture-order, node-mask, compact-set,
  impulse-mirror, cached payload and parallel-drain/bondless audit mismatch
  counters are zero. No escaped bodies are recorded. This exercises the host
  compatibility restore path, not a completed device-only topology checkpoint.
- Corrected grid-1 idle qualification runs 90 seconds with one broken bond,
  including one in the final third; it passes the existing limit.
- The initial city scenario run passes bounded single-shot damage (485 bonds,
  153 bodies), falling/spreading collapse, total debris retirement,
  containment, patch capacity and the performance guard. That guard measures
  `physx_step + stress_solve`: p95 is 54.5 ms against 91.4 ms, with 571 samples
  in its 3,000–6,000-awake band. It is not whole-tick streaming p99.

## What remains unresolved

The initial collapse fails the awake-decline guard: its last five seconds have
93.5 median awake bodies against a peak of 630, or 14.84%, above the 10% limit.
Only two remain awake at the final tick; the failure concerns retirement time,
not endless motion. A repeat passes, as does an ordinary-GPU control using the
same release binary and SDK. The repeat does not erase the original failure.

| Collapse run | Peak awake | Final-window median awake | Awake ratio | Mean simulation ms |
|---|---:|---:|---:|---:|
| Direct, initial scenario | 630 | 93.5 | 14.84% (fails) | 6.798 |
| Ordinary GPU control | 628 | 0 | 0% | 2.921 |
| Direct, repeat | 628 | 0 | 0% | 6.022 |

These are exploratory whole-scenario means with different fracture trajectories,
not a matched-awake multi-trial performance claim. They give no evidence for
promoting this reference path as a speed improvement. The existing ordinary-GPU
native physical-quality and grid-2 late-idle baseline failures documented in
[incremental city upgrade](incremental-city-upgrade-2026-09-05.md) remain open;
this campaign does not rerun or resolve them.

The first nested idle check incorrectly invoked the stock-SDK trace with Direct
GPU requested. It failed before completing a trace. Both scripts now honor
`VIBE_CITY_TRACE_BIN`; `VIBE_CITY_SCENARIO_OUT` also retains the idle CSV and log.
The corrected standalone idle check passes. The initial scenario failure and
its invocation fingerprint are retained separately.

The initial debug dropped-building case exceeded six minutes and was explicitly
terminated to investigate. A bounded 180-second reproduction sampled its active
test thread through a test-only preload library. Samples show progress through
fracture/mass calculations, contact sorting/aggregation, support processing and
restore calls. No deadlock was established. The optimized target subsequently
passed. Attach-based profiling was unavailable on this host; those failed
profiling attempts are also recorded. The sampling library was never loaded into
the city server.

## Next implementation

The Direct GPU mode currently mirrors every body's motion and copies contact
records to the CPU, where shape routing, sorting and aggregation precede the
existing stress pipeline. The device contact-to-stress API is already proven
in a small isolated fixture, but is not the city's load route. Removing this
round trip is the main architectural work, together with observing only the
motion that CPU gameplay, queries and streaming actually need.

The next work is to explain the variable retirement behavior, move contact
ordering/filtering and body/node load assembly onto the GPU with explicit
ownership across fracture, and retain the current path as a correctness
reference. Preserve normal and friction loads, support/wake behavior, full
same-tick restore and replay, and streaming only committed state. CPU commands,
compact fracture results and network output remain explicit boundaries.

A first playable Direct GPU increment should follow its own functional,
retirement and performance qualification; later increments can replace the
remaining compatibility copies. Completing all device-only replay and streaming
work is not a prerequisite for the first playtest. The full optimization plan
remains active.

## Reproduction and provenance

Evidence is in `bench-results/simulation-frontier/direct-gpu-city-qualification/`.
`summary.json` separates interrupted and successful runs; `summarize.py` accepts
an optional evidence directory and reads raw or gzip-compressed artifacts.
`qualify.py` records commands, SDK/source/binary fingerprints and runtime flags;
`scoped-test-wrapper.py` checks zero players, stops only the checkout-owned
server and restores it afterward. These are archived host-specific runners,
not replacement deployment infrastructure. `probe-drop.py` requires compiling
its accompanying `stack-probe.c` into `/tmp/direct-gpu-stack-probe.so`; it is
solely an opt-in test diagnostic.

The qualified release trace SHA-256 is
`0dd9a89a2463fa54f67e119df0eb16a77957b5b6ddd6b83ad64e659027c5d578`;
the candidate server is
`653f9c331cc0d29987afd140b44e458f9da65d7fbcd2570137d6c24bf82700e8`.
The live ordinary-GPU server is a different artifact, recorded separately in
`live-city.json`. No Direct GPU browser or public-network rollout is claimed.
