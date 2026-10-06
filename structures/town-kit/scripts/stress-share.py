#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Where a load goes in an authored structure, on the CPU, before any GPU run.

The native stress solve is a minimum-weighted-norm impulse problem (Blast
stress.cpp / bond.h BondMatrix::colScale): bond impulses J (3 linear, 3
angular each) that put every non-anchored chunk in equilibrium and minimise
sum |J_b|^2 / w_b^2, w_b = sqrt(E A / L) (physx-bridge append_bonds). That
answer does not depend on chunk masses (they only precondition it), so it can
be computed here exactly with a sparse least-squares solve, and each bond's
stresses taken with the solver's own formula (NvBlastExtStressFormula.h:
section-modulus bending and torsion with the gain capped at 3, fibre
tension = normal + bend) against its material's elastic and fatal limits.

    uv run structures/town-kit/scripts/stress-share.py PACK [--force X Y Z --at NODE|--near X Y Z] [--top 20]

Gravity always; --force adds a point load (N) on a chunk, e.g. a vehicle's
contact. Prints the most utilised bonds and, per bond material, how many are
past elastic and past fatal. Validated against the GPU's own at-rest rows
(VIBE_QUALIFY_BOND_ROWS) with --rows.
"""
import argparse, json, sys
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

G = 9.81


def load(path):
    pack = json.load(open(path))
    s, mats = pack['scenario'], pack['defaults']['solver']['materials']
    pos = np.array([[n['centroid'][k] for k in 'xyz'] for n in s['nodes']])
    mass = np.array([n['mass'] for n in s['nodes']])
    # A hull's node position is its reference point (hull-origins.mjs moves it
    # to the AABB corner); PhysX uses the hull's true centre of mass.
    from scipy.spatial import ConvexHull
    for i, c in enumerate(s['nodeColliders']):
        if c['kind'] == 'shape': c = s['shapeLibrary'][c['shape']]
        if c['kind'] != 'convex_hull': continue
        p = np.array(c['points']).reshape(-1, 3)
        h = ConvexHull(p); o = p.mean(0); vol = 0.0; com = np.zeros(3)
        for f in h.simplices:
            a, b2, d = p[f[0]] - o, p[f[1]] - o, p[f[2]] - o
            v = abs(np.dot(a, np.cross(b2, d))) / 6; vol += v; com += v * (a + b2 + d) / 4
        pos[i] = pos[i] + o + com / vol
    return pack, s, mats, pos, mass


def solve(s, mats, pos, mass, extra=None):
    n = len(s['nodes']); bonds = s['bonds']; m = len(bonds)
    free = mass > 0
    row = -np.ones(n, dtype=int); row[free] = np.arange(free.sum())
    rows, cols, vals = [], [], []
    w = np.empty(m)
    # The solver measures angular impulse in units of its mean bond offset
    # (NvBlastExtStressGpu m_lengthScale): the norm it minimises is
    # |linear|^2 + |angular / Ls|^2.
    offs = [np.linalg.norm(np.array([bd['centroid'][k] for k in 'xyz']) - pos[q]) for bd in bonds for q in (bd['node0'], bd['node1']) if mass[q] > 0]
    Ls = float(np.mean(offs)) if offs else 1.0
    for b, bd in enumerate(bonds):
        i, j = bd['node0'], bd['node1']
        c = np.array([bd['centroid'][k] for k in 'xyz'])
        E = mats[bd['m']].get('elasticModulus') or 30e9
        L = max(np.linalg.norm(pos[i] - pos[j]), 0.05)
        w[b] = np.sqrt(E / 30e9 * max(bd['area'], 1e-4) / L)
        # J (6) acts on node1 as +, node0 as -: force rows 0..2, torque rows 3..5 (about the node).
        for node, sign in ((j, 1.0), (i, -1.0)):
            r = row[node]
            if r < 0: continue
            arm = c - pos[node]
            for k in range(3):
                rows.append(6 * r + k); cols.append(6 * b + k); vals.append(sign * w[b])          # force from linear
                rows.append(6 * r + 3 + k); cols.append(6 * b + 3 + k); vals.append(sign * w[b] * Ls)  # torque from angular
            # torque from linear: arm x L
            X = np.array([[0, -arm[2], arm[1]], [arm[2], 0, -arm[0]], [-arm[1], arm[0], 0]])
            for a in range(3):
                for k in range(3):
                    if X[a, k] != 0:
                        rows.append(6 * r + 3 + a); cols.append(6 * b + k); vals.append(sign * w[b] * X[a, k])
    A = sp.csr_matrix((vals, (rows, cols)), shape=(6 * free.sum(), 6 * m))
    f = np.zeros(6 * free.sum())
    for node in np.nonzero(free)[0]:
        f[6 * row[node] + 1] = mass[node] * G           # bonds must supply +m g (up) against gravity
    if extra:
        for node, force in extra:
            f[6 * row[node]:6 * row[node] + 3] -= force  # and minus any applied load
    y = spla.lsqr(A, f, atol=1e-12, btol=1e-12, iter_lim=200000)[0]
    resid = np.linalg.norm(A @ y - f) / max(np.linalg.norm(f), 1e-30)
    J = (y.reshape(m, 6) * w[:, None])
    J[:, 3:] *= Ls
    return J, resid


def stresses(s, mats, J):
    out = []
    for b, bd in enumerate(s['bonds']):
        n = np.array([bd['normal'][k] for k in 'xyz']); a = bd['area']
        lin, ang = J[b, :3], J[b, 3:]
        ln = lin @ n
        normal = -ln / a                                   # + tension (pulling node1 back toward node0)
        shear = np.linalg.norm(lin - ln * n) / a
        an = ang @ n
        twist = abs(an) / a; bend = np.linalg.norm(ang - an * n) / a
        gt = min(4.81 / np.sqrt(max(a, 1e-6)), 3.0); gb = min(6.0 / np.sqrt(max(a, 1e-6)), 3.0)
        shear += twist * gt; bend *= gb
        tension = max(normal + bend, 0.0); compression = max(bend - normal, 0.0)
        m = mats[bd['m']]
        util = max(compression / m['compressionElastic'], tension / m['tensionElastic'], shear / m['shearElastic'])
        fatal = max(compression / m['compressionFatal'], tension / m['tensionFatal'], shear / m['shearFatal'])
        out.append((util, fatal, compression, tension, shear, bend))
    return np.array(out)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('pack'); p.add_argument('--force', nargs=3, type=float); p.add_argument('--at', type=int)
    p.add_argument('--near', nargs=3, type=float); p.add_argument('--top', type=int, default=15)
    p.add_argument('--rows', help='GPU bond rows (VIBE_QUALIFY_BOND_ROWS) to compare at rest')
    a = p.parse_args()
    pack, s, mats, pos, mass = load(a.pack)
    extra = None
    if a.force:
        node = a.at if a.at is not None else int(np.argmin([np.linalg.norm(pos[i] - a.near) if mass[i] > 0 else 1e9 for i in range(len(pos))]))
        extra = [(node, np.array(a.force))]
        print(f'load {a.force} N on node {node} ({s["nodeTypes"][node]} at {pos[node].round(2).tolist()})')
    J, resid = solve(s, mats, pos, mass, extra)
    st = stresses(s, mats, J)
    print(f'equilibrium residual {resid:.1e}; bonds {len(st)}; past elastic {int((st[:, 0] > 1).sum())}, past fatal {int((st[:, 1] > 1).sum())}')
    t = s['nodeTypes']
    name = lambda i: f'{t[i]}#{i}({",".join(f"{x:.2f}" for x in pos[i])})'
    for b in np.argsort(-st[:, 0])[:a.top]:
        bd = s['bonds'][b]
        print(f'  {st[b,0]:7.2f} x elastic ({st[b,1]:6.2f} fatal) {mats[bd["m"]]["name"]:22} {name(bd["node0"])} - {name(bd["node1"])}  c {st[b,2]:.2e} t {st[b,3]:.2e} s {st[b,4]:.2e} bend {st[b,5]:.2e}')
    by = {}
    for b, bd in enumerate(s['bonds']):
        by.setdefault(mats[bd['m']]['name'], []).append(st[b])
    for k, v in sorted(by.items()):
        v = np.array(v)
        print(f'  {k:24} {len(v):5}  median {np.median(v[:,0]):.3f}  max {v[:,0].max():8.2f}  >elastic {int((v[:,0]>1).sum()):4}  >fatal {int((v[:,1]>1).sum()):4}')
    if a.rows:
        rows = json.load(open(a.rows))['snapshots'][0]['rows']
        gpu = np.array([r['utilisation'] for r in rows]); cpu = st[[r['bond'] for r in rows], 0]
        ok = gpu > 0.05
        print(f'GPU at-rest utilisation vs this: median ratio {np.median(cpu[ok] / gpu[ok]):.3f}, p10 {np.percentile(cpu[ok]/gpu[ok],10):.3f}, p90 {np.percentile(cpu[ok]/gpu[ok],90):.3f} over {ok.sum()} bonds')


if __name__ == '__main__':
    main()
