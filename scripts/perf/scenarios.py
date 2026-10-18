#!/usr/bin/env python3
"""The scenario set, as declarations rather than shot counts.

A scenario is a HYPOTHESIS about a regime the solver has to survive, plus the
knobs that reach it, plus assertions that prove the run actually got there.
"heavy" told you the input and nothing about the city; these tell you what
structural regime is under test and why it is worth testing separately.

The city's life has four structurally different phases and they stress
completely different code:

  intact      one island per building, ~268k live bonds, nothing moving
  onset       first fractures: topology churn against a mostly-whole graph
  demolition  the partly-demolished band -- many MEDIUM islands, deep load
              paths, furthest from the convergence knee
  rubble      tens of thousands of tiny islands: launch-overhead bound
  settled     rubble at rest: does the quiet/settled skip actually engage?

Cost does NOT move monotonically across these. Island count peaks mid-shatter
and then FALLS as fragments stop being connected at all, so both ends of the
curve are cheap for different reasons and the middle is not. A suite that only
measures "idle" and "lots of shots" samples the two cheap ends and misses the
regime that actually hurts.

Each scenario declares `asserts`, checked against the measured trace. A run
that does not reach its intended regime is reported FAILED rather than quietly
charted -- otherwise a tuning change that stops the city fragmenting reads as
a speedup when it is really a different experiment.
"""

# grid 2 = 4 structures replicated 2x2. Bond total is scene+grid dependent and
# is read from the trace log at run time; this is the fallback for reporting.
GRID_BONDS = {1: 74543, 2: 267992, 3: 609662, 4: 1082232}


SCENARIOS = [
    dict(
        name="intact", bond_band=0.05, min_reps=1,
        shots=0, interval=0, seconds=40, warmup=600,
        purpose="The floor: a pristine, frozen city that nobody has touched.",
        proves=(
            "What the structure costs merely by existing. Every bond is live "
            "(~268k at grid 2), each building is ONE large island, nothing is "
            "awake -- so this isolates the solver's fixed per-tick cost from all "
            "destruction work. It is also the only scenario where the quiet- and "
            "settled-skip gates can be observed with zero confounding motion, "
            "and the skip rate here is diagnostic on its own: a static city that "
            "does not reach a high skip rate is a city whose islands never "
            "converge, so they can never latch as settled."
        ),
        watch="stress_solve should be ~95% of the tick. Skip rate measured 55% "
              "on 2026-09-01 -- 45% of islands re-solved every tick against an "
              "unchanging structure. That is the settled-skip gate not latching.",
        asserts=dict(broken_frac_max=0.01, awake_mean_max=50),
    ),
    dict(
        name="onset", bond_band=0.1, min_reps=1,
        shots=8, interval=90, seconds=45, warmup=600,
        purpose="First damage: a few widely-spaced hits on a whole structure.",
        proves=(
            "The fracture-tick path in isolation -- delta topology upload, "
            "incremental CSR patch, split detection, repartition -- against a "
            "graph still ~99% connected, so per-fracture cost is not hidden "
            "inside a scene that is already rubble. Islands stay few and LARGE."
        ),
        watch="frac_* spans, and the gap between fracture ticks and quiet ticks. "
              "A regression in topology handling shows up here first.",
        asserts=dict(broken_frac_min=0.002, broken_frac_max=0.05,
                     awake_mean_max=2500),
    ),
    dict(
        name="demolition", bond_band=0.18, min_reps=3,
        shots=450, interval=4, seconds=45, warmup=600,
        purpose="Peak load: active demolition, the busiest tick the game "
                "produces.",
        proves=(
            "The worst case that actually occurs. Damage climbs 6% -> 18% across "
            "the window while bodies climb past 10,000 and awake peaks near "
            "10,000 -- fracturing, island churn, contact generation and every "
            "host walk (begin/end/support) all at maximum simultaneously. If an "
            "optimisation helps intact and aftermath but not this, it has not "
            "helped where the frame budget is actually at risk."
        ),
        watch="end/support/begin and island churn. This is the scenario whose "
              "tick exceeds the 16.7 ms budget.",
        asserts=dict(broken_frac_min=0.05, broken_frac_max=0.25,
                     awake_mean_min=3000),
    ),
    dict(
        name="saturated", bond_band=0.18, min_reps=3,
        shots=2000, interval=4, seconds=90, warmup=3000,
        purpose="Maximum reachable destruction: the 18.6% damage ceiling.",
        proves=(
            "The most-destroyed city this harness can actually produce, measured "
            "AFTER the plateau so fracture work is done and only the standing "
            "cost of a large fragmented scene remains: ~14,900 bodies, ~49,700 "
            "broken bonds, ~1,700 islands/tick. This is the steady state a long "
            "session converges to."
        ),
        watch="Compare against `demolition`: same city, no active fracturing. "
              "Anything that does NOT fall between the two is doing work that "
              "destruction does not justify.",
        asserts=dict(broken_frac_min=0.15, broken_frac_max=0.25,
                     bodies_mean_min=12000),
    ),
    dict(
        name="aftermath", bond_band=0.18, min_reps=3,
        shots=2000, interval=4, seconds=150, warmup=7000,
        purpose="Long tail: does a demolished city ever come to rest? "
                "(Measured: no.)",
        proves=(
            "Whether the quiet/settled-skip gates ever engage after destruction. "
            "They largely do not: 170 s past the damage plateau, ~2,900 of "
            "14,959 bodies (19%) are STILL awake, so the cheap path a settled "
            "scene is supposed to fall onto is never reached in practice. This "
            "scenario exists to keep that honest -- if a change makes the city "
            "actually quiesce, awake_mean here collapses and it will be obvious."
        ),
        watch="awake, and whether begin/support/cb_drain approach their `intact` "
              "values. On 2026-09-01 they do not.",
        # awake_mean_max was 6,000 against the pre-merge physics. After the
        # structural-realism merge (2026-09-03) the same run holds ~6,400
        # awake 170 s past the plateau; the band follows the physics, the
        # assertion's purpose (is the quiet path ever reached? no) does not.
        asserts=dict(broken_frac_min=0.15, awake_mean_max=8000,
                     bodies_mean_min=12000),
    ),
]

# REPRODUCIBILITY -- read this before trusting any single-run A/B.
#
# Three IDENTICAL saturated runs (2026-09-01, grid 2, same binary, same env)
# ended at 53,437 / 62,488 / 60,597 broken bonds: a 14.5% spread. The
# destruction cascade is chaotic, and GPU rigid-body simulation is not
# bit-reproducible across runs (parallel reduction order varies), so the arms
# of an A/B genuinely simulate different cities even with everything fixed.
#
# Consequences, both enforced in bench_report.py:
#   * `bond_band` is PER SCENARIO. A 10% band applied everywhere would refuse
#     saturated against ITSELF. intact is near-deterministic (5%); the deep
#     scenarios need 18%.
#   * `min_reps` is 3 for anything past `onset`. A single-run delta smaller
#     than ~15% on those scenarios is indistinguishable from cascade drift,
#     no matter how clean the timing looks. Do not quote one.
#
# The tight scenarios are where small effects are resolvable: intact and onset
# hold their work counters to a few percent, so a 3-5% timing delta there is
# real. Measure small wins on those and confirm direction on the deep ones.

# NOT REACHABLE FROM THIS HARNESS, and it matters.
#
# A 2,000-shot / 200 s calibration probe (2026-09-01, grid 2) showed damage
# SATURATES at 18.6% of bonds. The plateau arrives by tick ~1800 (450 shots)
# and the next 1,550 shots add 0.9%. Shooting cannot demolish this city
# further: the 27 fixed targets are rubble by then and later shots land on
# debris.
#
# So the 25-75% "partly demolished" band -- which the convergence analysis
# identifies as the regime FURTHEST from its knee, and the one case that gets
# more expensive as the iteration budget rises -- CANNOT BE PRODUCED HERE. Any
# claim about that band must come from the standalone harness
# (blast-stress-solver-2 demos/blast-stress-demo/tests/gpu_stress_suite.cpp,
# scenarios live-light/live-city/live-heavy and broken-25/50/75), which
# fractures synthetically and is not bounded by what a player can shoot.
#
# Do not "fix" this by raising VIBE_CITY_SHOT_BLAST_RADIUS or
# VIBE_CITY_SHOT_STRESS_IMPULSE. Those are production physics constants; moving
# them makes the measurement describe a game nobody plays, which is the exact
# failure this suite exists to prevent.

BY_NAME = {s["name"]: s for s in SCENARIOS}
DEFAULT = "intact,onset,demolition,saturated,aftermath"


def main(argv):
    """`scenarios.py args NAME` prints the record-city-trace knobs."""
    if len(argv) > 2 and argv[1] == "args":
        s = BY_NAME[argv[2]]
        print(f"{s['shots']} {s['interval']} {s['seconds']} {s['warmup']}")
        return 0
    if len(argv) > 1 and argv[1] == "default":
        print(DEFAULT)
        return 0
    for s in SCENARIOS:
        print(f"{s['name']:<12} shots={s['shots']:<4} every={s['interval']:<4} "
              f"{s['seconds']}s  {s['purpose']}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv))
