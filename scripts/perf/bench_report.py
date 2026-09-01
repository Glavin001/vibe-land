#!/usr/bin/env python3
"""Render a bench.sh run set: one hierarchical budget per scenario, plus the
provenance needed to trust it and an A/B mode that refuses invalid comparisons.

The tree itself lives in dist.py; this adds the parts that make a number
quotable -- which binary produced it, which env, and whether the two arms
being compared actually simulated the same city.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dist  # noqa: E402


def _meta(d):
    p = os.path.join(d, "meta.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def _scenarios(d, meta):
    want = meta.get("scenarios") or []
    out = []
    for s in want:
        p = os.path.join(d, f"{s}.csv")
        if os.path.exists(p):
            out.append((s, p))
    if not out:  # fall back to whatever is on disk
        for f in sorted(os.listdir(d)):
            if f.endswith(".csv"):
                out.append((f[:-4], os.path.join(d, f)))
    return out


def _provenance(label, meta):
    print(f"== {label}")
    if not meta:
        print("   (no meta.json -- provenance unknown, treat with suspicion)")
        return
    print(f"   git {meta.get('git')}   binary inode {meta.get('binary_inode')} "
          f"mtime {meta.get('binary_mtime_unix')}")
    print(f"   scene {os.path.basename(meta.get('scene',''))} grid "
          f"{meta.get('grid')}  {meta.get('seconds')}s")
    env = meta.get("env", {})
    blast = {k: v for k, v in sorted(env.items()) if k.startswith("BLAST_")}
    print(f"   BLAST env: {blast if blast else '(none -- library defaults)'}")


def characterise(path, warmup, total_bonds):
    """What city did this run actually simulate?

    Timings mean nothing without this. Two runs of "45 shots" can land in
    different structural regimes, and a per-phase table that does not say which
    regime it describes is not reproducible -- it is an anecdote.
    """
    _, rows = dist.load(path, warmup)
    n = len(rows)
    f = lambda c, r: float(r.get(c) or 0)
    mean = lambda c: sum(f(c, r) for r in rows) / n
    last, first = rows[-1], rows[0]
    broken = f("bonds", last)
    # islands_tot / islands_skip are CUMULATIVE counters, so the per-tick
    # island population is their delta, not their value.
    d_tot = (f("islands_tot", last) - f("islands_tot", first)) / max(n - 1, 1)
    d_skip = (f("islands_skip", last) - f("islands_skip", first)) / max(n - 1, 1)
    return {
        "ticks": n,
        "broken_bonds": broken,
        "broken_frac": broken / total_bonds if total_bonds else 0.0,
        "live_bonds": (total_bonds - broken) if total_bonds else 0.0,
        "islands_per_tick": d_tot,
        "islands_skipped_per_tick": d_skip,
        "skip_rate": d_skip / d_tot if d_tot else 0.0,
        "bodies_mean": mean("bodies"),
        "awake_mean": mean("awake"),
        "frozen_mean": mean("frozen"),
        "overstressed_mean": mean("overstressed"),
        "pairs_mean": mean("pairs"),
    }


def check(spec, c):
    """TDD gate: did the run reach the regime the scenario claims to test?"""
    a = spec.get("asserts", {})
    out = []
    def cmp(key, val, bound, op):
        if bound is None:
            return
        ok = (val >= bound) if op == ">=" else (val <= bound)
        out.append((ok, f"{key} {val:,.4g} {op} {bound:,.4g}"))
    cmp("broken_frac", c["broken_frac"], a.get("broken_frac_min"), ">=")
    cmp("broken_frac", c["broken_frac"], a.get("broken_frac_max"), "<=")
    cmp("awake_mean", c["awake_mean"], a.get("awake_mean_min"), ">=")
    cmp("awake_mean", c["awake_mean"], a.get("awake_mean_max"), "<=")
    cmp("bodies_mean", c["bodies_mean"], a.get("bodies_mean_min"), ">=")
    return out


def _wrap(text, indent="   ", width=74):
    words, line, out = text.split(), "", []
    for w in words:
        if len(line) + len(w) + 1 > width:
            out.append(indent + line); line = w
        else:
            line = (line + " " + w).strip()
    if line:
        out.append(indent + line)
    return "\n".join(out)


def show(d, warmup):
    import scenarios
    meta = _meta(d)
    _provenance(os.path.basename(d.rstrip("/")), meta)
    def bonds_for(name):
        """Per-scenario live-bond total, read from the trace log at run time.
        Falls back to the grid table only if the run predates that capture."""
        p = os.path.join(d, f"{name}.bonds")
        if os.path.exists(p):
            try:
                return int(open(p).read().strip())
            except ValueError:
                pass
        return scenarios.GRID_BONDS.get(meta.get("grid"), 0)
    failures = []
    for name, path in _scenarios(d, meta):
        spec = scenarios.BY_NAME.get(name, {})
        w = spec.get("warmup", warmup)
        print(f"\n{'=' * 78}")
        print(f"== SCENARIO {name}   -- {spec.get('purpose','(undeclared)')}")
        print(f"{'=' * 78}")
        if spec.get("proves"):
            print("   WHY THIS EXISTS")
            print(_wrap(spec["proves"]))
        if spec.get("watch"):
            print("   WATCH")
            print(_wrap(spec["watch"]))
        total_bonds = bonds_for(name)
        c = characterise(path, w, total_bonds)
        print(f"\n   CITY UNDER TEST  ({c['ticks']} ticks analysed, "
              f"warm-up tick <= {w} excluded)")
        print(f"      live bonds        {c['live_bonds']:>12,.0f} of "
              f"{total_bonds:,} ({100 * (1 - c['broken_frac']):.1f}% intact)")
        print(f"      broken bonds      {c['broken_bonds']:>12,.0f} "
              f"({100 * c['broken_frac']:.1f}% destroyed)")
        print(f"      solver islands    {c['islands_per_tick']:>12,.0f} /tick, "
              f"{c['islands_skipped_per_tick']:,.0f} skipped "
              f"({100 * c['skip_rate']:.1f}% skip rate)")
        print(f"      chunk bodies      {c['bodies_mean']:>12,.0f}  "
              f"awake {c['awake_mean']:,.0f}  frozen {c['frozen_mean']:,.0f}")
        print(f"      overstressed      {c['overstressed_mean']:>12,.1f} /tick"
              f"   contact pairs {c['pairs_mean']:,.0f}")
        res = check(spec, c)
        if res:
            bad = [r for ok, r in res if not ok]
            if bad:
                failures.append(name)
                print(f"\n   REGIME CHECK: FAILED -- this run did not reach the "
                      f"regime it claims to test.")
                for r in bad:
                    print(f"      violated: {r}")
                print("      Timings below describe a DIFFERENT experiment than "
                      "the one named. Do not quote them.")
            else:
                print(f"\n   REGIME CHECK: pass ({len(res)} assertions)")
        print()
        dist.tree(path, w, "awake")
    # Cost drivers, pooled over every scenario. This is the step that turns
    # "where does time go" into "what is structurally wrong", so it runs by
    # default rather than being a thing to remember.
    print(f"\n{'=' * 78}")
    import drivers
    drivers.report(d)
    if failures:
        print(f"\n!! {len(failures)} scenario(s) failed their regime check: "
              f"{failures}")
    return 1 if failures else 0


# An A/B is only meaningful if both arms simulated the same city. Disabling
# contact reports once "saved ~6 ms" -- while breaking 21% fewer bonds, i.e.
# the fast arm was simulating a smaller city. Bucket-matching cannot rescue
# arms whose physics diverged, so this refuses rather than reports.
BOND_BAND = 0.10   # fallback only; scenarios declare their own measured band


def _work(path, warmup):
    _, rows = dist.load(path, warmup)
    last = rows[-1]
    return {"ticks": len(rows),
            "bonds": float(last.get("bonds") or 0),
            "awake_mean": sum(float(r.get("awake") or 0) for r in rows) / len(rows)}


def ab(da, db, warmup):
    ma, mb = _meta(da), _meta(db)
    _provenance("A: " + os.path.basename(da.rstrip("/")), ma)
    _provenance("B: " + os.path.basename(db.rstrip("/")), mb)

    ea = {k: v for k, v in (ma.get("env") or {}).items()}
    eb = {k: v for k, v in (mb.get("env") or {}).items()}
    diff = {k: (ea.get(k), eb.get(k)) for k in set(ea) | set(eb)
            if ea.get(k) != eb.get(k)}
    print(f"\n-- env delta A->B: {diff if diff else '(identical)'}")
    if ma.get("binary_inode") == mb.get("binary_inode") and not diff:
        print("   WARNING: same binary AND identical env -- this A/B compares "
              "a run against itself. Any delta is noise.")

    sa = dict(_scenarios(da, ma))
    sb = dict(_scenarios(db, mb))
    common = [s for s in sa if s in sb]
    if not common:
        print("REFUSING: no scenario present in both arms.")
        return 1

    import scenarios
    bad = []
    print(f"\n{'scenario':<12}{'ticks A/B':>16}{'bonds A/B':>20}{'band':>8}{'limit':>7}")
    for s in common:
        wa, wb = _work(sa[s], warmup), _work(sb[s], warmup)
        hi = max(wa["bonds"], wb["bonds"]) or 1.0
        band = abs(wa["bonds"] - wb["bonds"]) / hi
        spec = scenarios.BY_NAME.get(s, {})
        # Measured per-scenario, not a global guess: a flat 10% band would
        # refuse `saturated` against itself (14.5% spread over 3 identical runs).
        limit = spec.get("bond_band", BOND_BAND)
        flag = "OK" if band <= limit else "DIVERGED"
        if band > limit:
            bad.append(s)
        if spec.get("min_reps", 1) > 1:
            flag += f"  (needs n>={spec['min_reps']}: cascade drift ~{limit*100:.0f}%)"
        print(f"{s:<12}{wa['ticks']:>8}/{wb['ticks']:<8}"
              f"{wa['bonds']:>10.0f}/{wb['bonds']:<10.0f}{band * 100:>7.1f}%"
              f"{limit * 100:>6.0f}% {flag}")
    if bad:
        print(f"\nREFUSING the timing comparison for {bad}: the arms broke "
              f"different numbers of bonds (past that scenario's measured "
              f"band), so they did not simulate the same city.\nA per-phase "
              f"delta across diverged physics is not a speedup, it is a "
              f"different workload.")

    for s in common:
        if s in bad:
            continue
        print(f"\n{'=' * 78}\n== SCENARIO {s}   A -> B\n{'=' * 78}")
        dist.ab(sa[s], sb[s], warmup, "awake")
    return 0


def main(argv):
    flags = {a.split("=")[0]: (a.split("=")[1] if "=" in a else True)
             for a in argv[1:] if a.startswith("--")}
    args = [a for a in argv[1:] if not a.startswith("--")]
    warmup = int(flags.get("--warmup", 600))
    if flags.get("--ab"):
        return ab(args[0], args[1], warmup)
    return show(args[0], warmup) or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
