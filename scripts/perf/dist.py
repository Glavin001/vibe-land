#!/usr/bin/env python3
"""Distributions, not point estimates, from a record-city-trace CSV.

Every wrong performance conclusion on this project came from a point
estimate standing in for a distribution:

  - a 541 ms tick was attributed to the wrong phase because the columns it
    was decomposed against were 16-sample ring means, so the spike tick
    reported its neighbours' average;
  - a gather was called slower than a scatter on unbalanced arms (2 reps
    against 1), and balancing halved the delta;
  - a residual read 0.295 ms and IDENTICAL across five different scenes,
    because the mean included ring warm-up;
  - the contact callback's worst tick was found to have FEWER pairs than a
    normal tick and 64x the cost per pair -- visible only once cost was
    normalised per unit of work.

None of those were reasoning failures. They were all "I looked at a mean".
So this prints, for every timing column: n, min, p50, p95, p99, p99.9, max,
mean, sd, sum, share of total, and max/p50. A tail that matters cannot hide
behind a median, and a phase that spikes is ranked by how far it spikes.

Usage:
  dist.py TRACE.csv [--warmup N] [--by awake|pairs|none] [--spikes K]
  dist.py A.csv B.csv --ab            compare two arms, matched by bucket

Warm-up is EXCLUDED BY DEFAULT and the exclusion is printed, because the
one time it was applied ad hoc it was forgotten on the next run.
"""
import csv
import math
import statistics
import sys

# Columns that are wall time in ms. Everything else is a counter or a state
# variable and is summarised separately.
TIME_HINTS = ("_ms", "step", "solve", "begin", "end", "readback", "events",
              "filters", "ccd", "support", "shape", "slot", "bond_sample",
              "gpu_wait", "fetch", "callback", "gravity", "contact_proc",
              "frac_", "cb_", "gpu_host", "cascade", "ingest")
NOT_TIME = {"tick", "bodies", "awake", "frozen", "sleeping", "bonds", "pairs",
            "contacts_q", "islands_skip", "islands_tot", "quiet", "freeze",
            "unfreeze", "contact_wakes", "min_y", "pose_quiet", "overstressed",
            "patch_hw", "escaped", "cp_found", "cp_persists", "cp_points",
            "cp_supp", "node_mm", "node_ck", "sup_calls", "sup_kin", "sup_fy",
            "sup_exist", "sup_new", "sup_staged", "sup_unch", "sup_rows"}


# Columns that are NOT per-tick: sampled (1 tick in 16) or smoothed over a
# ring. They are legitimate for a 1 Hz report and WRONG for anything
# per-tick, and the difference is invisible in the name alone -- which is how
# a 541 ms spike came to be decomposed against its neighbours' average, and
# how this tool's own first per-unit table reported 1.23 us/pair max on a
# tick that actually cost 44.9. Listed here so they are marked in the table
# and refused as denominators or spike evidence.
DERIVED = {
    "gpu_wait": "sampled 1-in-16",
    "fetch_copy": "sampled 1-in-16",
    "callback": "16-sample ring mean",
    "fetch_total": "16-sample ring mean",
    "fetch_resid": "16-sample ring mean",
}
# The per-tick truth for each derived column, where one exists.
PER_TICK = {"callback": "cb_tick", "fetch_total": "fetch_tick"}


def is_time(col):
    if col in NOT_TIME:
        return False
    return any(h in col for h in TIME_HINTS)


def quant(sorted_vals, q):
    """Nearest-rank quantile. No interpolation: with a heavy tail the
    interpolated p99 is a number that never occurred, and the question here
    is always 'how bad does a real tick get'."""
    if not sorted_vals:
        return float("nan")
    i = min(len(sorted_vals) - 1, max(0, int(math.ceil(q * len(sorted_vals))) - 1))
    return sorted_vals[i]


class Dist:
    def __init__(self, values):
        self.v = sorted(values)
        self.n = len(self.v)

    def row(self):
        if not self.n:
            return None
        v = self.v
        mean = sum(v) / self.n
        sd = statistics.pstdev(v) if self.n > 1 else 0.0
        return dict(
            n=self.n, min=v[0], p50=quant(v, 0.50), p95=quant(v, 0.95),
            p99=quant(v, 0.99), p999=quant(v, 0.999), max=v[-1],
            mean=mean, sd=sd, total=sum(v),
            ratio=(v[-1] / v[self.n // 2]) if v[self.n // 2] > 0 else float("inf"),
        )


def load(path, warmup):
    with open(path) as fh:
        rows = [r for r in csv.DictReader(fh)]
    kept = [r for r in rows if float(r["tick"]) > warmup]
    return rows, kept


def buckets(rows, key):
    if key == "none":
        return [("all", rows)]
    edges = [(0, 500), (500, 1500), (1500, 3000), (3000, 6000), (6000, 10**9)]
    out = []
    for lo, hi in edges:
        sel = [r for r in rows if lo <= float(r[key]) < hi]
        if len(sel) >= 20:      # below this a quantile is theatre
            out.append((f"{lo}-{hi if hi < 10**8 else '+'}", sel))
    return out


def report(path, warmup, by, spikes):
    allrows, rows = load(path, warmup)
    print(f"== {path}")
    print(f"   {len(allrows)} ticks, {len(allrows) - len(rows)} excluded as warm-up "
          f"(tick <= {warmup}), {len(rows)} analysed")
    if not rows:
        return
    cols = [c for c in rows[0] if is_time(c)]

    for label, sel in buckets(rows, by):
        # Total is physx + blast: the two parents. Their children are shares
        # of one of them, never of each other.
        tot = [float(r["physx_step"]) + float(r["stress_solve"]) for r in sel]
        grand = sum(tot)
        print(f"\n-- bucket {by}={label}  ({len(sel)} ticks)  "
              f"total p50 {quant(sorted(tot), .5):.2f} ms, "
              f"p99 {quant(sorted(tot), .99):.2f} ms, max {max(tot):.2f} ms")
        print(f"{'column':<20}{'n':>6}{'min':>8}{'p50':>8}{'p95':>8}{'p99':>8}"
              f"{'p99.9':>8}{'max':>9}{'mean':>8}{'sd':>8}{'share':>7}{'max/p50':>9}")
        stats = []
        for c in cols:
            d = Dist([float(r[c]) for r in sel]).row()
            if d and d["total"] > 0:
                stats.append((c, d))
        # Ranked by total time owned, so the list reads as a budget.
        for c, d in sorted(stats, key=lambda kv: -kv[1]["total"]):
            mark = " ~" if c in DERIVED else ""
            print(f"{c+mark:<20}{d['n']:>6}{d['min']:>8.2f}{d['p50']:>8.2f}{d['p95']:>8.2f}"
                  f"{d['p99']:>8.2f}{d['p999']:>8.2f}{d['max']:>9.2f}{d['mean']:>8.2f}"
                  f"{d['sd']:>8.2f}{100 * d['total'] / max(grand, 1e-9):>6.1f}%"
                  f"{d['ratio']:>8.1f}x")
        if any(c in DERIVED for c, _ in stats):
            print("   ~ = sampled or ring-smoothed; per-tick truth: "
                  + ", ".join(f"{k}->{v}" for k, v in PER_TICK.items())
                  + ". Not usable for spikes or per-unit.")

        # Cost per unit of work. This is what exposed a spike tick with FEWER
        # pairs than normal and 64x the cost each -- invisible in absolute ms.
        print(f"\n   per-unit (us): {'':<10}{'p50':>10}{'p99':>10}{'max':>10}")
        for tcol, ucol, name in (("cb_tick", "__pairs", "us/contact pair"),
                                 ("cb_tick", "cp_points", "us/contact point"),
                                 ("support", "pairs", "us/support pair"),
                                 ("stress_solve", "awake", "us/awake body"),
                                 ("physx_step", "awake", "us/awake body")):
            if tcol in DERIVED:
                raise AssertionError(
                    f"{tcol} is {DERIVED[tcol]}; a per-unit cost built on it is "
                    f"meaningless. Use {PER_TICK.get(tcol, 'a per-tick column')}.")
            per = []
            for r in sel:
                if ucol == "__pairs":
                    u = float(r.get("cp_found", 0)) + float(r.get("cp_persists", 0))
                else:
                    u = float(r.get(ucol, 0))
                if u > 0:
                    per.append(1000.0 * float(r[tcol]) / u)
            if per:
                s = sorted(per)
                print(f"   {tcol:<12}{name:<18}{quant(s,.5):>10.2f}"
                      f"{quant(s,.99):>10.2f}{s[-1]:>10.2f}")

    if spikes:
        print(f"\n-- {spikes} worst ticks by total, fully decomposed")
        ranked = sorted(rows, key=lambda r: -(float(r["physx_step"]) + float(r["stress_solve"])))
        idx = {r["tick"]: i for i, r in enumerate(rows)}
        for r in ranked[:spikes]:
            t = float(r["physx_step"]) + float(r["stress_solve"])
            i = idx[r["tick"]]
            prev = rows[i - 1] if i > 0 else r
            pairs = float(r.get("cp_found", 0)) + float(r.get("cp_persists", 0))
            print(f"   tick {float(r['tick']):>7.0f} total {t:>8.2f}  "
                  f"physx {float(r['physx_step']):>7.2f} (sim {float(r.get('physx_sim',0)):>5.2f} "
                  f"fetch {float(r.get('fetch_tick',0)):>7.2f} cb {float(r.get('cb_tick',0)):>7.2f})  "
                  f"blast {float(r['stress_solve']):>6.2f}  "
                  f"awake {float(r['awake']):>6.0f} pairs {pairs:>6.0f} "
                  f"dBody {float(r['bodies'])-float(prev['bodies']):>5.0f} "
                  f"dBond {float(r['bonds'])-float(prev['bonds']):>5.0f}")


def ab(path_a, path_b, warmup, by):
    """Matched-bucket comparison with equal n, because unbalanced arms once
    reported -24.7% where the balanced answer was -11.7%."""
    _, A = load(path_a, warmup)
    _, B = load(path_b, warmup)
    print(f"== A/B  A={path_a} ({len(A)} ticks)  B={path_b} ({len(B)} ticks)")
    cols = [c for c in A[0] if is_time(c)]
    for label, _ in buckets(A, by):
        lo, hi = label.replace("+", str(10**9)).split("-")
        lo, hi = float(lo), float(hi)
        sa = [r for r in A if lo <= float(r[by]) < hi]
        sb = [r for r in B if lo <= float(r[by]) < hi]
        n = min(len(sa), len(sb))
        if n < 20:
            continue
        print(f"\n-- {by}={label}   n={n} per arm (truncated to match)")
        print(f"{'column':<20}{'A p50':>9}{'B p50':>9}{'d p50':>9}"
              f"{'A p99':>9}{'B p99':>9}{'d p99':>9}")
        for c in cols:
            va, vb = sorted(float(r[c]) for r in sa[:n]), sorted(float(r[c]) for r in sb[:n])
            a50, b50 = quant(va, .5), quant(vb, .5)
            a99, b99 = quant(va, .99), quant(vb, .99)
            if max(a50, b50) < 0.05:
                continue
            d50 = 100 * (a50 - b50) / b50 if b50 else float("nan")
            d99 = 100 * (a99 - b99) / b99 if b99 else float("nan")
            print(f"{c:<20}{a50:>9.2f}{b50:>9.2f}{d50:>8.1f}%"
                  f"{a99:>9.2f}{b99:>9.2f}{d99:>8.1f}%")


# Parent -> children, verified against live data: stress_solve closes to
# +0.001 ms against this child set, and physx_step to 0.00.
#
# blast phases like contact_proc/gravity/frac_* are NOT here because they are
# nested INSIDE begin/solve/end, and listing them as siblings would double
# count. They appear in the flat table instead.
TREE = {
    "TOTAL": ["physx_step", "stress_solve"],
    "physx_step": ["physx_sim", "fetch_tick"],
    "fetch_tick": ["gpu_wait", "cb_tick", "fetch_copy"],
    "cb_tick": ["cb_entity", "cb_extract", "cb_resolve", "cb_queue",
                "cb_events", "cb_pairld", "cb_wake", "cb_census", "cb_resize"],
    "stress_solve": ["begin", "solve", "end", "readback", "events", "filters",
                     "ccd", "support", "shape", "slot", "bond_sample"],
    # gpu_solve is DEVICE time and runs concurrently with gpu_host_blocked --
    # the host is blocked precisely because the kernel is executing. Listing it
    # as a sibling double counts and shrinks the apparent remainder. It is
    # annotated separately below instead.
    "solve": ["gpu_host_work", "gpu_host_blocked", "st_init", "st_err",
              "st_copy"],
}


def tree(path, warmup, by):
    """Hierarchical budget where the percentages actually add up.

    Shares are computed from SUMS, never from quantiles. A p99 is the 99th
    worst tick FOR THAT COLUMN, and different columns peak on different
    ticks -- so a parent's max is not its children's maxes added, and
    subtracting them to find 'what is missing' finds a number that describes
    no tick that ever ran. Sums are the only statistic that decomposes, so
    the % column is the honest one and the quantiles beside it are shape.
    """
    _, rows = load(path, warmup)
    print(f"== {path}   {len(rows)} ticks analysed (warm-up tick <= {warmup} excluded)")
    for label, sel in buckets(rows, by):
        col = lambda c: [float(r[c]) for r in sel] if c in sel[0] else None
        totv = [float(r["physx_step"]) + float(r["stress_solve"]) for r in sel]
        grand = sum(totv)
        print(f"\n-- bucket {by}={label}  ({len(sel)} ticks)")
        print(f"{'phase':<26}{'mean':>8}{'%par':>7}{'%tot':>7}"
              f"{'p50':>8}{'p95':>8}{'p99':>8}{'max':>8}{'n>0':>7}")

        def emit(name, values, parent_sum, depth):
            d = Dist(values).row()
            if not d:
                return
            nz = sum(1 for v in values if v > 0)
            pad = "  " * depth
            mark = " ~" if name in DERIVED else ""
            print(f"{pad + name + mark:<26}{d['mean']:>8.2f}"
                  f"{100 * d['total'] / max(parent_sum, 1e-9):>6.1f}%"
                  f"{100 * d['total'] / max(grand, 1e-9):>6.1f}%"
                  f"{d['p50']:>8.2f}{d['p95']:>8.2f}{d['p99']:>8.2f}{d['max']:>8.2f}"
                  f"{100.0 * nz / len(values):>6.0f}%")

        def walk(node, values, depth):
            vsum = sum(values)
            kids = TREE.get(node, [])
            present = [k for k in kids if k in sel[0]]
            acc = None
            for k in present:
                kv = col(k)
                emit(k, kv, vsum, depth)
                acc = kv if acc is None else [a + b for a, b in zip(acc, kv)]
                if k in TREE:
                    walk(k, kv, depth + 1)
            if present and acc is not None:
                resid = [a - b for a, b in zip(values, acc)]
                emit("[unattributed]", resid, vsum, depth)

        emit("TOTAL", totv, grand, 0)
        walk("TOTAL", totv, 1)
        if "gpu_solve" in sel[0]:
            g = Dist(col("gpu_solve")).row()
            print(f"   [concurrent] gpu_solve device {g['mean']:.2f} ms mean, "
                  f"p50 {g['p50']:.2f}, max {g['max']:.2f} -- overlaps "
                  f"gpu_host_blocked, NOT a disjoint child of solve.")
        print("   %par = share of the row above it, by SUM. Quantiles do not "
              "decompose:\n   a parent's max and its children's maxes are "
              "different ticks. n>0 = ticks where the phase ran at all.")


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a.split("=")[0]: (a.split("=")[1] if "=" in a else True)
             for a in argv[1:] if a.startswith("--")}
    warmup = int(flags.get("--warmup", 600))
    by = flags.get("--by", "awake")
    spikes = int(flags.get("--spikes", 8))
    if flags.get("--tree"):
        for p in args:
            tree(p, warmup, by)
        return 0
    if flags.get("--ab") and len(args) >= 2:
        ab(args[0], args[1], warmup, by)
    else:
        for p in args:
            report(p, warmup, by, spikes)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
