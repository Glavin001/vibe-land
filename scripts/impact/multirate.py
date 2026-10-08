#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""Multi-rate (asynchronous) explicit steps on the GPU step's own patches: sizing, stability and fidelity.

    uv run scripts/impact/multirate.py PATCH.exd [PATCH.exd ...] [--long-ticks 10] [--json OUT]

PATCH.exd: an explicit patch as its window starts, written by the PhysX capture replay
(IMPACT_EXPLICIT_DUMP=PREFIX; PREFIX-p<p>.exd, with PREFIX-p<p>.gpu, the GPU window's outcome).

The scheme (explicit-step.py run(levels=...)): every joint j gets a level L_j, the largest L with
2^L h0 omega~_j <= 0.9 x 2, i.e. omega~_j <= omega / 2^L for h0 = 0.9 x 2 / omega (the window's
bound), where omega~_j^2 = lambda_max(k^1/2 B_j^T (deg M^-1) B_j k^1/2) is the joint's element
frequency on split masses (each node's inverse mass times its live-joint count: by the element
eigenvalue theorem the assembled lambda_max is at most the largest such element's, so each joint
is stable on its own period). Joint j fires on the finest steps n with 2^L_j | n: its relative
displacement since its last firing from the nodes' displacement accumulators (u += h0 v each finest
step), then its law (trial, fracture, radial return); its force is held between firings. Rows and
nodes step every finest step.

The gate, per patch, against the uniform reference (every joint every step, h0) and that
reference's own spread (the same at h0 / 2):
  broken joints' Jaccard, the impactors' momentum change, the energy invariant (fracture + plastic
  <= impactors' KE loss + the joints' elastic energy at rest + the dead load's work), locality
  (median / max distance of the broken joints from the first contact), the break times' shift
  (quantisation to a joint's period), and stability: elastic runs (no fracture or yield) over
  --long-ticks ticks, E_dev = 1/2 v^T M v + 1/2 sum (J - J0)^2 / k, no growth (a resonance of
  commensurate steps, Fong, Darve & Lew 2008, would grow).
"""
import argparse, importlib.util, json, pathlib, sys
import numpy as np
import scipy.sparse as sp

H = pathlib.Path(__file__).resolve().parent
_s = importlib.util.spec_from_file_location('explicit_step', H / 'explicit-step.py')
xs = importlib.util.module_from_spec(_s); _s.loader.exec_module(xs)

LIVE, DUCTILE, BROKEN = 1, 2, 8
HELD = 0xffffffff


class ExDump:
    """An explicit patch (.exd) in the attributes explicit-step.py's Explicit reads."""

    def __init__(self, path):
        b = pathlib.Path(path).read_bytes(); o = 0
        def u32(n):
            nonlocal o; v = np.frombuffer(b, np.uint32, n, o).astype(np.int64); o += 4 * n; return v
        def f32(n):
            nonlocal o; v = np.frombuffer(b, np.float32, n, o).astype(np.float64); o += 4 * n; return v
        nn, nj, nr, _ = u32(4); dt, band, h, omega = f32(4)
        self.h_gpu, self.omega_gpu = h, omega
        chunk = np.zeros(nn, np.int64); tensor = np.zeros(nn, bool); im = np.zeros(nn); Iinv = np.zeros((nn, 6)); v = np.zeros((nn, 6))
        for i in range(nn):
            c, t = u32(2); f = f32(13); chunk[i], tensor[i] = c, bool(t); im[i] = f[0]; Iinv[i] = f[1:7]; v[i] = f[7:13]
        J = [(u32(4), f32(39)) for _ in range(nj)]; R = [(u32(2), f32(19)) for _ in range(nr)]
        assert o == len(b), 'dump size'
        nl = nj + nr; self.nn, self.nl, self.dt, self.band = nn, nl, dt, band
        self.index = {int(c): i for i, c in enumerate(chunk)}
        held = lambda l: int(2 ** 40 + l)   # a chunk id no node has: the end is held
        cid = lambda e, l: int(chunk[e]) if e != HELD else held(l)
        link_u = np.zeros((nl, 4), np.int64); link_f = np.zeros((nl, 14)); J0 = np.zeros((nl, 6)); comp = np.zeros((nl, 6))
        frames = np.zeros((nl, 15)); cen = np.zeros((nl, 3)); state = np.zeros(nl, np.int64)
        self.bond = np.full(nl, -1, np.int64); self.slip_before = np.zeros(nl); self.slip_limit = np.zeros(nl)
        for l, (u, f) in enumerate(J):
            link_u[l] = [l, cid(u[1], l), cid(u[2], l), 0]; self.bond[l] = u[0]; state[l] = u[3]
            frames[l] = f[:15]; kk = np.array([f[15], f[15], f[15], f[16], f[17], f[18]])
            kk = np.where((kk > 0) & (kk < 1e30), kk, 0.0); comp[l] = kk * dt * dt
            link_f[l, :9] = f[19:28]; link_f[l, 9:13] = f[15:19]; J0[l] = f[28:34]
            self.slip_before[l], self.slip_limit[l] = f[34], f[35]; cen[l] = f[36:39]
        for r, (u, f) in enumerate(R):
            l = nj + r; link_u[l] = [l, cid(u[0], l), cid(u[1], l), 0]; frames[l] = f[:15]; link_f[l, 13] = f[15]; cen[l] = f[16:19]
        self.joint = np.arange(nl) < nj; self.contact = ~self.joint
        self.alive0 = np.where(self.joint, (state & (LIVE | BROKEN)) != 0, True)
        self.ductile = self.joint & ((state & DUCTILE) != 0)
        self.comp, self.J0 = comp, J0
        self.d = dict(link_u=link_u, link_f=link_f, node_tensor=tensor, node_f=np.c_[im, Iinv[:, 0], Iinv, np.zeros((nn, 6))])
        # B: node dof <- link component, end 0 (+) and end 1 (-): a force q along R_q at the arm o
        # gives (s R_q, s o x R_q); a moment q gives (0, -s R_q) (exWrench)
        rows, cols, vals = [], [], []; blocks = np.zeros((nl, 72))
        for l in range(nl):
            Rq = frames[l, :9].reshape(3, 3)
            for e, c in ((0, link_u[l, 1]), (1, link_u[l, 2])):
                i = self.index.get(int(c)); sgn = 1.0 if e == 0 else -1.0
                o_ = frames[l, 9:12] if e == 0 else frames[l, 12:15]
                blk = np.zeros((6, 6))
                for q in range(3):
                    blk[:3, q] = sgn * Rq[q]; blk[3:, q] = sgn * np.cross(o_, Rq[q]); blk[3:, 3 + q] = -sgn * Rq[q]
                blocks[l, 36 * e:36 * e + 36] = blk.reshape(-1)
                if i is None: continue
                for a in range(6):
                    for q in range(6):
                        if blk[a, q] != 0.0: rows.append(6 * i + a); cols.append(6 * l + q); vals.append(blk[a, q])
        self.d['B'] = blocks
        self.B = sp.csr_matrix((vals, (rows, cols)), shape=(6 * nn, 6 * nl)); self.Bt = self.B.T.tocsr()
        Mi = np.zeros((6 * nn, 6 * nn)); M = np.zeros((6 * nn, 6 * nn))
        for i in range(nn):
            Mi[6 * i:6 * i + 3, 6 * i:6 * i + 3] = np.eye(3) * im[i]
            if tensor[i]:
                S = Iinv[i]; T = np.array([[S[0], S[3], S[4]], [S[3], S[1], S[5]], [S[4], S[5], S[2]]])
            else:
                T = np.diag(Iinv[i, :3])
            Mi[6 * i + 3:6 * i + 6, 6 * i + 3:6 * i + 6] = T
            M[6 * i:6 * i + 3, 6 * i:6 * i + 3] = np.eye(3) / im[i] if im[i] > 0 else 0.0
            M[6 * i + 3:6 * i + 6, 6 * i + 3:6 * i + 6] = np.linalg.pinv(T)
        self.Mi, self.M = sp.csr_matrix(Mi), sp.csr_matrix(M)
        self.mass = np.where(im > 0, 1.0 / np.where(im > 0, im, 1.0), 0.0)
        self.imp = [i for i in range(nn) if tensor[i]] or [0]
        self.v_init = v.reshape(-1); self.v0 = v[self.imp[0], :3].copy(); self.m_imp = self.mass[self.imp[0]]
        self.cen = cen; self.hit = cen[nj] if nr else cen[:nj].mean(0)
        self.tensor = tensor
        # each row's impact line: its contact point along its impactor's initial velocity (locality)
        self.lines = [(f[16:19].copy(), v[int(u[1]), :3] / np.linalg.norm(v[int(u[1]), :3])) for u, f in R if np.linalg.norm(v[int(u[1]), :3]) > 0]
        self.nj = nj

    def dist(self, links):
        return np.array([np.linalg.norm(self.cen[int(self.d['link_u'][l, 0])] - self.hit) for l in links])


def _patch_nodes(X, P):
    """Each live joint's patch ends (local node or -1) and the chunk nodes' sqrt(M^-1) diagonals."""
    live = P.alive0 & P.joint & X.inpatch
    Mi = X.Mi.tocsr(); d = Mi.diagonal().reshape(P.nn, 6)
    return live, X.ends, np.sqrt(np.maximum(d, 0.0))


def element_omegas(X, P):
    """Per live joint, its two-chunk element's frequency, on full node masses (omega_j, the notes' sizing:
    IMPACT_EXPLICIT_LOCAL) and on split masses (omega~_j: each node's inverse mass times its live-joint
    count, so the elements' masses sum to the nodes')."""
    live, ends, _ = _patch_nodes(X, P)
    deg = np.zeros(P.nn)
    for l in np.where(live)[0]:
        for i in ends[l]:
            if i >= 0: deg[i] += 1
    Mi = X.Mi.tocsr(); w = np.zeros(P.nl); ws = np.zeros(P.nl)
    for l in np.where(live)[0]:
        A = np.zeros((6, 6)); As = np.zeros((6, 6)); sk = np.sqrt(X.k[l])
        for e in (0, 1):
            i = ends[l][e]
            if i < 0: continue
            Bl = P.d['B'][l, 36 * e:36 * e + 36].reshape(6, 6); mi = Mi[6 * i:6 * i + 6, 6 * i:6 * i + 6].toarray()
            A += Bl.T @ mi @ Bl; As += deg[i] * (Bl.T @ mi @ Bl)
        w[l] = np.sqrt(max(np.linalg.eigvalsh(sk[:, None] * A * sk[None, :]).max(), 0.0))
        ws[l] = np.sqrt(max(np.linalg.eigvalsh(sk[:, None] * As * sk[None, :]).max(), 0.0))
    return w, ws


def levels_from_omegas(w, live, omega, cap):
    """The largest L <= cap with w 2^L <= omega."""
    L = np.zeros(len(w), np.int64)
    for l in np.where(live)[0]:
        while L[l] < cap and w[l] * (1 << (L[l] + 1)) <= omega: L[l] += 1
    return L


def cw_levels(X, P, omega, cap, products=8):
    """Levels from the window's own bound (the GPU's exFinish: Collatz-Wielandt on L >= |S|, S = M^-1/2 K M^-1/2,
    lumped to translation and rotation per node), rigorous per level: for every L the joints of level >= L
    form a subsystem whose largest frequency is at most omega / 2^L, so each level's period 2^L h0 meets the
    0.9 x 2 / omega_level condition on its own subsystem (Belytschko, Smolinski & Liu 1985: each partition
    stable at its own step).
    With x > 0 the full system's iterate, rho(|S_sub|) <= max_i (L_sub x)_i / x_i for any L_sub >= |S_sub|,
    and L_sub = sum over its joints of each joint's own lumped blocks (its diagonal block taken in absolute
    value on its own: |sum C| <= sum |C|). So with q_ji = max_group (each joint j's row of L x at node i) /
    x_i, the subsystem is within omega_L^2 = omega^2 / 4^L when every node's sum of q over the subsystem's
    joints is. Per node, joints sorted by q ascending: the k-th may sit at level L when the prefix sum
    q_1 + ... + q_k <= omega^2 / 4^L (a prefix: any joint of level >= L at the node has every smaller one
    at level >= L at this node's count, so the node's sum over level >= L is within a prefix that passes);
    a joint's level is the least of its two nodes'. No parameter but the cap."""
    live, ends, sm = _patch_nodes(X, P); nn = P.nn
    def lump(C, sr, sc):
        A = np.abs(C) * sr[:, None] * sc[None, :]
        return np.array([[A[3 * a:3 * a + 3, 3 * b:3 * b + 3].sum(1).max() for b in (0, 1)] for a in (0, 1)])
    D = np.zeros((nn, 6, 6)); own = {}; off = {}
    for l in np.where(live)[0]:
        Kd = np.diag(X.k[l]); Bl = [P.d['B'][l, 36 * e:36 * e + 36].reshape(6, 6) for e in (0, 1)]
        for e in (0, 1):
            i = ends[l][e]
            if i < 0: continue
            Cii = Bl[e] @ Kd @ Bl[e].T; D[i] += Cii; own[(l, i)] = lump(Cii, sm[i], sm[i])
            j = ends[l][1 - e]
            if j >= 0: off[(l, i)] = (j, lump(Bl[e] @ Kd @ Bl[1 - e].T, sm[i], sm[j]))
    chunk = np.array([not bool(P.d['node_tensor'][i]) for i in range(nn)]) & X.on
    Ld = np.array([lump(D[i], sm[i], sm[i]) for i in range(nn)])
    x = np.ones((nn, 2)); best = (np.inf, x.copy())
    for it in range(products + 1):
        Y = np.einsum('iab,ib->ia', Ld, x)
        for (l, i), (j, Lo) in off.items(): Y[i] += Lo @ x[j]
        lam = np.max((Y / x)[chunk])
        if lam < best[0]: best = (lam, x.copy())
        ym = Y[chunk].max()
        if not ym > 0: break
        x = np.where(Y > 0, Y / ym, 1.0)
    lam_full, x = best
    q = {}
    for (l, i), Lown in own.items():
        y = Lown @ x[i]
        if (l, i) in off: j, Lo = off[(l, i)]; y = y + Lo @ x[j]
        q[(l, i)] = float(np.max(y / x[i]))
    lam = omega * omega
    allow = {}
    by_node = {}
    for (l, i), v in q.items(): by_node.setdefault(i, []).append((v, l))
    for i, lst in by_node.items():
        lst.sort(); S = 0.0
        for v, l in lst:
            S += v; Ln = 0
            while Ln < cap and S <= lam / 4.0 ** (Ln + 1): Ln += 1
            allow[(l, i)] = Ln
    L = np.zeros(P.nl, np.int64)
    for l in np.where(live)[0]:
        L[l] = min(allow[(l, i)] for i in ends[l] if i >= 0) if any(i >= 0 for i in ends[l]) else cap
    return L, np.sqrt(lam_full)


def subsystem_omegas(X, P, L, iters=300):
    """The true largest frequency of each level's subsystem (joints of level >= L), power iteration, FP64."""
    live = P.alive0 & P.joint & X.inpatch; out = []
    for Lv in range(int(L[live].max()) + 1):
        m = live & (L >= Lv)
        K = (X.B @ sp.diags((X.k * m[:, None]).reshape(-1)) @ X.Bt).tocsr(); A = X.Mi @ K
        x = np.random.default_rng(1).standard_normal(A.shape[0]) * X.sel; lam = 0.0
        for _ in range(iters):
            y = A @ x; ny = np.linalg.norm(y)
            if not ny > 0: break
            lam = ny / max(np.linalg.norm(x), 1e-300); x = y / ny
        out.append(float(np.sqrt(lam)))
    return out


def macro_radius(X, P, L, h0, cols=1024):
    """The spectral radius of the linearised window (live joints elastic, no rows, no law) over one coarsest
    period 2^Lmax h0, from a step on which every joint has fired: state (u, v) of the chunk nodes with live
    joints; J = -k B^T u (the accumulator form keeps J exact at a firing). The map is built column by column
    and its eigenvalues taken densely (FP64, the state scaled by omega M^1/2 and M^1/2 for conditioning).
    Uniform steps (L = 0) give |lambda| = 1 (symplectic Euler, omega h0 < 2); > 1 is a growing mode."""
    live = P.alive0 & P.joint & X.inpatch
    nodes = sorted({int(i) for l in np.where(live)[0] for i in X.ends[l] if i >= 0})
    dof = np.array([6 * i + q for i in nodes for q in range(6)]); comp = np.array([6 * l + q for l in np.where(live)[0] for q in range(6)])
    B = X.B.tocsr()[dof][:, comp].tocsr(); Bt = B.T.tocsr(); Mi = X.Mi.tocsr()[dof][:, dof].tocsr()
    k = X.k[live].reshape(-1); per = np.repeat(np.int64(1) << L[live], 6); pmax = int(per.max())
    md = 1.0 / np.maximum(Mi.diagonal(), 1e-300); sq = np.sqrt(md); w = 1.8 / h0
    n = len(dof); Phi = np.zeros((2 * n, 2 * n))
    for c0 in range(0, 2 * n, cols):
        c1 = min(2 * n, c0 + cols); Z = np.zeros((2 * n, c1 - c0)); Z[np.arange(c0, c1), np.arange(c1 - c0)] = 1.0
        U = Z[:n] / (w * sq[:, None]); V = Z[n:] / sq[:, None]          # scaled -> physical
        J = -k[:, None] * (Bt @ U); kick = (per * h0)[:, None] * np.ones((1, c1 - c0))
        for s in range(1, pmax + 1):
            V = V + Mi @ (B @ (kick * J)); U = U + h0 * V
            fire = (s % per) == 0
            J[fire] = -k[fire, None] * (Bt @ U)[fire]
            kick = np.where(fire[:, None], (per * h0)[:, None], 0.0) * np.ones((1, c1 - c0))
        Phi[:n, c0:c1] = w * sq[:, None] * U; Phi[n:, c0:c1] = sq[:, None] * V
    ev = np.linalg.eigvals(Phi)
    return float(np.max(np.abs(ev))), pmax, n


def jac(a, b):
    a, b = set(a), set(b); return len(a & b) / max(1, len(a | b)) if (a or b) else 1.0


def line_dist(P, links):
    """Each link's centroid's distance from the impact lines (each row's point along its impactor's initial
    velocity), the nearest."""
    if not len(links): return np.zeros(0)
    c = np.array([P.cen[int(P.d['link_u'][l, 0])] for l in links])
    if not getattr(P, 'lines', None): return np.linalg.norm(c - P.hit, axis=1)
    return np.min([np.linalg.norm(np.cross(c - p, d), axis=1) for p, d in P.lines], axis=0)


def summary(P, X, R, h, label):
    imp = [i for i in range(P.nn) if P.d['node_tensor'][i]]
    v = R['v'].reshape(P.nn, 6).astype(np.float64); v0 = P.v_init.reshape(P.nn, 6)
    dpv = np.array([P.mass[i] * (v[i, :3] - v0[i, :3]) for i in imp])
    Mt = P.M.tocsr()
    ke = lambda vv, nodes: sum(0.5 * float(vv[i] @ (Mt[6 * i:6 * i + 6, 6 * i:6 * i + 6].toarray() @ vv[i])) for i in nodes)
    ke_in, ke_out = ke(v0, imp), ke(v, imp)
    house = [i for i in range(P.nn) if not P.d['node_tensor'][i]]
    k = X.k; u0 = 0.5 * float(np.sum(np.where(k > 0, P.J0 ** 2 / np.where(k > 0, k, 1.0), 0.0)[P.joint & P.alive0 & X.inpatch]))
    deficit = R['brittle_energy'] + R['plastic_work'] > (ke_in - ke_out) + u0 + max(R['dead'], 0.0) + 1e-9
    broken = sorted(R['broke_at']); dist = line_dist(P, broken)
    bond = lambda l: int(P.bond[l]) if hasattr(P, 'bond') else int(P.d['link_u'][l, 0])
    return dict(label=label, h_us=h * 1e6, steps=R['steps'], joint_updates=int(R['fired']), per_step=R['per_step'],
                broken=[bond(l) for l in broken], yielded=[bond(l) for l in R['yielded']], times={bond(l): R['broke_at'][l] for l in broken},
                n_broken=len(broken), dp=float(np.sum(np.linalg.norm(dpv, axis=1))), dp_net=float(np.linalg.norm(dpv.sum(0))),
                ke_in=ke_in, ke_out=ke_out, ke_house=ke(v, house), fracture=R['brittle_energy'], plastic=R['plastic_work'],
                return_drop=R['return_drop'], contact=R['contact_diss'], dead=R['dead'], u0=u0, deficit=bool(deficit),
                med_m=float(np.median(dist)) if len(dist) else 0.0, max_m=float(np.max(dist)) if len(dist) else 0.0,
                books_max=float(max((abs(b[2]) for b in R['books']), default=0.0)))


def window_us(per_step, joints_fixed=None):
    """The notes' cost model (fitted on the 1,273- and 1,919-joint lab patches): 2.5 us + 5.2 us per joint
    per thread (512 threads) per finest step."""
    return float(sum(2.5 + 5.2 * c / 512.0 for c in per_step))


def load(path):
    if path.endswith('.exd'): return ExDump(path)
    P = xs.cf.Problem(path, True, [2217, 2218])        # an impact-level dump (cannon-island1443.bin)
    P.v_init = np.zeros(6 * P.nn); P.v_init[6 * P.imp[0]:6 * P.imp[0] + 3] = P.v0
    P.lines = [(P.hit, P.v0 / np.linalg.norm(P.v0))]
    return P


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('dumps', nargs='+'); ap.add_argument('--long-ticks', type=float, default=6.0)
    ap.add_argument('--json'); ap.add_argument('--fp64', action='store_true'); ap.add_argument('--cap', type=int, default=3)
    ap.add_argument('--rules', default='cw,split,element'); ap.add_argument('--radius', action='store_true', help='the macro-period map\'s spectral radius (dense, slow on big patches)')
    a = ap.parse_args(); out = []
    for path in a.dumps:
        P = load(path); name = pathlib.Path(path).name
        X = xs.Explicit(P, dtype=np.float64 if a.fp64 else np.float32, cone='coulomb'); X.jacobi = True
        T = P.dt
        if hasattr(P, 'h_gpu'): h0 = P.h_gpu
        else: h0 = 0.9 * 2.0 / X.omega_bound()
        omega = 0.9 * 2.0 / h0
        live = P.alive0 & P.joint & X.inpatch
        w, ws = element_omegas(X, P)
        rules = {}
        for r in a.rules.split(','):
            if r == 'cw': rules[r] = cw_levels(X, P, omega, a.cap)[0]
            elif r == 'split': rules[r] = levels_from_omegas(ws, live, omega, a.cap)
            elif r == 'element': rules[r] = levels_from_omegas(w, live, omega, a.cap)
        print(f'{name}: {P.nn} nodes, {int(live.sum())} joints, {int(P.contact.sum())} rows; h0 {h0 * 1e6:.2f} us (omega {omega:.4g} rad/s); '
              f'element omega_j max {w.max() / omega:.3f} of omega, > omega/2 {np.mean(w[live] > omega / 2):.3f}', flush=True)
        ref_R = X.run(T, h0, books=True); ref = summary(P, X, ref_R, h0, 'reference')
        half = summary(P, X, X.run(T, h0 / 2, books=True), h0 / 2, 'h/2')
        res = dict(dump=path, h0=h0, joints=int(live.sum()), reference=ref, half=half, rules={})
        rows = [ref, half]
        for r, L in rules.items():
            lv = np.bincount(L[live], minlength=a.cap + 1)
            sub = subsystem_omegas(X, P, L)
            ok = all(sub[q] <= omega / 2 ** q * (1 + 1e-9) for q in range(len(sub)))
            R = X.run(T, h0, levels=L, books=True); m = summary(P, X, R, h0, r)
            m.update(levels=list(map(int, lv)), work=m['joint_updates'] / max(1, ref['joint_updates']),
                     sub_omega=[x / omega for x in sub], sub_ok=ok)
            if a.radius:
                rho, pmax, n = macro_radius(X, P, L, h0)
                m.update(rho=rho, pmax=pmax)
            res['rules'][r] = m; rows.append(m)
            print(f"  levels {r}: {list(map(int, lv))}; joint updates {m['work']:.3f} of uniform; subsystem omega/omega_L "
                  f"{' '.join(f'{x * 2 ** q:.3f}' for q, x in enumerate(m['sub_omega']))} ({'stable' if ok else 'OVER'})"
                  + (f"; macro map rho - 1 {m['rho'] - 1:.2e} over {m['pmax']} steps" if a.radius else ''), flush=True)
        for r in rows:
            print(f"  {r['label']:9s} h {r['h_us']:6.2f} us, {r['steps']} steps, {r['joint_updates']} joint updates (window {window_us(r['per_step']) / 1e3:.2f} ms by the cost model): "
                  f"broken {r['n_broken']}, yielded {len(r['yielded'])}, dp {r['dp']:.2f} N s (net {r['dp_net']:.2f}), line dist med/max {r['med_m']:.2f}/{r['max_m']:.2f} m; "
                  f"KE {r['ke_in']:.6g} -> {r['ke_out']:.6g} J, house KE {r['ke_house']:.4g}, fracture {r['fracture']:.4g}, plastic {r['plastic']:.4g} (return {r['return_drop']:.4g}), "
                  f"contact {r['contact']:.4g}, invariant deficit {r['deficit']}, books |resid| max {r['books_max']:.3g} J", flush=True)
        def gate(m):
            g = {}
            g['jaccard'] = (jac(ref['broken'], m['broken']), jac(ref['broken'], half['broken']))
            g['jaccard_yield'] = (jac(ref['yielded'], m['yielded']), jac(ref['yielded'], half['yielded']))
            for key in ('dp', 'ke_out', 'ke_house', 'fracture', 'plastic', 'med_m', 'max_m'):
                g[key] = (abs(m[key] - ref[key]), abs(half[key] - ref[key]))
            return g
        for r in rules:
            g = gate(res['rules'][r]); res['rules'][r]['gate'] = g
            common = set(ref['times']) & set(res['rules'][r]['times']); ch = set(ref['times']) & set(half['times'])
            sh = [abs(res['rules'][r]['times'][b] - ref['times'][b]) * 1e3 for b in common]; shh = [abs(half['times'][b] - ref['times'][b]) * 1e3 for b in ch]
            res['rules'][r]['shift_ms'] = (float(np.median(sh)) if sh else 0.0, float(max(sh)) if sh else 0.0)
            res['rules'][r]['shift_half_ms'] = (float(np.median(shh)) if shh else 0.0, float(max(shh)) if shh else 0.0)
            print(f"  gate {r} (multirate vs reference | h/2 vs reference): " + ', '.join(
                f"{k} {x:.3g}|{y:.3g}{'' if (x >= y if k.startswith('jac') else x <= y * (1 + 1e-9) + 1e-12) else ' FAIL'}" for k, (x, y) in g.items())
                + f"; break-time shift median/max {res['rules'][r]['shift_ms'][0]:.3f}/{res['rules'][r]['shift_ms'][1]:.3f} ms (h/2: {res['rules'][r]['shift_half_ms'][0]:.3f}/{res['rules'][r]['shift_half_ms'][1]:.3f})", flush=True)
        # stability over long windows: the books' residual (the shadow energy against fracture, the return,
        # the rows: exactly 0 for one rate) per tick, full physics and elastic (no fracture or yield)
        if a.long_ticks > 0:
            for r, L in rules.items():
                for el in (False, True):
                    try: R = X.run(a.long_ticks * T, h0, levels=L, books=True, elastic=el, record=())
                    except FloatingPointError as ex:
                        res['rules'][r]['long_elastic' if el else 'long'] = str(ex)
                        print(f"  long {r} {'elastic' if el else 'full   '}: {ex}", flush=True); continue
                    b = np.array([(x[0], x[2], x[1]) for x in R['books']]); tick = np.floor(b[:, 0] / T - 1e-9).astype(int)
                    per_tick = [float(np.max(np.abs(b[tick == q, 1]))) for q in range(int(a.long_ticks)) if (tick == q).any()]
                    Emax = float(np.max(np.abs(b[:, 2])))
                    res['rules'][r]['long_elastic' if el else 'long'] = per_tick
                    print(f"  long {r} {'elastic' if el else 'full   '} ({a.long_ticks:g} ticks): books |resid| per tick " + ' '.join(f'{x:.3g}' for x in per_tick)
                          + f" J (shadow energy up to {Emax:.4g} J)", flush=True)
        out.append(res)
    if a.json: pathlib.Path(a.json).write_text(json.dumps(out, indent=1, default=float))


if __name__ == '__main__':
    sys.exit(main())
