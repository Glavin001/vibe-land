#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""A two-body impact as explicit dynamics over the tick (CPU, FP64 or FP32; a research
harness and the GPU kernel's specification, never a runtime path).

The explicit impact step (explicit-step.py; PhysX PxgDestructionImpactExplicit.cuh)
integrates the struck patch's bond graph over the tick with the impactor as one rigid
node. A car is not rigid: its own joints break, bend and yield in the same window, and
the force between the two bodies is whatever both bond graphs and their inertia make
it. Grading the car's joints on the trial pass, where the struck chunks are still
anchored, grades them against a dead stop the corrected pass then withdraws
(physx-bridge/tests/vehicle_contact_load.rs: 1227 kN graded against 718-888 kN of
measured momentum change). Here both bodies' graphs are one patch:

    nodes    every chunk of both bodies (6 dof; anchors held), their velocities at the
             tick's start
    joints   both bodies' joints in the stress solver's 6 link components (N, V1, V2,
             T, M1, M2), stiffness k = E A / L (L = max(separation along n, sqrt A)),
             r^2 = A / 12 on bending, 2 r^2 in twist (the stage's square patch)
    rows     contacts between a chunk of one body and a chunk of the other, at the
             pair's point with the pair's normal: unilateral at velocity level
             (Moreau), Coulomb cone (explicit-step.cone_coulomb), speculative over
             their gap (a row closes its gap before it pushes), Jacobi with mass
             splitting (Tonge et al. 2012), as the kernel

Each substep h (symplectic Euler, the kernel's order):

    v += h M^-1 B (J - J0)                       J0 the rest state, -B J0 the dead load
    v += M^-1 B_c P,  P in the cone, every row from the same v (Jacobi)
    J  = J - h k (B^T v)                         the trial
    brittle joint, util >= 1 - band:             breaks (J = 0)
    ductile joint, util > 1:                     J /= util, slip += |dJ_pl| / k; breaks past
                                                 its ultimate slip

h = 0.9 x 2 / omega_max (omega_max of M^-1 K by Lanczos; the kernel bounds it from above).
Nothing in it is a tuned constant: the capacities, moduli, masses and ductile slips are
the assets'.

Scenes (--scene):
  fixture      vehicle_contact_load.rs's car (920 kg, six chunks, joints that cannot
               break) at 20 m/s into its mortared block wall (0.4 MPa): the car's graded
               load against its momentum change, against today's trial (a dead stop)
  truck-wall   the lab's monster truck (the cached garage asset; --real-joints for
               VIBE_REAL_VEHICLE_JOINTS) into the lab's masonry wall (the high pack) at
               --speed m/s
  ball-truck   the city cannonball (10.65 t steel at 60 m/s) into the parked truck's side
               at body height (the lab's `cannonball` trial)

    uv run scripts/impact/two-body.py --scene truck-wall --speed 10 [--fp32] [--json out.json]
"""
import argparse, importlib.util, json, pathlib, sys, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spl
from scipy.sparse.csgraph import connected_components

H = pathlib.Path(__file__).resolve().parent
ROOT = H.parent.parent
_s = importlib.util.spec_from_file_location('explicit_step', H / 'explicit-step.py')
ex = importlib.util.module_from_spec(_s); _s.loader.exec_module(ex)

G = 9.81
DT = 1.0 / 60.0
BAND = 0.0      # the capacity band (Settings::capacityBand; the stage's default for the explicit step is 0)


def frame(n):
    """The kernel's bond frame (PxgDestructionImpact.cuh frame): t1 = n x e normalised, t2 = n x t1."""
    e = np.array([1.0, 0.0, 0.0]) if abs(n[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    t1 = np.cross(n, e); t1 /= np.linalg.norm(t1)
    return np.stack([n, t1, np.cross(n, t1)])


class Model:
    """Both bodies' chunks, joints and the rows between them, in one (world) frame."""
    def __init__(self):
        self.nodes, self.joints, self.rows = [], [], []

    # The stage's chunks carry a scalar inertia, the trace / 3 of the part's tensor
    # (physx-bridge native_destruction.cc), and the kernel integrates with it; TENSOR keeps
    # the full tensor (a slender tube's axial spin then sets omega: 7e5 rad/s on the truck).
    TENSOR = False

    def node(self, body, name, mass, inertia, x, v=(0, 0, 0), w=(0, 0, 0), anchored=False):
        I = np.asarray(inertia, float)
        if I.ndim == 1: I = np.diag(I)
        if not Model.TENSOR: I = np.eye(3) * np.trace(I) / 3.0
        self.nodes.append(dict(body=body, name=name, m=float(mass), I=I, x=np.asarray(x, float), v=np.asarray(v, float),
                               w=np.asarray(w, float), anchored=anchored or not mass > 0))
        return len(self.nodes) - 1

    def joint(self, a, b, centroid, normal, area, capC, capT, capS, E, slip=0.0, name='', rest=None):
        """A joint between nodes a and b (the stage orients n from a to b). Capacities in Pa (fatal),
        the square patch's gains (no section data: gb = 6 / sqrt A, gt = 4.24 / sqrt A, uncapped)."""
        xa, xb = self.nodes[a]['x'], self.nodes[b]['x']
        n = np.asarray(normal, float); n = n / np.linalg.norm(n)
        if n @ (xb - xa) < 0: n = -n
        L = max(abs(n @ (xb - xa)), np.sqrt(area))
        kl = E * area / L; r2 = area / 12.0
        root = np.sqrt(max(area, 1e-6))
        self.joints.append(dict(a=a, b=b, c=np.asarray(centroid, float), R=frame(n), area=area,
                                F=np.array([capC * area, capT * area, capS * area, 6.0 / root, 4.2426407 / root, 0, 0, 0, 0]),
                                k=np.array([kl, kl, kl, kl * 2 * r2, kl * r2, kl * r2]), slip=float(slip), name=name))
        return len(self.joints) - 1

    def row(self, a, b, point, normal, mu, gap=0.0):
        """A contact between chunk a and chunk b at `point`; `normal` the direction of the contact
        force on a (from b into a); `gap` >= 0 the separation still to close along it."""
        n = np.asarray(normal, float); n = n / np.linalg.norm(n)
        self.rows.append(dict(a=a, b=b, p=np.asarray(point, float), R=frame(-n), mu=float(mu), gap=max(float(gap), 0.0)))

    # ------------------------------------------------------------------ the operators
    def build(self):
        N = self.nodes; nn = len(N)
        self.dyn = np.array([not n['anchored'] for n in N])
        self.mass = np.array([n['m'] for n in N])
        rows, cols, vals = [], [], []
        Mi = []
        for k, n in enumerate(N):
            if n['anchored']: Mi.append(np.zeros((6, 6))); continue
            b = np.zeros((6, 6)); b[:3, :3] = np.eye(3) / n['m']; b[3:, 3:] = np.linalg.inv(n['I'])
            Mi.append(b)
        self.Mi = sp.block_diag(Mi).tocsr()
        Mm = []
        for n in N:
            b = np.zeros((6, 6)); b[:3, :3] = np.eye(3) * n['m']; b[3:, 3:] = n['I']; Mm.append(b)
        self.M = sp.block_diag(Mm).tocsr()

        def blocks(R, o0, o1):
            """The wrench on each end from a bond-frame force x (addWrench): end 0 +lin at o0 and couple
            -ang; end 1 the opposite. Column q: unit x_q. Rows: force (3), torque (3)."""
            B0 = np.zeros((6, 6)); B1 = np.zeros((6, 6))
            for q in range(6):
                lin = R[q] if q < 3 else np.zeros(3); ang = R[q - 3] if q >= 3 else np.zeros(3)
                B0[:3, q] = lin; B0[3:, q] = np.cross(o0, lin) - ang
                B1[:3, q] = -lin; B1[3:, q] = -(np.cross(o1, lin) - ang)
            return B0, B1

        def place(l, ends, Bs, rows, cols, vals):
            for e, Bk in zip(ends, Bs):
                if e < 0 or N[e]['anchored']: continue
                for r in range(6):
                    for q in range(6):
                        if Bk[r, q] != 0.0: rows.append(6 * e + r); cols.append(6 * l + q); vals.append(Bk[r, q])

        nl = len(self.joints)
        for l, j in enumerate(self.joints):
            B0, B1 = blocks(j['R'], j['c'] - N[j['a']]['x'], j['c'] - N[j['b']]['x'])
            place(l, (j['a'], j['b']), (B0, B1), rows, cols, vals)
        self.B = sp.csr_matrix((vals, (rows, cols)), shape=(6 * nn, 6 * nl)); self.Bt = self.B.T.tocsr()
        self.k = np.array([j['k'] for j in self.joints]).reshape(nl, 6)
        self.F = np.array([j['F'] for j in self.joints]).reshape(nl, 9)
        self.ductile = np.array([j['slip'] > 0 for j in self.joints])
        self.limit = np.array([j['slip'] for j in self.joints])
        # rows: their 3 force components only
        self.Bc = []
        r_, c_, v_ = [], [], []
        for i, r in enumerate(self.rows):
            B0, B1 = blocks(r['R'], r['p'] - N[r['a']]['x'], r['p'] - N[r['b']]['x'])
            Bi = np.zeros((6 * nn, 3))
            for e, Bk in ((r['a'], B0), (r['b'], B1)):
                if N[e]['anchored']: continue
                Bi[6 * e:6 * e + 6] += Bk[:, :3]
            self.Bc.append(sp.csr_matrix(Bi))
        # each row's W with mass splitting (each end's inverse mass times its row count), and the true W
        count = np.zeros(nn)
        for r in self.rows: count[r['a']] += 1; count[r['b']] += 1
        split = sp.diags(np.repeat(np.maximum(count, 1), 6)) @ self.Mi
        self.Wsplit = [np.asarray((b.T @ split @ b).todense()) for b in self.Bc]
        self.Wtrue = [np.asarray((b.T @ self.Mi @ b).todense()) for b in self.Bc]
        self.mu = np.array([r['mu'] for r in self.rows]); self.gap0 = np.array([r['gap'] for r in self.rows])

    def rest_state(self, gravity=True):
        """J0: the joints' rest forces under the dead load (an elastic static solve on every node
        tied to an anchor; a free body -- the car in the air -- carries none: gravity is uniform)."""
        nl = len(self.joints); J0 = np.zeros((nl, 6))
        if not gravity: return J0
        nn = len(self.nodes)
        # nodes tied to an anchor through joints
        r, c = [], []
        anchored = np.zeros(nn, bool)
        for j in self.joints:
            a, b = j['a'], j['b']
            if self.nodes[a]['anchored']: anchored[b] = True
            elif self.nodes[b]['anchored']: anchored[a] = True
            else: r.append(a); c.append(b)
        _, lab = connected_components(sp.coo_matrix((np.ones(len(r)), (r, c)), shape=(nn, nn)), directed=False)
        held = set(lab[anchored])
        on = np.array([self.dyn[k] and lab[k] in held for k in range(nn)])
        sel = np.where(np.repeat(on, 6))[0]
        if not len(sel): return J0
        f = np.zeros(6 * nn); f[1::6][:] = 0
        for k in range(nn):
            if on[k]: f[6 * k + 1] = -self.nodes[k]['m'] * G
        K = (self.B @ sp.diags(self.k.reshape(-1)) @ self.Bt).tocsr()[sel][:, sel]
        u = np.zeros(6 * nn); u[sel] = spl.spsolve(K.tocsc(), f[sel])
        return -(self.k * (self.Bt @ u).reshape(nl, 6))

    def omega_max(self, live=None):
        nl = len(self.joints)
        kk = self.k.reshape(-1) if live is None else (self.k * live[:, None]).reshape(-1)
        K = (self.B @ sp.diags(kk) @ self.Bt).tocsr()
        d = self.dyn.repeat(6)
        Ms = self.M.diagonal()
        # S = M^-1/2 K M^-1/2 over the dynamic dofs (rotational blocks: the inertia's eigen-frame)
        Mih = []
        for n in self.nodes:
            b = np.zeros((6, 6))
            if not n['anchored']:
                b[:3, :3] = np.eye(3) / np.sqrt(n['m'])
                w, V = np.linalg.eigh(n['I']); b[3:, 3:] = V @ np.diag(1 / np.sqrt(w)) @ V.T
            Mih.append(b)
        Mih = sp.block_diag(Mih).tocsr()
        S = (Mih @ K @ Mih).tocsr()
        sel = np.where(d)[0]; S = S[sel][:, sel]
        lam = spl.eigsh(S, k=1, which='LA', return_eigenvectors=False, tol=1e-6)[0]
        return float(np.sqrt(max(lam, 0.0)))


def components(model, live):
    nn = len(model.nodes); r, c = [], []
    for l, j in enumerate(model.joints):
        if live[l] and not model.nodes[j['a']]['anchored'] and not model.nodes[j['b']]['anchored']: r.append(j['a']); c.append(j['b'])
    _, lab = connected_components(sp.coo_matrix((np.ones(len(r)), (r, c)), shape=(nn, nn)), directed=False)
    return lab


def run(model, T=DT, h=None, dtype=np.float64, record=(1e-3, 2e-3, 4e-3, 8e-3, DT), J0=None, sweeps=1, quiet=False):
    """The window. Returns the trace and the books."""
    nn, nl, nr = len(model.nodes), len(model.joints), len(model.rows)
    k = model.k.astype(dtype); Mi = model.Mi.astype(dtype); B = model.B.astype(dtype); Bt = model.Bt.astype(dtype)
    J0 = np.zeros((nl, 6)) if J0 is None else J0
    J = J0.astype(dtype).copy(); J0 = J0.astype(dtype)
    live = np.ones(nl, bool); slip = np.zeros(nl); yielded = np.zeros(nl, bool)
    v = np.zeros(6 * nn, dtype)
    for i, n in enumerate(model.nodes):
        if not n['anchored']: v[6 * i:6 * i + 3] = n['v']; v[6 * i + 3:6 * i + 6] = n['w']
    v0 = v.copy()
    Ks = np.where(k > 0, k, 1.0)
    if h is None:
        om = model.omega_max(); h = 0.9 * 2.0 / om
    steps = int(np.ceil(T / h - 1e-9)); h = T / steps
    gap = model.gap0.copy()
    Ptot = np.zeros((nr, 3)); Pmax = np.zeros(nr)
    broke_at = {}; plastic = 0.0; fracture = 0.0; contact_work = 0.0; dead_work = 0.0
    U0 = float(np.sum(0.5 * np.where(model.k > 0, J0.astype(float) ** 2 / Ks, 0.0)))
    KE = lambda vv: 0.5 * float(vv.astype(float) @ (model.M @ vv.astype(float)))
    KE0 = KE(v)
    trace = []; rec = list(record); peak_util = np.zeros(nl)
    f0 = -(B @ J0.reshape(-1))
    t0 = time.time()
    for s in range(steps):
        t = (s + 1) * h
        Jl = np.where(live[:, None], J, 0.0)
        f = B @ (Jl - J0).reshape(-1)
        dead_work += h * float((-(B @ J0.reshape(-1))) @ v)    # the rest load's work (f0 . v h)
        v = v + h * (Mi @ f)
        # contacts: Moreau, Jacobi from the same velocities, speculative over each row's gap
        ke_before = KE(v)
        for _ in range(sweeps):
            dv = np.zeros_like(v); Ps = np.zeros((nr, 3))
            for i in range(nr):
                g = np.asarray(model.Bc[i].T @ v.astype(float)).ravel()
                # g_N > 0 closes. A gap still open lets it close by gap / h this substep.
                g[0] -= gap[i] / h
                if g[0] <= 0 and not Ptot[i].any() and gap[i] > 0: continue
                W = model.Wsplit[i]
                P = ex.cone_coulomb(W, g, -np.linalg.solve(W, g), model.mu[i])
                if P[0] > 0: P[:] = 0.0
                Ps[i] = P; dv += np.asarray(model.Bc[i] @ P).ravel()
            v = v + (Mi @ dv.astype(dtype))
            Ptot += Ps; Pmax = np.maximum(Pmax, -Ps[:, 0] / h)
        contact_work += KE(v) - ke_before
        for i in range(nr):
            gn = float(np.asarray(model.Bc[i].T @ v.astype(float)).ravel()[0])
            gap[i] = max(gap[i] - gn * h, 0.0)
        # joints
        e = (Bt @ v).reshape(nl, 6)
        Jt = J - h * k * e
        idx = np.where(live)[0]
        u = ex.util_vec(model.F[idx], Jt[idx].astype(float))
        peak_util[idx] = np.maximum(peak_util[idx], u)
        brit = idx[(u >= 1 - BAND) & ~model.ductile[idx]]
        duc = idx[(u > 1) & model.ductile[idx]]
        if len(duc):
            ud = u[np.searchsorted(idx, duc)]
            Jy = Jt[duc] / ud[:, None]
            dpl = (Jt[duc] - Jy) / Ks[duc]
            slip[duc] += np.linalg.norm(dpl[:, :3].astype(float), axis=1)
            plastic += float(np.sum(np.abs(Jy * dpl)))
            Jt[duc] = Jy; yielded[duc] = True
            brit = np.concatenate([brit, duc[slip[duc] > model.limit[duc]]])
        J = Jt
        if len(brit):
            fracture += float(np.sum(0.5 * J[brit].astype(float) ** 2 / Ks[brit]))
            live[brit] = False; J[brit] = 0.0
            for l in brit: broke_at.setdefault(int(l), t)
        while rec and t >= rec[0] - 1e-12:
            trace.append(dict(t=rec.pop(0), v=v.copy(), live=live.copy(), P=Ptot.copy()))
        if not np.all(np.isfinite(v)): raise FloatingPointError(f'diverged at substep {s}')
    U = float(np.sum(0.5 * np.where(live[:, None], J.astype(float) ** 2 / Ks, 0.0)))
    return dict(h=h, steps=steps, wall=time.time() - t0, v=v, v0=v0, live=live, broke_at=broke_at, slip=slip, yielded=yielded,
                P=Ptot, Pmax=Pmax, KE0=KE0, KE=KE(v), U0=U0, U=U, plastic=plastic, fracture=fracture, contact=contact_work,
                dead=dead_work, peak_util=peak_util, trace=trace, J=J)


def body_momentum(model, v, body):
    p = np.zeros(3); m = 0.0
    for i, n in enumerate(model.nodes):
        if n['body'] == body and not n['anchored']: p += n['m'] * v[6 * i:6 * i + 3]; m += n['m']
    return p, m


def books(model, R, label=''):
    """The energy books: what the window started with (kinetic, elastic, the dead load's work)
    against what it ended with and dissipated (kinetic, elastic, fracture, plasticity, contact)."""
    inn = R['KE0'] + R['U0'] + R['dead']
    out = R['KE'] + R['U'] + R['fracture'] + R['plastic'] - R['contact']
    print(f"  energy{label}: in {inn / 1e3:.2f} kJ (kinetic {R['KE0'] / 1e3:.2f}, elastic {R['U0'] / 1e3:.3f}, dead load {R['dead'] / 1e3:.3f}); "
          f"out {out / 1e3:.2f} kJ (kinetic {R['KE'] / 1e3:.2f}, elastic {R['U'] / 1e3:.3f}, fracture {R['fracture'] / 1e3:.3f}, "
          f"plastic {R['plastic'] / 1e3:.3f}, contact {-R['contact'] / 1e3:.2f}); closure {(out - inn) / max(inn, 1e-9) * 100:+.3f}%; "
          f"contact work {'<= 0 (dissipative)' if R['contact'] <= 1e-6 * max(inn, 1) else '> 0: ADDS ENERGY'}")
    return dict(inJ=inn, outJ=out, closure=(out - inn) / max(inn, 1e-9), kineticIn=R['KE0'], kineticOut=R['KE'], elasticIn=R['U0'],
                elasticOut=R['U'], dead=R['dead'], fracture=R['fracture'], plastic=R['plastic'], contact=-R['contact'])


# ---------------------------------------------------------------------------- scenes
def box_inertia(m, h):
    return m * np.array([h[1] ** 2 + h[2] ** 2, h[0] ** 2 + h[2] ** 2, h[0] ** 2 + h[1] ** 2]) / 3.0


def fixture(speed=20.0, car_strength=None):
    """vehicle_contact_load.rs: setup(y 30, wall z 3.5). The car's front (z + 1.3) on the wall's face
    (z 3.375) at the tick its contact starts."""
    m = Model(); y, wall_z = 30.0, 3.5
    face = wall_z - 0.125
    z = face - 1.3                       # the car where its front meets the face
    pos = [(0, 0, 0), (-0.95, -0.1, 1.0), (0.95, -0.1, 1.0), (-0.95, -0.1, -1.0), (0.95, -0.1, -1.0), (0, 0.4, -0.7)]
    masses = [800, 20, 20, 20, 20, 40]
    car = []
    for i, (c, mm) in enumerate(zip(pos, masses)):
        h = (0.6, 0.2, 1.3) if i == 0 else (0.15, 0.15, 0.15)
        car.append(m.node('car', ['chassis', 'wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr', 'engine'][i], mm, box_inertia(mm, h),
                          (c[0], y + c[1], z + c[2]), v=(0, 0, speed)))
    # the car's joints: chassis to each part, area 0.01; unbreakable in the test (1e12 Pa)
    cs = car_strength or dict(capC=2e12, capT=2e12, capS=2e12, E=200e9, slip=0.0)
    for i in range(1, 6):
        c = np.array(pos[i]) * 0.5
        m.joint(car[0], car[i], (c[0], y + c[1], z + c[2]), (-1, 0, 0) if pos[i][0] < 0 else (1, 0, 0), 0.01, **cs, name=f'chassis-{m.nodes[car[i]]["name"]}')
    footing = m.node('wall', 'footing', 0.0, np.zeros(3), (0, y - 3.5, wall_z), anchored=True)
    blocks = {}
    for j in range(6):
        for i in range(8):
            c = (-3.75 + i, y - 2.75 + j, wall_z)
            blocks[i, j] = m.node('wall', f'block{i},{j}', 125.0, box_inertia(125.0, (0.5, 0.5, 0.125)), c)
    mortar = dict(capC=0.4e6, capT=0.4e6, capS=0.4e6, E=5e9)
    for j in range(6):
        for i in range(8):
            c = np.array((-3.75 + i, y - 2.75 + j, wall_z))
            if j == 0: m.joint(footing, blocks[i, j], c - (0, 0.5, 0), (0, 1, 0), 0.25, **mortar)
            if i < 7: m.joint(blocks[i, j], blocks[i + 1, j], c + (0.5, 0, 0), (1, 0, 0), 0.25, **mortar)
            if j < 5: m.joint(blocks[i, j], blocks[i, j + 1], c + (0, 0.5, 0), (0, 1, 0), 0.25, **mortar)
    # rows: the chassis's front face (x -0.6..0.6, y 29.8..30.2) on the blocks it covers, row j = 3
    for i in range(8):
        x0, x1 = max(-0.6, -4.25 + i), min(0.6, -3.25 + i)
        if x1 <= x0: continue
        m.row(blocks[i, 3], car[0], ((x0 + x1) / 2, y, face), (0, 0, 1), 0.5)
    return m, dict(car='car', wheels=car[1:5], chassis=car[0], speed=speed, mass=920.0, dead_stop=920.0 * speed / DT,
                   gpu=dict(trial_kN=1227.1, measured_kN=[718.5, 887.8, 791.0]))


def load_truck(real_joints=False):
    """The monster truck's cached garage asset (client/src/vehicles/prepare-asset.mjs; the hashes the
    lab prepared under the high profile)."""
    h = '19920828b451b768e835bf8aaadd3921eb663db89029da29a68f51ae6037e5ae' if real_joints else 'cdc8ae25012b565de727a544fd8e31b64de62bd0d5757a8a4f8a9ac1c0050f7a'
    for root in (ROOT / '.cache/vehicle-assets', pathlib.Path('/Users/glavin/Development/vibe-land/.cache/vehicle-assets')):
        p = root / h / 'metadata.json'
        if p.exists(): return json.loads(p.read_text())
    raise FileNotFoundError(f'monster asset {h}: run the lab once (scripts/impact/high-trials.sh) to prepare it')


def add_truck(m, meta, offset, v, w=(0, 0, 0)):
    """The truck's parts and joints into the model, its asset frame shifted by `offset` (world =
    asset + offset; the asset faces +z), moving at v. Returns part id -> node, and each part's hull
    points in world."""
    ids = {}; hulls = {}
    for p in meta['parts']:
        mp = p['massProperties']; c = np.array(mp['center']) + offset
        I = np.array(mp['inertia'])
        r = c - offset
        ids[p['id']] = m.node('truck', p['name'], p['mass'], I, c, v=np.asarray(v) + np.cross(w, np.zeros(3)), w=w)
        pts = []
        for s in p.get('shapes', []):
            base = np.array(p['position']) + np.array(s.get('position', (0, 0, 0)))
            verts = np.array(s.get('vertices', s.get('points', []))).reshape(-1, 3)
            if len(verts): pts.append(verts + base + offset)
        hulls[p['id']] = np.concatenate(pts) if pts else c[None]
    for b in meta['bonds']:
        s = b['strength']
        if b['a'] not in ids or b['b'] not in ids: continue
        m.joint(ids[b['a']], ids[b['b']], np.array(b['centroid']) + offset, b['normal'], b['area'],
                s['compressionFatal'], s['tensionFatal'], s['shearFatal'], s['elasticModulus'], slip=s.get('ductileSlip', 0.0) or 0.0,
                name=f"{b['a']}|{b['b']}|{b.get('attachment', '')}")
    return ids, hulls


def lab_wall(m):
    """The lab's masonry wall (lane `wall`, x 32, z 20; the high pack): 70 brick-plinth blocks
    0.5 x 0.5 x 0.25 m (118.75 kg) on mortar joints (0.6 MPa tension, 1 MPa shear, 40 MPa
    compression, E 5 GPa) and a buried footing."""
    p = ROOT / 'target/fidelity/high/structures/vehicle-lab/out/vehicle-lab-crush.json'
    d = json.loads(p.read_text()); s = d['scenario']; mats = d['defaults']['solver']['materials']
    ws = [i for i, g in enumerate(s['nodeGroups']) if g == 'wall@wall']
    node = {}
    for i in ws:
        n = s['nodes'][i]; c = np.array([n['centroid'][a] for a in 'xyz']); sz = np.array([s['nodeSizes'][i][a] for a in 'xyz'])
        node[i] = m.node('wall', f'n{i}', n['mass'], box_inertia(n['mass'], sz / 2), c)
    for b in s['bonds']:
        if b['node0'] in node and b['node1'] in node:
            mt = mats[b['m']]
            m.joint(node[b['node0']], node[b['node1']], [b['centroid'][a] for a in 'xyz'], [b['normal'][a] for a in 'xyz'], b['area'],
                    mt['compressionFatal'], mt['tensionFatal'], mt['shearFatal'], mt['elasticModulus'])
    blocks = [(i, node[i], np.array([s['nodes'][i]['centroid'][a] for a in 'xyz']), np.array([s['nodeSizes'][i][a] for a in 'xyz']))
              for i in ws if s['nodes'][i]['mass'] > 0]
    return blocks


def driven_wheel(p):
    """A part whose hulls follow Vehicle2's wheel (wheel and hub): the stage excludes a driven
    wheel's hulls from everything its road query stands on, the lab's walls and houses included
    (garage_destruction.rs pose_wheels, ROAD_GROUPS), so they meet no structure while driven."""
    return (p.get('motion') or {}).get('role') in ('wheel', 'hub')


def truck_wall(speed, real_joints=False, reach=None, wheel_contacts=False):
    """The truck's front on the wall's face (z 19.875) at the window's start, moving +z at `speed`.
    Rows: every (part, block) pair a hull vertex of the part will reach within the window
    (speed x dt) lies in, each with its own gap: the swept contacts the window must see."""
    m = Model(); meta = load_truck(real_joints)
    blocks = lab_wall(m)
    face = 20.0 - 0.125
    allz = np.concatenate([np.array([np.array(s.get('vertices', s.get('points', []))).reshape(-1, 3)[:, 2].max() + p['position'][2] + s.get('position', (0, 0, 0))[2]
                                     for s in p['shapes']]) for p in meta['parts'] if p.get('shapes')])
    front = allz.max()
    # the truck at x 32 (the lane), its wheels on the ground (y of its asset frame: originHeight above it)
    offset = np.array([32.0, meta.get('originHeight', 0.0), face - front])
    ids, hulls = add_truck(m, meta, offset, (0, 0, speed))
    reach = speed * DT if reach is None else reach
    rows = {}
    excluded = set() if wheel_contacts else {p['id'] for p in meta['parts'] if driven_wheel(p)}
    front = max(hulls[pid][:, 2].max() for pid in hulls if pid not in excluded)
    shift = face - front                 # the leading hull that can meet the wall on the face
    for pid in hulls: hulls[pid] = hulls[pid] + (0, 0, shift)
    for i in ids.values(): m.nodes[i]['x'] = m.nodes[i]['x'] + (0, 0, shift)
    for j in m.joints:
        if m.nodes[j['a']]['body'] == 'truck': j['c'] = j['c'] + (0, 0, shift)
    for pid, pts in hulls.items():
        if pid in excluded: continue
        near = pts[pts[:, 2] >= face - reach]
        for q in near:
            for (i, node, c, sz) in blocks:
                if abs(q[0] - c[0]) <= sz[0] / 2 and abs(q[1] - c[1]) <= sz[1] / 2:
                    rows.setdefault((pid, node), []).append(q)
    for (pid, node), qs in rows.items():
        qs = np.array(qs); lead = qs[:, 2].max()
        m.row(node, ids[pid], (qs[:, 0].mean(), qs[:, 1].mean(), face), (0, 0, 1), 0.5, gap=face - lead)
    wheels = [ids[p['id']] for p in meta['parts'] if (p.get('motion') or {}).get('role') == 'wheel']
    mass = sum(p['mass'] for p in meta['parts'])
    return m, dict(car='truck', ids=ids, meta=meta, speed=speed, mass=mass, dead_stop=mass * speed / DT, wheels=wheels)


def ball_truck(real_joints=False, mass=10650.0, speed=60.0, ticks=1):
    """The lab's `cannonball` trial: the city cannonball into the parked truck's side at body height
    (attack kind cannonball, from 90 degrees). The ball (steel, 7850 kg/m3) a rigid node; rows with
    every part its swept sphere crosses in the window (speed x dt along -x), normal along its path."""
    m = Model(); meta = load_truck(real_joints)
    ids, hulls = add_truck(m, meta, np.zeros(3), (0, 0, 0))
    r = (3 * mass / (4 * np.pi * 7850.0)) ** (1 / 3)
    com = np.array(meta['massProperties']['center']) if 'massProperties' in meta else np.zeros(3)
    allp = np.concatenate(list(hulls.values()))
    side = allp[:, 0].max()
    y = com[1]; z = com[2]
    ball = m.node('ball', 'ball', mass, np.eye(3) * 0.4 * mass * r * r, (side + r, y, z), v=(-speed, 0, 0))
    reach = speed * DT * ticks
    for pid, pts in hulls.items():
        d_perp = np.hypot(pts[:, 1] - y, pts[:, 2] - z)
        hit = pts[(d_perp <= r) & (pts[:, 0] >= side - reach)]
        if not len(hit): continue
        lead = hit[:, 0].max()
        m.row(ids[pid], ball, (lead, hit[:, 1].mean(), hit[:, 2].mean()), (-1, 0, 0), 0.3, gap=side - lead)
    wheels = [ids[p['id']] for p in meta['parts'] if (p.get('motion') or {}).get('role') == 'wheel']
    return m, dict(car='truck', ids=ids, meta=meta, speed=speed, mass=sum(p['mass'] for p in meta['parts']), wheels=wheels, ball=ball, ball_mass=mass)


def wheels_off(model, live, info):
    """Wheel chunks no longer in the chassis's component (part 0: the authored chassis anchor)."""
    lab = components(model, live)
    if info['car'] == 'car': chassis = info['chassis']
    else: chassis = info['ids'][info['meta']['parts'][0]['id']]
    return [w for w in info['wheels'] if lab[w] != lab[chassis]]


def report(model, R, info, args):
    car = info['car']
    p0, mc = body_momentum(model, R['v0'], car); p1, _ = body_momentum(model, R['v'], car)
    dv = (p1 - p0) / mc
    # the car's load: the rows' impulse on its chunks over the window, per second of tick
    rows_on_car = np.zeros(3)
    for i, r in enumerate(model.rows):
        for end, sign in ((r['a'], 1.0), (r['b'], -1.0)):
            if model.nodes[end]['body'] == car:
                rows_on_car += sign * (r['R'].T @ R['P'][i])
    graded = np.linalg.norm(rows_on_car) / DT; needed = mc * np.linalg.norm(dv) / DT
    nl = len(model.joints)
    car_j = np.array([model.nodes[j['a']]['body'] == car for j in model.joints])
    broken = np.array([not R['live'][l] for l in range(nl)])
    off = wheels_off(model, R['live'], info)
    out = dict(scene=args.scene, speed=info['speed'], real_joints=bool(getattr(args, 'real_joints', False)), fp32=args.fp32,
               nodes=len(model.nodes), joints=nl, rows=len(model.rows), h_us=R['h'] * 1e6, substeps=R['steps'], cpu_s=R['wall'],
               car_mass=mc, car_dv=dv.tolist(), car_dv_abs=float(np.linalg.norm(dv)),
               graded_kN=graded / 1e3, needed_kN=needed / 1e3, ratio=graded / max(needed, 1e-9),
               dead_stop_kN=info.get('dead_stop', 0) / 1e3,
               peak_row_force_kN=float(R['Pmax'].max() / 1e3) if len(R['Pmax']) else 0.0,
               car_broken=int((broken & car_j).sum()), car_yielded=int((R['yielded'] & car_j).sum()),
               other_broken=int((broken & ~car_j).sum()), wheels_off=len(off),
               car_peak_util=float(R['peak_util'][car_j].max()) if car_j.any() else 0.0)
    print(f"{args.scene} {info['speed']:.1f} m/s{' real joints' if out['real_joints'] else ''}{' fp32' if args.fp32 else ''}: "
          f"{out['nodes']} nodes, {nl} joints, {out['rows']} rows; h {out['h_us']:.2f} us, {out['substeps']} substeps, CPU {out['cpu_s']:.1f} s")
    print(f"  the car ({mc:.0f} kg): dv {out['car_dv_abs']:.2f} m/s; graded on {out['graded_kN']:.1f} kN of row impulse per tick, "
          f"its momentum change needs {out['needed_kN']:.1f} kN: ratio {out['ratio']:.3f} (a dead stop: {out['dead_stop_kN']:.0f} kN); peak row force {out['peak_row_force_kN']:.0f} kN")
    print(f"  car joints: {out['car_broken']} broken, {out['car_yielded']} yielded, peak utilisation {out['car_peak_util']:.2f}; wheels off {out['wheels_off']} of {len(info['wheels'])}; "
          f"struck body: {out['other_broken']} joints broken")
    if 'ball' in info:
        pb0, mb = body_momentum(model, R['v0'], 'ball'); pb1, _ = body_momentum(model, R['v'], 'ball')
        out['ball_dv'] = float(np.linalg.norm((pb1 - pb0) / mb)); out['ball_v_out'] = float(np.linalg.norm(pb1 / mb))
        print(f"  ball: {np.linalg.norm(pb0 / mb):.1f} -> {out['ball_v_out']:.1f} m/s")
    if 'gpu' in info:
        g = info['gpu']
        print(f"  GPU today: the trial graded the car on {g['trial_kN']:.0f} kN; the corrected pass gave it {min(g['measured_kN']):.0f}-{max(g['measured_kN']):.0f} kN of momentum change")
    for t in R['trace']:
        pc, _ = body_momentum(model, t['v'], car)
        nb = int((~t['live'] & car_j).sum()); nw = int((~t['live'] & ~car_j).sum())
        print(f"    t {t['t'] * 1e3:5.2f} ms: car v {np.linalg.norm(pc / mc):6.2f} m/s, car joints broken {nb:4d}, struck {nw:4d}, row impulse {np.linalg.norm(t['P'].sum(0)) / 1e3:8.2f} kN s")
    out['energy'] = books(model, R)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', default='fixture', choices=['fixture', 'truck-wall', 'ball-truck'])
    ap.add_argument('--speed', type=float, default=None)
    ap.add_argument('--real-joints', action='store_true', help='the truck with VIBE_REAL_VEHICLE_JOINTS capacities')
    ap.add_argument('--fp32', action='store_true')
    ap.add_argument('--dt-us', type=float, default=None)
    ap.add_argument('--brittle', action='store_true', help='every joint brittle (no ductile slip): the static verdict today')
    ap.add_argument('--ticks', type=int, default=1, help='the window over this many ticks (rows over the path swept in them)')
    ap.add_argument('--wheel-contacts', action='store_true', help="the driven wheels' hulls meet the wall (the stage excludes them)")
    ap.add_argument('--tensor-inertia', action='store_true', help="each chunk's full inertia tensor (the stage's chunks: scalar trace / 3)")
    ap.add_argument('--json')
    a = ap.parse_args()
    Model.TENSOR = a.tensor_inertia
    if a.scene == 'fixture': model, info = fixture(a.speed or 20.0)
    elif a.scene == 'truck-wall': model, info = truck_wall(a.speed or 21.7, a.real_joints, reach=(a.speed or 21.7) * DT * a.ticks, wheel_contacts=a.wheel_contacts)
    else: model, info = ball_truck(a.real_joints, speed=a.speed or 60.0, ticks=a.ticks)
    if a.brittle:
        for j in model.joints: j['slip'] = 0.0
    model.build()
    J0 = model.rest_state()
    om = model.omega_max()
    h = a.dt_us * 1e-6 if a.dt_us else 0.9 * 2.0 / om
    print(f"omega_max {om:.4g} rad/s -> h {h * 1e6:.2f} us")
    R = run(model, T=DT * a.ticks, h=h, dtype=np.float32 if a.fp32 else np.float64, J0=J0,
            record=tuple(t * 1e-3 for t in (1, 2, 4, 8)) + tuple(DT * (k + 1) for k in range(a.ticks)))
    out = report(model, R, info, a)
    out['omega_max'] = om
    if a.json: pathlib.Path(a.json).write_text(json.dumps(out, indent=1))


if __name__ == '__main__':
    sys.exit(main())
