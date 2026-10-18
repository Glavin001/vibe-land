#!/usr/bin/env python3
"""How much a configuration change moves load between bonds.

Two vehicle-lab reports of the same cars and scenarios (VIBE_LAB_REPORT_NAME),
for example physical bond stiffness at a high iteration cap (the reference)
and a compressed stiffness spread at the production cap. For every scenario,
compares each intact bond's stress on the last step and reports how far the
second configuration's stresses are from the reference: the share of bonds
within 10% / 25%, the median and p90 relative change of each bond's peak
fibre stress among the bonds carrying at least 5% of the case's peak stress,
and the worst.

  scripts/perf/compare-bond-loads.py target/vehicle-lab/reference.json target/vehicle-lab/candidate.json
"""
import json, sys

def load(path):
    return {(r['car'], r['run']['scenario']): r['run'] for r in json.load(open(path))}

ref, cand = load(sys.argv[1]), load(sys.argv[2])
for key in sorted(ref.keys() & cand.keys()):
    a = {row[0]: row for row in ref[key]['bondLoads']}
    b = {row[0]: row for row in cand[key]['bondLoads']}
    changes = []
    fibre = lambda r: max(r[2], r[3], r[4])
    peak = max((fibre(r) for r in a.values()), default=0.0)
    for i in a.keys() & b.keys():
        ra, rb = a[i], b[i]
        sa, sb = fibre(ra), fibre(rb)
        # The bonds that carry the load: at least 5% of this case's peak stress.
        if peak <= 0 or sa < 0.05 * peak:
            continue
        changes.append((abs(sb - sa) / sa, i, ra[1], rb[1]))
    if not changes:
        print(f"{key[0]:<8} {key[1]:<10} no loaded bonds to compare"); continue
    changes.sort()
    n = len(changes)
    within = lambda t: 100.0 * sum(1 for c in changes if c[0] <= t) / n
    q = lambda p: changes[min(n - 1, int(p * (n - 1)))][0] * 100
    worst = changes[-1]
    print(f"{key[0]:<8} {key[1]:<10} {n} loaded bonds: {within(0.10):.0f}% within 10%, {within(0.25):.0f}% within 25%; "
          f"median change {q(0.5):.0f}%, p90 {q(0.9):.0f}%; worst bond {worst[1]} {worst[0]*100:.0f}% (utilisation {worst[2]:.2f} -> {worst[3]:.2f}); "
          f"converged {ref[key]['converged']*100:.0f}% vs {cand[key]['converged']*100:.0f}%")
