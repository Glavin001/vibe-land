#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""The impact study's results as one table (markdown).

    uv run structures/town-kit/scripts/impact-study-report.py PACK out/impact-study/*.json

Locality is measured two ways: from the point of first contact, and from the
impactor's path through the structure (a projectile or a truck that goes
through breaks what it passes, which is local to its path however far from
where it went in).
"""
import importlib.util, json, pathlib, sys
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('impact_study', HERE / 'impact-study.py')
study = importlib.util.module_from_spec(spec); spec.loader.exec_module(study)


def path_distance(points, a, b):
    ab = b - a; L = max(ab @ ab, 1e-12)
    t = np.clip(((points - a) @ ab) / L, 0, 1)
    return np.linalg.norm(points - (a + t[:, None] * ab), axis=1)


def main():
    st = study.Structure(sys.argv[1])
    sc = study.scenarios()
    rows = []
    for f in sys.argv[2:]:
        for r in json.load(open(f))['runs']:
            if 'error' in r: continue
            imp = sc[r['scenario']]
            ks = np.array([k for k, t in r['brokenBonds'] if 0 <= t < 999], dtype=int)
            pts = st.bc[ks] if len(ks) else np.zeros((0, 3))
            # The path: first contact to where the leading face stopped (inside the house).
            alive = np.ones(st.n, bool)
            pts0, near = imp.contacts(st, alive, 1e9)
            s0 = min(near[k] for k in pts0)
            s1 = min(max(r['penetration'], s0), 12.0)
            a = imp.aim + imp.d * s0; b = imp.aim + imp.d * s1
            dp = path_distance(pts, a, b) if len(ks) else np.zeros(0)
            within = lambda x: int((dp < x).sum())
            rows.append(dict(scenario=r['scenario'], option=r['option'], broken=r['brokenFrac'], impact=r['impactBroken'], settle=r['settleBroken'],
                             structural=r['structuralBroken'], cosmetic=r['cosmeticBroken'], crushed=r['crushed'],
                             path1=within(1.0), path2=within(2.0), beyond2=int((dp >= 2.0).sum()),
                             held=r['structuralHeld'], roof=r['roofHeld'], through=r['penetration'] > 7.9 + 0.5 and r['exitSpeed'] > 0.05,
                             pen=r['penetration'] - s0, exit=r['exitSpeed'], stop=(r['stoppedBy'] or [None])[0],
                             impulse=r['deliveredImpulse'] / max(r['infiniteMassImpulse'], 1e-9), solves=r['solvesPerTick'],
                             seconds=r['wallSeconds']))
    order = {k: i for i, k in enumerate(['A', 'C', 'E', 'C+E', 'Ci+E', 'E coupled', 'C+E coupled', 'Ci+E coupled'])}
    scen = ['truck', 'truck-corner', 'cannonball', 'meteor', 'small-1.52', 'small-0.34', 'small+0.86']
    rows.sort(key=lambda r: (scen.index(r['scenario']) if r['scenario'] in scen else 99, order.get(r['option'], 99)))
    print('| scenario | option | bonds broken | impact / settle | frame / skin | crushed | breaks <1 m / <2 m / >=2 m of path | frame held | roof held | got in (speed left) | stopped by | contact impulse / initial momentum | QP solves per tick |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        # The house is 7.8 m deep: past that with speed left it went through.
        pen = (f"through ({r['exit']:.0f} m/s)" if r['exit'] > 0.05 and r['pen'] >= 7.8 else
               f"{min(r['pen'], 7.8):.1f} m in" + (f" ({r['exit']:.0f} m/s)" if r['exit'] > 0.05 else ', stopped'))
        print(f"| {r['scenario']} | {r['option']} | {100*r['broken']:.1f}% | {r['impact']} / {r['settle']} | {r['structural']} / {r['cosmetic']} | {r['crushed']} | "
              f"{r['path1']} / {r['path2']} / {r['beyond2']} | {100*r['held']:.0f}% | {100*r['roof']:.0f}% | {pen} | {r['stop'] or '-'} | {r['impulse']:.2f} | {r['solves']} |")


if __name__ == '__main__':
    main()
