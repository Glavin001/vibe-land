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


def _chunk_points(s, i):
    """Chunk i's collision vertices in the pack frame."""
    c = s['nodeColliders'][i]
    if c['kind'] == 'shape': c = s['shapeLibrary'][c['shape']]
    p0 = np.array([s['nodes'][i]['centroid'][k] for k in 'xyz'])
    if c['kind'] == 'cuboid':
        h = np.array([c['halfExtents'][k] for k in 'xyz'])
        return p0 + np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]) * h
    return p0 + np.array(c['points']).reshape(-1, 3)


def _hull2d(p):
    p = sorted(set(map(tuple, np.round(p, 9))))
    if len(p) < 3: return np.array(p)
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for q in p:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], q) <= 0: lo.pop()
        lo.append(q)
    for q in reversed(p):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], q) <= 0: hi.pop()
        hi.append(q)
    return np.array(lo[:-1] + hi[:-1])


def _slice(P, c, n, U, V, tol):
    """The convex chunk's cross-section in the bond plane (2D, U/V coordinates).
    A chunk that stops short of the plane (an authored gap: a column over its
    footing's plinth, a clip off its panel, a tie across a cavity) is cut at
    its face nearest the plane -- the face the bond joins."""
    d = (P - c) @ n
    if d.min() > tol: c = c + n * d.min(); d = d - d.min()
    elif d.max() < -tol: c = c + n * d.max(); d = d - d.max()
    pts = [P[np.abs(d) <= tol]]
    a, b = P[d < -tol], P[d > tol]
    if len(a) and len(b):
        da, db = d[d < -tol][:, None, None], d[d > tol][None, :, None]
        t = da / (da - db)
        pts.append((a[:, None, :] + t * (b[None, :, :] - a[:, None, :])).reshape(-1, 3))
    q = np.concatenate(pts) - c
    return _hull2d(np.stack([q @ U, q @ V], 1)) if len(q) >= 3 else np.zeros((0, 2))


def _clip(A, B):
    """Sutherland-Hodgman: convex A clipped by convex B (both counter-clockwise)."""
    out = list(A)
    for k in range(len(B)):
        if not out: break
        e0, e1 = B[k], B[(k + 1) % len(B)]
        inside = lambda p: (e1[0] - e0[0]) * (p[1] - e0[1]) - (e1[1] - e0[1]) * (p[0] - e0[0]) >= -1e-12
        src, out = out, []
        for i in range(len(src)):
            p, q = src[i], src[(i + 1) % len(src)]
            if inside(q):
                if not inside(p): out.append(_cut(p, q, e0, e1))
                out.append(q)
            elif inside(p): out.append(_cut(p, q, e0, e1))
    return np.array(out)


def _cut(p, q, e0, e1):
    r, s_ = q - p, e1 - e0
    den = r[0] * s_[1] - r[1] * s_[0]
    t = ((e0[0] - p[0]) * s_[1] - (e0[1] - p[1]) * s_[0]) / den if den else 0.0
    return p + t * r


def bond_sections(s, tol=1e-4):
    """Each bond's real cross-section, from the two chunks' collision geometry.

    The contact patch is the intersection of the two convex chunks' sections in
    the bond plane (for two touching boxes, the overlap rectangle the town kit's
    builder computes). Returns, per bond, (axis1, axis2, S1, S2, Zt, r1, r2, rt)
    or None where the chunks' faces do not overlap in the bond plane: S1 is the elastic section modulus for bending
    about principal axis 1 (I about axis 1 over the extreme fibre's distance
    from it), Zt the polar modulus I_p / r_max (tau_max = T / Zt), r the
    radii of gyration (sqrt(I/A)) about axis 1, 2 and the normal, all of the
    overlap's shape scaled to the authored area.
    """
    out = []
    for bd in s['bonds']:
        n = np.array([bd['normal'][k] for k in 'xyz']); n = n / np.linalg.norm(n)
        c = np.array([bd['centroid'][k] for k in 'xyz'])
        U = np.cross(n, [1.0, 0, 0] if abs(n[0]) < 0.9 else [0, 1.0, 0]); U /= np.linalg.norm(U); V = np.cross(n, U)
        A = _slice(_chunk_points(s, bd['node0']), c, n, U, V, tol)
        B = _slice(_chunk_points(s, bd['node1']), c, n, U, V, tol)
        if len(A) < 3 or len(B) < 3: out.append(None); continue
        P = _clip(A, B)
        if len(P) < 3: out.append(None); continue
        x, y = P[:, 0], P[:, 1]; x1, y1 = np.roll(x, -1), np.roll(y, -1); cr = x * y1 - x1 * y
        area = cr.sum() / 2
        if not area > 1e-12: out.append(None); continue
        cx, cy = ((x + x1) * cr).sum() / (6 * area), ((y + y1) * cr).sum() / (6 * area)
        Ixx = ((x * x + x * x1 + x1 * x1) * cr).sum() / 12 - area * cx * cx   # int u^2
        Iyy = ((y * y + y * y1 + y1 * y1) * cr).sum() / 12 - area * cy * cy   # int v^2
        Ixy = ((x * y1 + 2 * x * y + 2 * x1 * y1 + x1 * y) * cr).sum() / 24 - area * cx * cy
        lam, vec = np.linalg.eigh(np.array([[Ixx, Ixy], [Ixy, Iyy]]))   # lam[k] = int (x.e_k)^2
        if abs(Ixx - Iyy) <= 1e-6 * (Ixx + Iyy) and abs(Ixy) <= 1e-6 * (Ixx + Iyy):
            # Isotropic (a square): every axis is principal; the corner-fibre
            # sum is beam theory only on the edges' axes, so take the longest edge.
            d = np.roll(P, -1, 0) - P; k = int(np.argmax((d * d).sum(1)))
            e0 = d[k] / np.linalg.norm(d[k]); vec = np.array([[e0[0], -e0[1]], [e0[1], e0[0]]])
            lam = np.array([vec[:, 0] @ np.array([[Ixx, Ixy], [Ixy, Iyy]]) @ vec[:, 0], vec[:, 1] @ np.array([[Ixx, Ixy], [Ixy, Iyy]]) @ vec[:, 1]])
        e = [vec[0, k] * U + vec[1, k] * V for k in (0, 1)]
        q = np.stack([x - cx, y - cy], 1)
        reach = [np.abs(q @ vec[:, k]).max() for k in (0, 1)]
        # Bending about e[0]: fibres vary along e[1]; I = lam[1], c = reach[1].
        S = (lam[1] / reach[1], lam[0] / reach[0])
        # Twist about the normal: the patch is an interface between two rigid
        # chunks, so its shear grows with distance from the centroid, as in a
        # weld or fastener group under torsion (AISC Manual Part 8, elastic
        # method): tau = T r_max / I_p, I_p = I_u + I_v.
        Zt = (lam[0] + lam[1]) / np.sqrt((q * q).sum(1).max())
        # The authored area is the contact; the geometry gives its shape. Where
        # they differ (a fastener inside a larger overlap) the patch is taken
        # as the overlap's shape scaled to the authored area: lengths by
        # sqrt(k), moduli by k^1.5, radii of gyration by sqrt(k).
        k = bd['area'] / area; k15, k05 = k ** 1.5, k ** 0.5
        out.append((e[0], e[1], S[0] * k15, S[1] * k15, Zt * k15,
                    np.sqrt(lam[1] / area) * k05, np.sqrt(lam[0] / area) * k05, np.sqrt((lam[0] + lam[1]) / area) * k05))
    return out


def solve(s, mats, pos, mass, extra=None, angular='uniform', sections=None):
    """angular='uniform': the engine (every bond's angular impulse weighted by
    the mean bond offset Ls). 'section': each bond's rotational stiffness from
    its own section, k_rot = k I / A per principal axis (and the polar I_p / A
    for twist, the solver's one stiffness for every direction), so a moment is
    as dear as the patch's real rotational compliance makes it; bonds without
    a section keep the square patch of their area (r^2 = A / 12)."""
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
    R = np.zeros((m, 3, 3))   # angular column block: J_ang = w R y_ang
    for b, bd in enumerate(bonds):
        if angular != 'section':
            R[b] = np.eye(3) * Ls; continue
        sec = sections[b] if sections is not None else None
        nrm = np.array([bd['normal'][k] for k in 'xyz']); nrm = nrm / np.linalg.norm(nrm)
        if sec is None:
            r = np.sqrt(max(bd['area'], 1e-12) / 12)
            R[b] = np.eye(3) * r; R[b] += (np.sqrt(2) - 1) * r * np.outer(nrm, nrm)   # polar of a square: 2 a^2/12
        else:
            e1, e2, _, _, _, r1, r2, rt = sec
            R[b] = r1 * np.outer(e1, e1) + r2 * np.outer(e2, e2) + rt * np.outer(nrm, nrm)
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
                for a2 in range(3):                                                                 # torque from angular
                    if R[b][a2, k] != 0:
                        rows.append(6 * r + 3 + a2); cols.append(6 * b + 3 + k); vals.append(sign * w[b] * R[b][a2, k])
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
    Y = y.reshape(m, 6)
    J = Y * w[:, None]
    J[:, 3:] = np.einsum('bij,bj->bi', R, Y[:, 3:]) * w[:, None]
    return J, resid


def stresses(s, mats, J, bending='capped', sections=None):
    """bending='capped': the engine (section gain 6/sqrt(A) capped at 3 /m,
    torsion 4.81/sqrt(A) capped likewise). 'section': the real section --
    sigma = |M1|/S1 + |M2|/S2 (the corner fibre of a rectangle under biaxial
    bending), tau = T/Zt; bonds without a section use the square patch of
    their area (6/sqrt(A), 3 sqrt(2)/sqrt(A)), uncapped."""
    out = []
    for b, bd in enumerate(s['bonds']):
        n = np.array([bd['normal'][k] for k in 'xyz']); n = n / np.linalg.norm(n); a = bd['area']
        lin, ang = J[b, :3], J[b, 3:]
        ln = lin @ n
        normal = -ln / a                                   # + tension (pulling node1 back toward node0)
        shear = np.linalg.norm(lin - ln * n) / a
        an = ang @ n
        twist = abs(an) / a; bend = np.linalg.norm(ang - an * n) / a
        sec = sections[b] if (bending == 'section' and sections is not None) else None
        if bending == 'section' and sec is not None:
            e1, e2, S1, S2, Zt = sec[:5]
            shear += abs(an) / Zt; bend = abs(ang @ e1) / S1 + abs(ang @ e2) / S2
        elif bending == 'section':
            shear += twist * 3 * np.sqrt(2) / np.sqrt(max(a, 1e-12)); bend *= 6.0 / np.sqrt(max(a, 1e-12))
        else:
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
    p.add_argument('--bending', choices=['capped', 'section'], default='capped',
                   help="bond bending/torsion stress: the engine's capped gain, or each bond's real section")
    p.add_argument('--angular', choices=['uniform', 'section'], default='uniform',
                   help="the solve's rotational stiffness per bond: the engine's uniform length scale, or each bond's section")
    a = p.parse_args()
    pack, s, mats, pos, mass = load(a.pack)
    sections = None
    if a.bending == 'section' or a.angular == 'section':
        sections = bond_sections(s)
        miss = sum(x is None for x in sections)
        ratio = [((x[2] * 6) / s['bonds'][b]['area']) for b, x in enumerate(sections) if x is not None]
        print(f'sections: {len(sections) - miss} from geometry, {miss} without (square patch of their area); '
              f'section depth h = 6 S1 / A: median {np.median(ratio):.3f} m, p10 {np.percentile(ratio, 10):.3f}, p90 {np.percentile(ratio, 90):.3f}')
    extra = None
    if a.force:
        node = a.at if a.at is not None else int(np.argmin([np.linalg.norm(pos[i] - a.near) if mass[i] > 0 else 1e9 for i in range(len(pos))]))
        extra = [(node, np.array(a.force))]
        print(f'load {a.force} N on node {node} ({s["nodeTypes"][node]} at {pos[node].round(2).tolist()})')
    J, resid = solve(s, mats, pos, mass, extra, angular=a.angular, sections=sections)
    st = stresses(s, mats, J, bending=a.bending, sections=sections)
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
