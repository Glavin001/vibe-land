#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""The impact as one implicit dynamic step over the contact duration h, with the
impactor coupled as a node, solved as a linear system per event (CPU, FP64; a
research harness, never a runtime path). Compared with the Clarabel E reference.

    uv run scripts/impact/cheap-formulations.py PREFIX-island<id>.bin --impactor-momentum --base-load 2217 2218 \
        --only-e --e-cache E.json                      # the Clarabel reference: E.json and E.pkl
    uv run scripts/impact/cheap-contact-time.py PREFIX-island<id>.bin --e-cache E.json --e-state E.pkl

The step: (M + h^2 B K B^T) du = lam * f over the island (or a patch of it, the rest
held as boundary), f the impactor's momentum p / h on its node, the impactor tied to
its struck chunks by rigid contact rows (KKT; unilateral, sticking until the Coulomb
cone, then sliding frictionless). J = J0 + dJ, dJ = -k h^2 B^T du (J0: the dump's
near-rest state). Velocities over the step: du * h.

Failure order, event to event (no heuristic): the system is linear between events,
so every joint's critical load factor along the current increment is exact (the
root of util(J + d dJ) = 1, util convex). Advance to the smallest, apply that event
-- a brittle joint breaks and its force is released as a load (re-solve at the same
lam, cascading while anything is over), a ductile joint yields (leaves the operator,
keeps its force), a contact separates or starts to slide -- re-solve, repeat to
lam = 1. Against that: 'passes', everything over capacity at lam = 1 breaks (ductile:
secant yield) and the step is re-solved, 2-4 times.

Reports per h and patch radius: the broken set against E (Jaccard, count), its
locality, the momentum given to the impactor and to the debris, the solves and the
PCG iterations (block-Jacobi; contacts as stiff springs for the count).
Write-up: PhysX docs/destruction/IMPACT_CHEAP_FORMULATION.md.
"""
import argparse, importlib.util, json, pathlib, pickle, sys, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spl
from scipy.sparse.csgraph import connected_components

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('cheap', HERE / 'cheap-formulations.py')
cf = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(cf)
ol = cf.ol


def util_vec(F, X):
    """ol.utilisation over rows: F (n, 14) link floats, X (n, 6)."""
    capC, capT, capS, gb, gt, g0, g1, h0, h1 = (F[:, i] for i in range(9))
    N = X[:, 0]; V = np.hypot(X[:, 1], X[:, 2]); Tw = np.abs(X[:, 3]); M = np.hypot(X[:, 4], X[:, 5])
    L1 = g0 > 0
    bend = np.where(L1, g0 * np.abs(X[:, 4]) + g1 * np.abs(X[:, 5]), gb * M)
    pull = np.where(L1, h0 * np.abs(X[:, 4]) + h1 * np.abs(X[:, 5]), bend)
    r = lambda d, c: np.where(d <= 0, 0.0, d / np.where(c > 0, c, 1e-300))
    return np.maximum.reduce([r(np.maximum(N + pull, 0), capT), r(np.maximum(bend - N, 0), capC), r(V + gt * Tw, capS)])


class Step:
    def __init__(self, P, h, patch_radius=None, spin=False):
        self.P, self.h = P, h
        nn, nl = P.nn, P.nl; imp = P.imp[0]
        # chunk positions: the mean of their joints' centroids
        pos = np.zeros((nn, 3)); cnt = np.zeros(nn)
        for l in np.where(P.joint)[0]:
            for c in P.d['link_u'][l, 1:3]:
                k = P.index.get(int(c))
                if k is not None: pos[k] += P.cen[int(P.d['link_u'][l, 0])]; cnt[k] += 1
        pos[cnt > 0] /= cnt[cnt > 0, None]; pos[cnt == 0] = P.hit
        self.pos = pos
        self.on = np.ones(nn, bool) if patch_radius is None else (np.linalg.norm(pos - P.hit, axis=1) <= patch_radius)
        self.on[imp] = True
        for l in np.where(P.contact)[0]: self.on[P.index[int(P.d['link_u'][l, 1])]] = True   # the struck chunks always
        self.count_pcg = False; self.pcg_its = []; self._x_unit = None
        self.f = np.zeros(6 * nn); self.f[6 * imp:6 * imp + 3] = P.m_imp * P.v0 / h
        if spin: self.f[6 * imp + 3:6 * imp + 6] = P.pf[6 * imp + 3:6 * imp + 6] * P.dt / h
        self.sel = np.where(np.repeat(self.on, 6))[0]
        # links inside the patch (both ends on, or one end on and the other an anchor or a held boundary node)
        ends_on = np.array([[P.index.get(int(c)) is not None and self.on[P.index[int(c)]] for c in P.d['link_u'][l, 1:3]] for l in range(nl)])
        self.inpatch = ends_on.any(1)
        self.comp = np.where(P.comp > 0, P.comp / P.dt ** 2 * h * h, 0.0)       # k h^2

    def system(self, live, yielded, contacts):
        P = self.P; nl = P.nl
        el = live & P.joint & ~yielded & self.inpatch
        cw = np.zeros((nl, 6)); cw[el] = self.comp[el]
        A = (P.M + P.B @ sp.diags(cw.reshape(-1)) @ P.Bt).tocsr()[self.sel][:, self.sel]
        cl = [l for l in np.where(contacts > 0)[0]]
        cols = np.concatenate([np.arange(6 * l, 6 * l + (3 if contacts[l] == 1 else 1)) for l in cl]) if cl else np.zeros(0, int)
        C = P.Bt[cols][:, self.sel].T.tocsc() if len(cols) else None
        return A, C, cl, cw, el

    def solve(self, live, yielded, contacts, rhs_full, stats):
        P = self.P; nl = P.nl
        A, C, cl, cw, el = self.system(live, yielded, contacts)
        rhs = rhs_full[self.sel]
        if C is not None:
            K = sp.bmat([[A, C], [C.T, None]]).tocsc()
            x = spl.spsolve(K, np.concatenate([rhs, np.zeros(C.shape[1])]))
            uu, lamc = x[:len(self.sel)], x[len(self.sel):]
        else:
            uu = spl.spsolve(A.tocsc(), rhs); lamc = np.zeros(0)
        stats['solves'] = stats.get('solves', 0) + 1
        if self.count_pcg:
            # what PCG would take for this solve on the GPU: block-Jacobi, contacts as stiff springs,
            # warm-started from the last unit-load solution (a release solve starts from 0), stopped at
            # 1e-4 of its own right-hand side
            unit = rhs_full is self.f
            if C is not None:
                kc = 1e3 * max(P.mass[P.index[int(P.d['link_u'][l, 1])]] for l in cl) / self.h ** 2 * self.h ** 2
                As = (A + kc / self.h ** 2 * (C @ C.T)).tocsr()
            else:
                As = A.tocsr()
            dg = As.diagonal().reshape(-1, 6)
            blocks = np.array([np.linalg.inv(As[6 * i:6 * i + 6, 6 * i:6 * i + 6].toarray()) for i in range(As.shape[0] // 6)])
            prec = spl.LinearOperator(As.shape, matvec=lambda v: np.einsum('nij,nj->ni', blocks, v.reshape(-1, 6)).reshape(-1))
            x0 = self._x_unit if (unit and self._x_unit is not None) else np.zeros(As.shape[0])
            it = [0]
            xs, _ = spl.cg(As, rhs, x0=x0, rtol=1e-4, maxiter=20000, M=prec,
                           callback=lambda _: it.__setitem__(0, it[0] + 1))
            if unit: self._x_unit = xs
            self.pcg_its.append(it[0])
        du = np.zeros(6 * P.nn); du[self.sel] = uu
        dJ = np.zeros((nl, 6)); dJ[el] = -(cw * (P.Bt @ du).reshape(nl, 6))[el]
        k = 0
        for l in cl:
            n = 3 if contacts[l] == 1 else 1
            dJ[l, :n] = -lamc[k:k + n]; k += n
        return du, dJ

    def pcg_iterations(self, live, yielded, contacts, rhs_full, rtol=1e-4):
        """The same step as one SPD system (contacts as springs 1e3 x stiffer than the struck chunks' inertia
        over h): block-Jacobi PCG iterations to rtol."""
        P = self.P
        A, C, cl, cw, el = self.system(live, yielded, contacts)
        if C is not None:
            kc = 1e3 * max(P.mass[P.index[int(P.d['link_u'][l, 1])]] for l in cl)
            A = (A + kc * (C @ C.T)).tocsr()
        nb = A.shape[0] // 6
        blocks = np.array([np.linalg.inv(A[6 * i:6 * i + 6, 6 * i:6 * i + 6].toarray()) for i in range(nb)])
        prec = spl.LinearOperator(A.shape, matvec=lambda v: np.einsum('nij,nj->ni', blocks, v.reshape(-1, 6)).reshape(-1))
        it = [0]
        spl.cg(A, rhs_full[self.sel], rtol=rtol, maxiter=50000, M=prec, callback=lambda _: it.__setitem__(0, it[0] + 1))
        return it[0], A.shape[0]

    # ------------------------------------------------------------------
    def crit(self, Jb, dJ, live, yielded, contacts, cap=1.0):
        """Each joint's and contact's load-factor step to its event along dJ (inf if none within cap)."""
        P = self.P
        idx = np.where(live & P.joint & ~yielded & self.inpatch)[0]
        F = P.d['link_f'][idx]; A, D = Jb[idx], dJ[idx]
        u0 = util_vec(F, A)
        d = np.full(len(idx), np.inf)
        d[u0 >= 1 - P.band] = 0.0
        hi = np.full(len(idx), cap); m = (u0 < 1 - P.band) & (util_vec(F, A + cap * D) >= 1 - P.band)
        lo = np.zeros(len(idx)); hh = hi.copy()
        for _ in range(60):
            mid = 0.5 * (lo + hh); over = util_vec(F, A + mid[:, None] * D) >= 1 - P.band
            hh = np.where(over, mid, hh); lo = np.where(over, lo, mid)
        d[m] = hh[m]
        out = {int(l): float(x) for l, x in zip(idx, d) if np.isfinite(x)}
        cev = {}
        for l in np.where(contacts > 0)[0]:
            mu = P.d['link_f'][l, 13]
            g = lambda s: (Jb[l, 0] + s * dJ[l, 0]) if contacts[l] == 2 else max(Jb[l, 0] + s * dJ[l, 0], np.hypot(*(Jb[l, 1:3] + s * dJ[l, 1:3])) - mu * -(Jb[l, 0] + s * dJ[l, 0]))
            if g(cap) <= 0: continue
            if g(0) > 0: cev[int(l)] = 0.0; continue
            a, b = 0.0, cap
            for _ in range(60):
                mid = 0.5 * (a + b)
                if g(mid) > 0: b = mid
                else: a = mid
            cev[int(l)] = b
        return out, cev

    def ductile_breaks(self, J, u, live, yielded):
        P = self.P; out = []
        for l in np.where(live & P.joint & yielded)[0]:
            e = np.zeros(6)
            for end, c in ((0, P.d['link_u'][l, 1]), (1, P.d['link_u'][l, 2])):
                k = P.index.get(int(c))
                if k is not None: e += P.d['B'][l, 36 * end:36 * end + 36].reshape(6, 6).T @ u[6 * k:6 * k + 6]
            if P.slip_before[l] + 0.5 * np.linalg.norm(e[:3]) * self.h ** 2 > P.slip_limit[l]: out.append(l)
        return out


def release_load(P, J, links):
    """Removing joints that carry J: the nodes lose B J, i.e. the remaining system takes -B J."""
    Jr = np.zeros_like(J); Jr[links] = J[links]
    return -(P.B @ Jr.reshape(-1))


def run_events(S, max_events=400):
    """The exact event-to-event ramp of the impactor's momentum, lam 0 -> 1."""
    P = S.P; nl = P.nl; stats = {}
    live = P.alive0.copy(); yielded = np.zeros(nl, bool)
    contacts = np.where(P.contact & P.alive0, 1, 0)
    J = P.J0.copy(); J[P.contact] = 0.0
    u = np.zeros(6 * P.nn); lam = 0.0; broken = []; events = 0; t0 = time.time()
    while events < max_events:
        du, dJ = S.solve(live, yielded, contacts, S.f, stats)
        jev, cev = S.crit(J, dJ, live, yielded, contacts, cap=1.0 - lam)
        allev = list(jev.values()) + list(cev.values())
        step = min(allev) if allev else np.inf
        if step >= 1.0 - lam:
            J += (1.0 - lam) * dJ; u += (1.0 - lam) * du; lam = 1.0; break
        J += step * dJ; u += step * du; lam += step; events += 1
        tol = step + 1e-9 * max(1.0, step)
        for l, s in cev.items():
            if s > tol: continue
            if contacts[l] == 2 or dJ[l, 0] >= 0 and J[l, 0] >= -1e-9 * max(1.0, np.abs(J[l]).max()):
                contacts[l] = 0; J[l] = 0.0                      # separates: its force is zero here
            else:
                contacts[l] = 2                                  # slides: normal only, its friction released
                Jt = np.zeros_like(J); Jt[l, 1:3] = J[l, 1:3]; J[l, 1:3] = 0.0
                d2, j2 = S.solve(live, yielded, contacts, -(P.B @ Jt.reshape(-1)), stats); J += j2; u += d2
        hit = [l for l, s in jev.items() if s <= tol]
        # cascade at this lam: break the brittle ones, yield the ductile ones, release, re-check
        while hit:
            brk = [l for l in hit if not P.ductile[l]]
            for l in hit:
                if P.ductile[l]: yielded[l] = True
            if brk:
                ld = release_load(P, J, brk)
                for l in brk: live[l] = False; J[l] = 0.0; broken.append(l)
                d2, j2 = S.solve(live, yielded, contacts, ld, stats); J += j2; u += d2
            idx = np.where(live & P.joint & ~yielded & S.inpatch)[0]
            over = idx[util_vec(P.d['link_f'][idx], J[idx]) >= 1 - P.band]
            hit = list(over) if brk else []
    for l in S.ductile_breaks(J, u, live, yielded):
        live[l] = False; broken.append(l)
    return finish(S, 'events', broken, J, u, live, stats, lam=lam, events=events, seconds=time.time() - t0)


def run_passes(S, passes):
    P = S.P; nl = P.nl; stats = {}
    live = P.alive0.copy(); yielded = np.zeros(nl, bool); contacts = np.where(P.contact & P.alive0, 1, 0)
    scale = np.ones(nl); broken = []
    comp0 = S.comp.copy()
    for p in range(passes):
        for _ in range(6):     # the contact active set at the full load
            S.comp = comp0 * scale[:, None]
            du, dJ = S.solve(live, np.zeros(nl, bool), contacts, S.f, stats)
            J = np.where(live[:, None], P.J0 + dJ, 0.0); J[P.contact] = dJ[P.contact]
            ch = False
            for l in np.where(contacts > 0)[0]:
                if J[l, 0] > 0: contacts[l] = 0; ch = True
                elif contacts[l] == 1 and np.hypot(J[l, 1], J[l, 2]) > P.d['link_f'][l, 13] * -J[l, 0]: contacts[l] = 2; ch = True
            if not ch: break
        idx = np.where(live & P.joint & S.inpatch)[0]
        ut = util_vec(P.d['link_f'][idx], J[idx])
        brk = [l for l, x in zip(idx, ut) if x >= 1 - P.band and not P.ductile[l]]
        yl = [(l, x) for l, x in zip(idx, ut) if x > 1 + P.band and P.ductile[l]]
        for l, x in yl: scale[l] /= x
        for l in brk: live[l] = False; broken.append(l)
        if not brk and not yl: break
    S.comp = comp0
    u = du
    for l in S.ductile_breaks(J, u, live, scale < 1):
        live[l] = False; broken.append(l)
    return finish(S, f'{passes} passes', broken, J, u, live, stats)


def finish(S, name, broken, J, u, live, stats, **kw):
    P = S.P; h = S.h; imp = P.imp[0]
    v_imp = u[6 * imp:6 * imp + 3] * h
    dp_imp = P.m_imp * (P.v0 - v_imp)
    # debris: the groups no longer tied to an anchor
    nn = P.nn; r, c = [], []
    anch = np.zeros(nn, bool)
    for l in np.where(live & P.joint)[0]:
        a, b = (P.index.get(int(x)) for x in P.d['link_u'][l, 1:3])
        if a is not None and b is not None: r.append(a); c.append(b)
        elif a is not None: anch[a] = True
        elif b is not None: anch[b] = True
    _, lab = connected_components(sp.coo_matrix((np.ones(len(r)), (r, c)), shape=(nn, nn)), directed=False)
    held = set(lab[anch])
    free = np.array([lab[k] not in held and k != imp for k in range(nn)])
    vel = u.reshape(nn, 6)[:, :3] * h
    p_debris = (P.mass[free, None] * vel[free]).sum(0)
    p_house = (P.mass[np.arange(nn) != imp, None] * vel[np.arange(nn) != imp]).sum(0)
    return dict(model=name, broken=broken, dp_imp=dp_imp, v_imp=v_imp, p_debris=p_debris, m_debris=float(P.mass[free].sum()),
                p_house=p_house, solves=stats.get('solves', 0), **kw)


def e_reference(P, cache, state):
    c = json.loads(pathlib.Path(cache).read_text())
    e = pickle.load(open(state, 'rb'))
    S = Step(P, P.dt)
    res = finish(S, 'E reference', list(e['broken']), e['J'], e['u'], e['alive'], {'solves': c['solves']})
    return res


def row(P, res, ref, extra=''):
    b = set(int(P.d['link_u'][l, 0]) for l in res['broken']); e = set(int(P.d['link_u'][l, 0]) for l in ref['broken'])
    dist = P.dist(res['broken']) if res['broken'] else np.zeros(1)
    jac = len(b & e) / max(1, len(b | e))
    # same place, not necessarily the same joint: the share of each set within 0.3 m of the other's joints
    cb = np.array([P.cen[x] for x in b]) if b else np.zeros((0, 3)); ce = np.array([P.cen[x] for x in e])
    near = lambda X, Y: float(np.mean(np.min(np.linalg.norm(X[:, None] - Y[None], axis=2), axis=1) <= 0.3)) if len(X) and len(Y) else 0.0
    near_f1 = 2 * near(cb, ce) * near(ce, cb) / max(1e-9, near(cb, ce) + near(ce, cb))
    out = dict(model=res['model'], extra=extra, broken=len(b), jaccard=round(jac, 3), common=len(b & e), near_f1=round(near_f1, 2),
               within2=int((dist < 2).sum()) if res['broken'] else 0, median=round(float(np.median(dist)), 2), max=round(float(dist.max()), 1),
               dp_imp=round(float(np.linalg.norm(res['dp_imp'])), 1), v_imp=round(float(np.linalg.norm(res['v_imp'])), 2),
               p_debris=round(float(np.linalg.norm(res['p_debris'])), 1), m_debris=round(res['m_debris'], 1),
               solves=res['solves'], events=res.get('events'))
    print(f"{res['model']:<12} {extra:<26} broken {out['broken']:4d} J {out['jaccard']:.2f} ({out['common']:2d}) nearF1 {out['near_f1']:.2f}  <2m {out['within2']:4d}  "
          f"med {out['median']:.2f} max {out['max']:.1f} m  dp_imp {out['dp_imp']:8.1f} N s (|v| {out['v_imp']:.2f})  "
          f"debris {out['p_debris']:8.1f} N s / {out['m_debris']:.0f} kg  solves {out['solves']}" + (f" events {out['events']}" if out['events'] is not None else ''), flush=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dump'); ap.add_argument('--e-cache', required=True); ap.add_argument('--e-state', required=True)
    ap.add_argument('--base-load', type=int, nargs='*', default=[2217, 2218])
    ap.add_argument('--h-ms', type=float, nargs='*', default=[0.25, 0.5, 1.0, 2.0, 4.0, 16.67])
    ap.add_argument('--patch', type=float, nargs='*', default=[1.0, 2.0, 3.0, 5.0])
    ap.add_argument('--patch-h-ms', type=float, default=1.0)
    ap.add_argument('--json')
    a = ap.parse_args()
    P = cf.Problem(a.dump, True, a.base_load)
    ref = e_reference(P, a.e_cache, a.e_state)
    rows = [row(P, ref, ref, 'Clarabel ramp, dt step')]
    kmed = np.median(P.comp[P.joint & P.alive0][:, 0]) / P.dt ** 2
    print(f"median joint k_N {kmed:.3g} N/m, median chunk {np.median(P.mass):.3g} kg: hop time sqrt(m/k) {np.sqrt(np.median(P.mass) / kmed) * 1e3:.2f} ms")
    for hm in a.h_ms:
        S = Step(P, hm * 1e-3)
        live = P.alive0.copy(); con = np.where(P.contact & P.alive0, 1, 0)
        its, ndof = S.pcg_iterations(live, np.zeros(P.nl, bool), con, S.f)
        for res in (run_events(S), run_passes(S, 2), run_passes(S, 4)):
            rows.append(row(P, res, ref, f'h {hm:g} ms, full island')); rows[-1].update(h_ms=hm, pcg=its, dof=ndof)
        print(f"    h {hm:g} ms: PCG (block-Jacobi, rtol 1e-4) {its} iterations on {ndof} DOF", flush=True)
    patch_rows = []
    for R in [None] + a.patch:
        S = Step(P, a.patch_h_ms * 1e-3, patch_radius=R)
        live = P.alive0.copy(); con = np.where(P.contact & P.alive0, 1, 0)
        its, ndof = S.pcg_iterations(live, np.zeros(P.nl, bool), con, S.f)
        S.count_pcg = True; t0 = time.time()
        res = run_events(S)
        print(f"    PCG over the event ramp: {sum(S.pcg_its)} iterations in {len(S.pcg_its)} solves "
              f"(median {np.median(S.pcg_its):.0f}, max {max(S.pcg_its)})", flush=True)
        tag = f'h {a.patch_h_ms:g} ms, patch {R} m' if R else f'h {a.patch_h_ms:g} ms, full island'
        rows.append(row(P, res, ref, tag)); rows[-1].update(h_ms=a.patch_h_ms, patch=R, pcg=its, dof=ndof, nodes=int(S.on.sum()),
                                                            pcg_ramp=int(sum(S.pcg_its)), pcg_solves=len(S.pcg_its))
        print(f"    patch {R}: {int(S.on.sum())} nodes, {ndof} DOF, PCG {its} iterations", flush=True)
        if R is None: full = res
        else:
            fb, pb = set(full['broken']), set(res['broken'])
            dpe = np.linalg.norm(res['dp_imp'] - full['dp_imp']) / max(np.linalg.norm(full['dp_imp']), 1e-30)
            rows[-1].update(jaccard_vs_full=round(len(fb & pb) / max(1, len(fb | pb)), 3), dp_err_vs_full=round(float(dpe), 4))
            print(f"    patch {R} m against the full island: Jaccard {rows[-1]['jaccard_vs_full']:.2f}, impactor momentum error {dpe:.2%}", flush=True)
    if a.json: pathlib.Path(a.json).write_text(json.dumps(rows, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
