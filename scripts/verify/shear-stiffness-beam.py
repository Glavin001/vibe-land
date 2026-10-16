#!/usr/bin/env python3
"""The stage's anisotropic joint stiffness on a component past the block solver's
size (FIDELITY_AUDIT D11): a deep masonry beam of 9,600 chunks on two end
supports, its joints G = 0.4 E (EN 1996-1-1 3.8.3), solved by the GPU's
multilevel path and by the FP64 oracle (stress-share.py, the same model).

    shear-stiffness-beam.py make PACK [--gamma 0.4]       write the beam pack
    shear-stiffness-beam.py compare PACK ROWS              GPU rows vs the oracle

compare exits 1 unless every bond's normal and shear stress is within 0.1% of
the largest (and prints how far the isotropic oracle is, to show the case
discriminates). ROWS: VIBE_QUALIFY_BOND_ROWS from scripts/perf/qualify_structures.py.
"""
import argparse, importlib.util, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))


def make(path, gamma, nx=120, ny=80, h=0.1, rho=2000.0, y0=2.0):
    mat = {"name": "beam-masonry", "compressionElastic": 1e12, "compressionFatal": 1e12, "tensionElastic": 1e12, "tensionFatal": 1e12,
           "shearElastic": 1e12, "shearFatal": 1e12, "elasticModulus": 10.5e9, "residualAreaFraction": 0, "density": rho}
    if gamma != 1: mat["shearStiffnessRatio"] = gamma
    nodes, sizes, coll, types, mats, groups, bonds = [], [], [], [], [], [], []
    def add(c, m, size):
        nodes.append({"centroid": {"x": c[0], "y": c[1], "z": c[2]}, "mass": m, "volume": size[0] * size[1] * size[2], "m": 0})
        sizes.append({"x": size[0], "y": size[1], "z": size[2]})
        coll.append({"kind": "cuboid", "halfExtents": {"x": size[0] / 2, "y": size[1] / 2, "z": size[2] / 2}})
        types.append("wall" if m > 0 else "foundation"); mats.append("beam-masonry"); groups.append("beam@beam")
        return len(nodes) - 1
    idx = {(i, j): add((i * h, y0 + j * h, 0.0), rho * h ** 3, (h, h, h)) for j in range(ny) for i in range(nx)}
    left = add((-h, y0 + (ny - 1) * h / 2, 0.0), 0.0, (h, ny * h, h))
    right = add((nx * h, y0 + (ny - 1) * h / 2, 0.0), 0.0, (h, ny * h, h))
    def bond(a, b, c, n):
        bonds.append({"node0": a, "node1": b, "centroid": {"x": c[0], "y": c[1], "z": c[2]}, "normal": {"x": n[0], "y": n[1], "z": n[2]}, "area": h * h, "m": 0})
    for j in range(ny):
        for i in range(nx):
            if i + 1 < nx: bond(idx[i, j], idx[i + 1, j], ((i + 0.5) * h, y0 + j * h, 0), (1, 0, 0))
            if j + 1 < ny: bond(idx[i, j], idx[i, j + 1], (i * h, y0 + (j + 0.5) * h, 0), (0, 1, 0))
        bond(left, idx[0, j], (-0.5 * h, y0 + j * h, 0), (1, 0, 0))
        bond(idx[nx - 1, j], right, ((nx - 0.5) * h, y0 + j * h, 0), (1, 0, 0))
    pack = {"version": 2, "key": "shear-stiffness-beam", "title": "shear stiffness beam",
            "defaults": {"solver": {"gravity": -9.81, "materials": [mat]}},
            "scenario": {"nodes": nodes, "bonds": bonds, "nodeSizes": sizes, "nodeColliders": coll, "nodeTypes": types,
                         "nodeMaterials": mats, "nodeGroups": groups}}
    json.dump(pack, open(path, 'w'))
    print(f'{path}: {len(nodes)} nodes, {len(bonds)} bonds, gamma {gamma}')


def oracle(path, shear):
    os.environ['VIBE_SHEAR_STIFFNESS'] = '1' if shear else '0'
    spec = importlib.util.spec_from_file_location(f'ss{int(shear)}', os.path.join(ROOT, 'structures', 'town-kit', 'scripts', 'stress-share.py'))
    ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
    import numpy as np
    pack, s, mats, pos, mass = ss.load(path)
    sec = ss.fastener_twist(s, mats, ss.bond_sections(s))
    J, resid = ss.solve(s, mats, pos, mass, None, angular='section', sections=sec)
    n, v = [], []
    for b, bd in enumerate(s['bonds']):
        nv = np.array([bd['normal'][k] for k in 'xyz'], float); nv /= np.linalg.norm(nv)
        if nv @ (pos[bd['node1']] - pos[bd['node0']]) < 0: nv = -nv
        ln = J[b, :3] @ nv
        n.append(-ln / bd['area']); v.append(np.linalg.norm(J[b, :3] - ln * nv) / bd['area'])
    return np.array(n), np.array(v), resid


def compare(path, rows_path):
    import numpy as np
    snap = json.load(open(rows_path))['snapshots'][-1]
    rows = {x['bond']: x for x in snap['rows']}
    gn = np.array([rows[b]['normal'] for b in range(len(rows))]); gv = np.array([rows[b]['shear'] for b in range(len(rows))])
    worst = 0.0
    for shear in (True, False):
        n, v, resid = oracle(path, shear)
        dn = np.abs(gn - n).max() / np.abs(n).max(); dv = np.abs(gv - v).max() / v.max()
        print(f'oracle {"with" if shear else "WITHOUT"} shear stiffness (residual {resid:.1e}): normal stress off by at most {dn:.4%} '
              f'of the largest, shear stress {dv:.4%}')
        if shear: worst = max(dn, dv)
    print('PASS' if worst < 1e-3 else 'FAIL', f'(tick {snap["tick"]}; allowed 0.1%)')
    return 0 if worst < 1e-3 else 1


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('what', choices=['make', 'compare']); p.add_argument('pack'); p.add_argument('rows', nargs='?')
    p.add_argument('--gamma', type=float, default=0.4)
    a = p.parse_args()
    if a.what == 'make': make(a.pack, a.gamma)
    else: sys.exit(compare(a.pack, a.rows))
