#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Oracle (section bending + section rotation): bonds past elastic and past
fatal at rest, by material and the member types joined.

What-ifs (diagnostics, not models):
  TWIST=mat:radius,...   the material's polar radius of gyration (m) in
                         place of the contact patch's (a fastener group)
  PIN_ALL=1              ... and its bending radii too
  STIFF=mat:factor,...   scale the material's modulus
  BEARING=mat,...        grade the material as a bearing joint with its
                         fasteners at the patch centre: no tension until the
                         contact opens; then the fasteners carry
                         T = |M0| / z1 + |M1| / z0 - C (z the half depth, C
                         the compression), checked against the joint's
                         tension capacity
"""
import sys, os, importlib.util, collections, numpy as np
spec = importlib.util.spec_from_file_location('ss', os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../structures/town-kit/scripts/stress-share.py'))
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)


def bearing_grade(s, mats, J, sec, st, pos):
    names = set(filter(None, os.environ.get('BEARING', '').split(',')))
    if not names: return st
    st = st.copy()
    for b, bd in enumerate(s['bonds']):
        m = mats[bd['m']]
        if m['name'] not in names or sec[b] is None: continue
        n = np.array([bd['normal'][k] for k in 'xyz'], float); n /= np.linalg.norm(n)
        if n @ (pos[bd['node1']] - pos[bd['node0']]) < 0: n = -n
        a = bd['area']; e0, e1, S0, S1, Zt, r0, r1, rt = sec[b][:8]
        F, M = J[b, :3], J[b, 3:6]
        compression = F @ n                     # the oracle's sign: + presses the chunks together
        z1, z0 = a * r0 * r0 / S0, a * r1 * r1 / S1   # half depths across each bending axis
        T = max(0.0, abs(M @ e0) / z1 + abs(M @ e1) / z0 - compression)
        shear = st[b, 4]
        comp_stress = max(compression, 0) / a + abs(M @ e0) / S0 + abs(M @ e1) / S1
        st[b, 0] = max(comp_stress / m['compressionElastic'], T / a / m['tensionElastic'], shear / m['shearElastic'])
        st[b, 1] = max(comp_stress / m['compressionFatal'], T / a / m['tensionFatal'], shear / m['shearFatal'])
    return st


def whatif(s, mats):
    sec = ss.bond_sections(s) if os.environ.get('NO_FASTENER_TWIST') else ss.fastener_twist(s, mats, ss.bond_sections(s))
    for kv in filter(None, os.environ.get('STIFF', '').split(',')):
        for m in mats:
            if m['name'] == kv.split(':')[0]: m['elasticModulus'] *= float(kv.split(':')[1])
    pin = {kv.split(':')[0]: float(kv.split(':')[1]) for kv in filter(None, os.environ.get('TWIST', '').split(','))}
    for b, bd in enumerate(s['bonds']):
        name = mats[bd['m']]['name']
        if name not in pin: continue
        r = sec[b]
        if r is None:
            a = np.sqrt(bd['area']); n = np.array([bd['normal'][k] for k in 'xyz'], float); n /= np.linalg.norm(n)
            u = np.cross(n, [1.0, 0, 0] if abs(n[0]) < 0.9 else [0, 1.0, 0]); u /= np.linalg.norm(u); v = np.cross(n, u)
            r = (u, v, a ** 3 / 6, a ** 3 / 6, a ** 3 / 4.81, a / np.sqrt(12), a / np.sqrt(12), a / np.sqrt(6))
        g = max(pin[name], 1e-6)
        sec[b] = r[:5] + ((g, g, g * 2 ** 0.5) if os.environ.get('PIN_ALL') else (r[5], r[6], g)) + tuple(r[8:])
    return sec


if __name__ == '__main__':
    pack, s, mats, pos, mass = ss.load(sys.argv[1])
    sec = whatif(s, mats)
    J, _ = ss.solve(s, mats, pos, mass, angular='section', sections=sec)
    st = ss.stresses(s, mats, J, bending='section', sections=sec, pos=pos)
    st = bearing_grade(s, mats, J, sec, st, pos)
    t = [x.split('@')[0] for x in s['nodeTypes']]
    el, fa = collections.Counter(), collections.Counter(); worst = collections.defaultdict(float)
    for b, bd in enumerate(s['bonds']):
        k = (mats[bd['m']]['name'], ' - '.join(sorted((t[bd['node0']], t[bd['node1']]))))
        if st[b, 0] > 1: el[k] += 1
        if st[b, 1] > 1: fa[k] += 1
        worst[k] = max(worst[k], st[b, 1])
    print(f"{sys.argv[1].split('/')[-1]}: past elastic {sum(el.values())}, past fatal {sum(fa.values())} of {len(s['bonds'])}")
    for k, n in el.most_common(int(os.environ.get('TOP', '10'))):
        print(f'   elastic {n:4}  fatal {fa[k]:4}  worst fatal util {worst[k]:6.2f}  {k}')
