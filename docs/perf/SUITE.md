# The performance suite

One answer to "how good is our performance", per engine profile, against a
stored baseline. The headline is the **high-fidelity** profile's score.
Correctness is a separate suite (`scripts/verify/correctness.sh`); every
optimisation step must improve this score without breaking that one.

```bash
scripts/perf/suite.sh --quick                     # ~60-70 s on the GPU; compares with the baseline
scripts/perf/suite.sh                             # standard tier, ~110-130 s on the GPU
scripts/perf/suite.sh --reps 3 --save-baseline    # record scripts/perf/suite-baseline.json
scripts/perf/suite.sh --compare RUN/report.json   # against another run instead of the baseline
scripts/perf/suite.sh --report RUN_DIR            # re-read a run (no GPU)
scripts/perf/suite.sh --shared ...                # develop on a shared GPU (timings indicative only)
scripts/perf/suite.sh --capture                   # (once) the impact captures the high profile replays
```

Other SDKs: `HIGH_PHYSX_ROOT=<install>` and `RUNTIME_PHYSX_ROOT=<install>`
(read by `scripts/fidelity/{high,runtime}.env`). `--profiles high` runs one
profile. Runs land in `target/perf-suite/runs/<stamp>-<label>/`
(`report.txt`, `report.json`, `logs/`, `plans/`).

## Scenarios

Data: `scripts/perf/suite.json`. Harness: `server/src/perf_suite.rs` (the
production arena, `seed_world_for_match`, the fleet spawned before the city
opens, `CityRuntime::open`, then per tick player input, `city.pre_step`,
`step_vehicles_and_dynamics`, `city.step` -- the server's order). Fixed
inputs at fixed ticks; one scene per process (the city reads its pack once).

| Scenario | Scene | What |
|---|---|---|
| town-idle | Vibe Town, 22 cars, 16 iterations | at rest after a short settle |
| fleet-drive | Vibe Town | the 8 Main Street cars driven at 70 % throttle |
| town-bombard | Vibe Town | 3 cannonballs and 2 meteors into 4 houses and the cinema, 1/6 s apart (quick: the first two) |
| truck-house | vehicle lab | the monster truck floored into the brick-veneer house (lab trial framed-house) |
| cannonball-house | vehicle lab | the game's cannonball into the same house (trial cannonball-framed-house) |
| meteor-house | vehicle lab | the game's meteor into the same house (trial meteor-framed-house) |
| calib-collapse | calibration demolition | two RC frames blown down by their charge sequences, one standing |

Both profiles run every scenario on their own SDK and packs
(`scripts/fidelity/packs.sh`). **In the high profile the three lab house
impacts are replays**: the impact solve costs 2-12 s per impact tick there, so
the suite times PhysX `destruction_impact_capture_replay` on the slowest
captured evaluation of each trial (`$PERF_SUITE_CAPTURES`, default the main
checkout's `target/perf-suite/captures/`, `manifest.json` says what each is).
A replay times the impact solve alone, not the rest of that tick. The town
bombardment and the calibration collapse run live in both profiles, impact
solves included.

## Metrics (per scenario)

- **step ms** (median, p95, worst): the server tick's wall time -- player
  simulation, vehicles and dynamics (PhysX simulate and fetch, the native
  destruction stage inside), the city step. Replays: the evaluation's time.
- **fetch ms**: the PhysX fetch, where the host is blocked on the GPU's step
  (the stage runs in it). The exact GPU wait exists only on the bridge's
  sampled steps (1 in 16) and is kept in `report.json` (`gpu_wait_ms`). Real
  GPU busy time needs CuMetal's commit trace, which costs time: use
  `vl perf gpu` for attribution, not this suite.
- **it/tick**, **unconv**: stress iterations per tick and ticks whose solve
  stopped unconverged (the cap is 16 in town, 64 with the fleet in the lab).
- **impact** (high profile, `PX_DESTRUCTION_IMPACT_LOG=1`): triggered
  evaluations, ADMM steps, capped and diverged solves, the longest single
  dispatch. The log synchronises the stream around each evaluation (a few
  tenths of a ms a tick); both arms of any comparison pay it.
- **work**: bonds broken, crushed chunks, awake bodies, contacts. Not scored;
  a comparison whose bonds-broken differ by more than 15 % is flagged as a
  different workload (the cascade is chaotic; see perf-measure trap 7).

## The score

Per profile: the **geometric mean over scenarios of value / baseline value**,
where value is the p95 step time (live) or the median evaluation time
(replay). 1.000 is the baseline; lower is faster.

Why this one:
- A ratio per scenario makes a 5 ms idle tick and a 12 s impact solve count
  alike: a 10 % gain is a 10 % gain wherever it lands. An arithmetic mean of
  milliseconds would be the impact replays and nothing else.
- The geometric mean of ratios does not depend on which run is the reference
  (A/B and B/A are reciprocal), and halving one scenario moves the score as
  much as halving any other.
- p95 rather than the median: hitches are what players feel, and an
  optimisation that moves only the median of a fracture scenario has not
  moved its fracture ticks. p95 rather than the worst tick: the worst is one
  sample and swings run to run. Both are reported.

## Noise and significance

GPU physics is not bit-reproducible, so every value has run-to-run scatter.
The baseline is recorded with `--reps 3` (reps alternate the profile order).
A delta is **significant** when |log ratio| exceeds twice the run-to-run
standard deviation of log(value) (the larger of the two arms') times
sqrt(1/n_a + 1/n_b), and is at least 5 % and 0.3 ms (the `vl perf compare`
rule). The score's band combines the scenarios' bands. Single-rep runs
against the 3-rep baseline get wide bands on bursty scenarios (town-bombard,
the collapse); for a small effect run `--reps 3` and compare.

`COMPARABILITY` lines name anything besides the code that differs from the
baseline: packs (sha), captures, tier, a shared GPU.

## Timing discipline

- Each GPU job takes the machine's exclusive GPU lock for itself
  (`scripts/perf/gpu-run.sh`, no `VIBE_GPU_SHARED`): it waits for running
  shared jobs, holds the GPU for one process (seconds to a minute), and
  releases it, so queued correctness jobs run between scenarios. Lock waits
  are reported, not counted.
- An untimed warm-up process per profile binary first (first-use costs; the
  CuMetal pipeline cache is `target/cumetal-cache` of the main checkout).
- Builds are excluded (cargo, `target/perf-suite/cargo-<sdk>`).
- The fingerprint in `report.json`: git head and dirtiness, both SDKs'
  `sdk-artifacts.json` revision and library hashes, the binaries, every
  pack's sha, the captures' sha.
