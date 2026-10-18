#!/usr/bin/env python3
"""What DRIVES each phase's cost -- bodies, awake bodies, or neither?

A per-phase mean tells you where time goes. It does not tell you what to do
about it. This fits, over every tick of every scenario pooled together,

    phase_ms  ~  a * (bodies/1000) + b * (awake/1000) + c

and reports which coefficient dominates. That distinction is the difference
between "this phase is expensive" and "this phase is expensive FOR THE WRONG
REASON": a walk whose cost tracks TOTAL bodies is paying for bodies that are
frozen and provably not moving, which is an algorithmic defect with a known
fix (gate it on the awake set), not a constant factor to shave.

It found exactly that on 2026-09-01, over 10,395 pooled ticks:

    support   189.7 us/1k BODIES   118.9 us/1k awake   R2=0.96  -> BODIES
    begin      24.3 us/1k bodies   194.5 us/1k awake   R2=0.92  -> awake
    cb_drain   -4.0 us/1k bodies   627.6 us/1k awake   R2=0.91  -> awake

begin and cb_drain are gated on the awake set and drop to 0.00 ms on a static
city. support is not, and costs MORE in `saturated` (21,030 bodies, 13,894
frozen, 5,281 awake -> 4.63 ms) than in `demolition` (12,457 bodies, 8,054
awake -> 3.33 ms) despite a third fewer awake bodies.

Read the constant term too. `end` carries 0.90 ms that depends on neither
variable -- work done on a completely static scene -- and `solve` carries
2.52 ms at R2=0.26, i.e. bodies and awake do not explain it at all, because it
is driven by live BONDS and islands. A low R2 here is informative: it means the
phase has a driver this model does not contain, and you should find it before
designing a fix.

    scripts/perf/drivers.py bench-results/perf/base
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dist        # noqa: E402
import scenarios   # noqa: E402

PHASES = ["stress_solve", "begin", "solve", "end", "readback", "support",
          "physx_step", "gpu_wait", "cb_drain", "cb_tick", "fetch_copy"]
REGRESSORS = [("bodies", "bodies"), ("awake", "awake")]


def _solve(A, b):
    """Gaussian elimination with partial pivoting. n is 3; no numpy here."""
    n = len(b)
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(A[r][i]))
        A[i], A[p] = A[p], A[i]
        b[i], b[p] = b[p], b[i]
        if abs(A[i][i]) < 1e-12:
            return None
        for k in range(i + 1, n):
            m = A[k][i] / A[i][i]
            for j in range(i, n):
                A[k][j] -= m * A[i][j]
            b[k] -= m * b[i]
    x = [0.0] * n
    for i in reversed(range(n)):
        x[i] = (b[i] - sum(A[i][j] * x[j] for j in range(i + 1, n))) / A[i][i]
    return x


def fit(rows, phase):
    g = lambda r, c: float(r.get(c) or 0)
    X = [[g(r, "bodies") / 1000.0, g(r, "awake") / 1000.0, 1.0] for r in rows]
    y = [g(r, phase) for r in rows]
    n = 3
    A = [[sum(X[k][i] * X[k][j] for k in range(len(X))) for j in range(n)]
         for i in range(n)]
    b = [sum(X[k][i] * y[k] for k in range(len(X))) for i in range(n)]
    x = _solve(A, b)
    if x is None:
        return None
    ybar = sum(y) / len(y)
    ss = sum((y[k] - sum(X[k][i] * x[i] for i in range(n))) ** 2
             for k in range(len(y)))
    tt = sum((v - ybar) ** 2 for v in y)
    return x, (1 - ss / tt if tt > 0 else 0.0)


def report(d):
    rows = []
    for spec in scenarios.SCENARIOS:
        p = os.path.join(d, f"{spec['name']}.csv")
        if os.path.exists(p):
            _, r = dist.load(p, spec["warmup"])
            rows += r
    if not rows:
        print(f"no scenario csvs under {d}")
        return 1
    print(f"== cost drivers   {len(rows):,} ticks pooled from {d}")
    print(f"{'phase':<14}{'us/1k body':>12}{'us/1k awake':>13}"
          f"{'const ms':>10}{'R2':>7}   driver")
    for ph in PHASES:
        if ph not in rows[0]:
            continue
        res = fit(rows, ph)
        if not res:
            continue
        (a, bb, c), r2 = res
        if r2 < 0.4:
            drv = "NEITHER -- another driver (bonds? islands?)"
        elif abs(a) > abs(bb) * 1.5:
            drv = "BODIES <- pays for frozen bodies too"
        elif abs(bb) > abs(a) * 1.5:
            drv = "awake"
        else:
            drv = "mixed"
        print(f"{ph:<14}{a * 1000:>12.1f}{bb * 1000:>13.1f}"
              f"{c:>10.2f}{r2:>7.2f}   {drv}")
    print("   A BODIES driver on a per-tick walk is an algorithmic defect, not a")
    print("   constant factor: it is work done for bodies that are not moving.")
    print("   A low R2 means this model is missing that phase's real driver.")
    return 0


if __name__ == "__main__":
    sys.exit(report(sys.argv[1] if len(sys.argv) > 1
                    else "bench-results/perf/base"))
