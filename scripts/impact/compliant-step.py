#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""Every impact contact compliant: a shot through a structure as one explicit window (CPU, FP64 or
FP32; a research harness and the kernel's specification, never a runtime path).

The infinite walls (IMPACT_STEP_PLAN.md, hand-off, open problems 1-2): a struck chunk crushed in the
trial pass is skipped by routing, and the next layer is met in the corrected pass as a rigid stop no
model evaluated. Here every contact between the fast body and a structural chunk is a compliant row
of the explicit step, the chunks it meets later in the window included, and crushing happens in the
row, paid by the striker:

  rows    sphere (the impactor, rigid) against each chunk's convex hull, found every substep from
          the bodies' positions (the kernel's equivalent: the stage's rows with their signed gap,
          IMPACT_STEP_PLAN.md status 2026-10-08); the normal force a flat contact's, Johnson's punch
          k = 2 a E* (contact_law.py, the two-body agent's law, shared), integrated by backward
          Euler; friction the pair's Coulomb coefficient
  crush   a row's contact pressure F_N / (pi a^2) reaching the chunk material's crush strength (its
          own Drucker-Prager cone and cap, extStressCrushStep, read uniaxially: q = sigma, p =
          sigma / 3, so sigma_y = min(c / (1 - s / 3), 3 p_cap)) starts the crush; the row then
          carries the material's plateau pressure, its crush energy density e_c (J/m^3 = Pa: the
          work per crushed volume is the plateau stress, Gibson & Ashby, Cellular Solids, 1997,
          ch. 5), at most sigma_y, over the contact area, and the depth beyond the elastic one is
          crushed (delta_p). The work F delta_p is the striker's. The chunk is crushed through when
          delta_p reaches its depth along the row; then it is a free body (its joints break,
          PX_DESTRUCTION_CRUSH_CORRECTION) that rows no longer meet. A chunk the striker stops in
          keeps its partial crush (damage delta_p / depth).
  joints  the stage's (impc.prepare_bond: frame, wrench points, capacities, stiffness), brittle at
          capacity, ductile with radial return and slip to failure; J0 the dead load's elastic state
  window  symplectic Euler at h = min(0.9 x 2 / omega_max, the rows' sqrt(3 eps / (W k)), 50 us)
          (contact_law.row_step; eps 0.1, the kernel's), over as many ticks as the passage takes
          (routing applies on every tick of contact, IMPACT_STEP_PLAN.md section 1)

--rows rigid: the same window with rigid unilateral rows (Moreau, explicit-step.cone_coulomb) and no
crush in the step: today's step if every row were routed.

    uv run scripts/impact/compliant-step.py --case wm-masonry-meteor-0 [--rows compliant|rigid] [--fp32] [--json OUT]

Inputs: the stage's structure from a capture (.impc, impc.py) of the scene before the shot; chunk
hulls and the case's aim from the lab pack and its trial meta; the impactor's mass, radius and speed
from the test bed's probe (a run report) or the flags.
"""
import argparse, importlib.util, json, pathlib, sys, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spl
from scipy.spatial import ConvexHull, cKDTree

H = pathlib.Path(__file__).resolve().parent
ROOT = H.parent.parent
sys.path.insert(0, str(H))
import impc, contact_law as law
_s = importlib.util.spec_from_file_location('explicit_step', H / 'explicit-step.py')
ex = importlib.util.module_from_spec(_s); _s.loader.exec_module(ex)

G = 9.81
# the inputs live in the main checkout's target/ (a worktree has none of its own)
import subprocess
try: MAIN = pathlib.Path(subprocess.run(['git', '-C', str(H), 'rev-parse', '--path-format=absolute', '--git-common-dir'], capture_output=True, text=True).stdout.strip()).parent
except Exception: MAIN = ROOT
DEFAULT_CAPTURE = MAIN / '.claude/worktrees/impact-e/target/impact-capture/wm2/wm-masonry-meteor-0-r1/impact-235-prior.impc'
DEFAULT_PACK = MAIN / 'target/fidelity/high/structures/vehicle-lab/out/vehicle-lab-crush.json'
DEFAULT_META = MAIN / 'target/verify/meteor-floor-l/high/lab.meta.json'
EPS_ROW = 0.1        # Settings::explicitAccuracy (the two-body agent's)
H_CAP = 50e-6        # Settings::explicitMaxStep
SAFETY = 0.9         # Settings::explicitSafety
# The test bed's projectiles (server/src/vehicle_testbed.rs probe; the run reports' `probe`).
PROJECTILES = {'meteor': (110584.0625, 2.0), 'cannonball': (10650.0, 0.6870), 'ball100': (100.0, 0.14488183), 'ball1000': (1000.0, 0.31213844)}


class Scene:
    """The struck structure near the shot's line: chunks (nodes), their hulls, joints, the impactor."""

    def __init__(self, C, pack, path0, d, radius, length, margin, exclude=('terrain', 'debris')):
        self.C = C; S = pack['scenario']
        P = np.array([[n['centroid'][k] for k in 'xyz'] for n in S['nodes']])
        dist, idx = cKDTree(P).query(C.chunks['position'].astype(float))
        lib = S['shapeLibrary']
        # each mapped chunk's hull (world, at rest); the stage's chunks are the pack's nodes in the
        # structures' (kinematic, world-aligned) cluster frames
        self.hull = {}; self.group = {}
        a, b = path0, path0 + d * length
        for c in range(C.n):
            if dist[c] > 1e-3: continue
            k = int(idx[c]); g = S['nodeGroups'][k]
            if g.split('@')[0] in exclude: continue
            col = S['nodeColliders'][k]
            if col['kind'] == 'cuboid':
                e = np.array([col['halfExtents'][q] for q in 'xyz'])
                V = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) * e
            else:
                V = np.array(lib[col['shape']]['points'], float).reshape(-1, 3)
            p = C.chunks['position'][c].astype(float)
            rb = float(np.max(np.linalg.norm(V, axis=1)))
            # distance from the swept segment
            t = np.clip((p - a) @ d / (length if length > 0 else 1.0), 0, 1) if length > 0 else 0.0
            if np.linalg.norm(p - (a + d * length * t)) - rb > radius + margin: continue
            self.hull[c] = (V, rb); self.group[c] = g
        chunks = sorted(self.hull)
        self.chunks = chunks
        # nodes: the patch's chunks; joints: their live bonds (an end off the patch, or a support, is held)
        self.index = {c: i for i, c in enumerate(chunks)}
        bonds = sorted({i for c in chunks for i in C.chunk_bonds(c) if C.member(i)})
        self.joints = [j for j in (C.prepare_bond(i) for i in bonds) if j is not None]

    def hull_planes(self):
        """Each hull's triangles and outward planes (local), and its depth extent function."""
        self.tri, self.planes = {}, {}
        for c, (V, rb) in self.hull.items():
            h = ConvexHull(V)
            self.tri[c] = V[h.simplices]                       # (t, 3, 3)
            self.planes[c] = h.equations                       # n . x + e <= 0 inside


def closest_on_triangles(p, T):
    """Ericson's closest point on each triangle T (t, 3, 3) to p: (t, 3)."""
    a, b, c = T[:, 0], T[:, 1], T[:, 2]
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = np.einsum('ij,ij->i', ab, ap), np.einsum('ij,ij->i', ac, ap)
    bp = p - b; d3, d4 = np.einsum('ij,ij->i', ab, bp), np.einsum('ij,ij->i', ac, bp)
    cp = p - c; d5, d6 = np.einsum('ij,ij->i', ab, cp), np.einsum('ij,ij->i', ac, cp)
    vc = d1 * d4 - d3 * d2; vb = d5 * d2 - d1 * d6; va = d3 * d6 - d5 * d4
    out = np.empty_like(a)
    den = va + vb + vc; den = np.where(np.abs(den) > 0, den, 1.0)
    v = vb / den; w = vc / den
    out[:] = a + ab * v[:, None] + ac * w[:, None]
    m = (d1 <= 0) & (d2 <= 0); out[m] = a[m]
    m2 = (d3 >= 0) & (d4 <= d3); out[m2] = b[m2]
    m3 = (vc <= 0) & (d1 >= 0) & (d3 <= 0) & ~m & ~m2
    t3 = d1 / np.where(d1 - d3 != 0, d1 - d3, 1.0); out[m3] = (a + ab * t3[:, None])[m3]
    m4 = (d6 >= 0) & (d5 <= d6) & ~m & ~m2 & ~m3; out[m4] = c[m4]
    m5 = (vb <= 0) & (d2 >= 0) & (d6 <= 0) & ~m & ~m2 & ~m3 & ~m4
    t5 = d2 / np.where(d2 - d6 != 0, d2 - d6, 1.0); out[m5] = (a + ac * t5[:, None])[m5]
    m6 = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0) & ~m & ~m2 & ~m3 & ~m4 & ~m5
    t6 = (d4 - d3) / np.where((d4 - d3) + (d5 - d6) != 0, (d4 - d3) + (d5 - d6), 1.0); out[m6] = (b + (c - b) * t6[:, None])[m6]
    return out


def sphere_hull(center, r, T, E):
    """Sphere (center, r) against a convex hull (triangles T, planes E, both in the hull's frame at the
    origin): (penetration depth, unit normal from the hull to the sphere, contact point)."""
    s = E[:, :3] @ center + E[:, 3]
    if np.all(s <= 0):                                       # the centre inside: the nearest face
        f = int(np.argmax(s)); n = E[f, :3]
        return r - s[f], n, center - n * s[f]
    q = closest_on_triangles(center, T); dd = np.linalg.norm(q - center, axis=1); i = int(np.argmin(dd))
    if not dd[i] > 0: return r, E[int(np.argmax(s)), :3], q[i]
    return r - dd[i], (center - q[i]) / dd[i], q[i]


def frame(n):
    e = np.array([1.0, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 1.0, 0])
    t1 = np.cross(n, e); t1 /= np.linalg.norm(t1); return np.array([n, t1, np.cross(n, t1)])


def skew(r):
    return np.array([[0, -r[2], r[1]], [r[2], 0, -r[0]], [-r[1], r[0], 0]])


def run(case, args):
    C = impc.Capture(args.capture)
    pack = json.loads(pathlib.Path(args.pack).read_text())
    meta = json.loads(pathlib.Path(args.meta).read_text())
    trial = next(t for t in meta['trials'] if t['id'] == case)
    att = trial['attack']
    proj = 'ball100' if att.get('mass') == 100 else 'ball1000' if att.get('mass') == 1000 else att['projectile']
    m_imp, r = PROJECTILES[proj]
    v_in = args.speed if args.speed else {'meteor': 139.8253, 'cannonball': 59.988, 'ball100': 59.988, 'ball1000': 59.988}[proj]
    b = np.radians(att.get('from', 0)); d = np.array([-np.sin(b), -att.get('slope', 0), -np.cos(b)]); d /= np.linalg.norm(d)
    target = np.array(att['target'], float)
    T_max = args.ticks * C.settings['dt']
    length = v_in * T_max + 4 * r
    start = target - d * (r + 2.0 * r)
    sc = Scene(C, pack, start, d, r, length + 2 * r, args.margin)
    sc.hull_planes()
    chunks = sc.chunks; nc = len(chunks)
    pos0 = C.chunks['position'][chunks].astype(float)
    mass = C.chunks['mass'][chunks].astype(float); inert = C.chunks['inertia'][chunks].astype(float)
    dyn = mass > 0
    # the sphere's start: just clear of every hull along its line
    s_lo = 0.0
    def overlap(cen):
        for i, c in enumerate(chunks):
            V, rb = sc.hull[c]
            if np.linalg.norm(cen - pos0[i]) > r + rb: continue
            if sphere_hull(cen - pos0[i], r, sc.tri[c], sc.planes[c])[0] > 0: return True
        return False
    s = 0.0
    while not overlap(start + d * (s + 0.05)) and s < length: s += 0.05
    lo, hi = s, s + 0.05
    for _ in range(30):
        mid = 0.5 * (lo + hi)
        if overlap(start + d * mid): hi = mid
        else: lo = mid
    c_imp = start + d * lo
    # nodes: chunks then the impactor (index nc)
    nn = nc + 1
    held = lambda c: c not in sc.index or not dyn[sc.index[c]]
    J = []
    for j in sc.joints:
        a_on, b_on = j['c0'] in sc.index, j['c1'] in sc.index
        if not (a_on or b_on): continue
        J.append(j)
    nl = len(J)
    rows_i, cols_i, vals = [], [], []
    for l, j in enumerate(J):
        Rm = j['R']
        for e, (c, o, sgn) in enumerate(((j['c0'], j['o0'], 1.0), (j['c1'], j['o1'], -1.0))):
            if held(c): continue
            k = sc.index[c]
            for q in range(6):
                lin = Rm[q] if q < 3 else np.zeros(3); ang = Rm[q - 3] if q >= 3 else np.zeros(3)
                w = np.concatenate([sgn * lin, sgn * (np.cross(o, lin) - ang)])
                for rr in range(6):
                    if w[rr] != 0.0: rows_i.append(6 * k + rr); cols_i.append(6 * l + q); vals.append(w[rr])
    B = sp.csr_matrix((vals, (rows_i, cols_i)), shape=(6 * nn, 6 * nl)); Bt = B.T.tocsr()
    kk = np.array([j['k'] for j in J]).reshape(nl, 6); F = np.array([j['F'] for j in J]).reshape(nl, 9)
    ductile = np.array([j['slip'] > 0 for j in J]); limit = np.array([j['slip'] for j in J])
    jchunks = np.array([[j['c0'], j['c1']] for j in J])
    centroid = np.array([j['centroid'] for j in J])
    minv = np.zeros(6 * nn); mdiag = np.zeros(6 * nn)
    for i in range(nc):
        if dyn[i]: minv[6 * i:6 * i + 3] = 1 / mass[i]; minv[6 * i + 3:6 * i + 6] = 1 / inert[i]; mdiag[6 * i:6 * i + 3] = mass[i]; mdiag[6 * i + 3:6 * i + 6] = inert[i]
    I_imp = 0.4 * m_imp * r * r
    minv[6 * nc:6 * nc + 3] = 1 / m_imp; minv[6 * nc + 3:] = 1 / I_imp; mdiag[6 * nc:6 * nc + 3] = m_imp; mdiag[6 * nc + 3:] = I_imp
    # the dead load's elastic state J0 (every dynamic chunk; held ends support)
    f = np.zeros(6 * nn); f[1:6 * nc:6] = -mass * G * dyn
    sel = np.where(np.repeat(np.r_[dyn, False], 6))[0]
    K = (B @ sp.diags(kk.reshape(-1)) @ Bt).tocsr()[sel][:, sel]
    u = np.zeros(6 * nn)
    if len(sel):
        Kc = K + sp.diags(1e-9 * np.maximum(K.diagonal(), 1.0))
        u[sel] = spl.spsolve(Kc.tocsc(), f[sel])
    J0 = -(kk * (Bt @ u).reshape(nl, 6))
    rest_util = ex.util_vec(F, J0)
    # the explicit bound (true omega_max of M^-1 K over the dynamic chunks) and the rows'
    Kf = (B @ sp.diags(kk.reshape(-1)) @ Bt).tocsr()
    mh = np.where(minv > 0, np.sqrt(minv), 0.0)
    Sm = (sp.diags(mh) @ Kf @ sp.diags(mh)).tocsr()[sel][:, sel]
    omega = float(np.sqrt(max(spl.eigsh(Sm, k=1, which='LA', return_eigenvectors=False, tol=1e-6)[0], 0.0))) if len(sel) > 6 else 0.0
    Emod = {c: C.modulus(c) for c in chunks}
    mats = {c: C.materials[C.chunks[c]['material']] for c in chunks}
    vol = {c: float(C.chunks[c]['volume']) for c in chunks}
    row_law = {c: law.punch_row(Emod[c], None, [np.zeros(3)], vol[c], Rb=np.sqrt(2.5 * I_imp / m_imp)) for c in chunks if Emod[c] > 0}
    laws = {c: law.crush_of(mats[c]) for c in chunks}
    sig_y = {c: laws[c][0] for c in chunks}; sig_pl = {c: laws[c][1] for c in chunks}
    crush_state = [dict(on=laws[c][0], pl=laws[c][1], crushing=False, d_tot=0.0, R=(r if args.crater == 'impactor' else None)) for c in chunks]
    h_row = min((law.row_step(1 / mass[sc.index[c]] + 1 / m_imp, law.row_k(row_law[c], 1e9), EPS_ROW)
                 for c in row_law if dyn[sc.index[c]]), default=H_CAP) if args.rows == 'compliant' else H_CAP
    h = args.dt_us * 1e-6 if args.dt_us else min(SAFETY * 2 / omega if omega > 0 else H_CAP, h_row, H_CAP)
    dty = np.float32 if args.fp32 else np.float64
    mu = 0.5     # the pair's Coulomb coefficient (ContactRow::friction: the lab's 0.5)
    # state
    v = np.zeros(6 * nn, dty); v[6 * nc:6 * nc + 3] = d * v_in
    x = np.zeros((nn, 3)); x[:nc] = pos0; x[nc] = c_imp; rot = np.repeat(np.eye(3)[None], nc, 0)
    Jc = J0.astype(dty).copy(); J0d = J0.astype(dty)
    live = np.ones(nl, bool); slip = np.zeros(nl)
    crushed = np.zeros(nc, bool); dp = np.zeros(nc); crushing = np.zeros(nc, bool); depth_t = np.zeros(nc)
    struck = np.zeros(nc, bool); peakF = np.zeros(nc); onset = np.zeros(nc); rowstate = {}; routing = []
    books = dict(fracture=0.0, plastic=0.0, crush=0.0, plug=0.0, contact=0.0, dead=0.0, gravity=0.0, crushed_bonds=0.0)
    broke_at = {}
    KE = lambda vv: 0.5 * float(np.sum(mdiag * vv.astype(float) ** 2))
    KE0 = KE(v)
    U0 = float(np.sum(0.5 * J0 ** 2 / kk))
    steps = int(np.ceil(T_max / h)); exit_v = None; exit_t = None
    far = None; trace = []
    Ks = kk.astype(dty)
    t0 = time.time()

    def kill(idx, why):
        if len(idx) == 0: return
        books['crushed_bonds' if why == 'crush' else 'fracture'] += float(np.sum(0.5 * Jc[idx].astype(float) ** 2 / kk[idx]))
        live[idx] = False; Jc[idx] = 0.0
        for l in idx: broke_at.setdefault(int(l), (t, why))
        if args.verbose:
            for l in idx:
                ut = ex.util_vec(F[l:l + 1], Jt_last[l:l + 1].astype(float)) if Jt_last is not None else [0]
                print(f"    break {why} t {t * 1e3:.2f} ms joint {l} chunks {tuple(jchunks[l])} at {np.round(centroid[l], 2)} n {np.round(J[l]['R'][0], 2)} "
                      f"util {float(ut[0]):.2f} J {np.round(Jt_last[l].astype(float) / 1e3, 1) if Jt_last is not None else ''} kN cap {np.round(F[l, :3] / 1e3)}")

    t = 0.0; Jt_last = None; fixed = []; dt_tick = C.settings['dt']; next_rebuild = 0.0; refresh = args.refresh_us * 1e-6 if args.refresh_us else dt_tick; refreshes = []
    contact_face = {c: row_law[c]['face'] for c in row_law}
    for s in range(steps):
        t = (s + 1) * h
        # 1. joints' forces and the dead load (f0 = -B J0 on the chunks); gravity on the impactor
        Jl = np.where(live[:, None], Jc, 0.0)
        fv = B @ (Jl - J0d).reshape(-1)
        books['dead'] += h * float((-(B @ J0.reshape(-1))) @ v.astype(float))
        v = v + (h * minv * fv).astype(dty)
        v[6 * nc + 1] -= h * G; books['gravity'] -= h * G * m_imp * float(v[6 * nc + 1])
        # 2. rows: the sphere against every hull it reaches, from the same velocities (Jacobi, split masses)
        ke_b = KE(v)
        cen = x[nc]; rows = []
        vimp = v[6 * nc:6 * nc + 3].astype(float)
        if args.geometry == 'fixed' and t - h >= next_rebuild - 1e-12:
            if args.refresh_us is None:
                # auto: a fixed row is the tangent plane of its pair's distance at the rebuild; it holds
                # while the contact point stays on the chunk's face, so rebuild after the impactor has
                # moved one face radius (the smallest of the chunks it can reach) relative to them
                near = [contact_face[c] for i, c in enumerate(chunks) if dyn[i] and not crushed[i] and c in contact_face
                        and np.linalg.norm(cen - x[i]) <= r + sc.hull[c][1] + float(np.linalg.norm(vimp)) * dt_tick]
                refresh = min(dt_tick, min(near, default=np.inf) / max(float(np.linalg.norm(vimp)), 1e-9))
                refreshes.append(refresh)
            next_rebuild += refresh
            # the kernel's rows: at the tick's start, one per chunk the sphere can reach in the tick (its
            # signed gap, PhysX's speculative contact within the contact offset |v| dt), fixed point and
            # normal for the tick, the depth integrated from the closing rate
            fixed = []
            reach = float(np.linalg.norm(vimp)) * refresh
            for i, c in enumerate(chunks):
                if crushed[i] or not dyn[i]: continue
                V, rb = sc.hull[c]; rel = cen - x[i]
                if np.linalg.norm(rel) > r + rb + reach: continue
                pen, nrm, q = sphere_hull(rot[i].T @ rel, r, sc.tri[c], sc.planes[c])
                if pen < -reach: continue
                nrm = rot[i] @ nrm; q = rot[i] @ q
                fixed.append(dict(i=i, c=c, R=frame(nrm), rc_local=rot[i].T @ q, d=pen))
        for i, c in enumerate(chunks) if args.geometry == 'exact' else []:
            # no row on a support (a mass-0 chunk: the ground, rigid in the stage, FIDELITY_AUDIT E10)
            if crushed[i] or not dyn[i]: continue
            V, rb = sc.hull[c]
            rel = cen - x[i]
            if np.linalg.norm(rel) > r + rb + float(np.linalg.norm(vimp)) * h: continue
            # the hull turns with its chunk (else a contact's torque spins it with no change of depth: work
            # from nowhere)
            pen, nrm, q = sphere_hull(rot[i].T @ rel, r, sc.tri[c], sc.planes[c])
            nrm = rot[i] @ nrm; q = rot[i] @ q
            # relative motion at the point: chunk point less the sphere's, along nrm (from the hull to the sphere)
            pw = q + x[i]
            rc = pw - x[i]; rs = pw - cen
            vc = v[6 * i:6 * i + 3] + np.cross(v[6 * i + 3:6 * i + 6], rc) if dyn[i] else np.zeros(3)
            vs = v[6 * nc:6 * nc + 3] + np.cross(v[6 * nc + 3:6 * nc + 6], rs)
            Rf = frame(nrm); g = Rf @ (vc - vs)
            if args.rows == 'compliant':
                d_el = pen - dp[i]
                if d_el + h * g[0] <= 0: continue
            else:
                if pen + h * g[0] <= 0: continue
                d_el = pen
            rows.append((i, c, Rf, rc, rs, g, d_el, pen))
        if args.geometry == 'fixed':
            for fr in fixed:
                i, c = fr['i'], fr['c']
                if crushed[i]: continue
                Rf = fr['R']; rc = rot[i] @ fr['rc_local']; rs = -r * Rf[0]
                vc = v[6 * i:6 * i + 3] + np.cross(v[6 * i + 3:6 * i + 6], rc)
                vs = v[6 * nc:6 * nc + 3] + np.cross(v[6 * nc + 3:6 * nc + 6], rs)
                g = Rf @ (vc - vs); pen = fr['d']
                d_el = pen - dp[i] if args.rows == 'compliant' else pen
                if d_el + h * g[0] <= 0: continue
                rows.append((i, c, Rf, rc, rs, g, d_el, pen))
        if rows:
            cnt_imp = len(rows)
            dvt = np.zeros(6 * nn)
            for (i, c, Rf, rc, rs, g, d_el, pen) in rows:
                # W = sum over the ends of (split) J M^-1 J^T, the row frame
                Ws = np.zeros((3, 3))
                Jsph = np.hstack([-np.eye(3), skew(rs)])                       # v at the sphere's point (negated: relative = chunk - sphere)
                Ms = np.diag(np.r_[[1 / m_imp] * 3, [1 / I_imp] * 3]) * cnt_imp
                Ws += Rf @ (Jsph @ Ms @ Jsph.T) @ Rf.T
                if dyn[i]:
                    Jch = np.hstack([np.eye(3), -skew(rc)])
                    Mc = np.diag(np.r_[[1 / mass[i]] * 3, [1 / inert[i]] * 3])
                    Ws += Rf @ (Jch @ Mc @ Jch.T) @ Rf.T
                if args.rows == 'compliant' and c in row_law:
                    cr = crush_state[i]; cr['d_tot'] = pen
                    was = cr['crushing']
                    P = law.compliant_impulse(Ws, g, d_el, row_law[c], mu, h, crush=cr)
                    if cr['crushing'] and not was:
                        onset[i] = t
                        if depth_t[i] == 0:
                            V = sc.hull[c][0] @ rot[i].T; pr = V @ Rf[0]; depth_t[i] = float(pr.max() - pr.min())
                    crushing[i] = cr['crushing']
                    rowstate[i] = True
                else:
                    gg = g.copy(); gg[0] += max(pen, 0.0) * 0.0
                    P = ex.cone_coulomb(Ws, g, -np.linalg.solve(Ws, g), mu)
                    if P[0] > 0: P[:] = 0.0
                Lw = Rf.T @ P                                      # the impulse on the chunk (world); -Lw on the sphere
                if args.verbose and -P[0] / h > 2e7 and peakF[i] <= 2e7:
                    print(f"    big row t {t * 1e3:.2f} chunk {c} {sc.group[c]} mat {C.chunks[c]['material']} m {mass[i]:.1f} V {vol[c]:.4f} pen {pen:.3f} d_el {d_el:.3f} dp {dp[i]:.3f} crushing {crushing[i]} "
                          f"sig_y {sig_y[c]:.3g} E {Emod[c]:.3g} F {-P[0] / h / 1e6:.1f} MN g {np.round(g, 1)} inside {bool(np.all(sc.planes[c][:, :3] @ (cen - x[i]) + sc.planes[c][:, 3] <= 0))} live-ties {int(np.sum(live & ((jchunks[:, 0] == c) | (jchunks[:, 1] == c))))}")
                if not struck[i] and c in row_law:
                    # the routing criterion at first contact: the peak force v sqrt(k m) of the contact
                    # (k the compliant row in series with the chunk's joints along n, m the reduced
                    # mass of the impactor and the chunk) against the smaller of what the chunk's
                    # joints carry along n (the support function of their capacity sets) and its
                    # crush onset over the face
                    n_ = -Rf[0]; ks, cap = 0.0, 0.0
                    for l in np.where(live & ((jchunks[:, 0] == c) | (jchunks[:, 1] == c)))[0]:
                        aa = float(J[l]['R'][0] @ n_); tt = np.sqrt(max(0.0, 1 - aa * aa))
                        ks += kk[l, 0] * abs(aa) + kk[l, 1] * tt
                        cap += (F[l, 0] if aa * (1 if jchunks[l, 0] == c else -1) > 0 else F[l, 1]) * abs(aa) + F[l, 2] * tt
                    kc = law.row_k(row_law[c], 1e9); keff = 1 / (1 / kc + (1 / ks if ks > 0 else 0.0))
                    meff = 1 / (1 / m_imp + 1 / mass[i]) if ks == 0 else m_imp
                    Fpk = max(g[0], 0.0) * np.sqrt(keff * meff); Fcr = sig_y[c] * np.pi * row_law[c]['face'] ** 2
                    routing.append(dict(chunk=int(c), vn=round(float(g[0]), 2), k_row=kc, k_path=ks, m_eff=meff, F_peak=Fpk, cap=cap, F_crush=Fcr,
                                        routed=bool(Fpk > min(cap if cap > 0 else np.inf, Fcr))))
                peakF[i] = max(peakF[i], -P[0] / h); struck[i] = True
                if dyn[i]:
                    dvt[6 * i:6 * i + 3] += Lw / mass[i]; dvt[6 * i + 3:6 * i + 6] += np.cross(rc, Lw) / inert[i]
                dvt[6 * nc:6 * nc + 3] -= Lw / m_imp; dvt[6 * nc + 3:6 * nc + 6] -= np.cross(rs, Lw) / I_imp
            v = v + dvt.astype(dty)
            if args.geometry == 'fixed':
                for fr in fixed:
                    i = fr['i']; Rf = fr['R']; rc = rot[i] @ fr['rc_local']; rs = -r * Rf[0]
                    vc = v[6 * i:6 * i + 3] + np.cross(v[6 * i + 3:6 * i + 6], rc); vs = v[6 * nc:6 * nc + 3] + np.cross(v[6 * nc + 3:6 * nc + 6], rs)
                    fr['d_next'] = fr['d'] + h * float(Rf[0] @ (vc - vs))
            # crush: the intrusion past the elastic depth F / k, at the applied force, is crushed (the
            # striker's work F delta)
            if args.rows == 'compliant':
                for (i, c, Rf, rc, rs, g, d_el, pen) in rows:
                    if not crushing[i] or i not in rowstate: continue
                    cr = crush_state[i]
                    vc = v[6 * i:6 * i + 3] + np.cross(v[6 * i + 3:6 * i + 6], rc) if dyn[i] else np.zeros(3)
                    vs = v[6 * nc:6 * nc + 3] + np.cross(v[6 * nc + 3:6 * nc + 6], rs)
                    dd = law.crush_advance(cr, d_el, float(Rf[0] @ (vc - vs)), h)
                    dp[i] += dd; books['crush'] += cr['F'] * dd
                    if dp[i] >= depth_t[i] > 0 and not crushed[i]:
                        crushed[i] = True
                        kill(np.where(live & ((jchunks[:, 0] == c) | (jchunks[:, 1] == c)))[0], 'crush')
                        # the crushed material cannot pass through the striker: it leaves with the
                        # striker's normal speed (momentum, perfectly inelastic: the plug of Recht &
                        # Ipson 1963, here the whole chunk, the stage's crush granularity)
                        if dyn[i]:
                            vc = v[6 * i:6 * i + 3].astype(float); vs = v[6 * nc:6 * nc + 3].astype(float)
                            n = Rf[0]; gN = float(n @ (vc - vs))
                            if gN > 0:
                                Pn = gN / (1 / mass[i] + 1 / m_imp)
                                ke1 = KE(v)
                                v[6 * i:6 * i + 3] -= (Pn / mass[i] * n).astype(dty); v[6 * nc:6 * nc + 3] += (Pn / m_imp * n).astype(dty)
                                books['plug'] += ke1 - KE(v)
            rowstate.clear()
        if args.geometry == 'fixed':
            for fr in fixed:
                if 'd_next' in fr: fr['d'] = fr.pop('d_next')
                else:
                    i = fr['i']; Rf = fr['R']; rc = rot[i] @ fr['rc_local']; rs = -r * Rf[0]
                    vc = v[6 * i:6 * i + 3] + np.cross(v[6 * i + 3:6 * i + 6], rc); vs = v[6 * nc:6 * nc + 3] + np.cross(v[6 * nc + 3:6 * nc + 6], rs)
                    fr['d'] += h * float(Rf[0] @ (vc - vs))
        books['contact'] += KE(v) - ke_b
        # 3. positions
        x[:nc] += (v.reshape(nn, 6)[:nc, :3] * dyn[:, None]).astype(float) * h
        x[nc] += v[6 * nc:6 * nc + 3].astype(float) * h
        w_ = v.reshape(nn, 6)[:nc, 3:].astype(float) * dyn[:, None] * h
        th = np.linalg.norm(w_, axis=1); moving = np.where(th > 0)[0]
        for i in moving:
            k_ = w_[i] / th[i]; Kx = skew(k_)
            rot[i] = (np.eye(3) + np.sin(th[i]) * Kx + (1 - np.cos(th[i])) * Kx @ Kx) @ rot[i]
        # 4. joints: the trial, brittle at capacity, ductile radial return
        e = (Bt @ v).reshape(nl, 6)
        idx = np.where(live)[0]
        Jt = Jc.copy(); Jt[idx] = Jc[idx] - (h * Ks[idx] * e[idx]).astype(dty)
        uu = ex.util_vec(F[idx], Jt[idx].astype(float))
        brit = idx[(uu >= 1.0) & ~ductile[idx]]
        duc = idx[(uu > 1.0) & ductile[idx]]
        if len(duc):
            ud = uu[np.searchsorted(idx, duc)]
            Jy = Jt[duc] / ud[:, None].astype(dty); dpl = (Jt[duc] - Jy).astype(float) / kk[duc]
            slip[duc] += np.linalg.norm(dpl[:, :3], axis=1); books['plastic'] += float(np.sum(np.abs(Jy.astype(float) * dpl)))
            Jt[duc] = Jy; brit = np.concatenate([brit, duc[slip[duc] > limit[duc]]])
        Jt_last = Jt.copy(); Jc = Jt; kill(brit, 'break')
        if not np.all(np.isfinite(v)): raise FloatingPointError(f'diverged at substep {s}')
        # the exit: the sphere's trailing point past every struck hull's far side along d
        if struck.any():
            far = max(float(np.max((sc.hull[chunks[i]][0] + pos0[i]) @ d)) for i in np.where(struck)[0])
            vi = v[6 * nc:6 * nc + 3].astype(float)
            if exit_v is None and (x[nc] @ d) - r > far:
                exit_v = float(vi @ d); exit_t = t
        if s % max(1, int(1e-3 / h)) == 0:
            vi = v[6 * nc:6 * nc + 3].astype(float)
            trace.append((round(t * 1e3, 3), round(float(vi @ d), 2), int(len(rows)), int(crushed.sum()), int((~live).sum())))
        if exit_t is not None and t > exit_t + 2e-3: break
        if float(v[6 * nc:6 * nc + 3].astype(float) @ d) < 0 and t > 5e-3: break
    wall = time.time() - t0
    vi = v[6 * nc:6 * nc + 3].astype(float)
    # books (FP64 view): what the impactor lost against where it went
    ke_imp = 0.5 * m_imp * (v_in ** 2 - vi @ vi) - 0.5 * I_imp * float(v[6 * nc + 3:].astype(float) @ v[6 * nc + 3:].astype(float))
    vv = v.astype(float).copy(); vv[6 * nc:] = 0
    ke_house = 0.5 * float(np.sum(mdiag * vv ** 2))
    U = float(np.sum(np.where(live[:, None], 0.5 * Jc.astype(float) ** 2 / kk, 0.0)))
    supplied = ke_imp + books['dead'] + U0 + books['gravity']
    spent = ke_house + U + books['fracture'] + books['crushed_bonds'] + books['plastic'] + books['crush'] + books['plug']
    # locality: broken joints' distance from the line
    line = lambda p: np.linalg.norm((p - target) - np.outer((p - target) @ d, d), axis=1)
    bl = np.array(sorted(broke_at)); dist = line(centroid[bl]) if len(bl) else np.zeros(0)
    # the ghost check: a chunk the sphere's path swept through (its hull within r of the line it took),
    # not crushed and still tied to a support, overlapping the tube now
    swept_intact = 0
    for i, c in enumerate(chunks):
        if crushed[i] or not dyn[i] or not struck[i]: continue
        ties = np.where(live & ((jchunks[:, 0] == c) | (jchunks[:, 1] == c)))[0]
        if not len(ties): continue
        pen = sphere_hull(rot[i].T @ (x[nc] - x[i]), r, sc.tri[c], sc.planes[c])[0]
        if pen - dp[i] > 0.05 * r and exit_v is not None: swept_intact += 1
    out = dict(case=case, rows=args.rows, fp32=args.fp32, projectile=proj, mass=m_imp, radius=r, v_in=v_in,
               chunks=nc, dynamic=int(dyn.sum()), joints=nl, rest_over=int((rest_util >= 1).sum()), omega=omega, h_us=h * 1e6,
               h_row_us=h_row * 1e6, substeps=s + 1, window_ms=round(t * 1e3, 2), wall_s=round(wall, 1),
               exit_v=exit_v, exit_ms=None if exit_t is None else round(exit_t * 1e3, 2), v_end=float(vi @ d),
               struck=int(struck.sum()), crushed=int(crushed.sum()), partial=int(((dp > 0) & ~crushed).sum()),
               broken=len(broke_at), broken_by_crush=sum(1 for v_ in broke_at.values() if v_[1] == 'crush'),
               reach_max=float(dist.max()) if len(dist) else 0.0, swept_intact=swept_intact,
               peak_force_MN=round(float(peakF.max()) / 1e6, 3),
               books={k: round(v_ / 1e3, 2) for k, v_ in dict(impactor_lost=ke_imp, dead=books['dead'], U0=U0, house_ke=ke_house, U=U,
                                                         fracture=books['fracture'], crushed_bonds=books['crushed_bonds'], plastic=books['plastic'],
                                                         crush=books['crush'], plug=books['plug'], contact_ke=books['contact'], residual=supplied - spent).items()},
               refresh_us=round(float(np.mean(refreshes)) * 1e6, 1) if refreshes else None, rebuilds=len(refreshes),
               routing=dict(rows=len(routing), routed=sum(r_['routed'] for r_ in routing), min_ratio=min((r_['F_peak'] / min(r_['cap'] if r_['cap'] > 0 else np.inf, r_['F_crush']) for r_ in routing), default=None)), routing_rows=routing,
               trace=trace, distances=[round(float(x_), 2) for x_ in dist])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--case', required=True, action='append')
    ap.add_argument('--capture', default=str(DEFAULT_CAPTURE)); ap.add_argument('--pack', default=str(DEFAULT_PACK))
    ap.add_argument('--meta', default=str(DEFAULT_META))
    ap.add_argument('--rows', default='compliant', choices=['compliant', 'rigid'])
    ap.add_argument('--refresh-us', type=float, default=None, help='fixed geometry: rows rebuilt this often (default: auto, one face radius of travel)')
    ap.add_argument('--crater', default='law', choices=['law', 'impactor'], help="the crater's curvature: the law's relative R, or the impactor's own radius (a sphere into a flat face)")
    ap.add_argument('--geometry', default='exact', choices=['exact', 'fixed'], help="rows from the bodies' positions every substep, or the kernel's: fixed at each tick's start with their signed gap")
    ap.add_argument('--ticks', type=int, default=3); ap.add_argument('--margin', type=float, default=3.0)
    ap.add_argument('--speed', type=float, default=None); ap.add_argument('--dt-us', type=float, default=None)
    ap.add_argument('--fp32', action='store_true'); ap.add_argument('--json'); ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()
    res = []
    for case in a.case:
        o = run(case, a); res.append(o)
        print(f"{case} [{a.rows}{' fp32' if a.fp32 else ''}]: {o['chunks']} chunks ({o['dynamic']} dyn), {o['joints']} joints ({o['rest_over']} over at rest); "
              f"h {o['h_us']:.1f} us (rows {o['h_row_us']:.1f}), {o['substeps']} substeps, {o['window_ms']} ms, CPU {o['wall_s']} s", flush=True)
        print(f"  exit {o['exit_v']} m/s at {o['exit_ms']} ms (v_in {o['v_in']:.1f}, end {o['v_end']:.2f}); struck {o['struck']}, crushed {o['crushed']}, partial {o['partial']}; "
              f"broken {o['broken']} ({o['broken_by_crush']} by crush), farthest {o['reach_max']:.2f} m; swept-intact {o['swept_intact']}; peak row {o['peak_force_MN']} MN", flush=True)
        print(f"  books kJ {o['books']}", flush=True)
        print(f"  routing at first contact: {o['routing']}; geometry rebuilds {o['rebuilds']} (mean every {o['refresh_us']} us)", flush=True)
    if a.json: pathlib.Path(a.json).write_text(json.dumps(res, indent=1))


if __name__ == '__main__':
    sys.exit(main())
