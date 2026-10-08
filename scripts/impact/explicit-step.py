#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""The impact as explicit dynamics over the tick (CPU, FP64 and FP32; a research harness, never a runtime path).

Rigid chunks (M), bonds as elastic-perfectly-plastic (ductile) or elastic-brittle
springs in the stress solver's 6 link components (stiffness k = comp / dt^2), the
impactor a node with its momentum, contacts unilateral at velocity level (Moreau:
an inelastic impulse per substep, Coulomb cone). Symplectic Euler:

    v += dt M^-1 B (J - J0)          (J0 balances the dead load: f_ext = -B J0)
    v  = contact projection(v)
    J  = J - dt k (B^T v)            (trial)
    brittle util >= 1 - band: break; ductile util > 1: J /= util, slip += |dJ_pl| / k

Nothing is ordered or batched: a bond breaks in the substep its force reaches its
capacity, so the failure order is the wave's.

    uv run scripts/impact/explicit-step.py target/impact-diag/cannon-island1443.bin \
        --e-json target/impact-diag/cheap-e.json [--patch 3] [--boundary fixed|absorbing] [--fp32] [--handoff]

--handoff runs the next tick's static verdict under dead load alone on the damaged
house (debris excluded), brittle-only as the engine's static verdict is, and with
ductile joints yielding (secant) instead. Write-up: vibe-land
docs/destruction/IMPACT_STEP_PLAN.md.
"""
import argparse, importlib.util, json, pathlib, sys, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg
from scipy.sparse.csgraph import connected_components

H = pathlib.Path(__file__).resolve().parent
_s = importlib.util.spec_from_file_location('cheap', H / 'cheap-formulations.py')
cf = importlib.util.module_from_spec(_s); _s.loader.exec_module(cf)


def util_vec(F, X):
    capC, capT, capS, gb, gt, g0, g1, h0, h1 = (F[:, i] for i in range(9))
    N = X[:, 0]; V = np.hypot(X[:, 1], X[:, 2]); Tw = np.abs(X[:, 3]); M = np.hypot(X[:, 4], X[:, 5])
    L1 = g0 > 0
    bend = np.where(L1, g0 * np.abs(X[:, 4]) + g1 * np.abs(X[:, 5]), gb * M)
    pull = np.where(L1, h0 * np.abs(X[:, 4]) + h1 * np.abs(X[:, 5]), bend)
    r = lambda d, c: np.where(d <= 0, 0.0, d / np.where(c > 0, c, 1e-300))
    return np.maximum.reduce([r(np.maximum(N + pull, 0), capT), r(np.maximum(bend - N, 0), capC), r(V + gt * Tw, capS)])


def cone_metric(W, Ps, mu):
    """The projection of Ps onto the Coulomb cone {P_N <= 0, |P_T| <= mu |P_N|} in the metric W
    (argmin (P - Ps)^T W (P - Ps) / 2): it never adds kinetic energy, where scaling the tangential
    part alone can (W couples normal and tangential on an off-centre contact). The GPU's search:
    the boundary P = l d(t), d = (-1, mu cos t, mu sin t), l = max(0, d^T W Ps / d^T W d); t by a
    16-point scan of the circle from Ps's tangential direction, refined by 24 golden-section steps."""
    tn = np.hypot(Ps[1], Ps[2])
    if Ps[0] <= 0 and tn <= mu * -Ps[0]: return Ps.copy()
    WP = W @ Ps
    def value(t):
        d = np.array([-1.0, mu * np.cos(t), mu * np.sin(t)]); dWd = d @ W @ d; dWP = d @ WP
        l = max(0.0, dWP / dWd) if dWd > 0 else 0.0
        return 0.5 * l * l * dWd - l * dWP, l, d
    if not mu > 0:
        l = max(0.0, -WP[0] / W[0, 0]) if W[0, 0] > 0 else 0.0
        return np.array([-l, 0.0, 0.0])
    t0 = np.arctan2(Ps[2], Ps[1]); best, tb = 0.0, None
    for k in range(16):
        t = t0 + 2 * np.pi * k / 16; v = value(t)[0]
        if v < best: best, tb = v, t
    if tb is None: return np.zeros(3)
    a, b = tb - 2 * np.pi / 16, tb + 2 * np.pi / 16
    for _ in range(24):
        c, e = b - 0.618034 * (b - a), a + 0.618034 * (b - a)
        if value(c)[0] < value(e)[0]: b = e
        else: a = c
    t = 0.5 * (a + b)
    if value(t)[0] < best: tb = t
    _, l, d = value(tb)
    return l * d


def cone_coulomb(W, g, Ps, mu):
    """The GPU step's contact impulse: sticking when Ps = -W^-1 g is in the cone; else Coulomb
    sliding with the normal approach stopped (P_N = -g_N / (W_NN - mu W_NT . t), P_T = -mu P_N t,
    t the slip direction after the impulse, to a fixed point) when that pulls nowhere and adds no
    kinetic energy; else the projection in the metric W (cone_metric, which may dilate)."""
    tn = np.hypot(Ps[1], Ps[2])
    if Ps[0] <= 0 and tn <= mu * -Ps[0]: return Ps.copy()
    if Ps[0] <= 0 and mu > 0 and tn > 0:
        t = Ps[1:] / tn; ok = False; PN = 0.0
        for _ in range(8):
            den = W[0, 0] - mu * (W[0, 1] * t[0] + W[0, 2] * t[1])
            if not den > 0: ok = False; break
            PN = -g[0] / den
            if not PN <= 0: ok = False; break
            P = np.array([PN, -mu * PN * t[0], -mu * PN * t[1]])
            slip = (g + W @ P)[1:]; sn = np.hypot(*slip); ok = True
            if not sn > 0: break
            u = -slip / sn; change = np.abs(u - t).sum(); t = u
            if change < 1e-4: break
        if ok:
            P = np.array([PN, -mu * PN * t[0], -mu * PN * t[1]])
            if g @ P + 0.5 * P @ W @ P <= 0: return P
    return cone_metric(W, Ps, mu)


class Explicit:
    def __init__(self, P, patch=None, boundary='fixed', dtype=np.float64, mass_scale=None, damping=0.0, cone='coulomb'):
        self.P = P; nn, nl = P.nn, P.nl; self.dtype = dtype; self.cone = cone
        imp = P.imp[0]; self.imp = imp
        # node positions: the mean of their joints' centroids (as cheap-contact-time.py)
        pos = np.zeros((nn, 3)); cnt = np.zeros(nn)
        for l in np.where(P.joint)[0]:
            for c in P.d['link_u'][l, 1:3]:
                k = P.index.get(int(c))
                if k is not None: pos[k] += P.cen[int(P.d['link_u'][l, 0])]; cnt[k] += 1
        pos[cnt > 0] /= cnt[cnt > 0, None]; pos[cnt == 0] = P.hit; self.pos = pos
        on = np.ones(nn, bool) if patch is None else np.linalg.norm(pos - P.hit, axis=1) <= patch
        on[imp] = True
        for l in np.where(P.contact)[0]: on[P.index[int(P.d['link_u'][l, 1])]] = True
        self.on = on
        self.k = np.where(P.joint[:, None], P.comp / P.dt ** 2, 0.0)            # N/m, N m/rad per component
        ends = np.array([[P.index.get(int(c), -1) for c in P.d['link_u'][l, 1:3]] for l in range(nl)])
        self.ends = ends
        e_on = np.where(ends >= 0, on[np.maximum(ends, 0)], False)
        self.inpatch = e_on.any(1)                                             # links that act on a patch node
        self.cross = e_on.any(1) & ~np.where(ends >= 0, on[np.maximum(ends, 0)], True).all(1)   # one end outside (not an anchor)
        sel = np.repeat(on, 6)
        self.sel = sel
        # dynamic node DOF mask: off-patch nodes are held (fixed) -- their rows of v stay 0
        Mi = P.Mi.tocsr().astype(np.float64)
        self.mass = P.mass.copy()
        if mass_scale is not None:
            # selective (rotational) mass scaling: raise each node's rotational inertia so its own
            # rotational frequency bound stays under the translational one (see plan)
            Mi = self.scale_rotation(Mi, mass_scale)
        self.Mi = sp.diags(sel.astype(float)) @ Mi @ sp.diags(sel.astype(float))
        self.B, self.Bt = P.B.tocsr(), P.Bt.tocsr()
        # absorbing boundary: a dashpot on each crossing link, Z = sqrt(k m_out) per component
        self.Z = np.zeros((nl, 6))
        if boundary == 'absorbing' and patch is not None:
            for l in np.where(self.cross & P.joint)[0]:
                out = [e for e in ends[l] if e >= 0 and not on[e]][0]
                f = P.d['node_f'][out]
                mo = np.array([1 / f[0]] * 3 + [1 / f[1] if not P.d['node_tensor'][out] else 1 / np.mean(f[2:5])] * 3)
                self.Z[l] = np.sqrt(self.k[l] * mo)
        self.damping = damping
        self.S = None
        if self.Z.any():
            self._Scache = {}
            def S(dt, live):
                key = (dt, (self.cross & live).tobytes())
                if key not in self._Scache:
                    C = self.B @ sp.diags((self.Z * (self.cross & live)[:, None]).reshape(-1)) @ self.Bt
                    C = sp.diags(self.sel.astype(float)) @ C @ sp.diags(self.sel.astype(float))
                    A = (sp.identity(6 * nn) + dt * (self.Mi @ C)).tocsr()
                    blocks = [np.linalg.inv(A[6 * n:6 * n + 6, 6 * n:6 * n + 6].toarray()) for n in range(nn)]
                    self._Scache = {key: sp.block_diag(blocks).tocsr()}
                return self._Scache[key]
            self.S = S
        self.F = P.d['link_f']
        self.contacts = np.where(P.contact & P.alive0)[0]
        self.mu = P.d['link_f'][self.contacts, 13]
        # each contact row's 3x3 effective inverse mass W = B_c^T M^-1 B_c (normal + 2 tangents)
        self.Bc = [self.B[:, 6 * l:6 * l + 3] for l in self.contacts]
        self.W = [np.asarray((b.T @ self.Mi @ b).todense()) for b in self.Bc]

    def scale_rotation(self, Mi, target):
        """Rotational inertia raised so no node's rotational Gershgorin frequency exceeds `target` (rad/s)."""
        P = self.P; Mi = Mi.tolil()
        Kd = (self.B @ sp.diags(self.k.reshape(-1)) @ self.Bt).tocsr()
        added = 0.0
        for n in range(P.nn):
            if n == self.imp: continue
            r = slice(6 * n + 3, 6 * n + 6)
            krow = np.abs(Kd[6 * n + 3:6 * n + 6]).sum(1).A.ravel().max()
            Iinv = np.asarray(Mi[r, r].todense())
            w2 = krow * np.linalg.eigvalsh(Iinv).max()
            if w2 > target ** 2:
                s = w2 / target ** 2
                Mi[r, r] = Iinv / s; added += 1
        self.scaled_nodes = int(added)
        return Mi.tocsr()

    def omega_max(self, iters=200):
        """Largest eigenfrequency of M^-1 B K B^T over the patch (power iteration), and the cheap per-node
        Gershgorin bound the GPU can compute (max over nodes of |K row|_1 * max eig M^-1 block)."""
        K = (self.B @ sp.diags(self.k[:, :].reshape(-1) * np.repeat(self.inpatch & self.P.alive0, 6)) @ self.Bt).tocsr()
        A = self.Mi @ K
        x = np.random.default_rng(0).standard_normal(A.shape[0]) * self.sel
        lam = 0
        for _ in range(iters):
            y = A @ x; lam = np.linalg.norm(y) / max(np.linalg.norm(x), 1e-300); x = y / max(np.linalg.norm(y), 1e-300)
        rows = np.abs(K).sum(1).A.ravel()
        mid = self.Mi.diagonal()
        gers = np.max(rows * mid)
        return np.sqrt(lam), np.sqrt(gers)

    def run(self, T, dt, record=(0.5e-3, 1e-3, 2e-3, 4e-3, 8e-3, 16.67e-3), sweeps=4):
        P = self.P; nl = P.nl; nn = P.nn; dty = self.dtype
        k = self.k.astype(dty); Mi = self.Mi.astype(dty); B = self.B.astype(dty); Bt = self.Bt.astype(dty)
        J0 = np.where((P.alive0 & P.joint & self.inpatch)[:, None], P.J0, 0.0).astype(dty)
        J = J0.copy()
        live = P.alive0 & P.joint & self.inpatch
        slip = P.slip_before.copy()
        v = np.zeros(6 * nn, dty); v[6 * self.imp:6 * self.imp + 3] = P.v0
        broke_at = {}; Pc_tot = np.zeros((len(self.contacts), 3)); plastic_work = 0.0; brittle_energy = 0.0
        snaps = {}; rec = list(record); steps = int(np.ceil(T / dt))
        Ks = np.where(k > 0, k, 1.0)
        ev_steps = 0
        for s in range(steps):
            t = (s + 1) * dt
            Jl = np.where(live[:, None], J, 0.0)
            f = B @ (Jl - J0).reshape(-1)
            Jv = None
            if self.damping:   # stiffness-proportional (Rayleigh beta) damping: a dashpot beta k beside each live bond
                Jv = -self.damping * k * (Bt @ v).reshape(nl, 6) * live[:, None]
                f = f + B @ Jv.reshape(-1)
            v = v + dt * (Mi @ f)
            if self.S is not None:   # absorbing boundary, implicit per node: (I + dt M^-1 C) v = v*
                v = self.S(dt, live) @ v
            # contacts: Moreau impulse per substep, Gauss-Seidel over the rows, Coulomb cone
            Pc = np.zeros((len(self.contacts), 3))
            for _ in range(sweeps):
                for i, l in enumerate(self.contacts):
                    g = np.asarray(self.Bc[i].T @ v).ravel()
                    old = Pc[i].copy()
                    trial = old - np.linalg.solve(self.W[i], g)
                    if self.cone == 'coulomb':
                        trial = old + cone_coulomb(self.W[i], g, trial - old, self.mu[i]) if not old.any() else cone_coulomb(self.W[i], g + self.W[i] @ old, trial - old, self.mu[i]) + old
                    elif self.cone == 'metric':
                        trial = cone_metric(self.W[i], trial, self.mu[i])
                    elif trial[0] > 0: trial[:] = 0.0                          # separating (P_N <= 0 is compression)
                    else:
                        tn = np.hypot(trial[1], trial[2]); lim = self.mu[i] * -trial[0]
                        if tn > lim: trial[1:] *= lim / tn
                    d = trial - old; Pc[i] = trial
                    v = v + Mi @ (self.Bc[i] @ d)
            Pc_tot += Pc
            # bonds: trial elastic increment, then brittle break / ductile return
            e = (Bt @ v).reshape(nl, 6)
            Jt = J - dt * k * e
            idx = np.where(live)[0]
            u = util_vec(self.F[idx], Jt[idx] + (Jv[idx] if Jv is not None else 0.0))
            brit = idx[(u >= 1 - P.band) & ~P.ductile[idx]]
            duc = idx[(u > 1) & P.ductile[idx]]
            if len(duc):
                ud = util_vec(self.F[duc], Jt[duc])
                Jy = Jt[duc] / ud[:, None]
                dpl = (Jt[duc] - Jy) / Ks[duc]
                slip[duc] += np.linalg.norm(dpl[:, :3], axis=1)
                plastic_work += float(np.sum(np.abs(Jy * dpl)))
                Jt[duc] = Jy
                over = duc[slip[duc] > P.slip_limit[duc]]
                brit = np.concatenate([brit, over])
            J = Jt
            if len(brit):
                ev_steps += 1
                brittle_energy += float(np.sum(0.5 * (J[brit] - 0) ** 2 / Ks[brit] * (k[brit] > 0)))
                live[brit] = False; J[brit] = 0.0
                for l in brit: broke_at.setdefault(int(l), t)
            while rec and t >= rec[0] - 1e-12:
                snaps[rec.pop(0)] = dict(broken=sorted(broke_at), v=v.copy(), J=J.copy(), live=live.copy(), Pc=Pc_tot.copy())
            if not np.all(np.isfinite(v)):
                raise FloatingPointError(f'diverged at substep {s} (t {t * 1e3:.3f} ms)')
        live_full = P.alive0 & P.joint; live_full[self.inpatch] = live[self.inpatch]
        for sn in snaps.values():
            lf = P.alive0 & P.joint; lf[self.inpatch] = sn['live'][self.inpatch]; sn['live'] = lf
        return dict(broke_at=broke_at, v=v, J=J, live=live_full, Pc=Pc_tot, snaps=snaps, steps=steps, ev_steps=ev_steps,
                    plastic_work=plastic_work, brittle_energy=brittle_energy)


def debris(P, live, v):
    nn = P.nn; r, c = [], []; anch = np.zeros(nn, bool)
    for l in np.where(live & P.joint)[0]:
        a, b = (P.index.get(int(x)) for x in P.d['link_u'][l, 1:3])
        if a is not None and b is not None: r.append(a); c.append(b)
        elif a is not None: anch[a] = True
        elif b is not None: anch[b] = True
    _, lab = connected_components(sp.coo_matrix((np.ones(len(r)), (r, c)), shape=(nn, nn)), directed=False)
    held = set(lab[anch]); imp = P.imp[0]
    free = np.array([lab[k] not in held and k != imp for k in range(nn)])
    vel = v.reshape(nn, 6)[:, :3]
    return free, (P.mass[free, None] * vel[free]).sum(0), float(P.mass[free].sum())


def static_gravity(P, broken, rounds=12, plastic=False):
    """The next tick's static verdict under dead load alone on the damaged house: min-norm elastic J with
    B J = B J0 on every node still tied to an anchor (debris excluded), brittle and ductile both break at
    util >= 1 (the static verdict has no plasticity), cascade until nothing is over."""
    k = np.where(P.joint[:, None], P.comp / P.dt ** 2, 0.0)
    live = P.alive0 & P.joint; live[list(broken)] = False
    J0 = np.where(P.alive0[:, None] & P.joint[:, None], P.J0, 0.0)
    f = P.B @ J0.reshape(-1)
    hist = []; scale = np.ones(P.nl)
    if plastic: rounds = 40
    for r in range(rounds):
        free, _, _ = debris(P, live, np.zeros(6 * P.nn))
        house = ~free; house[P.imp[0]] = False
        sel = np.where(np.repeat(house, 6))[0]
        K = (P.B @ sp.diags((k * (live * scale)[:, None]).reshape(-1)) @ P.Bt).tocsr()[sel][:, sel]
        K = K + 1e-9 * sp.diags(np.maximum(K.diagonal(), 1.0))
        x = np.zeros(6 * P.nn); x[sel] = sp.linalg.spsolve(K.tocsc(), -f[sel])
        J = -(k * scale[:, None] * (P.Bt @ x).reshape(P.nl, 6))
        idx = np.where(live)[0]
        u = util_vec(P.d['link_f'][idx], J[idx])
        over = idx[u >= 1 - P.band]
        if plastic:     # ductile joints yield (secant: stiffness scaled to carry their capacity) instead of breaking
            yl = over[P.ductile[over]]; scale[yl] /= np.maximum(u[np.searchsorted(idx, yl)], 1.0) * (1 + P.band)
            over = over[~P.ductile[over]]
            if not len(over) and not len(yl): hist.append(dict(round=r, over=0, max_util=round(float(u.max()), 3), resid=0, over_far4=0, yielded=int((scale < 1).sum()))); break
            if not len(over): continue
        resid = float(np.linalg.norm(P.B[sel] @ (J * live[:, None]).reshape(-1) - f[sel]) / max(np.linalg.norm(f[sel]), 1e-30))
        hist.append(dict(round=r, over=int(len(over)), max_util=round(float(u.max()), 3), resid=resid,
                         over_far4=int((P.dist(list(over)) > 4).sum()) if len(over) else 0))
        if not len(over): break
        live[over] = False
    print(f"  static dead load{' (ductile yield)' if plastic else ''} after {len(broken)} breaks [{int(P.ductile[list(broken)].sum()) if len(broken) else 0} ductile]: " + ', '.join(f"r{h['round']} over {h['over']} (far {h['over_far4']}) max util {h['max_util']}" for h in hist), flush=True)
    return dict(total=int(sum(h['over'] for h in hist)), rounds=hist)


def compare(P, broken, ebroken):
    b = set(int(P.d['link_u'][l, 0]) for l in broken); e = set(int(P.d['link_u'][l, 0]) for l in ebroken)
    dist = P.dist(list(broken)) if broken else np.zeros(1)
    jac = len(b & e) / max(1, len(b | e))
    cb = np.array([P.cen[x] for x in b]) if b else np.zeros((0, 3)); ce = np.array([P.cen[x] for x in e])
    near = lambda X, Y: float(np.mean(np.min(np.linalg.norm(X[:, None] - Y[None], axis=2), axis=1) <= 0.3)) if len(X) and len(Y) else 0.0
    nf = 2 * near(cb, ce) * near(ce, cb) / max(1e-9, near(cb, ce) + near(ce, cb))
    return dict(n=len(b), jac=round(jac, 2), nearF1=round(nf, 2), within2=int((dist < 2).sum()) if broken else 0,
                med=round(float(np.median(dist)), 2), max=round(float(dist.max()), 2))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('dump'); ap.add_argument('--e-json', required=True)
    ap.add_argument('--T-ms', type=float, default=16.67); ap.add_argument('--safety', type=float, default=0.9)
    ap.add_argument('--patch', type=float, default=None); ap.add_argument('--boundary', default='fixed')
    ap.add_argument('--fp32', action='store_true'); ap.add_argument('--mass-scale', type=float, default=None,
                    help='target rotational frequency (rad/s); default none')
    ap.add_argument('--dt-us', type=float, default=None); ap.add_argument('--sweeps', type=int, default=4); ap.add_argument('--json'); ap.add_argument('--zeta', type=float, default=0.0, help='damping ratio at the hop frequency (beta = 2 zeta / omega_hop)'); ap.add_argument('--handoff', action='store_true')
    ap.add_argument('--cone', default='coulomb', choices=['coulomb', 'metric', 'clamp'], help='the contact impulse: Coulomb sliding with the metric projection as its energy-safe fallback (the GPU step), the projection alone, or the tangential clamp')
    a = ap.parse_args()
    P = cf.Problem(a.dump, True, [2217, 2218])
    E = json.loads(pathlib.Path(a.e_json).read_text()); eb = E['broken']
    X = Explicit(P, patch=a.patch, boundary=a.boundary, dtype=np.float32 if a.fp32 else np.float64, mass_scale=a.mass_scale, cone=a.cone)
    wmax, wg = X.omega_max()
    k_med = np.median(X.k[P.joint & P.alive0][:, 0]); w_hop = np.sqrt(k_med / np.median(P.mass))
    X.damping = 2 * a.zeta / w_hop if a.zeta else 0.0
    zmax = X.damping * wmax / 2
    dt = a.dt_us * 1e-6 if a.dt_us else a.safety * 2.0 / wmax * (np.sqrt(1 + zmax ** 2) - zmax)
    if a.zeta: print(f"damping beta {X.damping:.3g} s (zeta {a.zeta} at the hop frequency {w_hop:.0f} rad/s, {zmax:.2f} at omega_max)")
    kmed = np.median(X.k[P.joint & P.alive0][:, 0]); mmed = np.median(P.mass)
    print(f"nodes {int(X.on.sum())}, links in patch {int((X.inpatch & P.alive0).sum())}, omega_max {wmax:.3g} rad/s (Gershgorin {wg:.3g}), "
          f"dt {dt * 1e6:.2f} us, substeps {int(np.ceil(a.T_ms * 1e-3 / dt))}; median k_N {kmed:.3g} N/m, chunk {mmed:.3g} kg; "
          f"scaled rotation on {getattr(X, 'scaled_nodes', 0)} nodes", flush=True)
    t0 = time.time(); R = X.run(a.T_ms * 1e-3, dt, sweeps=a.sweeps); wall = time.time() - t0
    out = dict(patch=a.patch, boundary=a.boundary, fp32=a.fp32, dt_us=dt * 1e6, steps=R['steps'], wall_s=wall, nodes=int(X.on.sum()),
               links=int((X.inpatch & P.alive0).sum()), omega=wmax, omega_gers=wg, rows=[])
    imp = P.imp[0]
    for tt, sn in sorted(R['snaps'].items()):
        c = compare(P, sn['broken'], eb)
        vi = sn['v'][6 * imp:6 * imp + 3]; dp = P.m_imp * (P.v0 - vi)
        free, pd, md = debris(P, sn['live'], sn['v'])
        nframe = None
        row = dict(t_ms=round(tt * 1e3, 2), **c, dp_imp=round(float(np.linalg.norm(dp)), 1), v_imp=round(float(np.linalg.norm(vi)), 2),
                   p_debris=round(float(np.linalg.norm(pd)), 1), m_debris=round(md, 1),
                   contact_impulse=round(float(np.linalg.norm(sn['Pc'].sum(0))), 1))
        out['rows'].append(row)
        print(f"t {row['t_ms']:6.2f} ms: broken {c['n']:4d} J {c['jac']:.2f} nearF1 {c['nearF1']:.2f} <2m {c['within2']:4d} med {c['med']:.2f} max {c['max']:.2f} m | "
              f"imp dp {row['dp_imp']:8.1f} N s |v| {row['v_imp']:.2f} | debris {row['p_debris']:7.1f} N s / {row['m_debris']:.0f} kg", flush=True)
    # energy over the window (FP64 view)
    vi = R['v'][6 * imp:6 * imp + 3]
    ke_imp_lost = 0.5 * P.m_imp * (P.v0 @ P.v0 - vi @ vi)
    vv = R['v'].copy(); vv[6 * imp:6 * imp + 6] = 0
    Mfull = P.M.tocsr()
    ke_house = 0.5 * float(vv @ (Mfull @ vv))
    out.update(ke_imp_lost=ke_imp_lost, ke_house=ke_house, plastic_work=R['plastic_work'], ev_steps=R['ev_steps'],
               broken_final=sorted(R['broke_at']), first_break_ms={str(k): v * 1e3 for k, v in R['broke_at'].items()})
    print(f"energy: impactor lost {ke_imp_lost:.0f} J, house KE {ke_house:.0f} J, plastic work {R['plastic_work']:.0f} J; "
          f"substeps with a break {R['ev_steps']} of {R['steps']}; CPU {wall:.1f} s", flush=True)
    if a.handoff:
        out['handoff'] = {}
        for name, brk in (('intact', []), ('E', eb), ('explicit', sorted(R['broke_at']))):
            out['handoff'][name] = static_gravity(P, brk)
            out['handoff'][name + '_plastic'] = static_gravity(P, brk, plastic=True)
    if a.json: pathlib.Path(a.json).write_text(json.dumps(out, indent=1))


if __name__ == '__main__':
    sys.exit(main())
