#!/usr/bin/env python3
"""Offline convergence bench on captured native stress systems (sparse).

  uv run --with numpy --with scipy python3 scripts/stress/rotbench.py CAPTURE_DIR --solves 0 --prec poly6,agg16

Captures: the stress-problem capture SDK (scripts/perf/build-stress-capture-sdk.sh)
with PHYSX_STRESS_PROBLEM_PREFIX/_SOLVES and PHYSX_COMPONENT_WORK_OUTPUT set.
Preconditioners: poly6 (the native two-step polynomial on 6x6 block-Jacobi),
jac6, aggK / jaggK (strength-matched aggregates of at most K chunks, dense
blocks, with / without the polynomial). ticks(): a run of capped warm-started
solves at rest, restarted or carried (the Krylov carry).

Replays the native small-component PCG (projected steepest descent at
iteration 0, then restarted PCG) with candidate preconditioners and reports
iterations to: the native residual test, the force-tolerance test (1e-3), and
a true bond-force error of 1e-3 (max bond, relative to the largest bond force)
against the FP64 direct solution."""
import argparse, json, math, sys
from collections import defaultdict
from pathlib import Path
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
import scipy.linalg as la

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle  # noqa: E402

PA, PB = oracle.POLY_A, oracle.POLY_B


def skew(v):
    x, y, z = v
    return np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])


class Sys:
    def __init__(self, cap, identity):
        nodes, bonds = cap.nodes, cap.bonds
        members = np.flatnonzero(nodes['component'] == identity)
        labels = nodes['component']
        live = bonds['health'] > 0
        sel = np.flatnonzero(live & ((labels[bonds['first']] == identity) | (labels[bonds['second']] == identity)))
        local = np.full(len(nodes), -1, dtype=np.int64)
        local[members] = np.arange(len(members))
        rows, cols, vals = [], [], []
        anchored = False
        pairs = []
        for e, s in enumerate(sel):
            b = bonds[s]
            ends = []
            for side, key in enumerate(('first', 'second')):
                node = int(b[key]); i = local[node]
                if i < 0:
                    anchored = True; ends.append(-1); continue
                ends.append(i)
                blk = np.eye(6)
                blk[:3, 3:] = -skew(b['offset' + str(side)].astype(np.float64))
                if cap.rotation is not None:
                    blk[:, :3] = blk[:, :3] @ cap.rotation[s]
                blk[:3] *= float(nodes['inertia'][node][0]); blk[3:] *= float(nodes['inertia'][node][1])
                blk *= float(b['scale']) * (1 if side == 0 else -1)
                r, c = np.nonzero(blk)
                rows.extend((6 * i + r).tolist()); cols.extend((6 * e + c).tolist()); vals.extend(blk[r, c].tolist())
            pairs.append(ends)
        self.n = len(members)
        self.B = sp.csr_matrix((vals, (rows, cols)), shape=(6 * self.n, 6 * len(sel)))
        self.A = (self.B @ self.B.T).tocsr()
        self.pairs = np.array(pairs, dtype=np.int64)
        self.anchored = anchored
        self.members, self.sel = members, sel
        self.rhs = nodes['rhs'][members].astype(np.float64).ravel()
        self.warm = bonds['warm'][sel].astype(np.float64).ravel()
        self.r0 = self.rhs - self.B @ self.warm
        self.threshold = float(nodes['threshold'][members][0])
        # 6x6 diagonal blocks
        Ad = self.A
        self.blocks = np.array([Ad[6 * i:6 * i + 6, 6 * i:6 * i + 6].toarray() for i in range(self.n)])


# ----------------------------------------------------------- aggregation ---

def strength(S):
    """Scaled coupling strength per (i<j) node pair: ||D_i^-1/2 E_ij D_j^-1/2||_F."""
    n = S.n
    Lc = [np.linalg.cholesky(S.blocks[i]) for i in range(n)]
    Li = [np.linalg.inv(l) for l in Lc]
    A = S.A.tocoo()
    acc = defaultdict(float)
    Acsr = S.A
    seen = set()
    out = {}
    for (i, j) in S.pairs:
        if i < 0 or j < 0 or i == j:
            continue
        a, b = min(i, j), max(i, j)
        if (a, b) in out:
            continue
        E = Acsr[6 * a:6 * a + 6, 6 * b:6 * b + 6].toarray()
        out[(a, b)] = float(np.linalg.norm(Li[a] @ E @ Li[b].T))
    return out


def aggregate(S, K, mode='strength'):
    """Greedy union of strongest couplings, aggregates capped at K nodes."""
    n = S.n
    parent = list(range(n)); size = [1] * n

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    if n <= K:
        return np.zeros(n, dtype=np.int64)
    st = strength(S)
    order = sorted(st.items(), key=lambda kv: -kv[1]) if mode == 'strength' else list(st.items())
    for (a, b), w in order:
        ra, rb = find(a), find(b)
        if ra == rb or size[ra] + size[rb] > K:
            continue
        if size[ra] < size[rb]:
            ra, rb = rb, ra
        parent[rb] = ra; size[ra] += size[rb]
    roots = np.array([find(i) for i in range(n)])
    _, lab = np.unique(roots, return_inverse=True)
    return lab


class AggPrec:
    def __init__(self, S, labels, poly=True, f32=False):
        self.S, self.poly = S, poly
        A = S.A
        self.groups = [np.flatnonzero(labels == g) for g in range(labels.max() + 1)]
        self.idx = [np.concatenate([np.arange(6 * i, 6 * i + 6) for i in g]) for g in self.groups]
        self.inv = []
        dt = np.float32 if f32 else np.float64
        for ix in self.idx:
            blk = A[ix][:, ix].toarray()
            # scaled Cholesky inverse (as a GPU would hold it)
            d = np.sqrt(np.diag(blk)); bs = (blk / d[:, None] / d[None, :]).astype(dt)
            c = la.cho_factor(bs.astype(np.float64) if not f32 else bs, lower=True)
            self.inv.append((ix, d, c))
        rows, cols = [], []
        for ix in self.idx:
            rr, cc = np.meshgrid(ix, ix, indexing='ij'); rows.append(rr.ravel()); cols.append(cc.ravel())
        mask = sp.csr_matrix((np.ones(sum(len(r) for r in rows)), (np.concatenate(rows), np.concatenate(cols))), shape=A.shape)
        self.E = (A - A.multiply(mask)).tocsr()
        self.blocksize = [len(g) for g in self.groups]

    def M(self, v):
        out = np.zeros_like(v)
        for ix, d, c in self.inv:
            out[ix] = la.cho_solve(c, v[ix] / d) / d
        return out

    def __call__(self, r):
        z = self.M(r)
        if not self.poly:
            return z
        return (PA + PB - PA * PB) * z - PA * PB * self.M(self.E @ z)


# ------------------------------------------------------------- iteration ---

def run(S, prec, x_star, limit, first='identity', ftol=1e-3, dtype=np.float64):
    A, B = S.A, S.B
    lam_true = (S.warm + B.T @ x_star).reshape(-1, 6)
    peak = max(float(np.max(np.linalg.norm(lam_true, axis=1))), 1e-30)
    r0 = S.r0.copy()
    x = np.zeros_like(r0); r = r0.copy(); p = np.zeros_like(r0)
    prev = 0.0
    lam0n = float(np.linalg.norm(S.warm))
    travel = 0.0
    hit = dict(native=None, force_tol=None, err=None)
    errs = []
    for it in range(limit + 1):
        g = B.T @ r; e = float(g @ g)
        if hit['native'] is None and S.threshold > 0 and e <= S.threshold:
            rt = r0 - A @ x; gt = B.T @ rt
            if float(gt @ gt) <= S.threshold:
                hit['native'] = it
        lam = (S.warm + B.T @ x).reshape(-1, 6)
        err = float(np.max(np.linalg.norm(lam - lam_true, axis=1))) / peak
        errs.append(err)
        if all(h is not None for h in hit.values()) or it == limit:
            break
        usepoly = it > 0 or first != 'identity'
        z = prec(r) if usepoly else r.copy()
        z = z.astype(dtype)
        gamma = float(r @ z)
        restart = 1 if first == 'identity' else 0
        beta = gamma / prev if (it > restart and prev > 0) else 0.0
        p = z + beta * p
        q = A @ p
        den = float(p @ q)
        if not (den > 0 and gamma > 0):
            break
        alpha = gamma / den
        x = x + alpha * p; r = (r - alpha * q).astype(dtype)
        prev = gamma
        step = gamma / math.sqrt(den)
        travel += step
        if hit['force_tol'] is None and usepoly:
            if step <= ftol * (lam0n + travel):
                lamn = float(np.linalg.norm(S.warm + B.T @ x))
                if step <= ftol * lamn:
                    hit['force_tol'] = it + 1
    # first iteration after which err stays < 1e-3
    errs = np.array(errs)
    below = errs < 1e-3
    k = None
    for i in range(len(errs)):
        if below[i:].all():
            k = i; break
    hit['err'] = k
    hit['final_err'] = float(errs[-1])
    return hit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('capture', type=Path)
    ap.add_argument('--solves', default='0')
    ap.add_argument('--min-nodes', type=int, default=8)
    ap.add_argument('--prec', default='poly6,agg16')
    ap.add_argument('--limit', type=int, default=600)
    ap.add_argument('--first', default='identity')
    ap.add_argument('--f32', action='store_true')
    ap.add_argument('--top', type=int, default=4, help='largest components only')
    args = ap.parse_args()
    for solve in args.solves.split(','):
        metas = sorted(args.capture.glob(f'*.solve-{solve}.json'))
        if not metas:
            print('no capture for solve', solve); continue
        cap = oracle.Capture(metas[0])
        ids = cap.component_ids()
        sizes = sorted(((int(np.sum(cap.nodes['component'] == i)), i) for i in ids), reverse=True)
        for n, ident in sizes[:args.top]:
            if n < args.min_nodes:
                continue
            S = Sys(cap, ident)
            if not S.anchored:
                print(f'solve {solve} comp {ident}: {n} nodes, free: skipped'); continue
            x_star = spla.spsolve(S.A.tocsc(), S.r0)
            rec = cap.record(ident)
            gpu = f"gpu it={int(rec['iterations'])} conv={int(rec['converged'])}" if rec is not None else ''
            print(f'solve {solve} comp {ident}: {n} nodes {len(S.sel)} bonds {gpu}', flush=True)
            for name in args.prec.split(','):
                if name == 'poly6':
                    prec = AggPrec(S, np.arange(S.n), poly=True, f32=args.f32); passes = 2
                elif name == 'jac6':
                    prec = AggPrec(S, np.arange(S.n), poly=False, f32=args.f32); passes = 1
                else:
                    poly = name.startswith('pagg') or name.startswith('agg')
                    plain = name.startswith('jagg')
                    K = int(''.join(ch for ch in name if ch.isdigit()))
                    lab = aggregate(S, K)
                    prec = AggPrec(S, lab, poly=not plain, f32=args.f32); passes = 1 if plain else 2
                h = run(S, prec, x_star, args.limit, first=args.first)
                nb = len(prec.groups)
                print(f'   {name:8s} aggs={nb:5d} native={h["native"]} ftol={h["force_tol"]} err1e-3={h["err"]} final_err={h["final_err"]:.2e}', flush=True)


if __name__ == '__main__':
    main()


def ticks(S, prec, x_star, T, cap=16, carry=False, ftol=1e-3, first='identity', guard=None):
    """T ticks at rest of at most `cap` iterations each, warm-started from the
    previous tick's iterate. carry: keep (p, gamma) across ticks (no restart)."""
    A, B = S.A, S.B
    lam_true = (S.warm + B.T @ x_star).reshape(-1, 6)
    peak = max(float(np.max(np.linalg.norm(lam_true, axis=1))), 1e-30)
    x = np.zeros_like(S.r0); p = np.zeros_like(S.r0); prev = 0.0
    out = []
    for t in range(T):
        r = S.r0 - A @ x
        lamstart = float(np.linalg.norm(S.warm + B.T @ x)); travel = 0.0
        conv = None
        if not carry:
            p[:] = 0; prev = 0.0
        for it in range(cap + 1):
            g = B.T @ r
            if S.threshold > 0 and float(g @ g) <= S.threshold and (it or t):
                conv = ('native', it); break
            if it == cap:
                break
            usepoly = it > 0 or first != 'identity' or (carry and t > 0)
            z = prec(r) if usepoly else r.copy()
            gamma = float(r @ z)
            restart = (1 if first == 'identity' else 0) if not (carry and t > 0) else -1
            beta = gamma / prev if (it > restart and prev > 0) else 0.0
            if guard is not None and carry and t > 0 and it == 0 and beta > guard:
                beta = 0.0
            p = z + beta * p
            q = A @ p; den = float(p @ q)
            if not (den > 0 and gamma > 0):
                break
            alpha = gamma / den
            x = x + alpha * p; r = r - alpha * q; prev = gamma
            step = gamma / math.sqrt(den); travel += step
            if usepoly and step <= ftol * (lamstart + travel) and step <= ftol * float(np.linalg.norm(S.warm + B.T @ x)):
                conv = ('force', it + 1); break
        lam = (S.warm + B.T @ x).reshape(-1, 6)
        err = float(np.max(np.linalg.norm(lam - lam_true, axis=1))) / peak
        out.append((t, conv, err))
    return out
