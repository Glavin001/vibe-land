#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""The GPU impact solve's ADMM, step for step, on a dumped level -- in FP64 or
emulated FP32 (a diagnostic, never a runtime path).

    uv run scripts/impact/admm-fp64.py DUMP.bin --length-scale L [--jstep exact|cg] [--inner-tol 1]

Same formulation, same scaling, same rho schedule as PxgDestructionImpact.cuh
`solve`: penalty R = rho D (D the kinetic majoriser of `precondition`), the J
step through N = M + B A^-1 B^T (A = C + R), the Z step the projection onto each
link's capacity set in the metric R (a port of `project`), U += J - Z, OSQP
rebalance every 25 steps. The J step is either exact (a sparse direct solve)
or the GPU's: block-Jacobi conjugate gradients warm-started from the last y and
stopped when the residual's motion over the tick is under inner-tol x tolerance.

Per step it records primal, dual, motion, rho, the CG iterations and the J
step's own error (|J - J_exact| as dual-residual motion), so an inexact J step
can be told from a non-convergent ADMM.
"""
import argparse, importlib.util, os, sys, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spl

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('oracle_level', os.path.join(HERE, 'oracle-level.py'))
oracle = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(oracle)
ALIVE, CONTACT = 8, 16
FLT_MAX = np.float32(3.4028235e38)


# ---------------------------------------------------------------------------
# Projections (vectorised ports of polytope / triangle / projectContact)
# ---------------------------------------------------------------------------
def tri_project(px, py, ax, ay, bx, by, cx, cy):
    """Nearest point of the triangle (a, b, c) (counter-clockwise) to p; arrays."""
    e0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    e1 = (cx - bx) * (py - by) - (cy - by) * (px - bx)
    e2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
    inside = (e0 >= 0) & (e1 >= 0) & (e2 >= 0)
    best = np.full(px.shape, np.inf, dtype=px.dtype); qx = px.copy(); qy = py.copy()
    for (sx, sy, tx, ty) in ((ax, ay, bx, by), (bx, by, cx, cy), (cx, cy, ax, ay)):
        ex, ey = tx - sx, ty - sy; l = ex * ex + ey * ey
        t = np.where(l > 0, ((px - sx) * ex + (py - sy) * ey) / np.where(l > 0, l, 1), 0.0); t = np.clip(t, 0, 1)
        x, y = sx + t * ex, sy + t * ey; d = (px - x) ** 2 + (py - y) ** 2
        m = d < best; best = np.where(m, d, best); qx = np.where(m, x, qx); qy = np.where(m, y, qy)
    return np.where(inside, px, qx), np.where(inside, py, qy), ~inside


def polytope(p, w, g0, g1, h0, h1, capT, capC):
    """Projection of p = (N, |M0|, |M1|) onto the section's L1 set in metric diag(w): the GPU's KKT bisection."""
    p = p.copy()
    tolT, tolC = 1e-6 * capT, 1e-6 * capC
    ten = lambda q: h0 * q[:, 1] + h1 * q[:, 2] + q[:, 0]
    com = lambda q: g0 * q[:, 1] + g1 * q[:, 2] - q[:, 0]
    out = ~((ten(p) <= capT + tolT) & (com(p) <= capC + tolC))
    if not out.any(): return p
    idx = np.where(out)[0]
    P = p[idx]; W = w[idx]; G0, G1, H0, H1, CT, CC = g0[idx], g1[idx], h0[idx], h1[idx], capT[idx], capC[idx]
    def point(lt, lc):
        q = np.empty_like(P)
        q[:, 0] = P[:, 0] - (lt - lc) / W[:, 0]
        q[:, 1] = np.maximum(0, P[:, 1] - (lt * H0 + lc * G0) / W[:, 1])
        q[:, 2] = np.maximum(0, P[:, 2] - (lt * H1 + lc * G1) / W[:, 2])
        return q
    gm = np.maximum(np.minimum(G0, G1), 1e-30); hm = np.maximum(np.minimum(H0, H1), 1e-30)
    big = (np.abs(P[:, 0]) + CT + CC + (G0 + H0) * P[:, 1] + (G1 + H1) * P[:, 2]) * \
        (W[:, 0] + W[:, 1] / (gm * hm) + W[:, 2] / (gm * hm) + W[:, 1] / gm ** 2 + W[:, 2] / hm ** 2) + 1.0
    res = np.full(P.shape, np.nan, dtype=P.dtype); done = np.zeros(len(idx), bool)
    tenL = lambda q: H0 * q[:, 1] + H1 * q[:, 2] + q[:, 0]
    comL = lambda q: G0 * q[:, 1] + G1 * q[:, 2] - q[:, 0]
    for side in (0, 1):
        lo = np.zeros(len(idx), P.dtype); hi = big.copy()
        for _ in range(64):
            mid = 0.5 * (lo + hi)
            q = point(mid, 0 * mid) if side == 0 else point(0 * mid, mid)
            f = tenL(q) - CT if side == 0 else comL(q) - CC
            lo = np.where(f > 0, mid, lo); hi = np.where(f > 0, hi, mid)
        q = point(hi, 0 * hi) if side == 0 else point(0 * hi, hi)
        other = comL(q) - CC if side == 0 else tenL(q) - CT
        ok = (~done) & (other <= (tolC[idx] if side == 0 else tolT[idx]))
        res[ok] = q[ok]; done |= ok
    if (~done).any():
        k = ~done
        tau = CT + CC; c0 = G0 + H0; c1 = G1 + H1
        A = tau / c1; Bc = -c0 / c1; C = CT - H1 * A; D = -H0 - H1 * Bc
        num = W[:, 0] * D * (P[:, 0] - C) + W[:, 1] * P[:, 1] + W[:, 2] * Bc * (P[:, 2] - A)
        den = W[:, 0] * D * D + W[:, 1] + W[:, 2] * Bc * Bc
        smax = tau / c0; sv = np.clip(np.where(den > 0, num / den, 0), 0, smax)
        q = np.stack([C + D * sv, sv, np.maximum(0, A + Bc * sv)], 1)
        res[k] = q[k]
    p[idx] = res
    return p


def project(x, f, flags, R):
    """Port of `project` (x: [nl, 6] bond-frame wrenches, R: [nl, 6] metric)."""
    x = x.copy()
    contact = (flags & CONTACT) != 0
    capC0, capT, capS, gb, gt, g0, g1, h0, h1 = (f[:, i] for i in range(9))
    mu = f[:, 13]
    # Contacts: compression cone, no couple.
    c = np.where(contact)[0]
    if len(c):
        s = -x[c, 0]; v = np.hypot(x[c, 1], x[c, 2]); m = mu[c]
        inside = v <= m * s; polar = (~inside) & (m * v <= -s)
        t = (s + m * v) / (1 + m * m); k = np.where(v > 0, m * t / np.where(v > 0, v, 1), 0)
        n0 = np.where(inside, x[c, 0], np.where(polar, 0, -t))
        n1 = np.where(inside, x[c, 1], np.where(polar, 0, x[c, 1] * k))
        n2 = np.where(inside, x[c, 2], np.where(polar, 0, x[c, 2] * k))
        x[c, 0], x[c, 1], x[c, 2] = n0, n1, n2; x[c, 3:6] = 0
    j = np.where(~contact)[0]
    if not len(j): return x
    capC = np.minimum(capC0[j], 1e3 * np.maximum(capT[j], capS[j]))
    sl = np.sqrt(R[j, 0])
    L1 = g0[j] > 0
    a = j[L1]
    if len(a):
        p = np.stack([x[a, 0], np.abs(x[a, 4]), np.abs(x[a, 5])], 1)
        w = np.stack([R[a, 0], R[a, 4], R[a, 5]], 1)
        q = polytope(p, w, g0[a], g1[a], h0[a], h1[a], capT[a], capC[L1])
        x[a, 0] = q[:, 0]; x[a, 4] = np.copysign(q[:, 1], x[a, 4]); x[a, 5] = np.copysign(q[:, 2], x[a, 5])
    r_ = j[~L1]
    if len(r_):
        cc = capC[~L1]; ct = capT[r_]; slr = sl[~L1]; sa = np.sqrt(R[r_, 4])
        m = np.hypot(x[r_, 4], x[r_, 5]); s = slr * x[r_, 0]; r = sa * m
        fromT = s > 0.5 * slr * (ct - cc); o = np.where(fromT, slr * ct, -slr * cc)
        s2, r2, mv = tri_project(s - o, r, -slr * cc - o, 0 * s, slr * ct - o, 0 * s, 0.5 * slr * (ct - cc) - o, 0.5 * sa * (ct + cc) / gb[r_])
        s2 = s2 + o; mn = r2 / sa
        scale = np.where(m > 0, mn / np.where(m > 0, m, 1), 0)
        x[r_, 0] = np.where(mv, s2 / slr, x[r_, 0])
        x[r_, 4] = np.where(mv, x[r_, 4] * scale, x[r_, 4]); x[r_, 5] = np.where(mv, x[r_, 5] * scale, x[r_, 5])
    # Shear set (T, V): |V| + gt |T| <= capS.
    sa = np.sqrt(R[j, 3]); v = np.hypot(x[j, 1], x[j, 2]); s = sa * x[j, 3]; r = sl * v
    cs = capS[j]; g = gt[j]
    s2, r2, mv = tri_project(s, r, -sa * cs / g, 0 * s, sa * cs / g, 0 * s, 0 * s, sl * cs)
    vn = r2 / sl; scale = np.where(v > 0, vn / np.where(v > 0, v, 1), 0)
    x[j, 3] = np.where(mv, s2 / sa, x[j, 3])
    x[j, 1] = np.where(mv, x[j, 1] * scale, x[j, 1]); x[j, 2] = np.where(mv, x[j, 2] * scale, x[j, 2])
    return x


def utilisation(f, flags, x):
    return np.array([oracle.utilisation(f[l], x[l]) if not flags[l] & CONTACT else 0.0 for l in range(len(x))])


# ---------------------------------------------------------------------------
# The problem
# ---------------------------------------------------------------------------
class Problem:
    def __init__(self, d, L, F=np.float64):
        self.d = d; self.L = L; self.F = F
        nn, nl = d['nn'], d['nl']; self.nn, self.nl = nn, nl
        self.dt = d['dt']; self.idt2 = 1.0 / self.dt ** 2
        index = {int(c): i for i, c in enumerate(d['node_chunk'])}
        self.flags = d['link_u'][:, 3].astype(np.int64); self.f = d['link_f']
        self.alive = (self.flags & ALIVE) != 0; self.contact = (self.flags & CONTACT) != 0
        rows, cols, vals = [], [], []
        self.ends = []   # per link: list of (node, |o|^2)
        for l in range(nl):
            _, c0, c1, _ = d['link_u'][l]; e = []
            for end, c in ((0, c0), (1, c1)):
                n = index.get(int(c))
                if n is None: continue
                blk = d['B'][l, 36 * end:36 * end + 36].reshape(6, 6)
                o2 = 0.5 * float(np.sum(blk[3:6, 0:3] ** 2))
                e.append((n, o2))
                for k in range(6):
                    for q in range(6):
                        if blk[k, q] != 0.0: rows.append(6 * n + k); cols.append(6 * l + q); vals.append(blk[k, q])
            self.ends.append(e)
        self.B = sp.csr_matrix((vals, (rows, cols)), shape=(6 * nn, 6 * nl))
        self.Bt = self.B.T.tocsr()
        # M^-1 and M per node.
        Mi = np.zeros((nn, 6, 6)); Mm = np.zeros((nn, 6, 6)); self.im = np.zeros(nn); self.iimax = np.zeros(nn)
        for n in range(nn):
            f = d['node_f'][n]; im, ii = f[0], f[1]
            Mi[n, :3, :3] = np.eye(3) * im; Mm[n, :3, :3] = np.eye(3) / im; self.im[n] = im
            if d['node_tensor'][n]:
                S = oracle.sym(f[2:8]); Mi[n, 3:, 3:] = S; Mm[n, 3:, 3:] = np.linalg.inv(S)
                self.iimax[n] = np.max(np.sum(np.abs(S), 1))
            else:
                Mi[n, 3:, 3:] = np.eye(3) * ii; Mm[n, 3:, 3:] = np.eye(3) * (1 / ii if ii > 0 else 0); self.iimax[n] = ii
        self.Mi = sp.block_diag(list(Mi)).tocsr(); self.M = sp.block_diag(list(Mm)).tocsr(); self.Mi_blocks = Mi
        self.q = d['node_f'][:, 8:14].reshape(-1)
        kk = self.f[:, 9:13]
        k6 = np.stack([kk[:, 0], kk[:, 0], kk[:, 0], kk[:, 1], kk[:, 2], kk[:, 3]], 1)
        self.C = np.where(self.contact[:, None] | (k6 >= 1e30), 0.0, self.idt2 / np.where(k6 > 0, k6, 1))
        self.C[~self.alive] = 0
        self.T = d['T'].copy(); self.T[~self.alive] = 0
        # The kinetic majoriser D (precondition): Gershgorin over each dynamic endpoint's live links.
        deg = np.zeros(nn)
        for l in range(nl):
            if self.alive[l]:
                for n, _ in self.ends[l]: deg[n] += 1
        self.D = np.ones((nl, 6))
        for l in range(nl):
            dl = da = 0.0
            for n, o2 in self.ends[l]:
                dl += deg[n] * (self.im[n] + 2 * o2 * self.iimax[n]); da += deg[n] * 2 * self.iimax[n]
            self.D[l, :3] = dl if dl > 0 else 1; self.D[l, 3:] = da if da > 0 else 1
        cap = np.maximum(np.maximum(self.f[:, 0], self.f[:, 1]), self.f[:, 2]); self.cap = cap
        self.gain = np.maximum(np.maximum(self.f[:, 3], self.f[:, 4]), np.maximum(self.f[:, 5], self.f[:, 6]))
        self.u = self.Mi @ self.q   # M^-1 p
        # The working precision (FP32 emulates the GPU's arithmetic; the operators rounded to float as the GPU holds them).
        self.B64, self.Bt64 = self.B, self.Bt
        self.B = self.B.astype(F); self.Bt = self.Bt.astype(F); self.M = self.M.astype(F); self.Mi = self.Mi.astype(F)
        self.Bf = self.f.astype(F); self.u = self.u.astype(F); self.C = self.C.astype(F); self.D = self.D.astype(F); self.T = self.T.astype(F)

    def N(self, Ainv):
        return (self.M.astype(np.float64) + self.B64 @ sp.diags(Ainv.reshape(-1).astype(np.float64)) @ self.Bt64).tocsc()

    def objective(self, J):
        r = self.q + self.B @ J.reshape(-1); a = self.Mi @ r
        return 0.5 * r @ a + 0.5 * np.sum(self.C * (J - self.T) ** 2)

    def node_motion(self, r):
        a = (self.Mi @ r).reshape(-1, 6)
        return 0.5 * self.dt ** 2 * max(np.max(np.linalg.norm(a[:, :3], axis=1)), np.max(np.linalg.norm(a[:, 3:], axis=1)) * self.L)


def run(P, args):
    tol, ctol = args.tol, args.ctol
    eps8 = 8 * (np.finfo(np.float32).eps if args.floors == 'fp32' else np.finfo(np.float64).eps)
    F = P.F
    J = P.d['J'].astype(F); J[~P.alive] = 0
    Z = J.copy(); U = np.zeros_like(J); y = np.zeros(6 * P.nn, F)
    rho = F(args.rho); half = 0.5 * P.dt ** 2
    # The product's J-step stop (PxgDestructionImpact.cuh solve, innerLimit): innerTolerance,
    # at most 1 / (4 (1 + |o|/L)) for the island's longest lever.
    lever = max((np.sqrt(o2) for e in P.ends for _, o2 in e), default=0.0)
    limit = args.inner_tol if args.raw_inner else min(args.inner_tol, 0.25 / (1.0 + lever / P.L))
    worstJ = 0.0
    if args.start:   # a capped solve's state (IMPACT_DUMP's .state.bin): rho, steps, Z, U, y
        raw = np.fromfile(args.start, np.float32); nl6, nn6 = 6 * P.nl, 6 * P.nn
        rho = F(raw[0] if args.rho_from_start else args.rho); Z = raw[2:2 + nl6].reshape(-1, 6).astype(F); U = raw[2 + nl6:2 + 2 * nl6].reshape(-1, 6).astype(F)
        y = raw[2 + 2 * nl6:2 + 2 * nl6 + nn6].astype(F)
        print(f"  resuming from {args.start}: rho {rho:.4g} after {raw[1]:.0f} steps")
    g = (P.Bt @ P.u).reshape(-1, 6)
    fact = None; factRho = None; blocks = None
    hist = []
    t0 = time.time()
    for it in range(args.iterations):
        R = rho * P.D; Ainv = F(1) / (P.C + R); Ainv[~P.alive] = 0
        if fact is None or factRho != rho:
            Nm = P.N(Ainv); fact = spl.splu(Nm); factRho = rho
            Nd = Nm.toarray() if P.nn * 6 <= 3000 else None
            # Block-Jacobi preconditioner: each node's exact 6x6 block inverted.
            blocks = np.zeros((P.nn, 6, 6))
            Ncsr = Nm.tocsr()
            for n in range(P.nn): blocks[n] = np.linalg.inv(Ncsr[6 * n:6 * n + 6, 6 * n:6 * n + 6].toarray())
            blocks = blocks.astype(F)
        a = Ainv * (-g + P.C * P.T + R * (Z - U)); a[~P.alive] = 0
        b = P.B @ a.reshape(-1)
        y_exact = fact.solve(b.astype(np.float64))
        cg = 0
        if args.jstep == 'exact':
            y = y_exact.astype(F); motion = 0.0
        else:
            Nm_ = None
            def Nmul(v): return P.M @ v + P.B @ (Ainv.reshape(-1) * (P.Bt @ v))
            def prec(r): return np.einsum('nij,nj->ni', blocks, r.reshape(-1, 6)).reshape(-1)
            r = b - Nmul(y); z = prec(r); p = z.copy(); rz = r @ z
            motion = P.node_motion(r)
            while cg < args.inner and rz > 0 and motion > limit * tol:
                q = Nmul(p); pq = p @ q
                if not pq > 0: break
                al = rz / pq; y = y + al * p; r = r - al * q; z = prec(r); rz2 = r @ z
                p = z + (rz2 / rz) * p; rz = rz2; cg += 1
                motion = P.node_motion(r)
        ey = (P.Bt @ y).reshape(-1, 6)
        Jn = Ainv * (-g + P.C * P.T + R * (Z - U) - ey); Jn[~P.alive] = 0
        Jx = Ainv * (-g + P.C * P.T + R * (Z - U) - (P.Bt @ y_exact).reshape(-1, 6)); Jx[~P.alive] = 0
        # The J step's error in the dual residual's own metric (a joint's relative
        # motion over the tick: 1/2 dt^2 |R (J - J_exact)|, rotations at L).
        dJ = R * (Jn - Jx); jerr = half * max(np.max(np.linalg.norm(dJ[:, :3], axis=1)), np.max(np.linalg.norm(dJ[:, 3:], axis=1)) * P.L)
        worstJ = max(worstJ, jerr)
        x = Jn + U
        Zold = Z
        Z = project(x, P.Bf, P.flags, R); Z[~P.alive] = 0
        U = U + Jn - Z
        rp = Jn - Z; rd = R * (Z - Zold)
        lp = np.linalg.norm(rp[:, :3], axis=1); ap = np.linalg.norm(rp[:, 3:], axis=1)
        prim_j = (lp + P.gain * ap) / P.cap
        # Contacts: the motion the split leaves unexplained, as a fraction of the joints' scale.
        prim = np.where(P.contact, 0.0, prim_j)
        if P.contact.any():
            for l in np.where(P.contact & P.alive)[0]:
                im = sum(P.im[n] for n, _ in P.ends[l]); ii = sum(P.iimax[n] for n, _ in P.ends[l])
                prim[l] = half * (lp[l] * im + ap[l] * ii * P.L) / tol * ctol
        primal = float(np.max(prim[P.alive]))
        ld = np.linalg.norm(rd[:, :3], axis=1); ad = np.linalg.norm(rd[:, 3:], axis=1)
        zl = np.maximum(np.linalg.norm(Z[:, :3], axis=1), np.linalg.norm(x[:, :3], axis=1))
        za = np.maximum(np.linalg.norm(Z[:, 3:], axis=1), np.linalg.norm(x[:, 3:], axis=1))
        uu = P.u.reshape(-1, 6); yy = y.reshape(-1, 6)
        ua = np.zeros(P.nl); uw = np.zeros(P.nl)
        un = np.linalg.norm(uu[:, :3], axis=1) + np.linalg.norm(yy[:, :3], axis=1)
        wn = np.linalg.norm(uu[:, 3:], axis=1) + np.linalg.norm(yy[:, 3:], axis=1)
        for l in range(P.nl):
            for n, _ in P.ends[l]: ua[l] += un[n]; uw[l] += wn[n]
        fl = half * eps8 * np.maximum(R[:, 0] * zl, ua); fa = half * eps8 * np.maximum(R[:, 3:].max(1) * za, uw) * P.L
        rl = half * ld; ra = half * ad * P.L
        dl_ = np.maximum(rl / np.maximum(1, fl / tol), ra / np.maximum(1, fa / tol))
        dual = float(np.max(dl_[P.alive]))
        worst = int(np.argmax(np.where(P.alive, np.maximum(prim / ctol, dl_ / tol), -1)))
        hist.append((it, primal, dual, motion, rho, cg, jerr, worst))
        if it % args.every == 0 or it < 5:
            print(f"  step {it:7d}: primal {primal:.3e} dual {dual:.3e} motion {motion:.2e} rho {rho:.4g} cg {cg:2d} J-step error {jerr:.2e} worst link {worst}", flush=True)
        if primal <= ctol and dual <= tol and motion <= tol:
            print(f"  converged at step {it + 1} ({time.time() - t0:.1f} s): primal {primal:.3e} dual {dual:.3e}")
            break
        rpn, rdn = primal / ctol, dual / tol
        if it % 25 == 24 and (rpn > 0 or rdn > 0) and not args.fixed_rho:
            ratio = np.sqrt(rpn / rdn) if rdn > 0 else 10.0
            if (ratio > 5 and rho < 1e3) or (ratio < 0.2 and rho > 1e-3):
                nxt = min(max(rho * min(max(ratio, 0.1), 10.0), 1e-3), 1e3)
                U *= F(rho / nxt); rho = F(nxt)
    else:
        print(f"  NOT converged in {args.iterations} steps ({time.time() - t0:.1f} s)")
    print(f"  J step: stop at {limit:.3g} x tolerance (longest lever {lever:.3g} m, L {P.L:.3g} m); its worst error {worstJ:.3e} m = {worstJ / tol:.3f} x tolerance")
    run.worstJ = worstJ / tol; run.converged = it + 1 < args.iterations or (primal <= ctol and dual <= tol)
    return Z, hist


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dump'); ap.add_argument('--length-scale', type=float, default=1.0)
    ap.add_argument('--jstep', choices=('exact', 'cg'), default='exact')
    ap.add_argument('--inner-tol', type=float, default=0.1); ap.add_argument('--inner', type=int, default=64)
    ap.add_argument('--tol', type=float, default=1e-4); ap.add_argument('--ctol', type=float, default=1e-4)
    ap.add_argument('--rho', type=float, default=1.0); ap.add_argument('--fixed-rho', action='store_true')
    ap.add_argument('--iterations', type=int, default=20000); ap.add_argument('--every', type=int, default=500)
    ap.add_argument('--floors', choices=('fp32', 'fp64'), default='fp32')
    ap.add_argument('--start', help='resume from a .state.bin'); ap.add_argument('--rho-from-start', action='store_true', default=True)
    ap.add_argument('--raw-inner', action='store_true', help='stop the CG at inner-tol x tolerance (the pre-fix rule), not the product limit')
    ap.add_argument('--assert-jstep', type=float, help='exit 1 unless every J step errs by at most this fraction of the tolerance and the solve converges')
    ap.add_argument('--dtype', choices=('fp64', 'fp32'), default='fp64')
    ap.add_argument('--save', help='write the per-step history (npy)')
    a = ap.parse_args()
    d = oracle.load(a.dump)
    P = Problem(d, a.length_scale, np.float32 if a.dtype == 'fp32' else np.float64)
    print(f"{a.dump}: {P.nn} nodes, {P.nl} links ({d['nb']} joints, {d['nr']} contacts), lambda {d['lam']:.4g}; {a.dtype}; J step {a.jstep}"
          + (f" (CG to {a.inner_tol} x tolerance, at most {a.inner})" if a.jstep == 'cg' else ''))
    Z, hist = run(P, a)
    print(f"  objective {P.objective(Z):.9g} (dump J {P.objective(d['J']):.9g})")
    if a.save: np.save(a.save, np.array(hist))
    if a.assert_jstep is not None and not (run.converged and run.worstJ <= a.assert_jstep):
        print(f"  FAIL: J-step error {run.worstJ:.3f} x tolerance (allowed {a.assert_jstep}), converged {run.converged}"); return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
