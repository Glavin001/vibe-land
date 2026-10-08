#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""Can a cheap (near-linear) formulation reproduce the impact solve's answer?
A research harness on a dumped impact level (CPU, FP64; never a runtime path).

    uv run scripts/impact/cheap-formulations.py PREFIX-island<id>.bin \
        --impactor-momentum --base-load 2217 2218 [--skip-e]

The reference, E, is oracle-ramp.py's ramp (Clarabel, exact) with the same
loads (variant C: the impactor's load is its pre-tick momentum m v / dt, the
depenetration chunks keep their base load). Every candidate starts from the
same state as E: the dump's level (its J as the trial, r as the motion already
applied, its live set).

  L   linear: E's level problem with the capacity sets dropped -- the stationary
      point of 1/2|q + B J|^2_{M^-1} + 1/2|J - T|^2_{W}, i.e.
          (M + B W^-1 B^T) u = q + B T,   J = T - W^-1 B^T u    (W^-1 = k dt^2),
      the elastic-plus-inertia tick ((B K B^T + M / dt^2) x = f with x = u dt^2).
      Rigid contacts are kept exactly (a KKT block), unilateral by active set.
      After each solve: brittle joints at capacity break, ductile ones at
      capacity yield (they leave the operator and carry their capped force as a
      load) and break past their ultimate slip; then re-solve.
  C1  L with the impactor node and its rigid contacts (the trial's rigid stop).
  C2  L with the impactor removed and its load on the struck chunks bounded
      (bounded_load): 'cap', the capacities (along the impactor's velocity) of
      each struck chunk's live joints times dt plus its momentum at the
      impactor's speed; 'inertia', the momentum that brings the free chunk to
      the impactor's normal speed; 'oracle' (diagnostic), E's own contact
      impulse per row. The impactor keeps the rest (passes through).
  C3  C2 under a short ramp of that bounded load (levels 1/8, 1/4, 1/2, 1).
  C4  E with its ramp started (from the dump's state) at the level nearest the
      bounded load.
Write-up: PhysX docs/destruction/IMPACT_CHEAP_FORMULATION.md.

Reports per model: the broken set (Jaccard with E, count, distance from the
hit), the impulse delivered to the impactor, the energy balance, the linear
solves (and PCG iterations measured on the same systems) or the Clarabel
solves.
"""
import argparse, importlib.util, json, pathlib, sys, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spl

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('oracle_level', HERE / 'oracle-level.py')
ol = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ol)
ALIVE, CONTACT, DUCTILE = ol.ALIVE, ol.CONTACT, ol.DUCTILE


# ---------------------------------------------------------------------------
# The problem
# ---------------------------------------------------------------------------
class Problem:
    def __init__(self, path, impactor_momentum, base_load):
        d = ol.load(path); self.d = d
        nn, nl, dt = d['nn'], d['nl'], d['dt']; self.nn, self.nl, self.dt, self.band = nn, nl, dt, d['band']
        rb = open(path[:-4] + '.ramp.bin', 'rb').read()
        head = np.frombuffer(rb, np.float32, 8, 0).astype(np.float64)
        self.first, self.factor = head[0], head[1]; self.level0 = int(head[4])
        nodes = np.frombuffer(rb, np.float32, 18 * nn, 32).astype(np.float64).reshape(nn, 18)
        self.pb, self.pf, self.r0 = nodes[:, :6].reshape(-1).copy(), nodes[:, 6:12].reshape(-1).copy(), nodes[:, 12:18].reshape(-1).copy()
        links = np.frombuffer(rb, np.float32, 2 * nl, 32 + 72 * nn).astype(np.float64).reshape(nl, 2)
        self.slip_limit, self.slip_before = links[:, 0], links[:, 1]
        self.index = {int(c): i for i, c in enumerate(d['node_chunk'])}
        self.imp = [i for i in range(nn) if d['node_tensor'][i]]
        cb = pathlib.Path(path[:-4] + '.centroids.bin').read_bytes(); mb = int(np.frombuffer(cb, np.uint32, 1, 0)[0])
        self.hit = np.frombuffer(cb, np.float32, 3, 4).astype(np.float64)
        self.cen = np.frombuffer(cb, np.float32, 3 * mb, 16).astype(np.float64).reshape(mb, 3)
        rr = open(path[:-4] + '.rows.bin', 'rb').read(); nrows = int(np.frombuffer(rr, np.uint32, 1, 0)[0])
        self.row_vel = None
        for i in range(nrows):
            off = 4 + 64 * i
            self.row_vel = np.frombuffer(rr, np.float32, 3, off + 12 + 24).astype(np.float64)   # the impactor's velocity (same on every row)
        n = self.imp[0]
        if impactor_momentum:
            self.pf[6 * n:6 * n + 3] = self.row_vel / (d['node_f'][n, 0] * dt)
        for c in base_load:
            k = self.index[c]; self.pf[6 * k:6 * k + 6] = self.pb[6 * k:6 * k + 6]
        self.m_imp = 1.0 / d['node_f'][n, 0]; self.v0 = self.pf[6 * n:6 * n + 3] * dt * d['node_f'][n, 0]
        flags = d['link_u'][:, 3]
        self.contact = (flags & CONTACT) != 0; self.ductile = (flags & DUCTILE) != 0; self.alive0 = (flags & ALIVE) != 0
        self.joint = ~self.contact
        kk = d['link_f'][:, 9:13]; kf = np.stack([kk[:, 0], kk[:, 0], kk[:, 0], kk[:, 1], kk[:, 2], kk[:, 3]], 1)
        finite = np.isfinite(kf) & (kf < 1e30)
        self.comp = np.where(finite, kf * dt * dt, 0.0)          # W^-1 per component (0 for the rigid contacts)
        self.wgt = np.where(finite, 1.0 / (np.where(finite, kf, 1.0) * dt * dt), 0.0)
        rows, cols, vals = [], [], []
        for l in range(nl):
            _, c0, c1, _ = d['link_u'][l]
            for end, c in ((0, c0), (1, c1)):
                k = self.index.get(int(c))
                if k is None: continue
                blk = d['B'][l, 36 * end:36 * end + 36].reshape(6, 6)
                for a in range(6):
                    for b in range(6):
                        if blk[a, b] != 0.0: rows.append(6 * k + a); cols.append(6 * l + b); vals.append(blk[a, b])
        self.B = sp.csr_matrix((vals, (rows, cols)), shape=(6 * nn, 6 * nl)); self.Bt = self.B.T.tocsr()
        Mr, Mc, Mv, Ir, Ic, Iv = [], [], [], [], [], []
        self.mass = 1.0 / d['node_f'][:, 0]
        for k in range(nn):
            f = d['node_f'][k]
            I = np.linalg.inv(ol.sym(f[2:8])) if d['node_tensor'][k] else np.eye(3) / f[1]
            Ii = ol.sym(f[2:8]) if d['node_tensor'][k] else np.eye(3) * f[1]
            for a in range(3):
                Mr.append(6 * k + a); Mc.append(6 * k + a); Mv.append(1.0 / f[0]); Ir.append(6 * k + a); Ic.append(6 * k + a); Iv.append(f[0])
                for b in range(3):
                    Mr.append(6 * k + 3 + a); Mc.append(6 * k + 3 + b); Mv.append(I[a, b]); Ir.append(6 * k + 3 + a); Ic.append(6 * k + 3 + b); Iv.append(Ii[a, b])
        self.M = sp.csr_matrix((Mv, (Mr, Mc)), shape=(6 * nn, 6 * nn)); self.Mi = sp.csr_matrix((Iv, (Ir, Ic)), shape=(6 * nn, 6 * nn))
        self.J0 = d['J'].copy(); self.J0[~self.alive0] = 0.0

    def dist(self, links):
        return np.array([np.linalg.norm(self.cen[int(self.d['link_u'][l, 0])] - self.hit) for l in links])

    def wrench_world_force(self, l, end, F):
        """The node wrench of a world force F applied through link l's contact frame at its end."""
        blk = self.d['B'][l, 36 * end:36 * end + 36].reshape(6, 6)
        J = np.linalg.lstsq(blk[:3, :3], F, rcond=None)[0]
        return blk[:, :3] @ J

    def bond_cap_along(self, l, end, vhat):
        """A joint's capacity against a force along vhat on its chunk at `end` (N, V only; moments come out of the solve)."""
        f = self.d['link_f'][l]; capC, capT, capS = f[0], f[1], f[2]
        blk = self.d['B'][l, 36 * end:36 * end + 36].reshape(6, 6)
        n = blk[:3, 0]; n = n / max(np.linalg.norm(n), 1e-30)
        c = float(-vhat @ n)          # the joint's N to resist +vhat on this chunk: N n = -vhat => N = -vhat.n (> 0 tension)
        capN = capT if c > 0 else capC
        s2 = max(0.0, 1.0 - c * c)
        return 1.0 / np.sqrt((c / capN) ** 2 + s2 / capS ** 2 + 1e-300)


# ---------------------------------------------------------------------------
# The linear model (L): one tick of elastic joints and chunk inertia
# ---------------------------------------------------------------------------
def linear_solve(P, nodes_on, live, scale, q, T, contacts_on, stats, cg=True):
    """(M + B W^-1 B^T) u = q + B T over the live joints (a yielded ductile joint at its secant
    stiffness: W^-1 and T times its scale), rigid contacts on as constraints (B_c^T u)_{N,V} = 0
    (or N only for a sliding row: contacts_on 2). Returns the increment u (6 nn, 0 off nodes_on) and J."""
    nl = P.nl
    el = live & P.joint
    cw = np.zeros((nl, 6)); cw[el] = P.comp[el] * scale[el, None]
    Ts = np.zeros((nl, 6)); Ts[el] = T[el] * scale[el, None]
    A = (P.M + P.B @ sp.diags(cw.reshape(-1)) @ P.Bt).tocsr()
    rhs = q + P.B @ Ts.reshape(-1)
    sel = np.where(np.repeat(nodes_on, 6))[0]
    A = A[sel][:, sel]; rhs = rhs[sel]
    cl = np.where(contacts_on > 0)[0]
    if len(cl):
        cols = np.concatenate([np.arange(6 * l, 6 * l + (3 if contacts_on[l] == 1 else 1)) for l in cl])
        C = P.Bt[cols][:, sel].T.tocsc()
        K = sp.bmat([[A, C], [C.T, None]]).tocsc()
        x = spl.spsolve(K, np.concatenate([rhs, np.zeros(len(cols))]))
        uu, lamc = x[:len(sel)], x[len(sel):]
    else:
        uu = spl.spsolve(A.tocsc(), rhs); lamc = None
        if cg:
            # PCG cost on the same system: block-Jacobi (6x6) preconditioner, as the GPU's.
            Ad = A.tocsr(); nb = len(sel) // 6
            dense = lambda i: Ad[6 * i:6 * i + 6, 6 * i:6 * i + 6].toarray()
            blocks = np.array([np.linalg.inv(dense(i)) for i in range(nb)])
            prec = spl.LinearOperator(A.shape, matvec=lambda v: np.einsum('nij,nj->ni', blocks, v.reshape(-1, 6)).reshape(-1))
            for tol in (1e-3, 1e-6):
                it = [0]
                spl.cg(Ad, rhs, rtol=tol, maxiter=20000, M=prec, callback=lambda _: it.__setitem__(0, it[0] + 1))
                stats.setdefault(f'cg{tol:g}', []).append(it[0])
    u = np.zeros(6 * P.nn); u[sel] = uu
    J = np.zeros((nl, 6))
    J[el] = Ts[el] - (cw * (P.Bt @ u).reshape(nl, 6))[el]
    if lamc is not None:
        k = 0
        for l in cl:
            n = 3 if contacts_on[l] == 1 else 1
            J[l, :n] = -lamc[k:k + n]; k += n          # the KKT multiplier is minus the row's force
    stats['solves'] = stats.get('solves', 0) + 1
    return u, J


def judge(P, live, scale, J, u_tot, final=True):
    """Brittle joints at capacity break; ductile ones at capacity yield (secant: their stiffness
    scaled down to carry their capacity) and break past their ultimate slip. Returns (broken, yielded now)."""
    newly, newyield = [], []
    for l in np.where(live & P.joint)[0]:
        util = ol.utilisation(P.d['link_f'][l], J[l])
        if util < 1 - P.band and scale[l] == 1.0: continue
        if not P.ductile[l]:
            newly.append(l); continue
        if util > 1 + P.band:
            scale[l] /= util; newyield.append(l)
        if final:
            e = np.zeros(6)
            for end, c in ((0, P.d['link_u'][l, 1]), (1, P.d['link_u'][l, 2])):
                k = P.index.get(int(c))
                if k is None: continue
                e += P.d['B'][l, 36 * end:36 * end + 36].reshape(6, 6).T @ u_tot[6 * k:6 * k + 6]
            if P.slip_before[l] + 0.5 * np.linalg.norm(e[:3]) * P.dt ** 2 > P.slip_limit[l]: newly.append(l)
    return newly, newyield


def kinetic(P, k, w):
    I = P.M[6 * k + 3:6 * k + 6, 6 * k + 3:6 * k + 6].toarray()
    return 0.5 * P.mass[k] * w[:3] @ w[:3] + 0.5 * w[3:] @ I @ w[3:]


def energy(P, u_tot, J, live, nodes_on, delivered):
    """The impactor's kinetic energy lost (against its free motion: linear and angular) against the
    house's kinetic energy and the change of its joints' strain energy over the tick."""
    dt = P.dt; imp = P.imp[0]
    if nodes_on[imp]:
        free = (P.Mi @ P.pf)[6 * imp:6 * imp + 6] * dt
        e_in = kinetic(P, imp, free) - kinetic(P, imp, u_tot[6 * imp:6 * imp + 6] * dt)
    else:
        v0 = P.v0; v1 = v0 - delivered / P.m_imp
        e_in = 0.5 * P.m_imp * (v0 @ v0 - v1 @ v1)
    ke = sum(kinetic(P, k, u_tot[6 * k:6 * k + 6] * dt) for k in range(P.nn) if nodes_on[k] and k != imp)
    el = live & P.joint
    se = 0.5 * float(np.sum(J[el] ** 2 * P.wgt[el])) * dt * dt
    se0 = 0.5 * float(np.sum(P.J0[P.alive0 & P.joint] ** 2 * P.wgt[P.alive0 & P.joint])) * dt * dt
    return e_in, ke, se - se0


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
def struck_rows(P):
    return [(l, P.index[int(P.d['link_u'][l, 1])]) for l in np.where(P.contact & P.alive0)[0]]


def bounded_load(P, live, bound):
    """The impactor's load on each struck chunk, bounded by what that chunk can take (world impulses).
    'cap': along the impactor's velocity, the capacities of the chunk's live joints times dt plus its
    momentum at the impactor's speed (all scaled down together if that exceeds the impactor's momentum).
    'inertia': along the row's normal, the momentum that brings a free chunk to the impactor's normal speed.
    'oracle' (diagnostic): E's own contact impulse on each row, so only the structural response differs.
    Each is applied through the chunk's centroid (a prescribed impulse at a lever on a free chunk would
    spin it up without the contact that limits it, creating energy), except the oracle (E's rows as they are)."""
    if bound == 'oracle':
        return [(l, k, np.array(P.oracle_rows[str(l)])) for l, k in struck_rows(P)]
    vhat = P.v0 / np.linalg.norm(P.v0); speed = np.linalg.norm(P.v0)
    out = []
    for l, k in struck_rows(P):
        c = int(P.d['node_chunk'][k])
        if bound == 'cap':
            cap = 0.0
            for m in np.where(live & P.joint)[0]:
                for end, cc in ((0, P.d['link_u'][m, 1]), (1, P.d['link_u'][m, 2])):
                    if int(cc) == c: cap += P.bond_cap_along(m, end, vhat)
            out.append((l, k, (cap * P.dt + P.mass[k] * speed) * vhat))
        else:
            n = P.d['B'][l, :36].reshape(6, 6)[:3, 0]
            push = -n / np.linalg.norm(n)                       # a compressive row pushes its chunk along -n
            out.append((l, k, P.mass[k] * max(0.0, P.v0 @ push) * push))
    tot = sum(np.linalg.norm(p) for _, _, p in out)
    s = min(1.0, P.m_imp * speed / max(tot, 1e-30))
    return [(l, k, p * s) for l, k, p in out]


def run_linear(P, mode, rounds, ramp_levels=(1.0,), max_per_level=4, bound='cap', label=''):
    """C1 (mode 'rigid'): the impactor node with rigid unilateral contacts. C2/C3 (mode 'bounded'):
    the impactor replaced by its bounded load on the struck chunks. Solve, judge, re-solve."""
    nn, nl, dt = P.nn, P.nl, P.dt
    stats = {}
    live = P.alive0.copy(); scale = np.ones(nl)
    nodes_on = np.ones(nn, bool); imp = P.imp[0]
    T = P.J0.copy()
    contacts_on = np.where(P.contact & P.alive0, 1, 0)
    if mode != 'rigid':
        contacts_on[:] = 0; nodes_on[imp] = False; live[P.contact] = False; T[P.contact] = 0.0
    broken, history = [], []
    delivered = np.zeros(3)
    ramp = len(ramp_levels) > 1
    for lam in ramp_levels:
        for rep in range(max_per_level if ramp else rounds):
            q = P.pf - P.r0                                # the full load less the motion already applied
            if mode != 'rigid':
                q = q.copy(); q[6 * imp:6 * imp + 6] = 0.0
                delivered = np.zeros(3)
                for l, k, p in bounded_load(P, live, bound):
                    if bound == 'oracle': q[6 * k:6 * k + 6] += P.wrench_world_force(l, 0, lam * p / dt)
                    else: q[6 * k:6 * k + 3] += lam * p / dt
                    delivered += lam * p
                u, J = linear_solve(P, nodes_on, live, scale, q, T, contacts_on, stats)
            else:
                for _ in range(8):                          # the contact active set (each pass a solve)
                    u, J = linear_solve(P, nodes_on, live, scale, q, T, contacts_on, stats)
                    change = False
                    for l in np.where(contacts_on > 0)[0]:
                        if J[l, 0] > 0: contacts_on[l] = 0; change = True
                        elif contacts_on[l] == 1 and np.hypot(J[l, 1], J[l, 2]) > P.d['link_f'][l, 13] * -J[l, 0]:
                            contacts_on[l] = 2; change = True
                    if not change: break
                delivered = np.zeros(3)
                for l in np.where(contacts_on > 0)[0]:
                    delivered += (P.d['B'][l, :36].reshape(6, 6) @ J[l])[:3] * dt
            ut = u_total(P, u, nodes_on)
            newly, newyield = judge(P, live, scale, J, ut, final=(lam >= 1.0))
            for l in newly: live[l] = False; broken.append(l)
            history.append((lam, len(newly), len(newyield)))
            if not newly and not newyield: break
    e_in, ke, dse = energy(P, ut, J, live, nodes_on, delivered)
    if mode == 'rigid':
        vend = ut[6 * imp:6 * imp + 3] * dt; delivered = (P.v0 - vend) * P.m_imp
    vend = P.v0 - delivered / P.m_imp
    return dict(model=label or mode, broken=broken, solves=stats['solves'], history=history, delivered=delivered, vend=vend,
                e_in=e_in, ke=ke, dse=dse, cg=stats)


def u_total(P, u, nodes_on):
    """The tick's motion (velocity / dt) of every node: the increment plus the motion already applied (M^-1 r)."""
    return u + np.where(np.repeat(nodes_on, 6), P.Mi @ P.r0, 0.0)


def run_e(P, start_level, cold, max_solves=200, label='E', trace=False):
    import cvxpy as cp
    nn, nl, dt = P.nn, P.nl, P.dt
    d = P.d
    Sh = sp.lil_matrix((6 * nn, 6 * nn))
    for k in range(nn):
        f = d['node_f'][k]
        for a in range(3): Sh[6 * k + a, 6 * k + a] = np.sqrt(f[0])
        if d['node_tensor'][k]:
            w, V = np.linalg.eigh(ol.sym(f[2:8])); R = V @ np.diag(np.sqrt(np.maximum(w, 0))) @ V.T
            for a in range(3):
                for b in range(3): Sh[6 * k + 3 + a, 6 * k + 3 + b] = R[a, b]
        else:
            for a in range(3): Sh[6 * k + 3 + a, 6 * k + 3 + a] = np.sqrt(f[1])
    Sh = Sh.tocsr()
    x = cp.Variable(6 * nl); X = cp.reshape(x, (nl, 6), order='C')
    qP = cp.Parameter(6 * nn); TP = cp.Parameter(6 * nl); scaleP = cp.Parameter(nonneg=True)
    wgt = P.wgt.reshape(-1)
    obj = scaleP * (0.5 * cp.sum_squares(Sh @ qP + (Sh @ P.B) @ x) + 0.5 * cp.sum_squares(cp.multiply(np.sqrt(wgt), x) - cp.multiply(np.sqrt(wgt), TP)))
    def build(alive):
        cons = []
        dead = np.where(~alive)[0]
        if len(dead): cons.append(X[dead, :] == 0)
        Jl = np.where(alive & P.joint)[0]; Cl = np.where(alive & P.contact)[0]
        f = d['link_f'][Jl]
        capC, capT, capS, gb, gt, g0, g1, h0, h1 = (f[:, i] for i in range(9))
        L1 = g0 > 0; Xj = X[Jl, :]
        absM0 = cp.abs(Xj[:, 4]); absM1 = cp.abs(Xj[:, 5]); Mn = cp.norm(Xj[:, 4:6], 2, axis=1)
        bend = cp.multiply(np.where(L1, g0, 0), absM0) + cp.multiply(np.where(L1, g1, 0), absM1) + cp.multiply(np.where(L1, 0, gb), Mn)
        pull = cp.multiply(np.where(L1, h0, 0), absM0) + cp.multiply(np.where(L1, h1, 0), absM1) + cp.multiply(np.where(L1, 0, gb), Mn)
        cons += [Xj[:, 0] + pull <= capT, bend - Xj[:, 0] <= capC, cp.norm(Xj[:, 1:3], 2, axis=1) + cp.multiply(gt, cp.abs(Xj[:, 3])) <= capS]
        if len(Cl):
            mu = d['link_f'][Cl, 13]; Xc = X[Cl, :]
            cons += [Xc[:, 0] <= 0, cp.norm(Xc[:, 1:3], 2, axis=1) <= cp.multiply(mu, -Xc[:, 0]), Xc[:, 3:6] == 0]
        return cp.Problem(cp.Minimize(obj), cons)
    alive = P.alive0.copy()
    if cold:
        J = P.J0.copy(); r = P.r0.copy()     # the rest state the dump carries (its level's J and motion)
    else:
        J = P.J0.copy(); r = P.r0.copy()
    prob = build(alive); level = start_level; broken = []; solves = 0; t0 = time.time()
    while solves < max_solves:
        lam = min(1.0, P.first * P.factor ** level); final = lam >= 1.0
        load = (1 - lam) * P.pb + lam * P.pf
        qP.value = load - r; TP.value = J.reshape(-1)
        w0 = Sh @ (qP.value + P.B @ J.reshape(-1)); scaleP.value = 1.0 / max(1.0, 0.5 * float(w0 @ w0))
        prob.solve(solver='CLARABEL', warm_start=True); solves += 1
        J = x.value.reshape(nl, 6).copy(); J[~alive] = 0.0
        r = load + P.B @ J.reshape(-1); u = P.Mi @ r
        newly = []
        for l in np.where(alive & P.joint)[0]:
            if ol.utilisation(d['link_f'][l], J[l]) < 1 - P.band: continue
            fails = not P.ductile[l]
            if not fails and final:
                e = np.zeros(6)
                for end, c in ((0, d['link_u'][l, 1]), (1, d['link_u'][l, 2])):
                    k = P.index.get(int(c))
                    if k is None: continue
                    e += d['B'][l, 36 * end:36 * end + 36].reshape(6, 6).T @ u[6 * k:6 * k + 6]
                fails = P.slip_before[l] + 0.5 * np.linalg.norm(e[:3]) * dt * dt > P.slip_limit[l]
            if fails: newly.append(l)
        if trace:
            ci = sum((d['B'][l, :36].reshape(6, 6) @ J[l])[:3] * dt for l in np.where(P.contact & alive)[0])
            print(f"    {label} solve {solves}: level {level} lambda {lam:.4g}: {len(newly)} broken, contact impulse {np.linalg.norm(ci):.4g} N s", flush=True)
        for l in newly: alive[l] = False; J[l] = 0.0; broken.append(l)
        if newly: prob = build(alive); continue
        if final: break
        level += 1
    imp = P.imp[0]
    vend = u[6 * imp:6 * imp + 3] * dt
    delivered = (P.v0 - vend) * P.m_imp
    nodes_on = np.ones(nn, bool)
    e_in, ke, dse = energy(P, u, J, alive, nodes_on, delivered)
    return dict(model=label, broken=broken, solves=solves, delivered=delivered, vend=vend, e_in=e_in, ke=ke, dse=dse,
                start_level=start_level, seconds=time.time() - t0, cg={}, J=J, u=u, alive=alive)


# ---------------------------------------------------------------------------
def report(P, res, ref):
    b = set(int(P.d['link_u'][l, 0]) for l in res['broken']); e = set(int(P.d['link_u'][l, 0]) for l in ref['broken']) if ref else b
    jac = len(b & e) / max(1, len(b | e))
    dist = P.dist(res['broken']) if res['broken'] else np.zeros(0)
    within2 = int((dist < 2).sum())
    imp = np.linalg.norm(res['delivered'])
    cg = res.get('cg', {})
    cgs = ', '.join(f"{k[2:]}: {sum(v)} its ({max(v)} max/solve)" for k, v in cg.items() if k.startswith('cg'))
    dissip = res['e_in'] - res['ke'] - res['dse']
    line = (f"{res['model']:<26} broken {len(b):4d}  Jaccard {jac:.2f} (common {len(b & e)})  within 2 m {within2:4d}  "
            f"median {np.median(dist) if len(dist) else 0:.2f} m  max {dist.max() if len(dist) else 0:.1f} m  "
            f"impulse {imp:9.4g} N s  |v_end| {np.linalg.norm(res['vend']):.2f} m/s  "
            f"E_in {res['e_in']:.4g} J  KE_house {res['ke']:.4g} J  dStrain {res['dse']:.3g} J  dissipated {dissip:.4g} J  "
            f"solves {res['solves']}" + (f"  PCG {cgs}" if cgs else ''))
    print(line, flush=True)
    return dict(model=res['model'], broken=len(b), jaccard=jac, common=len(b & e), within2=within2,
                median=float(np.median(dist)) if len(dist) else 0.0, max=float(dist.max()) if len(dist) else 0.0,
                impulse=float(imp), vend=float(np.linalg.norm(res['vend'])), e_in=float(res['e_in']), ke=float(res['ke']),
                dse=float(res['dse']), solves=res['solves'], cg={k: v for k, v in cg.items()}, history=[list(map(str, h)) for h in res.get('history', [])],
                bonds=sorted(b))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dump')
    ap.add_argument('--impactor-momentum', action='store_true')
    ap.add_argument('--base-load', type=int, nargs='*', default=[])
    ap.add_argument('--no-spin', action='store_true', help="sensitivity: zero the impactor's angular load")
    ap.add_argument('--skip-e', action='store_true', help='skip the Clarabel models (E, C4)')
    ap.add_argument('--only-e', action='store_true', help='only the reference E')
    ap.add_argument('--e-cache', help='reuse (or write) the reference E result here (json)')
    ap.add_argument('--json', help='write the table rows')
    ap.add_argument('--trace', action='store_true', help="print E's contact impulse per solve")
    a = ap.parse_args()
    P = Problem(a.dump, a.impactor_momentum, a.base_load)
    if a.no_spin:
        i = P.imp[0]; P.pf[6 * i + 3:6 * i + 6] = 0.0
    print(f"{a.dump}: {P.nn} nodes, {P.nl} links, impactor {P.m_imp:.0f} kg at {np.linalg.norm(P.v0):.2f} m/s "
          f"(momentum {P.m_imp * np.linalg.norm(P.v0):.4g} N s), dump level {P.level0} (lambda {P.first * P.factor ** P.level0:.3g})")
    rows = []
    ref = None
    if a.e_cache and pathlib.Path(a.e_cache).exists():
        c = json.loads(pathlib.Path(a.e_cache).read_text())
        ref = dict(c, delivered=np.array(c['delivered']), vend=np.array(c['vend']))
        rows.append(report(P, ref, ref))
    elif not a.skip_e:
        ref = run_e(P, P.level0, cold=False, label='E (reference ramp)' + (' no spin' if a.no_spin else ''), trace=a.trace)
        rows.append(report(P, ref, ref)); rows[-1]['seconds'] = ref['seconds']
        if a.e_cache:
            pathlib.Path(a.e_cache).write_text(json.dumps(dict(model=ref['model'], broken=[int(l) for l in ref['broken']], solves=ref['solves'],
                delivered=ref['delivered'].tolist(), vend=ref['vend'].tolist(), e_in=ref['e_in'], ke=ref['ke'], dse=ref['dse'], seconds=ref['seconds'],
                rows={str(l): ((P.d['B'][l, :36].reshape(6, 6) @ ref['J'][l])[:3] * P.dt).tolist() for l in np.where(P.contact)[0]})))
        import pickle      # E's state, for cheap-contact-time.py --e-state
        pickle.dump(dict(J=ref['J'], u=ref['u'], alive=ref['alive'], broken=ref['broken']), open(a.e_cache[:-5] + '.pkl', 'wb'))
        ref['rows'] = {str(l): ((P.d['B'][l, :36].reshape(6, 6) @ ref['J'][l])[:3] * P.dt).tolist() for l in np.where(P.contact)[0]}
    if a.only_e: return 0
    for rounds, tag in ((1, '1 solve'), (4, '4 rounds'), (50, 'to convergence')):
        rows.append(report(P, run_linear(P, 'rigid', rounds, label=f'C1 rigid contacts, {tag}'), ref))
    bounds = ('cap', 'inertia') + (('oracle',) if ref is not None and 'rows' in ref else ())
    if 'oracle' in bounds: P.oracle_rows = ref['rows']
    for bound in bounds:
        for rounds, tag in ((1, '1 solve'), (4, '4 rounds'), (50, 'to convergence')):
            rows.append(report(P, run_linear(P, 'bounded', rounds, bound=bound, label=f'C2 {bound} bound, {tag}'), ref))
        rows.append(report(P, run_linear(P, 'bounded', 0, ramp_levels=(0.125, 0.25, 0.5, 1.0), max_per_level=4, bound=bound,
                                         label=f'C3 {bound} bound, 4-level ramp'), ref))
    imp_mom = P.m_imp * np.linalg.norm(P.v0)
    fracs = {}
    for bound in ('cap', 'inertia'):
        tot = sum(np.linalg.norm(p) for _, _, p in bounded_load(P, P.alive0 & P.joint, bound))
        fracs[bound] = tot / imp_mom
        print(f"bounded load '{bound}' (all joints live) {tot:.4g} N s = {fracs[bound]:.3g} of the impactor's momentum")
    if not a.skip_e:
        for bound in ('cap', 'inertia'):
            L = int(np.floor(np.log(fracs[bound] / P.first) / np.log(P.factor)))
            res = run_e(P, L, cold=True, label=f'C4 E from level {L} ({bound})')
            rows.append(report(P, res, ref)); rows[-1]['seconds'] = res['seconds']
    if a.json: pathlib.Path(a.json).write_text(json.dumps(dict(bound_fraction=fracs, rows=rows), indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
