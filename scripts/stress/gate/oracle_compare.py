#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""GPU bond rows (VIBE_QUALIFY_BOND_ROWS, first snapshot) vs the CPU oracle
(stress-share.py, --bending/--angular as given). Prints stress agreement on
load-bearing bonds and the past-fatal sets."""
import argparse, importlib.util, json, os, sys
import numpy as np

spec = importlib.util.spec_from_file_location(
    'ss', os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../structures/town-kit/scripts/stress-share.py'))
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)

p = argparse.ArgumentParser()
p.add_argument('pack'); p.add_argument('rows')
p.add_argument('--bending', default='section'); p.add_argument('--angular', default='section')
p.add_argument('--snapshot', type=int, default=0)
a = p.parse_args()
pack, s, mats, pos, mass = ss.load(a.pack)
sections = ss.bond_sections(s) if 'section' in (a.bending, a.angular) else None
J, resid = ss.solve(s, mats, pos, mass, angular=a.angular, sections=sections)
st = ss.stresses(s, mats, J, bending=a.bending, sections=sections, pos=pos)  # util, fatal, comp, tens, shear, bend
snap = json.load(open(a.rows))['snapshots'][a.snapshot]
rows = snap['rows']
idx = np.array([r['bond'] for r in rows])
gpu = {k: np.array([r[k] for r in rows], float) for k in ('utilisation', 'compression', 'tension', 'shear', 'bend', 'remaining', 'area')}
broken = np.array([r['broken'] for r in rows])
cpu = st[idx]
# GPU fatal ratio from its stresses and the pack's limits
fatal, elastic = [], []
for r in rows:
    m = mats[s['bonds'][r['bond']]['m']]
    fatal.append(max(r['compression'] / m['compressionFatal'], r['tension'] / m['tensionFatal'], r['shear'] / m['shearFatal']))
    elastic.append(max(r['compression'] / m['compressionElastic'], r['tension'] / m['tensionElastic'], r['shear'] / m['shearElastic']))
fatal, elastic = np.array(fatal), np.array(elastic)
# Utilisation against the pack's own (real) limits: the GPU may have run raised ones.
gpu['utilisation'] = elastic
print(f"{a.pack.split('/')[-1]}: tick {snap['tick']}, {len(rows)} bonds, GPU broken {int(broken.sum())}, oracle residual {resid:.1e}")
live = ~broken & (gpu['remaining'] >= gpu['area'] * 0.999)
for name, g, c in [('utilisation', gpu['utilisation'], cpu[:, 0]), ('shear', gpu['shear'], cpu[:, 4]),
                   ('bend', gpu['bend'], cpu[:, 5]), ('tension', gpu['tension'], cpu[:, 3]), ('compression', gpu['compression'], cpu[:, 2])]:
    scale = np.maximum(np.abs(c), 1e-12)
    # load-bearing: utilisation over 5% on the oracle; error relative to the bond's largest stress
    big = np.maximum.reduce([cpu[:, 2], cpu[:, 3], cpu[:, 4], cpu[:, 5]])
    ok = live & (cpu[:, 0] > float(__import__('os').environ.get('LB_UTIL', '0.05')))
    err = np.abs(g - c)[ok] / np.maximum(big[ok], 1e-9) if name != 'utilisation' else np.abs(g - c)[ok] / np.maximum(c[ok], 1e-9)
    if ok.sum():
        print(f"  {name:12} over {ok.sum():5} load-bearing bonds: |gpu-cpu| / bond max  median {np.median(err):.2e}  p90 {np.percentile(err, 90):.2e}  max {err.max():.2e}")
cf, gf = set(idx[cpu[:, 1] > 1]), set(idx[(fatal > 1) | broken])
print(f"  past fatal: oracle {len(cf)}, GPU {len(gf)} (incl. broken), both {len(cf & gf)}, oracle only {sorted(cf - gf)[:12]}, GPU only {sorted(gf - cf)[:12]}")
ce, ge = set(idx[cpu[:, 0] > 1]), set(idx[gpu['utilisation'] > 1])
print(f"  past elastic: oracle {len(ce)}, GPU {len(ge)}, both {len(ce & ge)}")
