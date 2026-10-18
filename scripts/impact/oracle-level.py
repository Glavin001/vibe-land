#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""The impact solve's capped level, solved exactly in FP64 (a diagnostic oracle,
never a runtime path).

    PhysX destruction_impact_capture_replay CAPTURE.impc with IMPACT_DUMP=PREFIX
        writes PREFIX-island<id>.bin: the island at the level whose solve capped
        (load fraction lambda), with each link's wrench blocks on its nodes
    uv run scripts/impact/oracle-level.py PREFIX-island<id>.bin [--first-row-point x y z]

The problem (PxgDestructionImpact.cuh, solve):
    minimise 1/2 sum_nodes |q_n + sum_links B_ln J_l|^2_{M_n^-1} + 1/2 sum_links sum_i (J_li - T_li)^2 / (k_li dt^2)
    over J_l in C_l
with q_n = (1 - lambda) pb + lambda pf - r (the dump's node load), J in each
link's bond frame (N, V1, V2, twist, M0, M1). C_l: a joint's
    N + pull <= capT, bend - N <= capC, |V| + gt |twist| <= capS,
    bend = g0|M0| + g1|M1|, pull = h0|M0| + h1|M1| (section L1 set; g0 > 0),
    or bend = pull = gb |M| (round set);
a contact row's Coulomb cone: N <= 0, |V| <= mu (-N), no couple; a dead link 0.
Reports: the optimum's objective (and the dump's J, the last converged state,
for scale), the joints at capacity (utilisation >= 1 - capacityBand: a
brittle one breaks there), each contact row's impulse, the solver's status.
"""
import argparse, sys
import numpy as np
import scipy.sparse as sp
import cvxpy as cp

ALIVE, CONTACT, DUCTILE = 8, 16, 4


def load(path):
    raw = open(path, 'rb').read()
    u32 = lambda off, n: np.frombuffer(raw, np.uint32, n, off)
    f32 = lambda off, n: np.frombuffer(raw, np.float32, n, off).astype(np.float64)
    nn, nl, nb, nr = u32(0, 4); dt, lam, band, tol = f32(16, 4)
    off = 32
    node_chunk = np.zeros(nn, np.int64); node_tensor = np.zeros(nn, bool); node_f = np.zeros((nn, 14))
    for i in range(nn):
        c, t = u32(off, 2); node_chunk[i] = c; node_tensor[i] = t != 0; off += 8
        node_f[i] = f32(off, 14); off += 56
    link_u = np.zeros((nl, 4), np.int64); link_f = np.zeros((nl, 14)); J = np.zeros((nl, 6)); T = np.zeros((nl, 6)); B = np.zeros((nl, 72))
    for l in range(nl):
        link_u[l] = u32(off, 4); off += 16
        link_f[l] = f32(off, 14); off += 56
        J[l] = f32(off, 6); off += 24
        T[l] = f32(off, 6); off += 24
        B[l] = f32(off, 72); off += 288
    assert off == len(raw), (off, len(raw))
    return dict(nn=int(nn), nl=int(nl), nb=int(nb), nr=int(nr), dt=float(dt), lam=float(lam), band=float(band), tol=float(tol),
                node_chunk=node_chunk, node_tensor=node_tensor, node_f=node_f, link_u=link_u, link_f=link_f, J=J, T=T, B=B)


def sym(S):
    xx, yy, zz, xy, xz, yz = S
    return np.array([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]])


def utilisation(f, x):
    capC, capT, capS, gb, gt, g0, g1, h0, h1 = f[:9]
    N = x[0]; V = np.hypot(x[1], x[2]); Tw = abs(x[3]); M = np.hypot(x[4], x[5])
    bend = g0 * abs(x[4]) + g1 * abs(x[5]) if g0 > 0 else gb * M
    pull = h0 * abs(x[4]) + h1 * abs(x[5]) if g0 > 0 else bend
    r = lambda d, c: 0.0 if d <= 0 else (d / c if c > 0 else np.inf)
    return max(r(max(N + pull, 0), capT), r(max(bend - N, 0), capC), r(V + gt * Tw, capS))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dump')
    ap.add_argument('--solver', default='CLARABEL')
    ap.add_argument('--out', help='write the optimum J (nl x 6 float64, link order) for destruction_impact_level_replay')
    a = ap.parse_args()
    d = load(a.dump)
    nn, nl, dt = d['nn'], d['nl'], d['dt']
    index = {int(c): i for i, c in enumerate(d['node_chunk'])}
    # The node rows of B (6 per node) by link column (6 per link).
    rows, cols, vals = [], [], []
    for l in range(nl):
        _, c0, c1, flags = d['link_u'][l]
        for end, c in ((0, c0), (1, c1)):
            n = index.get(int(c))
            if n is None: continue          # an anchor: not a node of the island
            blk = d['B'][l, 36 * end:36 * end + 36].reshape(6, 6)
            for k in range(6):
                for q in range(6):
                    if blk[k, q] != 0.0: rows.append(6 * n + k); cols.append(6 * l + q); vals.append(blk[k, q])
    Bm = sp.csr_matrix((vals, (rows, cols)), shape=(6 * nn, 6 * nl))
    # M^-1/2 per node (scalar or tensor inertia).
    S_rows, S_cols, S_vals = [], [], []
    for n in range(nn):
        f = d['node_f'][n]; im, ii = f[0], f[1]
        for k in range(3): S_rows.append(6 * n + k); S_cols.append(6 * n + k); S_vals.append(np.sqrt(im))
        if d['node_tensor'][n]:
            w, V = np.linalg.eigh(sym(f[2:8])); R = V @ np.diag(np.sqrt(np.maximum(w, 0))) @ V.T
            for i in range(3):
                for j in range(3): S_rows.append(6 * n + 3 + i); S_cols.append(6 * n + 3 + j); S_vals.append(R[i, j])
        else:
            for k in range(3): S_rows.append(6 * n + 3 + k); S_cols.append(6 * n + 3 + k); S_vals.append(np.sqrt(ii))
    S = sp.csr_matrix((S_vals, (S_rows, S_cols)), shape=(6 * nn, 6 * nn))
    q = d['node_f'][:, 8:14].reshape(-1)
    x = cp.Variable(6 * nl)
    X = cp.reshape(x, (nl, 6), order='C')
    obj = 0.5 * cp.sum_squares(S @ (q + Bm @ x))
    kk = d['link_f'][:, 9:13]; kfull = np.stack([kk[:, 0], kk[:, 0], kk[:, 0], kk[:, 1], kk[:, 2], kk[:, 3]], 1)
    alive = (d['link_u'][:, 3] & ALIVE) != 0; contact = (d['link_u'][:, 3] & CONTACT) != 0
    finite = np.isfinite(kfull) & (kfull < 1e30) & alive[:, None]
    wgt = np.where(finite, 1.0 / (np.where(finite, kfull, 1.0) * dt * dt), 0.0).reshape(-1)
    Tv = d['T'].reshape(-1)
    obj = obj + 0.5 * cp.sum_squares(cp.multiply(np.sqrt(wgt), x - Tv))
    cons = []
    dead = np.where(~alive)[0]
    if len(dead): cons.append(X[dead, :] == 0)
    J_ = np.where(alive & ~contact)[0]; C_ = np.where(alive & contact)[0]
    if len(J_):
        f = d['link_f'][J_]
        capC, capT, capS, gb, gt, g0, g1, h0, h1 = (f[:, i] for i in range(9))
        L1 = g0 > 0
        Xj = X[J_, :]
        absM0 = cp.abs(Xj[:, 4]); absM1 = cp.abs(Xj[:, 5]); Mn = cp.norm(Xj[:, 4:6], 2, axis=1)
        bend = cp.multiply(np.where(L1, g0, 0), absM0) + cp.multiply(np.where(L1, g1, 0), absM1) + cp.multiply(np.where(L1, 0, gb), Mn)
        pull = cp.multiply(np.where(L1, h0, 0), absM0) + cp.multiply(np.where(L1, h1, 0), absM1) + cp.multiply(np.where(L1, 0, gb), Mn)
        cons += [Xj[:, 0] + pull <= capT, bend - Xj[:, 0] <= capC, cp.norm(Xj[:, 1:3], 2, axis=1) + cp.multiply(gt, cp.abs(Xj[:, 3])) <= capS]
    if len(C_):
        mu = d['link_f'][C_, 13]; Xc = X[C_, :]
        cons += [Xc[:, 0] <= 0, cp.norm(Xc[:, 1:3], 2, axis=1) <= cp.multiply(mu, -Xc[:, 0]), Xc[:, 3:6] == 0]
    prob = cp.Problem(cp.Minimize(obj), cons)
    def objective(xv):
        w = S @ (q + Bm @ xv); return 0.5 * w @ w + 0.5 * np.sum(wgt * (xv - Tv) ** 2)
    print(f"{a.dump}: {nn} nodes, {nl} links ({d['nb']} joints, {d['nr']} contacts), lambda {d['lam']:.4g}, dt {dt:.5g}")
    prob.solve(solver=a.solver, verbose=False)
    print(f"  {a.solver}: {prob.status}, objective {prob.value:.9g} (the last converged state's J: {objective(d['J'].reshape(-1)):.9g}; J = 0: {objective(np.zeros(6 * nl)):.9g})")
    if x.value is None: return 1
    Jopt = x.value.reshape(nl, 6)
    if a.out: np.ascontiguousarray(Jopt, np.float64).tofile(a.out)
    u = np.array([utilisation(d['link_f'][l], Jopt[l]) for l in J_]) if len(J_) else np.zeros(0)
    at = J_[u >= 1 - d['band']]
    ductile = (d['link_u'][at, 3] & DUCTILE) != 0
    print(f"  joints at capacity (utilisation >= 1 - {d['band']}): {len(at)} ({int((~ductile).sum())} brittle: they break at this level; {int(ductile.sum())} ductile: they yield)")
    for l in at[np.argsort(-u[u >= 1 - d['band']])][:40]:
        print(f"    bond {d['link_u'][l, 0]} (chunks {d['link_u'][l, 1]} {d['link_u'][l, 2]}{', ductile' if d['link_u'][l, 3] & DUCTILE else ''}): utilisation {utilisation(d['link_f'][l], Jopt[l]):.4f}")
    total = np.zeros(3)
    for l in C_:
        # The row's force on its struck chunk, world frame: the wrench block on chunk0 (the struck chunk) times J.
        F = d['B'][l, :36].reshape(6, 6) @ Jopt[l]
        total += F[:3] * dt
        print(f"  contact link {l} (row {d['link_u'][l, 0]}, chunk {d['link_u'][l, 1]}): impulse on the chunk ({F[0]*dt:.4g} {F[1]*dt:.4g} {F[2]*dt:.4g}) N s")
    print(f"  total contact impulse on the struck chunks: ({total[0]:.5g} {total[1]:.5g} {total[2]:.5g}) N s, |.| {np.linalg.norm(total):.5g}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
