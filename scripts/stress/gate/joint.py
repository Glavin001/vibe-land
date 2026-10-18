#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Oracle forces on one material's bonds: force in the bond frame, moment,
stresses and limits.  joint.py PACK MATERIAL [N]  (MIN_FATAL=1: only those
past fatal; the what-ifs of overloads.py apply)."""
import sys, os, importlib.util, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import overloads as ov
ss = ov.ss
pack, s, mats, pos, mass = ss.load(sys.argv[1]); want = sys.argv[2]
sec = ov.whatif(s, mats)
J, _ = ss.solve(s, mats, pos, mass, angular='section', sections=sec)
st = ss.stresses(s, mats, J, bending='section', sections=sec, pos=pos)
t = [x.split('@')[0] for x in s['nodeTypes']]
shown = 0
for b, bd in enumerate(s['bonds']):
    m = mats[bd['m']]
    if m['name'] != want or st[b, 1] < float(os.environ.get('MIN_FATAL', '-1')): continue
    if shown == 0: print({k: v for k, v in m.items() if not isinstance(v, (dict, list))})
    if shown >= int(sys.argv[3] if len(sys.argv) > 3 else 4): break
    shown += 1
    n = np.array([bd['normal'][k] for k in 'xyz'], float); n /= np.linalg.norm(n)
    if n @ (pos[bd['node1']] - pos[bd['node0']]) < 0: n = -n
    F, M = J[b, :3], J[b, 3:6]
    print(f"bond {b} {t[bd['node0']]}@{np.round(pos[bd['node0']],2)} - {t[bd['node1']]}@{np.round(pos[bd['node1']],2)} area {bd['area']:.5f} n {n.round(2)} section {'yes' if sec[b] is not None else 'fallback'}")
    print(f"   F {F.round(1)} N (normal {F @ n:.1f}, shear {np.linalg.norm(F - (F @ n) * n):.1f}); M {M.round(1)} N m (twist {M @ n:.1f}); util {st[b,0]:.2f} fatal {st[b,1]:.2f} comp {st[b,2]/1e6:.3f} tens {st[b,3]/1e6:.3f} shear {st[b,4]/1e6:.3f} bend {st[b,5]/1e6:.3f} MPa")
