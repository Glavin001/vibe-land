#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Failure sequencing within a step (FIDELITY_AUDIT C10), on the CPU: a research
harness for choosing the engine's method, never a runtime path.

The stage's static verdict breaks every bond past fatal in one elastic snapshot.
Two principled ways to order failures, each run here on a calibration case:

  cascade   the engine today (static-cascade.py's rounds): every bond past fatal
            breaks at once, re-solve, repeat.
  ramp      a quasi-static load ramp (event-by-event, as sequentially linear
            analysis: Rots and Invernizzi 2004): the load goes from the last
            equilibrium (lambda 0) to the new state (lambda 1); each bond's
            critical load factor is where its utilisation reaches 1 on the
            linear path J(lambda) = J_e + (lambda - lambda_e) dJ of the current
            topology; the first one breaks, the structure is solved again at
            that load, and the ramp goes on. Under proportional loading the first
            event is the most utilised bond (u is homogeneous of degree 1 in J),
            which is where "most overloaded first" comes from; after a removal
            the path is not proportional and the order is the crossings'.
  dynamic   explicit dynamics: rigid chunks (mass, rotational inertia), bonds as
            elastic-brittle springs (k = E A / L, k r^2 in rotation; the engine's
            one stiffness per bond), stiffness-proportional damping, symplectic
            Euler. A bond breaks in the substep its force reaches capacity: the
            order is the inertia's and the waves'.

Two set-ups:
  removal   (default) the intact house at equilibrium, then the case's members
            removed: ramp releases their forces quasi-statically (the alternate
            path method's load-controlled removal, GSA 2016 / UFC 4-023-03),
            dynamic removes them in an instant (its dynamic counterpart).
  asbuilt   the case's house as authored (the calibration: built with the gap),
            its dead load ramped from 0 (ramp only).

Re-bearing (C9, --rebearing, the high profile): a bearing joint whose fasteners
fail is a unilateral contact (compression to its capacity, shear by friction
mu 0.23, no tension): in the ramp it lifts out of the solve in tension and is
readmitted when the displacement presses it; in the dynamic run its force is
projected on the contact's cone every substep.

    uv run structures/town-kit/scripts/sequence-lab.py SCENE --case truck-door --mode ramp [--rebearing] [--json OUT]
"""
import argparse, collections, importlib.util, json, os, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

here = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location('stress_share', os.path.join(here, 'stress-share.py'))
ss = importlib.util.module_from_spec(_s); _s.loader.exec_module(ss)
G = 9.81
MU = 0.23   # timber on timber, EN 1995-2:2004 Table 6.2 (PhysX kRebearingTimberFriction)
SKIN = {'drywall', 'brick-veneer', 'veneer-lintel-course', 'ceiling-lining', 'glazing', 'window-frame', 'door-frame',
        'roof-covering', 'ivory-trim', 'roof-batten', 'gable-weatherboard'}
ROOF = {'rafter', 'ridge-board', 'ceiling-joist', 'hip-rafter', 'gable-frame'}
CASES = {'intact': (0, None), 'bay1': (14, (1.45, 1.65)), 'bay2': (28, (0.9, 1.65)), 'truck': (42, (-1.5, 1.3)), 'truck-door': (56, (-1.5, 1.65))}


# ------------------------------------------------------------------ structure
def subscene(scene, group, dz):
    s = scene['scenario']
    keep = [i for i, g in enumerate(s['nodeGroups']) if g == group]
    idx = {o: k for k, o in enumerate(keep)}
    out = {k: [s[k][i] for i in keep] for k in ('nodes', 'nodeSizes', 'nodeColliders', 'nodeTypes', 'nodeMaterials', 'nodePieces', 'nodeGroups')}
    out['shapeLibrary'] = s['shapeLibrary']
    out['nodes'] = [dict(n, centroid={'x': n['centroid']['x'], 'y': n['centroid']['y'], 'z': n['centroid']['z'] - dz}) for n in out['nodes']]
    out['bonds'] = []
    for b in s['bonds']:
        if b['node0'] in idx and b['node1'] in idx:
            c = b['centroid']
            out['bonds'].append(dict(b, node0=idx[b['node0']], node1=idx[b['node1']], centroid={'x': c['x'], 'y': c['y'], 'z': c['z'] - dz}))
    return out


class Structure:
    def __init__(self, s, mats):
        self.s, self.mats = s, mats
        pack = {'scenario': s, 'defaults': {'solver': {'materials': mats}}}
        tmp = '/tmp/sequence-lab-pack.json'
        json.dump(pack, open(tmp, 'w'))
        _, s2, _, self.pos, self.mass = ss.load(tmp)
        self.sections = ss.fastener_twist(s, mats, ss.bond_sections(s))
        n, m = len(s['nodes']), len(s['bonds'])
        self.n, self.m = n, m
        self.types = s['nodeTypes']
        self._operator()
        self._grading()

    def _operator(self):
        """B: node wrench rows (free nodes) x bond columns (6: force, moment), the
        solver's convention (J acts on node1 +, node0 -); Wd: per-bond column
        weights (w I3 linear, w R angular), so A = B Wd is stress-share's matrix."""
        s, pos, mass = self.s, self.pos, self.mass
        free = mass > 0
        self.free = free
        row = -np.ones(self.n, int); row[free] = np.arange(free.sum()); self.row = row
        r, c, v = [], [], []
        R = np.zeros((self.m, 3, 3)); w = np.zeros(self.m); k = np.zeros(self.m)
        self.normal = np.zeros((self.m, 3))
        for b, bd in enumerate(s['bonds']):
            i, j = bd['node0'], bd['node1']
            cen = np.array([bd['centroid'][q] for q in 'xyz'])
            nrm = np.array([bd['normal'][q] for q in 'xyz'], float); nrm /= np.linalg.norm(nrm)
            if nrm @ (pos[j] - pos[i]) < 0: nrm = -nrm
            self.normal[b] = nrm
            sec = self.sections[b]
            if sec is None:
                rr = np.sqrt(max(bd['area'], 1e-12) / 12); R[b] = np.eye(3) * rr + (np.sqrt(2) - 1) * rr * np.outer(nrm, nrm)
            else:
                e1, e2, _, _, _, r1, r2, rt = sec[:8]; R[b] = r1 * np.outer(e1, e1) + r2 * np.outer(e2, e2) + rt * np.outer(nrm, nrm)
            mt = self.mats[bd['m']]
            E = mt.get('bearingElasticModulus') or mt.get('elasticModulus') or 30e9
            L = max(abs(nrm @ (pos[j] - pos[i])), np.sqrt(bd['area']))
            k[b] = E * bd['area'] / L
            w[b] = np.sqrt(k[b] / 30e9)
            for node, sign in ((j, 1.0), (i, -1.0)):
                if row[node] < 0: continue
                arm = cen - pos[node]
                X = np.array([[0, -arm[2], arm[1]], [arm[2], 0, -arm[0]], [-arm[1], arm[0], 0]])
                for a in range(3):
                    r.append(6 * row[node] + a); c.append(6 * b + a); v.append(sign)
                    r.append(6 * row[node] + 3 + a); c.append(6 * b + 3 + a); v.append(sign)
                    for q in range(3):
                        if X[a, q] != 0: r.append(6 * row[node] + 3 + a); c.append(6 * b + q); v.append(sign * X[a, q])
        self.B = sp.csr_matrix((v, (r, c)), shape=(6 * free.sum(), 6 * self.m))
        blocks = []
        for b in range(self.m):
            blk = np.zeros((6, 6)); blk[:3, :3] = np.eye(3) * w[b]; blk[3:, 3:] = R[b] * w[b]; blocks.append(blk)
        self.Wd = sp.csr_matrix(sp.block_diag(blocks, format='csr'))
        self.A = (self.B @ self.Wd).tocsr()
        self.R, self.w, self.k = R, w, k
        # Gravity: the load the bonds must carry (+m g up on every free node).
        self.fg = np.zeros(6 * free.sum())
        for node in np.nonzero(free)[0]: self.fg[6 * row[node] + 1] = mass[node] * G

    def _grading(self):
        """Per-bond arrays for the vectorised stresses (stress-share stresses, section bending)."""
        m, s = self.m, self.s
        self.area = np.array([bd['area'] for bd in s['bonds']])
        self.e1 = np.zeros((m, 3)); self.e2 = np.zeros((m, 3)); self.S1 = np.zeros(m); self.S2 = np.zeros(m); self.Zt = np.zeros(m)
        self.hasSec = np.zeros(m, bool); self.d0 = np.zeros(m); self.d1 = np.zeros(m); self.bearing = np.zeros(m, bool)
        lim = np.zeros((m, 6))
        for b, bd in enumerate(s['bonds']):
            mt = self.mats[bd['m']]
            lim[b] = [mt['compressionElastic'], mt['compressionFatal'], mt['tensionElastic'], mt['tensionFatal'], mt['shearElastic'], mt['shearFatal']]
            sec = self.sections[b]
            if sec is not None:
                self.hasSec[b] = True; self.e1[b], self.e2[b] = sec[0], sec[1]; self.S1[b], self.S2[b], self.Zt[b] = sec[2], sec[3], sec[4]
                if mt.get('bearingJoint') and len(sec) >= 10: self.bearing[b] = True; self.d0[b], self.d1[b] = sec[8], sec[9]
        self.lim = lim

    def stresses(self, J):
        """(fatal utilisation, normal (+ tension) N, shear V, compression stress, mode) per bond."""
        n, a = self.normal, self.area
        lin, ang = J[:, :3], J[:, 3:]
        ln = (lin * n).sum(1); normal = -ln / a
        shear = np.linalg.norm(lin - ln[:, None] * n, axis=1) / a
        an = (ang * n).sum(1)
        bendSec = np.abs((ang * self.e1).sum(1)) / np.where(self.S1 > 0, self.S1, 1) + np.abs((ang * self.e2).sum(1)) / np.where(self.S2 > 0, self.S2, 1)
        bendSq = np.linalg.norm(ang - an[:, None] * n, axis=1) / a * 6.0 / np.sqrt(np.maximum(a, 1e-12))
        bend = np.where(self.hasSec, bendSec, bendSq)
        shear = shear + np.where(self.hasSec, np.abs(an) / np.where(self.Zt > 0, self.Zt, 1), np.abs(an) / a * 3 * np.sqrt(2) / np.sqrt(np.maximum(a, 1e-12)))
        tension = np.maximum(normal + bend, 0); compression = np.maximum(bend - normal, 0)
        T = np.abs((ang * self.e1).sum(1)) / np.where(self.d0 > 0, self.d0, 1) + np.abs((ang * self.e2).sum(1)) / np.where(self.d1 > 0, self.d1, 1) + normal * a
        tension = np.where(self.bearing, np.maximum(T, 0) / a, tension)
        L = self.lim
        fatal = np.maximum.reduce([compression / L[:, 1], tension / L[:, 3], shear / L[:, 5]])
        crush = compression / L[:, 1]
        return fatal, normal * a, shear * a, crush


# ------------------------------------------------------------------ solves
class Solver:
    """The min-norm static solve on a bond mask: J = Wd Wd^T B^T z, (A A^T) z = f."""
    def __init__(self, S): self.S = S

    def anchored(self, live):
        S = self.S; adj = collections.defaultdict(list)
        for b in np.nonzero(live)[0]:
            bd = S.s['bonds'][b]; adj[bd['node0']].append(bd['node1']); adj[bd['node1']].append(bd['node0'])
        seen = ~S.free.copy(); stack = list(np.nonzero(seen)[0])
        while stack:
            i = stack.pop()
            for j in adj[i]:
                if not seen[j]: seen[j] = True; stack.append(j)
        return seen

    def solve(self, live, f):
        """Bond forces (m x 6) and displacement z (free node rows) under node load f, with
        unanchored nodes dropped (their rows' load ignored: they fall)."""
        S = self.S
        keep = self.anchored(live)
        on = live & keep[[bd['node0'] for bd in S.s['bonds']]] & keep[[bd['node1'] for bd in S.s['bonds']]]
        rows = np.repeat(keep[S.free], 6)
        cols = np.repeat(on, 6)
        A = S.A[rows][:, cols]
        L = (A @ A.T).tocsc()
        z = spla.spsolve(L, f[rows])
        J = np.zeros((S.m, 6)); J[on] = (S.Wd[cols][:, cols] @ (A.T @ z)).reshape(-1, 6)
        zf = np.zeros(len(f)); zf[rows] = z
        return J, zf, on, keep

    def wouldbe(self, z, bonds):
        """Forces the given (removed) bonds would carry under displacement z."""
        S = self.S
        cols = np.zeros(6 * S.m, bool)
        for b in bonds: cols[6 * b:6 * b + 6] = True
        A = S.A[:, cols]
        J = np.zeros((S.m, 6)); J[bonds] = (S.Wd[cols][:, cols] @ (A.T @ z)).reshape(-1, 6)
        return J


# ------------------------------------------------------------------ report
def classify(S, broken, gap):
    c = collections.Counter()
    for b in broken:
        bd = S.s['bonds'][b]; t0, t1 = S.types[bd['node0']], S.types[bd['node1']]
        kind = 'skin' if (t0 in SKIN or t1 in SKIN) else ('roof' if (t0 in ROOF or t1 in ROOF) else 'frame')
        x, z = bd['centroid']['x'], bd['centroid']['z']
        where = 'over' if gap and gap[0] - 0.6 <= x <= gap[1] + 0.6 else 'beyond'
        c[f"{kind}:{'front' if z < -3.0 else 'rest'}:{where}"] += 1
    return c


def summary(S, broken, gap, extra):
    c = classify(S, broken, gap)
    fb = sum(v for k, v in c.items() if k.startswith('frame') and k.endswith('beyond'))
    ffb = c.get('frame:front:beyond', 0)
    return dict(extra, broken=len(broken), frameBeyond=fb, frontFrameBeyond=ffb, regions=dict(sorted(c.items())))


# ------------------------------------------------------------------ modes
def cascade(S, live0, f, rebearing, gap, rounds=60):
    sol = Solver(S); live = live0.copy(); broken = []; solves = 0; contact = np.zeros(S.m, bool)
    for r in range(rounds):
        J, z, on, keep = sol.solve(live & ~contact | (contact & live), f); solves += 1
        fatal, N, V, crush = S.stresses(J)
        over = on & (fatal > 1)
        if rebearing:
            # fastenings fail to contact where it bears (and does not crush or slide)
            conv = over & S.bearing & ~contact & (crush < 1) & (N < 0) & (V <= MU * -N)
            contact |= conv; over &= ~conv
            cbad = on & contact & ((crush >= 1) | (V > MU * np.maximum(-N, 0)) & (N < 0))
            lift = on & contact & (N > 0)
            over |= cbad; live[lift] = False   # lifted contacts leave (not broken)
        if not over.any(): break
        live[over] = False; broken += list(np.nonzero(over)[0])
    return summary(S, broken, gap, {'mode': 'cascade', 'solves': solves, 'rounds': r + 1})


def events_of(S, J, contact):
    """Per bond: an event has happened (bool) and whether it is a lift (a contact pulled)."""
    fatal, N, V, crush = S.stresses(J)
    cbreak = (crush >= 1) | (V + MU * N > 0)
    return np.where(contact, cbreak, fatal >= 1), N


def ramp(S, live0, f0, df, rebearing, gap, max_solves=6000):
    """Load f(lambda) = f0 + lambda df, lambda 0 -> 1, event by event. Each event is the
    earliest crossing on the current topology's linear path; the structure is then solved
    again at that load (a cascade at constant load is a run of events at one lambda)."""
    sol = Solver(S); live = live0.copy(); contact = np.zeros(S.m, bool); lifted = np.zeros(S.m, bool)
    lam = 0.0; broken = []; order = []; solves = 0; t0 = time.time(); lifts = closes = converts = 0; lam_closed = -1.0
    while solves < max_solves:
        Ja, za, on, keep = sol.solve(live & ~lifted, f0 + lam * df); solves += 1
        # A lifted contact recloses when the load has moved on since it lifted (at one load the
        # active set is not iterated: a contact the solve pulls at this lambda stays out).
        if rebearing and lam > lam_closed and (lifted & live).any():
            lb = np.nonzero(lifted & live)[0]
            _, Nw, _, _ = S.stresses(sol.wouldbe(za, lb))
            # the same zero the lift used: a pull of numerical size is no press
            close = lb[Nw[lb] < -1e-6 * max(1.0, np.abs(Nw).max(), np.abs(S.stresses(Ja)[1]).max())]
            lam_closed = lam
            if len(close): lifted[close] = False; closes += len(close); continue
        Jd = sol.solve(live & ~lifted, df)[0] if lam < 1 else np.zeros_like(Ja); solves += lam < 1
        rem = 1.0 - lam
        hit0, _ = events_of(S, Ja, contact)
        hit1, _ = events_of(S, Ja + rem * Jd, contact)
        cand = on & (hit0 | hit1)
        if not cand.any(): break
        lo, hi = np.zeros(S.m), np.full(S.m, rem); hi[hit0] = 0.0
        for _ in range(36):
            mid = 0.5 * (lo + hi); h, _ = events_of(S, Ja + mid[:, None] * Jd, contact)
            hi = np.where(h, mid, hi); lo = np.where(h, lo, mid)
        tc = np.where(cand, hi, np.inf); b = int(np.argmin(tc)); lam = min(1.0, lam + tc[b])
        fatal, N, V, crush = S.stresses(Ja + tc[b] * Jd)
        kind = None
        if contact[b]:
            if N[b] >= -1e-9 * max(1.0, abs(N).max()): lifted[b] = True; lifts += 1
            else: kind = 'slid' if crush[b] < 1 else 'crushed'
        elif rebearing and S.bearing[b] and crush[b] < 1:
            contact[b] = True; converts += 1
            if N[b] >= 0: lifted[b] = True; lifts += 1
            elif V[b] + MU * N[b] > 0: kind = 'slid'
        else: kind = 'fatal'
        if kind: live[b] = False; broken.append(b); order.append((lam, b, kind))
    keep = sol.anchored(live & ~lifted)
    bd = S.s['bonds']
    fell = int(sum(1 for b in range(S.m) if live[b] and not lifted[b] and not (keep[bd[b]['node0']] and keep[bd[b]['node1']])))
    name = lambda b: S.types[bd[b]['node0']] + '|' + S.types[bd[b]['node1']]
    return summary(S, broken, gap, {'mode': 'ramp', 'solves': solves, 'events': len(order) + lifts + closes + converts, 'breaks': len(order),
                                    'converted': converts, 'lifts': lifts, 'closes': closes, 'lambda': round(lam, 4), 'bondsOnFallenPieces': fell,
                                    'seconds': round(time.time() - t0, 1),
                                    'order': [(round(l, 4), name(b), round(bd[b]['centroid']['x'], 2), round(bd[b]['centroid']['z'], 2), k) for l, b, k in order[:40]]})


def inertia(S):
    """Per chunk principal moments (kg m^2) from its collider's box (a hull's AABB)."""
    out = np.zeros((S.n, 3))
    for i, c in enumerate(S.s['nodeColliders']):
        if c['kind'] == 'shape': c = S.s['shapeLibrary'][c['shape']]
        if c['kind'] == 'cuboid': h = np.array([c['halfExtents'][q] for q in 'xyz'])
        else:
            pts = np.array(c.get('points', [0.05] * 3)).reshape(-1, 3); h = (pts.max(0) - pts.min(0)) / 2
        m = S.mass[i]; out[i] = m / 3 * np.array([h[1] ** 2 + h[2] ** 2, h[0] ** 2 + h[2] ** 2, h[0] ** 2 + h[1] ** 2])
    return np.maximum(out, 1e-9)


def dynamic(S, live0, J0, g, removed, rebearing, gap, T=0.4, safety=0.8):
    """Explicit dynamics from the intact equilibrium with the case's members gone at t = 0
    (undamped: symplectic Euler conserves energy but for what breaks and slips release)."""
    nf = int(S.free.sum()); fr = np.nonzero(S.free)[0]
    Minv = np.zeros(6 * nf); I = inertia(S)
    for k, i in enumerate(fr):
        Minv[6 * k:6 * k + 3] = 1 / S.mass[i]; Minv[6 * k + 3:6 * k + 6] = 1 / I[i]
    for i in removed:
        if S.row[i] >= 0: Minv[6 * S.row[i]:6 * S.row[i] + 6] = 0   # gone: they take no part
    R2 = np.einsum('bij,bjk->bik', S.R, S.R)
    Bt = S.B.T.tocsr()
    alive = live0.copy()
    def kmul(D):   # bond force rate from deformation rate (m x 6 -> m x 6)
        out = np.empty_like(D); out[:, :3] = S.k[:, None] * D[:, :3]; out[:, 3:] = S.k[:, None] * np.einsum('bij,bj->bi', R2, D[:, 3:]); return out
    # the largest frequency (power iteration on M^-1 B K B^T)
    x = np.random.default_rng(1).standard_normal(6 * nf) * (Minv > 0); lam_ = 0
    for _ in range(120):
        D = (Bt @ x).reshape(-1, 6) * alive[:, None]; y = Minv * (S.B @ kmul(D).reshape(-1))
        lam_ = np.linalg.norm(y) / max(np.linalg.norm(x), 1e-30); x = y / max(np.linalg.norm(y), 1e-30)
    wmax = np.sqrt(lam_ * 1.05); dt = safety * 2 / wmax
    steps = int(np.ceil(T / dt))
    print(f'dynamic: omega_max {wmax:.3g} rad/s, dt {dt * 1e6:.2f} us, {steps} substeps for {T} s')
    J = J0.copy(); J[~alive] = 0; v = np.zeros(6 * nf); u = np.zeros(6 * nf)
    Kinv_lin = 1 / S.k; R2inv = np.linalg.pinv(R2)
    def strain(Jc, mask):   # sum 1/2 J K^-1 J over live bonds
        a = (Jc[:, :3] ** 2).sum(1) * Kinv_lin; b = np.einsum('bi,bij,bj->b', Jc[:, 3:], R2inv, Jc[:, 3:]) * Kinv_lin
        return 0.5 * float(((a + b) * mask).sum())
    gy = g.copy()
    E0 = strain(J, alive); dissipated = 0.0; worstGain = 0.0
    contact = np.zeros(S.m, bool); broken = []; order = []; t0 = time.time(); Ptx = None
    dpos = np.where(S.d0 > 0, np.minimum(S.d0, np.where(S.d1 > 0, S.d1, S.d0)), np.sqrt(S.area) / 2)
    rp = np.linalg.norm(S.R, axis=(1, 2)) / np.sqrt(3)
    peakKE = 0.0
    for step in range(steps):
        P = J * alive[:, None]
        if contact.any():
            n = S.normal; lin = P[:, :3]; ln = (lin * n).sum(1); Nn = -ln   # + tension
            C = np.maximum(-Nn, 0)
            closed = contact & (Nn < 0)
            tang = lin - ln[:, None] * n; tv = np.linalg.norm(tang, axis=1)
            sc = np.where(tv > MU * C, MU * C / np.maximum(tv, 1e-30), 1.0)
            ang = P[:, 3:]; an = (ang * n).sum(1); bendv = ang - an[:, None] * n; bm = np.linalg.norm(bendv, axis=1)
            bsc = np.where(bm > C * dpos, C * dpos / np.maximum(bm, 1e-30), 1.0)
            tsc = np.where(np.abs(an) > MU * C * rp, MU * C * rp / np.maximum(np.abs(an), 1e-30), 1.0)
            Pc = np.concatenate([ln[:, None] * n + sc[:, None] * tang, bsc[:, None] * bendv + (tsc * an)[:, None] * n], 1)
            Pc[~closed] = 0
            P = np.where(contact[:, None], Pc, P)
            Ptx = P
            # slip is permanent: the stored tangential force follows the cap
            J[contact, :3] = np.where(closed[contact, None], ln[contact, None] * n[contact] + sc[contact, None] * tang[contact], J[contact, :3])
        acc = Minv * (S.B @ P.reshape(-1) - g)
        v += dt * acc; u += dt * v
        D = (Bt @ v).reshape(-1, 6)
        J -= dt * kmul(D) * alive[:, None]
        if step % 4 == 0 or step == steps - 1:
            fatal, N, V, crush = S.stresses(J * alive[:, None])
            hit = alive & ~contact & (fatal >= 1)
            if rebearing:
                conv = hit & S.bearing & (crush < 1); contact |= conv; hit &= ~conv
                hit |= alive & contact & (crush >= 1)
            if hit.any():
                for b in np.nonzero(hit)[0]: order.append((step * dt, int(b)))
                # A brittle break releases its strain energy: a bond's, or a contact's at the force it transmits.
                dissipated += strain(J, hit & ~contact) + (strain(Ptx, hit & contact) if contact.any() else 0.0)
                alive[hit] = False; broken += list(np.nonzero(hit)[0]); J[hit] = 0
            if step % 400 == 0 or step == steps - 1:
                ke = 0.5 * np.sum(v * v / np.where(Minv > 0, Minv, np.inf)); peakKE = max(peakKE, ke)
                # E = KE + strain - work of the dead load (u . -g): with no damping it can only fall
                # (brittle breaks, contact slip). Slip work is not tallied, so the check is E <= E0.
                E = ke + strain(J, alive & ~contact) + (strain(Ptx, alive & contact) if contact.any() else 0.0) - float(u @ -gy)
                worstGain = max(worstGain, (E + dissipated - E0))
    bd = S.s['bonds']; name = lambda b: S.types[bd[b]['node0']] + '|' + S.types[bd[b]['node1']]
    return summary(S, broken, gap, {'mode': 'dynamic', 'substeps': steps, 'dtMicroseconds': round(dt * 1e6, 3), 'simulated': T,
                                    'contacts': int(contact.sum()), 'seconds': round(time.time() - t0, 1), 'peakKineticJ': round(peakKE, 2),
                                    'energyStartJ': round(E0, 2), 'releasedByBreaksJ': round(dissipated, 2), 'worstEnergyGainJ': round(worstGain, 3),
                                    'order': [(round(t * 1e3, 2), name(b), round(bd[b]['centroid']['x'], 2), round(bd[b]['centroid']['z'], 2)) for t, b in order[:40]]})


# ------------------------------------------------------------------ the engine's law (C10)
# Joint damping (--law stage): a dashpot on each joint at its own frequency,
# c_q = 2 zeta sqrt(k_q m_q), m_q = 1 / W_qq (W = B^T M^-1 B over the joint's two
# chunks), zeta the material's damping ratio: 0.015 for timber with mechanical
# joints (EN 1995-2:2004 6.4(2)). The house is timber framed; its veneer ties and
# board screws are mechanical joints too.
ZETA_TIMBER_MECHANICAL = 0.015
BAND = 2e-3   # a joint is at capacity at utilisation >= 1 - band (the explicit step's capacityBand, the oracle's)


def lowest_omega(S, Minv, bonds, nodes_mask=None):
    """The lowest natural frequency (rad/s) of the structure held by `bonds` (shift-invert
    Lanczos on K = B diag(k) B^T against M over the free dofs that some bond reaches)."""
    R2 = np.einsum('bij,bjk->bik', S.R, S.R)
    kd = np.zeros((S.m, 6, 6)); kd[:, :3, :3] = np.eye(3) * S.k[:, None, None]; kd[:, 3:, 3:] = R2 * S.k[:, None, None]; kd[~bonds] = 0
    K = (S.B @ sp.block_diag(list(kd), format='csr') @ S.B.T).tocsc()
    dof = (Minv > 0) & (np.asarray(abs(S.B[:, np.repeat(bonds, 6)]).sum(1)).ravel() > 0)
    if nodes_mask is not None: dof &= np.repeat(nodes_mask, 6)
    if dof.sum() < 8: return np.inf
    try:
        ev = spla.eigsh(K[dof][:, dof], k=1, M=sp.diags(1 / Minv[dof]), sigma=0, which='LM', return_eigenvectors=False)
        return float(np.sqrt(abs(ev[0])))
    except Exception:
        return np.inf


def dynamic_seq(S, live0, J0, g, removed, gap, T=0.4, safety=0.8, zeta=ZETA_TIMBER_MECHANICAL, slide='seat',
                handback=False, rebearing=True, tick=1 / 60, dt_scale=1.0, damping='stiffness'):
    """The candidate engine law for C10: explicit dynamics as dynamic(), with
      - re-bearing contacts graded as the stage grades them (PxgDestructionRebearing.cuh):
        compression to the bearing capacity (crushing breaks), shear V + twist by friction
        (mu C on the stage's shear measure, the slip permanent), rocking capped where the
        fasteners' tension line T = |M0|/d0 + |M1|/d1 - C reaches zero (the contact turns
        about its edge: nothing stored);
      - slide 'seat': a contact is lost (breaks) when its accumulated slip leaves the bearing
        patch: the patch is the faces' overlap, of half-widths d1 along e1 and d0 along e2
        (the reaches its rocking line uses), and two such rectangles translated by s overlap
        iff |s.e1| < 2 d1 and |s.e2| < 2 d0, so the seat is lost at a slip of the patch's full
        width along it ('permanent': never; 'break': at the first slip, the static law);
      - damping 'stiffness' (the default, C10 (ii)): Rayleigh's stiffness-proportional damping,
        c = beta k on every live joint (not on contacts), beta = 2 zeta / omega_K (Chopra, Dynamics
        of Structures, 11.4), omega_K^2 = (K v)^T M^-1 (K v) / v^T K v the frequency of the
        deformation the island has (mechanisms, K v = 0, drop out): zeta (EN 1995-2:2004 6.4(2),
        a modal ratio) on that motion, more above; integrated implicitly per joint, F = -c d /
        (1 + h c W), W its split inverse mass (Jacobi), so h is unchanged. A/B: 'modal', mass-
        proportional at omega_R (it damps mechanisms: sliding and hanging pieces); 'joint',
        dashpots at each joint's own frequency (zeta omega_i / omega_j on the ringing modes);
      - the freeze (C10 (B)): the island is settled at the first tick when it has had no
        activity (a break, a bearing joint's fastenings failing, a seat lost, a contact
        crushed, slipping, opening or closing) for a full period of its slowest motion: the
        longest 2 pi / omega_R since that activity, omega_R^2 = v^T K v / v^T M v the Rayleigh
        quotient of its anchored part's velocity field. Every joint is then below capacity
        and no contact slides. The engine then holds its forces (carried: plus the static
        solve's elastic increment) until an event or a topology change thaws it.
        handback=True stops there; False records the freeze and runs on (the long reference:
        breaksAfterFreeze are the breaks the freeze would have missed).
    The books: E = KE + strain + the dead load's potential (KE = v_n . M v_n+1 / 2, the discrete
    energy's pairing); dissipated = what the breaks released + slip work + the dashpots' discrete
    work (their force on the next substep's rates); E + dissipated never exceeds E0 but by round-off."""
    nf = int(S.free.sum()); fr = np.nonzero(S.free)[0]
    Minv = np.zeros(6 * nf); I = inertia(S)
    for k, i in enumerate(fr):
        Minv[6 * k:6 * k + 3] = 1 / S.mass[i]; Minv[6 * k + 3:6 * k + 6] = 1 / I[i]
    for i in removed:
        if S.row[i] >= 0: Minv[6 * S.row[i]:6 * S.row[i] + 6] = 0
    R2 = np.einsum('bij,bjk->bik', S.R, S.R); R2inv = np.linalg.pinv(R2)
    Bt = S.B.T.tocsr(); alive = live0.copy(); sol = Solver(S); bd = S.s['bonds']
    def kmul(D):
        out = np.empty_like(D); out[:, :3] = S.k[:, None] * D[:, :3]; out[:, 3:] = S.k[:, None] * np.einsum('bij,bj->bi', R2, D[:, 3:]); return out
    def strainv(Jc):
        return 0.5 * ((Jc[:, :3] ** 2).sum(1) + np.einsum('bi,bij,bj->b', Jc[:, 3:], R2inv, Jc[:, 3:])) / S.k
    def contactv(Pc, Jc):
        # A contact's stored energy: its force's, but a rocking one's moments capped at P while
        # it turns on to J: P^T K^-1 (J - P / 2) (the elastic-plastic path without permanent set).
        return (0.5 * (Pc[:, :3] ** 2).sum(1) + np.einsum('bi,bij,bj->b', Pc[:, 3:], R2inv, Jc[:, 3:] - 0.5 * Pc[:, 3:])) / S.k
    kq = np.zeros((S.m, 6)); kq[:, :3] = S.k[:, None]; kq[:, 3:] = S.k[:, None] * np.einsum('bii->bi', R2)
    Wq = np.asarray(S.B.multiply(S.B).T @ Minv).reshape(-1, 6)
    zj = zeta if damping == 'joint' else 0.0
    c = np.where(Wq > 0, 2 * zj * np.sqrt(kq / np.where(Wq > 0, Wq, 1)), 0.0)
    x = np.random.default_rng(1).standard_normal(6 * nf) * (Minv > 0)
    for _ in range(120):
        D = (Bt @ x).reshape(-1, 6) * alive[:, None]; y = Minv * (S.B @ kmul(D).reshape(-1))
        lam_ = np.linalg.norm(y) / max(np.linalg.norm(x), 1e-30); x = y / max(np.linalg.norm(y), 1e-30)
    wmax = np.sqrt(lam_ * 1.05); dt = safety * 2 * (np.sqrt(1 + zj * zj) - zj) / wmax
    dt *= dt_scale * float(os.environ.get('SEQ_DT_SCALE', '1'))   # (the reference's own sensitivity to its substep: export's ensemble)
    steps = int(np.ceil(T / dt)); per_tick = max(1, int(round(tick / dt)))
    print(f'dynamic (stage law): omega_max {wmax:.3g} rad/s, zeta {zeta}, dt {dt * 1e6:.2f} us, {steps} substeps for {T} s, slide {slide}')
    J = J0.copy(); J[~alive] = 0; v = np.zeros(6 * nf); u = np.zeros(6 * nf)
    contact = np.zeros(S.m, bool); slip = np.zeros((S.m, 3)); n = S.normal
    gam = np.where(S.hasSec, S.area / np.where(S.Zt > 0, S.Zt, 1), 3 * np.sqrt(2) / np.sqrt(np.maximum(S.area, 1e-12)))
    ktw = S.k * np.einsum('bi,bij,bj->b', n, R2, n)
    d0 = np.where(S.d0 > 0, S.d0, np.sqrt(S.area) / 2); d1 = np.where(S.d1 > 0, S.d1, np.sqrt(S.area) / 2)
    E0 = float(strainv(J)[alive].sum()); released = slipWork = dashWork = 0.0; worstGain = 0.0
    broken = []; order = []; kinds = collections.Counter(); t0 = time.time()
    lastEvent = 0.0; omega1 = None; handbackAt = None; checks = []
    # The freeze (C10 (B)): the island's motion since its last activity -- an event, a contact
    # slipping, opening or closing -- has lasted a full period of its slowest motion, 2 pi /
    # omega_R, omega_R^2 = v^T K v / v^T M v over its anchored part (the Rayleigh quotient of the
    # velocity field it actually has: Rayleigh 1877), the longest since that activity; every
    # joint is then below capacity and no contact slides (else there was activity).
    activity = {'slip': False}; closedNow = np.zeros(S.m, bool); closedPrev = np.zeros(S.m, bool); stuckNow = np.zeros(S.m, bool)
    Tnode = np.zeros(S.n)   # (iii): per chunk, the longest period of its component's motion since the last activity
    from scipy.sparse.csgraph import connected_components
    b0 = np.array([bd[b]['node0'] for b in range(S.m)]); b1 = np.array([bd[b]['node1'] for b in range(S.m)])
    Ifull = I
    lastActive = 0.0; periodMax = 0.0; freezeAt = None; Fd_prev = np.zeros_like(J); resample = False
    # Modal damping (damping 'modal', C10 (i)): mass-proportional on the anchored structure's
    # velocity, alpha = 2 zeta omega_R, omega_R^2 = v^T K v / v^T M v its velocity field's
    # Rayleigh quotient now: zeta on the motion it has (EN 1995-2:2004 6.4(2) is a modal ratio),
    # more below. Applied every KD substeps as the exact decay exp(-alpha KD h) (alpha KD h about
    # 1e-2: the splitting's error is of its square). Pieces broken free are not damped (they
    # leave the stage's islands at the tick's end); its work is booked (dashWork).
    KD = 32
    # (ii) beta = 2 zeta / omega_K, sampled at the end of every KD-th substep and of a substep with an
    # event, used from the next (as the kernel: none before the first sample); W the joints' split
    # inverse mass at the start (each end's 1/m times its live joints: Jacobi, Tonge et al. 2012).
    beta = 0.0
    deg = np.zeros(S.n); np.add.at(deg, b0[alive], 1); np.add.at(deg, b1[alive], 1)
    degr = np.repeat(np.maximum(deg[fr], 1), 6)
    Wsplit = np.asarray(S.B.multiply(S.B).T @ (Minv * degr)).reshape(-1, 6)
    local_free = -np.ones(S.n, int); local_free[fr] = np.arange(nf)
    # The joints' forces on the nodes for the next substep (the kernel's wr): a bond's J and its
    # dashpot, a contact's projection P; and P alone (the contacts' transmitted force, for the books).
    Ptot = J * alive[:, None]; P = np.zeros_like(J)
    def project(cm):
        """Contacts cm: the trial J projected on the contact set; the slip is permanent (J follows it)."""
        nonlocal slipWork
        Pc = np.zeros((int(cm.sum()), 6)); idx = np.nonzero(cm)[0]
        if not len(idx): return Pc, idx
        Jc = J[idx]; nn_ = n[idx]; lin = Jc[:, :3]; ln = (lin * nn_).sum(1); C = np.maximum(ln, 0); closed = ln > 0
        tang = lin - ln[:, None] * nn_; V = np.linalg.norm(tang, axis=1)
        ang = Jc[:, 3:]; an = (ang * nn_).sum(1); m0 = (ang * S.e1[idx]).sum(1); m1 = (ang * S.e2[idx]).sum(1)
        s_ = V + gam[idx] * np.abs(an); sc = np.where(s_ > MU * C, MU * C / np.maximum(s_, 1e-30), 1.0)
        rock = np.abs(m0) / d0[idx] + np.abs(m1) / d1[idx]; bsc = np.where(rock > C, C / np.maximum(rock, 1e-30), 1.0)
        sl = closed & (sc < 1)
        if sl.any():
            # The radial return's plastic part: the slip (m) and its work (J) at the capped force.
            dsl = (1 - sc)[:, None] * tang / S.k[idx, None]; slip[idx[sl]] += dsl[sl]
            slipWork += float(((sc * V) * np.linalg.norm(dsl, axis=1))[sl].sum() + ((sc * np.abs(an)) * (1 - sc) * np.abs(an) / np.maximum(ktw[idx], 1e-30))[sl].sum())
            J[idx[sl], :3] = (ln[:, None] * nn_ + sc[:, None] * tang)[sl]
            J[idx[sl], 3:] -= ((1 - sc) * an)[sl, None] * nn_[sl]
        Pc[:, :3] = ln[:, None] * nn_ + sc[:, None] * tang
        Pc[:, 3:] = (bsc * m0)[:, None] * S.e1[idx] + (bsc * m1)[:, None] * S.e2[idx] + (sc * an)[:, None] * nn_
        Pc[~closed] = 0
        activity['slip'] = bool(sl.any()); closedNow[:] = False; closedNow[idx] = closed
        stuckNow[:] = False; stuckNow[idx] = closed & (sc >= 1) & (bsc >= 1)
        if sl.any(): activity['who'] = [(int(b), float(f'{q:.3g}')) for b, q in zip(idx[sl][:4], (s_ / np.maximum(MU * C, 1e-30))[sl][:4])]
        return Pc, idx
    for step in range(steps):
        t = (step + 1) * dt
        acc = Minv * (S.B @ Ptot.reshape(-1) - g)
        vOld = v.copy() if (step + 1) % per_tick == 0 or step == steps - 1 else None
        v += dt * acc; u += dt * v
        D = (Bt @ v).reshape(-1, 6); J -= dt * kmul(D) * alive[:, None]
        # The dashpots' work over this substep: their force (from the last substep's rates) on
        # this substep's rates (the exact discrete work: power F . B^T v over dt).
        dashWork += dt * float(-(Fd_prev * D).sum())
        # Bonds: graded on the whole force (spring and dashpot), at capacity within the band.
        damped = alive & ~contact
        if damping == 'stiffness' and zeta > 0:
            cq = beta * kq
            Fd = -(cq / (1 + dt * cq * Wsplit) * D) * damped[:, None]
        else:
            Fd = -(c * D) * damped[:, None]
        tot = (J + Fd) * damped[:, None]
        # Graded on the spring's force: Rayleigh's stiffness-proportional damping stands for the joints'
        # energy loss, not a stress they carry (its implicit dashpot is near rigid on the stiffest
        # joints' kHz rates: graded, its force broke 77 joints / 17 frame beyond against 45 / 3 in
        # truck-door's first second). The joint-local dashpot (A/B) is graded with its force.
        fatal, N, Vv, crush = S.stresses(J * damped[:, None] if damping == 'stiffness' else tot)
        hit = damped & (fatal >= 1 - BAND)
        conv = hit & S.bearing & (crush < 1 - BAND) if rebearing else np.zeros(S.m, bool)
        hit &= ~conv; contact |= conv
        # Contacts (and the joints whose fastenings just failed): the projection, crushing on it, the seat.
        P[:] = 0; Pc, idx = project(alive & contact); P[idx] = Pc
        crushed = np.zeros(S.m, bool); crushed[idx] = S.stresses(P)[3][idx] >= 1 - BAND
        off = np.zeros(S.m, bool)
        if slide == 'seat': off = alive & contact & ((np.abs((slip * S.e1).sum(1)) >= 2 * d1) | (np.abs((slip * S.e2).sum(1)) >= 2 * d0))
        elif slide == 'break' and len(idx): off[idx] = (np.linalg.norm(slip[idx], axis=1) > 0)
        gone = hit | crushed | off
        flips = (closedNow != closedPrev) & contact & alive
        if activity['slip'] or bool(flips.any()):
            lastActive = t; periodMax = 0.0; Tnode[:] = 0.0
            if os.environ.get('SEQ_ACTIVITY') and (step + 1) % per_tick == 0:
                w_ = activity.get('who') or []
                print(f"  activity at {t * 1e3:.0f} ms: slip {activity['slip']} ({w_}), flips {[int(b) for b in np.nonzero(flips)[0][:6]]}; slip so far {[(int(b), float(f'{np.linalg.norm(slip[b]) * 1e6:.4g}')) for b, _ in w_]} um, seat {[float(f'{2 * min(d0[b], d1[b]) * 1e3:.3g}') for b, _ in w_]} mm")
        closedPrev[:] = closedNow
        if conv.any() or gone.any():
            lastEvent = t; omega1 = None; lastActive = t; periodMax = 0.0
            kinds['fastenings'] += int(conv.sum())
        if gone.any():
            released += float(strainv(J)[gone & ~contact].sum() + contactv(P, J)[gone & contact].sum())
            for b in np.nonzero(gone)[0]:
                k = 'fatal' if hit[b] else ('crushed' if crushed[b] else 'seat'); kinds[k] += 1; order.append((t, int(b), k))
            alive[gone] = False; broken += list(np.nonzero(gone)[0]); J[gone] = 0; P[gone] = 0
        Ptot = np.where(contact[:, None], P, tot) * alive[:, None]
        Fd_prev = np.where(contact[:, None], 0.0, Fd) * alive[:, None]
        if damping == 'stiffness' and zeta > 0 and (step % KD == 0 or resample):
            # omega_K^2 = (K v)^T M^-1 (K v) / v^T K v over the live joints and closed contacts at this
            # substep's rates (mechanisms have K v = 0: they drop out).
            Dk = D * (alive & (~contact | closedNow))[:, None]; kd = kmul(Dk)
            Kv = S.B @ kd.reshape(-1); den = float((Dk * kd).sum()); num = float(np.sum(Kv * Kv * Minv))
            if den > 0 and num > 0: beta = 2 * zeta / np.sqrt(num / den)
        resample = bool(conv.any() or gone.any())
        if damping == 'component' and zeta > 0 and (step + 1) % KD == 0:
            # (iii) Each rigidly connected component (live bonds and stuck closed contacts; open,
            # sliding or rocking contacts part them) damped on its internal velocity -- less its
            # rigid motion, the anchored one's relative to the frame -- at alpha = 2 zeta omega_s,
            # omega_s = 2 pi / T_s, T_s the longest period of its motion since the last activity.
            edge = alive & (~contact | stuckNow)
            u0 = local_free[b0[edge]]; u1 = local_free[b1[edge]]
            both = (u0 >= 0) & (u1 >= 0)
            G = sp.coo_matrix((np.ones(both.sum()), (u0[both], u1[both])), shape=(nf, nf))
            ncomp, lab = connected_components(G, directed=False)
            anc = np.zeros(ncomp, bool); one = (u0 >= 0) ^ (u1 >= 0); anc[lab[np.where(u0 >= 0, u0, u1)[one]]] = True
            for cpt in range(ncomp):
                nodes_ = np.nonzero(lab == cpt)[0]
                if len(nodes_) < 2 and not anc[cpt]: continue
                rows = (6 * nodes_[:, None] + np.arange(6)).ravel()
                m_ = 1 / Minv[6 * nodes_]; vv = v.reshape(-1, 6)[nodes_]
                if not anc[cpt]:
                    pos_ = S.pos[fr[nodes_]]; M_ = m_.sum(); com = (m_[:, None] * pos_).sum(0) / M_; r_ = pos_ - com
                    V = (m_[:, None] * vv[:, :3]).sum(0) / M_
                    Ii = np.array([np.diag(1 / Minv[6 * k + 3:6 * k + 6]) for k in nodes_])
                    L = (np.cross(r_, m_[:, None] * vv[:, :3]) + np.einsum('kij,kj->ki', Ii, vv[:, 3:])).sum(0)
                    It = Ii.sum(0) + np.einsum('k,kij->ij', m_, (r_ * r_).sum(1)[:, None, None] * np.eye(3) - np.einsum('ki,kj->kij', r_, r_))
                    Om = np.linalg.solve(It, L)
                    rig = np.concatenate([V + np.cross(Om, r_), np.repeat(Om[None], len(nodes_), 0)], 1)
                else: rig = np.zeros_like(vv)
                vi = vv - rig; vfull = np.zeros(6 * nf); vfull[rows] = vi.ravel()
                Dc = (Bt @ vfull).reshape(-1, 6) * edge[:, None]
                den = float(np.sum(vi.ravel() ** 2 / Minv[rows])); num = float((Dc * kmul(Dc)).sum())
                if not (den > 0 and num > 0): continue
                Tn = 2 * np.pi / np.sqrt(num / den); Ts = max(Tn, float(Tnode[fr[nodes_]].max())); Tnode[fr[nodes_]] = Ts
                f = np.exp(-2 * zeta * (2 * np.pi / Ts) * KD * dt)
                dashWork += 0.5 * (1 - f * f) * den
                v.reshape(-1, 6)[nodes_] = rig + f * vi
        if damping == 'modal' and zeta > 0 and (step + 1) % KD == 0:
            heldD = alive & (~contact | closedNow)
            keepD = sol.anchored(heldD); anD = np.repeat(keepD[S.free], 6)
            Dv = (Bt @ (v * anD)).reshape(-1, 6) * heldD[:, None]
            mvv = v * v / np.where(Minv > 0, Minv, np.inf)
            den = float(np.sum(mvv[anD])); num = float((Dv * kmul(Dv)).sum())
            if den > 0 and num > 0:
                f = np.exp(-2 * zeta * np.sqrt(num / den) * KD * dt)
                dashWork += 0.5 * (1 - f * f) * den
                v[anD] *= f
        if (step + 1) % per_tick == 0 or step == steps - 1:
            # (the kinetic energy as v_n . M v_n+1 / 2: symplectic Euler's discrete energy pairs
            # the velocities either side of the positions)
            ke = 0.5 * float(np.sum(vOld * v / np.where(Minv > 0, Minv, np.inf)))
            if freezeAt is None:
                held = alive & (~contact | closedNow)
                keep = sol.anchored(held); an_ = np.repeat(keep[S.free], 6)
                Dv = (Bt @ (v * an_)).reshape(-1, 6) * held[:, None]
                den = float(np.sum((v * v / np.where(Minv > 0, Minv, np.inf))[an_]))
                num = float((Dv * kmul(Dv)).sum())
                if den > 0 and num > 0: periodMax = max(periodMax, 2 * np.pi / np.sqrt(num / den))
                if os.environ.get('SEQ_RING') and (step + 1) % (per_tick * 15) == 0:
                    print(f"  ring {t:.2f} s: anchored KE {0.5 * den:.4g} J, omega_R {np.sqrt(num / den) if den > 0 and num > 0 else 0:.4g} rad/s, dashpots {dashWork:.4g} J, slip {slipWork:.4g} J")
                if t - lastActive >= max(periodMax, tick):
                    freezeAt = t; print(f'freeze at {t * 1e3:.0f} ms (no activity for {(t - lastActive) * 1e3:.0f} ms >= the slowest motion\'s period {periodMax * 1e3:.0f} ms)')
                    checks.append((round(t, 3), round(periodMax, 3)))
                    if handback: steps = step + 1; break
            E = ke + float(strainv(J)[alive & ~contact].sum() + contactv(P, J)[alive & contact & closedNow].sum()) + float(u @ g)
            worstGain = max(worstGain, E + released + slipWork + dashWork - E0)
    name = lambda b: S.types[bd[b]['node0']] + '|' + S.types[bd[b]['node1']]
    late = [o for o in order if freezeAt is not None and o[0] > freezeAt]
    return summary(S, broken, gap, {'mode': 'dynamic', 'law': 'stage', 'zeta': zeta, 'slide': slide, 'substeps': steps, 'dtMicroseconds': round(dt * 1e6, 3),
                                    'simulated': round(steps * dt, 4), 'seconds': round(time.time() - t0, 1), 'contacts': int(contact.sum()), 'events': dict(kinds),
                                    'energyStartJ': round(E0, 3), 'releasedByBreaksJ': round(released, 3), 'slipWorkJ': round(slipWork, 3), 'dashpotWorkJ': round(dashWork, 3),
                                    'worstEnergyGainJ': worstGain, 'freezeMs': None if freezeAt is None else round(freezeAt * 1e3, 1),
                                    'breaksAfterFreeze': len(late), 'lastActiveMs': round(lastActive * 1e3, 1), 'lastBreakMs': round(order[-1][0] * 1e3, 2) if order else None, 'freezeChecks': checks[-12:],
                                    'order': [(round(t * 1e3, 2), name(b), round(bd[b]['centroid']['x'], 2), round(bd[b]['centroid']['z'], 2), k) for t, b, k in order],
                                    'orderBonds': [(t, b, k) for t, b, k in order]})


ENSEMBLE = (1 + 1e-6, 1 - 1e-6, 1 + 1e-5, 1 - 1e-5, 1 + 1e-4, 1 - 1e-4, 1 + 1e-3, 1 - 1e-3)


def export_dynamic(S, live0, J0, g, removed, prefix, T, zeta=ZETA_TIMBER_MECHANICAL, safety=0.8, ensemble=0):
    """The removal's dynamic problem in the explicit step's terms (PhysX
    tests/dynamic_sequence_replay.cu, 'DSEQ'), and dynamic_seq's answer over T
    (PREFIX.expected: per broken joint its link index and time), for the GPU's
    parity with this reference. The bond frame: n (chunk0 to chunk1), t1 the
    section's first axis (any for a square patch), t2 = n x t1; the joint's force
    x = (-J_lin, J_ang) in it (the kernel's J is the force on chunk0, this
    harness's the force on node1), its stiffness k on forces, k r^2 per axis."""
    import struct
    nf = int(S.free.sum()); fr = np.nonzero(S.free)[0]; I = inertia(S)
    local = -np.ones(S.n, int); keep = [i for i in fr if i not in removed]
    for k, i in enumerate(keep): local[i] = k
    R2 = np.einsum('bij,bjk->bik', S.R, S.R); bd = S.s['bonds']
    links = [b for b in range(S.m) if live0[b] and (local[bd[b]['node0']] >= 0 or local[bd[b]['node1']] >= 0)]
    out = bytearray(b'DSEQ'); u = lambda v: struct.pack('<I', int(v) & 0xffffffff); f = lambda *v: struct.pack(f'<{len(v)}f', *[float(x) for x in v])
    # (the substep the reference takes: dynamic_seq's)
    Minv = np.zeros(6 * nf)
    for k, i in enumerate(fr): Minv[6 * k:6 * k + 3] = 1 / S.mass[i]; Minv[6 * k + 3:6 * k + 6] = 1 / I[i]
    for i in removed:
        if S.row[i] >= 0: Minv[6 * S.row[i]:6 * S.row[i] + 6] = 0
    res = dynamic_seq(S, live0, J0, g, removed, None, T, safety=safety, zeta=zeta)
    out += u(len(keep)) + u(len(links)) + f(T, res['dtMicroseconds'] * 1e-6, BAND, MU)
    for i in keep:
        r = S.row[i]; p = -g[6 * r:6 * r + 6]
        out += f(1 / S.mass[i], *(1 / I[i])) + f(*p)
    for b in links:
        i0, i1 = bd[b]['node0'], bd[b]['node1']; n = S.normal[b]
        if S.hasSec[b]: t1 = S.e1[b] - n * (S.e1[b] @ n); t1 /= np.linalg.norm(t1)
        else:
            e = np.array([1.0, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 1.0, 0]); t1 = np.cross(n, e); t1 /= np.linalg.norm(t1)
        t2 = np.cross(n, t1); cen = np.array([bd[b]['centroid'][q] for q in 'xyz'])
        o0 = cen - S.pos[i0]; o1 = cen - S.pos[i1]
        k = S.k[b]; kq = [k, k, k, k * n @ R2[b] @ n, k * t1 @ R2[b] @ t1, k * t2 @ R2[b] @ t2]
        a = S.area[b]; L = S.lim[b]
        if S.hasSec[b]:
            g0, g1, gt, gb = a / S.S1[b], a / S.S2[b], a / S.Zt[b], a / S.S1[b]
            h0, h1 = (1 / S.d0[b], 1 / S.d1[b]) if S.bearing[b] else (g0, g1)
        else:
            g0 = g1 = h0 = h1 = 0.0; gb = 6 / np.sqrt(a); gt = 3 * np.sqrt(2) / np.sqrt(a)
        J = J0[b]; x = [-J[:3] @ n, -J[:3] @ t1, -J[:3] @ t2, J[3:] @ n, J[3:] @ t1, J[3:] @ t2]
        out += u(local[i0]) + u(local[i1]) + u(4 if S.bearing[b] else 0) + f(*n, *t1, *t2) + f(*o0) + f(*o1) + f(*kq)
        out += f(L[1] * a, L[3] * a, L[5] * a, gb, gt, g0, g1, h0, h1) + f(zeta) + f(*x)
    open(prefix + '.bin', 'wb').write(bytes(out))
    index = {b: l for l, b in enumerate(links)}
    with open(prefix + '.expected', 'w') as fh:
        fh.write(f"{len(res['orderBonds'])}\n")
        for t, b, kind in res['orderBonds']: fh.write(f"{index[b]} {t * 1e3:.4f} {kind}\n")
    # The reference's own spread (PREFIX.ensemble): the same run at substeps perturbed by
    # 1e-6 .. 1e-3 relative (the sequence is chaotic past its first breaks: a parity gate
    # holds the GPU's FP32 run to this spread, not to one member). Per member, a line: its
    # substep's scale, broken count, first break (ms), Jaccard against the base run, and its
    # broken links.
    if ensemble:
        base = {index[b] for _, b, _ in res['orderBonds']}
        with open(prefix + '.ensemble', 'w') as fh:
            for sc in ENSEMBLE[:ensemble]:
                r = dynamic_seq(S, live0, J0, g, removed, None, T, safety=safety, zeta=zeta, dt_scale=sc)
                mine = {index[b] for _, b, _ in r['orderBonds']}
                jac = len(base & mine) / max(1, len(base | mine))
                first = min((t for t, _, _ in r['orderBonds']), default=-1e-3) * 1e3
                fh.write(f"{sc:.7f} {len(mine)} {first:.4f} {jac:.4f} " + ' '.join(str(x) for x in sorted(mine)) + "\n")
    res.pop('orderBonds')
    return res


# ------------------------------------------------------------------ set-ups
def match_removed(scene, case, dz, tol=0.005):
    """Nodes of the intact house that the case removed: the intact nodes with no node of the
    same type within tol (m) in the case's house (float32 positions after the case offset)."""
    from scipy.spatial import cKDTree
    s = scene['scenario']
    P = lambda i, d: (s['nodes'][i]['centroid']['x'], s['nodes'][i]['centroid']['y'], s['nodes'][i]['centroid']['z'] - d)
    intact = [i for i, g in enumerate(s['nodeGroups']) if g == 'case@intact']
    other = [i for i, g in enumerate(s['nodeGroups']) if g == f'case@{case}']
    removed = []
    for t in set(s['nodeTypes'][i] for i in intact):
        mine = [k for k, i in enumerate(intact) if s['nodeTypes'][i] == t]
        theirs = [i for i in other if s['nodeTypes'][i] == t]
        if not theirs: removed += mine; continue
        tree = cKDTree([P(i, dz) for i in theirs]); used = set()
        for k in mine:
            hits = [h for h in tree.query_ball_point(P(intact[k], 0), tol) if h not in used]
            if hits: used.add(hits[0])
            else: removed.append(k)
    return removed


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('scene'); p.add_argument('--case', default='truck-door')
    p.add_argument('--mode', choices=['cascade', 'ramp', 'dynamic'], default='ramp')
    p.add_argument('--setup', choices=['removal', 'asbuilt'], default='removal')
    p.add_argument('--rebearing', action='store_true'); p.add_argument('--json')
    p.add_argument('--T', type=float, default=0.4, help='dynamic: seconds simulated')
    p.add_argument('--law', choices=['study', 'stage'], default='study', help="dynamic: the study's contact law (dynamic()) or the engine's candidate (dynamic_seq: stage-graded contacts, seat loss, joint dashpots, hand-back)")
    p.add_argument('--zeta', type=float, default=ZETA_TIMBER_MECHANICAL, help='--law stage: joint damping ratio (0: undamped)')
    p.add_argument('--damping', choices=['stiffness', 'component', 'modal', 'joint'], default='stiffness', help="--law stage: stiffness-proportional at the island's deformation frequency omega_K, implicit per joint (stiffness); A/B: mass-proportional at omega_R (modal), dashpots at each joint's own frequency (joint)")
    p.add_argument('--slide', choices=['seat', 'permanent', 'break'], default='seat', help='--law stage: when a sliding contact is lost')
    p.add_argument('--ensemble', type=int, default=0, help='--export: also run this many perturbed-substep references (PREFIX.ensemble)')
    p.add_argument('--export', help='--law stage: write the problem and the answer for the GPU replay (EXPORT.bin, EXPORT.expected)')
    p.add_argument('--handback', action='store_true', help='--law stage: stop at the freeze (else record it and run on to T)'); p.add_argument('--safety', type=float, default=0.8, help='dynamic: substep as this fraction of 2 / omega_max')
    a = p.parse_args()
    scene = json.load(open(a.scene)); mats = scene['defaults']['solver']['materials']
    dz, gap = CASES[a.case]
    t0 = time.time()
    if a.setup == 'asbuilt':
        S = Structure(subscene(scene, f'case@{a.case}', dz), mats)
        live = np.ones(S.m, bool); f0 = np.zeros_like(S.fg); df = S.fg
        print(f'{a.case} as built: {S.n} chunks, {S.m} bonds ({time.time() - t0:.0f} s to build)')
        if a.mode == 'cascade': out = cascade(S, live, S.fg, a.rebearing, gap)
        elif a.mode == 'ramp': out = ramp(S, live, f0, df, a.rebearing, gap)
        else: raise SystemExit('dynamic needs --setup removal')
    else:
        S = Structure(subscene(scene, 'case@intact', 0), mats)
        removed = set(match_removed(scene, a.case, dz))
        bd = S.s['bonds']
        cut = np.array([b['node0'] in removed or b['node1'] in removed for b in bd])
        print(f'{a.case} by removal from the intact house: {S.n} chunks, {S.m} bonds, {len(removed)} chunks removed '
              f'({", ".join(sorted(set(S.types[i] for i in removed)))}), {int(cut.sum())} bonds cut ({time.time() - t0:.0f} s to build)')
        sol = Solver(S)
        J0, z0, on0, _ = sol.solve(np.ones(S.m, bool), S.fg)
        # The removed chunks' bonds' action on the rest, and their weight gone from the load.
        fR = -(S.B[:, np.repeat(cut, 6)] @ J0[cut].reshape(-1))
        g = S.fg.copy()
        for i in removed:
            if S.row[i] >= 0: g[6 * S.row[i]:6 * S.row[i] + 6] = 0; fR[6 * S.row[i]:6 * S.row[i] + 6] = 0
        live = ~cut
        if a.mode == 'cascade': out = cascade(S, live, g, a.rebearing, gap)
        elif a.mode == 'ramp': out = ramp(S, live, g + fR, -fR, a.rebearing, gap)
        elif a.law == 'stage' and a.export: out = export_dynamic(S, live, J0, g, removed, a.export, a.T, zeta=a.zeta, safety=a.safety, ensemble=a.ensemble)
        elif a.law == 'stage': out = dynamic_seq(S, live, J0, g, removed, gap, a.T, safety=a.safety, zeta=a.zeta, slide=a.slide, handback=a.handback, rebearing=a.rebearing, damping=a.damping)
        else: out = dynamic(S, live, J0, g, removed, a.rebearing, gap, a.T, safety=a.safety)
    out.pop('orderBonds', None)
    out.update(case=a.case, setup=a.setup, rebearing=a.rebearing, wall=round(time.time() - t0, 1))
    print(json.dumps(out, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)))
    if a.json: json.dump(out, open(a.json, "w"), indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))


if __name__ == '__main__':
    main()
