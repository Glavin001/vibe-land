#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""What a hit does to an authored structure under four stress models, on the CPU.

The native stage's trial rigid solve holds an anchored building immovable, so an
impactor is stopped in one tick and the contact carries its whole momentum
(M v / dt: 6.5 MN for the monster truck, 38 MN for the cannonball). The stress
solve then routes that force to the anchors as a static load. This tool runs
one structure through the same hits under four models and reports what breaks:

  A    the engine today: min-norm static bond forces (stress-share.py's solve,
       which matches the GPU at rest to ~0.9x); every bond past its fatal limit
       breaks. Gravity and contact are the only loads.
  C    A plus the native crush model (NvBlastExtStressMaterialFormula.h
       extStressCrushStep, as PxgDestructionMaterial.cuh evaluates it): each
       crushable chunk's Love-Weber virial from its contact and bond forces,
       Drucker-Prager cone with a cap, Perzyna damage; a crushed chunk is
       destroyed with its bonds. Bond verdicts come from the same solve.
  E    inertia and bond capacity. The tick's contact impulse is ramped from 0
       to its full value (event to event, the classical incremental analysis);
       a bond whose demand reaches its capacity (the fatal limits, which are
       the characteristic strengths) fails: a brittle one (mortar, glass, wall
       ties, gypsum screws, timber within a member) breaks; a ductile one
       (nailed and bolted timber joints) yields and carries its capacity on.
       Whatever group of chunks is then no longer held to the anchors moves as
       a rigid body (d'Alembert: its own mass resists the load beyond the
       capacity of the bonds holding it), so nothing past those bonds sees more
       than they can carry. A yielded ductile joint breaks when its slip over
       the tick exceeds its ultimate slip. No ordering or threshold is chosen:
       which bond fails, and when, follows from the forces.
  C+E  both: a crushable chunk's crush is evaluated at every load level too, and
       its comminution energy (Bond's law) is taken from the impactor.

Over the event, tick by tick (1/60 s): the impactor's leading face sweeps the
structure; the first surface in each 0.1 m cell of its cross-section is in
contact; the trial stops it (contact = M v / dt, the engine's infinite-mass
coupling). A contact chunk still held to the anchors after the verdict stops it
in the corrected pass, as the engine does; groups set free in its path are
pushed ahead with it (momentum shared). `--coupled` replaces the trial's
infinite-mass contact for E and C+E with the physically coupled one: the
impulse ramp stops once the struck group and the impactor would move together.
After the event the damaged structure settles under gravity (A's rule).

    uv run structures/town-kit/scripts/impact-study.py PACK --meta META [--scenario NAME ...] [--options A,C,E,C+E] [--json OUT]
"""
import argparse, importlib.util, json, math, pathlib, sys, time
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from scipy.sparse.csgraph import connected_components

G = 9.81
DT = 1.0 / 60.0
TRACE_EVENTS = []  # [aim point] when --trace-events
RAMP, RAMP_LEVELS = 2.0, 9  # contact impulse ramp: 1/256 .. 1 in factors of 2
HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('stress_share', HERE / 'stress-share.py')
share = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(share)

# ---------------------------------------------------------------------------
# Materials for the models (every number with its source)
# ---------------------------------------------------------------------------

# Brittle bond materials: capacity reached means fracture, not flow.
#  mortar: EN 1996-1-1 3.6 -- masonry joints fail in flexural tension / bond
#   shear with no plateau; glazing: glass; wall ties: pulled out of their mortar
#   bed or buckled (Choi & LaFave 2004, J. Struct. Eng. 130(9): corrugated ties
#   lose their load at pull-out); timber within a member: clear wood breaks
#   brittly in tension and bending (Thelandersson & Larsen, Timber Engineering
#   2003, ch. 5). Everything else is a fastener in timber (below).
BRITTLE = {'veneer-mortar-joint', 'mortar-joint', 'glazing-joint', 'wall-tie',
           'stud-timber', 'brick-veneer', 'drywall', 'concrete-roof-tile', 'gable-weatherboard', 'gable-frame',
           'ivory-trim', 'footing', 'particleboard-flooring', 'window-glass'}
# Ductile: dowel-type connections in timber -- nails, bolts, and the screws
# holding gypsum board, whose shear slip is what makes a light-frame wall ductile
# (Folz & Filiatrault 2001, J. Struct. Eng. 127(4), CUREE sheathing-connector
# tests: peak at ~10-15 mm, load held well beyond). Ultimate slip: EN 12512
# classes a joint "high ductility" at D = v_u / v_y >= 6; with v_y = F / K_ser
# (EN 1995-1-1 7.1, 16d nail ~770 N at 719 N/mm: ~1.1 mm) that is ~6.4 mm, and
# nailed and bolted timber joints in test reach their ultimate load at 10-15 mm
# of slip (Ehlbeck & Larsen 1993, STEP lecture C14; Smith et al., Dowel-type
# fasteners). 15 mm here. At impact speeds a yielded joint slips v dt ~ 0.1-0.4
# m in one tick, so the result does not depend on this value; it matters for
# slow loads only.
ULTIMATE_SLIP = 0.015

# Crushable chunk materials (C, C+E). Cone pinned to the material's own
# unconfined compressive strength fc (PhysX blast-stress-solver
# export-reference-building.mjs: cohesion = fc (1 - k/3), k = 1.2, i.e. a
# ~30 degree friction angle; cap at 2.5 fc where confined pore collapse starts).
# fc:
#  brick veneer (a panel of clay brick in mortar): EN 1996-1-1 eq. 3.1,
#   f_k = K f_b^0.7 f_m^0.3 = 0.55 x 20^0.7 x 4^0.3 = 6.8 MPa (Group 1 clay
#   units, normalised strength 20 MPa -- common facing brick, EN 771-1 /
#   AS/NZS 4455 -- in M4 general-purpose mortar, the 1:1:6 of veneer work).
#  gypsum board: core crushing ~3.5 MPa (materials.mjs GYPSUM, EN 520).
# crushEnergy: specific comminution energy by Bond's law, W = 10 Wi (1/sqrt(P80)
#  - 1/sqrt(F80)) kWh/t (sizes in um) with Bond's (1961) work indices: brick to
#  20 mm rubble from 100 mm pieces at Wi 13 kWh/t (fired clay; cement clinker
#  13.5): 0.51 kWh/t = 1.8 kJ/kg x 1900 kg/m3 = 3.5 MJ/m3. Gypsum board to
#  5 mm from its 13 mm thickness at Wi 8.2 (gypsum rock 8.16): 0.44 kWh/t =
#  1.6 kJ/kg x 700 = 1.1 MJ/m3.
# crushViscosity (Perzyna overstress): from the dynamic increase factor of
#  compressive strength, CEB-FIP Model Code 1990 2.1.6.4: DIF = (e'/e's)^(1.026
#  a_s), a_s = 1/(5 + 9 fc/10 MPa), e's = 30e-6 /s. Overstress (DIF-1) fc at
#  30/s over 30/s: masonry (fc 6.8) DIF 3.6 -> 5.9e5 Pa s; gypsum (3.5) DIF
#  5.4 -> 5.1e5 Pa s.
# Not crushable: timber and steel members (they snap or bend; crush pressure
# effectively unreachable), concrete roof tiles and glass (they fail in
# flexure, EN 490 / EN 572 test them so, not by bulk crushing), the slab and
# footings (anchors: never removed).
def crush_props(fc, energy, viscosity, k=1.2):
    return dict(cap=2.5 * fc, cohesion=fc * (1 - k / 3), slope=k, energy=energy, viscosity=viscosity)
CRUSH = {
    'brick-veneer': crush_props(6.8e6, 3.5e6, 5.9e5),
    'drywall': crush_props(3.5e6, 1.1e6, 5.1e5),
}

# Acoustic impedance rho c of the crushable chunk materials, c = sqrt(E / rho):
# brick masonry E = 1000 f_k (EN 1996-1-1 3.7.2) = 6.8 GPa at 1900 kg/m3 ->
# 1890 m/s; gypsum board E 2 GPa (materials.mjs GYPSUM) at 700 -> 1690 m/s.
IMPEDANCE = {'brick-veneer': 1900 * math.sqrt(6.8e9 / 1900), 'drywall': 700 * math.sqrt(2e9 / 700)}

STRUCTURAL = {'foundation', 'stud', 'king-stud', 'jack-stud', 'cripple-stud', 'junction-stud', 'bottom-plate', 'top-plate',
              'header', 'sill-trimmer', 'rim-joist', 'ceiling-joist', 'floor-joist', 'subfloor', 'rafter', 'ridge-board', 'gable-frame'}
ROOF = {'rafter', 'ridge-board', 'ceiling-joist', 'gable-frame'}

# ---------------------------------------------------------------------------
# The structure
# ---------------------------------------------------------------------------

class Structure:
    def __init__(self, path):
        pack, s, mats, pos, mass = share.load(path)
        self.s, self.mats, self.pos, self.mass = s, mats, pos, mass
        n = len(pos); self.n = n
        self.types = s['nodeTypes']
        self.vol = np.array([nd.get('volume', 0.0) for nd in s['nodes']])
        self.nmat = [mats[nd.get('m', 0)]['name'] for nd in s['nodes']]
        # AABBs (local frame; cuboids are axis-aligned about their centroid,
        # hull points are relative to it).
        lo = np.zeros((n, 3)); hi = np.zeros((n, 3))
        for i, c in enumerate(s['nodeColliders']):
            ctr = np.array([s['nodes'][i]['centroid'][k] for k in 'xyz'])
            if c['kind'] == 'shape': c = s['shapeLibrary'][c['shape']]
            if c['kind'] == 'cuboid':
                h = np.array([c['halfExtents'][k] for k in 'xyz']); lo[i] = ctr - h; hi[i] = ctr + h
            else:
                p = np.array(c['points']).reshape(-1, 3); lo[i] = ctr + p.min(0); hi[i] = ctr + p.max(0)
        self.lo, self.hi = lo, hi
        size = hi - lo
        self.inertia = mass[:, None] / 12.0 * np.stack([size[:, 1] ** 2 + size[:, 2] ** 2, size[:, 0] ** 2 + size[:, 2] ** 2, size[:, 0] ** 2 + size[:, 1] ** 2], 1)
        self.free = mass > 0
        b = s['bonds']; m = len(b); self.m = m
        self.b0 = np.array([x['node0'] for x in b]); self.b1 = np.array([x['node1'] for x in b])
        self.bc = np.array([[x['centroid'][k] for k in 'xyz'] for x in b])
        nrm = np.array([[x['normal'][k] for k in 'xyz'] for x in b])
        disp = pos[self.b1] - pos[self.b0]
        self.bn = nrm * np.where((nrm * disp).sum(1) < 0, -1.0, 1.0)[:, None]
        self.ba = np.maximum(np.array([x['area'] for x in b]), 1e-6)
        bm = [mats[x['m']] for x in b]
        self.bmat = [x['name'] for x in bm]
        self.cF = np.array([x['compressionFatal'] for x in bm]); self.tF = np.array([x['tensionFatal'] for x in bm]); self.sF = np.array([x['shearFatal'] for x in bm])
        self.brittle = np.array([x in BRITTLE for x in self.bmat])
        E = np.array([x.get('elasticModulus') or 30e9 for x in bm])
        L = np.maximum(np.linalg.norm(disp, axis=1), 0.05)
        self.w = np.sqrt(E / 30e9 * np.maximum(self.ba, 1e-4) / L)
        offs = np.concatenate([np.linalg.norm(self.bc - pos[q], axis=1)[mass[q] > 0] for q in (self.b0, self.b1)])
        self.Ls = float(offs.mean())
        self.row = -np.ones(n, dtype=int); self.row[self.free] = np.arange(self.free.sum())
        self.nf = int(self.free.sum())
        self.structural_bond = np.array([self.types[i] in STRUCTURAL and self.types[j] in STRUCTURAL for i, j in zip(self.b0, self.b1)])
        self.crush = [CRUSH.get(x) for x in self.nmat]
        self._coo()

    def _coo(self):
        """A's entries for every bond: bond k, row, column offset in k's 6 columns, value."""
        R, C, V, K = [], [], [], []
        for k in range(self.m):
            for node, sign in ((self.b1[k], 1.0), (self.b0[k], -1.0)):
                r = self.row[node]
                if r < 0: continue
                arm = self.bc[k] - self.pos[node]; w = self.w[k]
                for a in range(3):
                    R.append(6 * r + a); C.append(a); V.append(sign * w); K.append(k)
                    R.append(6 * r + 3 + a); C.append(3 + a); V.append(sign * w * self.Ls); K.append(k)
                X = np.array([[0, -arm[2], arm[1]], [arm[2], 0, -arm[0]], [-arm[1], arm[0], 0]])
                for a in range(3):
                    for c in range(3):
                        if X[a, c] != 0: R.append(6 * r + 3 + a); C.append(c); V.append(sign * w * X[a, c]); K.append(k)
        self.cR, self.cC, self.cV, self.cK = map(np.array, (R, C, V, K))


class Solver:
    """Min-norm bond forces on the active graph, with free groups moving rigidly."""
    def __init__(self, st, active, alive):
        self.st, self.active = st, active.copy()
        n, m = st.n, st.m
        # Groups: free nodes joined by active bonds; a group touching an anchor is held.
        a = active & alive[st.b0] & alive[st.b1]
        ff = a & st.free[st.b0] & st.free[st.b1]
        adj = sp.coo_matrix((np.ones(ff.sum()), (st.b0[ff], st.b1[ff])), shape=(n, n))
        self.ncomp, self.label = connected_components(adj, directed=False)
        held = np.zeros(self.ncomp, bool)
        fa = a & (st.free[st.b0] ^ st.free[st.b1])
        held[self.label[np.where(st.free[st.b0[fa]], st.b0[fa], st.b1[fa])]] = True
        self.held = held
        self.alive = alive
        idx = np.nonzero(a)[0]; self.idx = idx
        col = -np.ones(m, dtype=int); col[idx] = np.arange(len(idx))
        sel = col[st.cK] >= 0
        A = sp.csr_matrix((st.cV[sel], (st.cR[sel], 6 * col[st.cK[sel]] + st.cC[sel])), shape=(6 * st.nf, 6 * len(idx)))
        self.A = A
        AAt = (A @ A.T).tocsc()
        d = AAt.diagonal(); eps = max(1e-10 * (d.mean() if len(d) else 1.0), 1e-12)
        self.lu = spla.splu((AAt + sp.identity(AAt.shape[0], format='csc') * eps).tocsc(), permc_spec='COLAMD')

    def rigid(self, F, T):
        """Remove each free group's rigid acceleration from per-node loads (force F, torque T about the node)."""
        st, lab = self.st, self.label
        F = F.copy(); T = T.copy()
        mask = st.free & self.alive & ~self.held[lab]
        if not mask.any(): return F, T, {}
        motion = {}
        for g in np.unique(lab[mask]):
            nodes = np.nonzero(mask & (lab == g))[0]
            m = st.mass[nodes]; M = m.sum(); p = st.pos[nodes]; c = (m[:, None] * p).sum(0) / M; r = p - c
            Ft = F[nodes].sum(0); Tt = (T[nodes] + np.cross(r, F[nodes])).sum(0)
            I = np.diag(st.inertia[nodes].sum(0)) + (m[:, None, None] * ((r * r).sum(1)[:, None, None] * np.eye(3) - r[:, :, None] * r[:, None, :])).sum(0)
            acc = Ft / M; alpha = np.linalg.lstsq(I, Tt, rcond=None)[0]
            F[nodes] -= m[:, None] * (acc + np.cross(alpha, r)); T[nodes] -= st.inertia[nodes] * alpha
            motion[g] = (c, acc, alpha, M)
        return F, T, motion

    def solve(self, F, T):
        """Bond forces (m x 6: linear on node1, angular) for external loads F, T (n x 3)."""
        st = self.st
        F, T, motion = self.rigid(F, T)
        f = np.zeros(6 * st.nf)
        rows = st.row[st.free]
        f[(6 * rows[:, None] + np.arange(3)).ravel()] = -F[st.free].ravel()
        f[(6 * rows[:, None] + 3 + np.arange(3)).ravel()] = -T[st.free].ravel()
        J = np.zeros((st.m, 6))
        if len(self.idx):
            y = self.A.T @ self.lu.solve(f)
            Jy = y.reshape(-1, 6) * st.w[self.idx, None]; Jy[:, 3:] *= st.Ls
            J[self.idx] = Jy
        return J, motion


def utilisation(st, J):
    """Fatal utilisation of every bond (the solver's own formula, fibre bending)."""
    n = st.bn; a = st.ba; lin = J[:, :3]; ang = J[:, 3:]
    ln = (lin * n).sum(1); normal = -ln / a
    shear = np.linalg.norm(lin - ln[:, None] * n, axis=1) / a
    an = (ang * n).sum(1); twist = np.abs(an) / a; bend = np.linalg.norm(ang - an[:, None] * n, axis=1) / a
    gt = np.minimum(4.81 / np.sqrt(a), 3.0); gb = np.minimum(6.0 / np.sqrt(a), 3.0)
    shear = shear + twist * gt; bend = bend * gb
    tension = np.maximum(normal + bend, 0.0); compression = np.maximum(bend - normal, 0.0)
    return np.maximum(np.maximum(compression / st.cF, tension / st.tF), shear / st.sF)


def node_stress(st, J, active, Fc, Xc):
    """Per-node mean stress (Love-Weber virial / V) from bond and contact forces: pressure p, deviator q."""
    vir = np.zeros((st.n, 3, 3))
    lin = J[:, :3] * active[:, None]
    for q, sign in ((st.b1, 1.0), (st.b0, -1.0)):
        r = st.bc - st.pos[q]
        np.add.at(vir, q, sign * r[:, :, None] * lin[:, None, :])
    r = Xc - st.pos
    vir += r[:, :, None] * Fc[:, None, :]
    vir = 0.5 * (vir + vir.transpose(0, 2, 1))
    sig = vir / np.maximum(st.vol, 1e-9)[:, None, None]
    p = -np.trace(sig, axis1=1, axis2=2) / 3
    dev = sig + p[:, None, None] * np.eye(3)
    q = np.sqrt(1.5 * np.maximum((dev * dev).sum((1, 2)), 0))
    return p, q


def crush_excess(st, p, q):
    """Native extStressCrushStep's overstress per node (0 where not crushable or in tension)."""
    out = np.zeros(st.n)
    for i, c in enumerate(st.crush):
        if c is None or not st.free[i] or p[i] <= 0: continue
        out[i] = max(q[i] - (c['cohesion'] + c['slope'] * p[i]), p[i] - c['cap'], 0.0)
    return out


def crush_threshold(st, damage):
    """Overstress at which a node's damage reaches 1 within this tick."""
    t = np.full(st.n, np.inf)
    for i, c in enumerate(st.crush):
        if c is not None and st.free[i]: t[i] = math.sqrt(max(1 - damage[i], 0) * c['viscosity'] * c['energy'] / DT)
    return t

# ---------------------------------------------------------------------------
# Impactors and contact
# ---------------------------------------------------------------------------

class Impactor:
    def __init__(self, name, mass, speed, direction, aim, shape, size, impedance=None, pressure_cap=np.inf):
        self.name, self.M, self.u = name, mass, speed
        # Acoustic impedance rho c (Pa s/m) and the most contact pressure its own
        # structure can deliver (Pa): what the impact-pressure crush reads.
        self.Z, self.pressure_cap = impedance, pressure_cap
        d = np.array(direction, float); self.d = d / np.linalg.norm(d)
        self.aim = np.array(aim, float); self.shape, self.size = shape, size
        up = np.array([0, 1.0, 0]); e1 = np.cross(up, self.d)
        if np.linalg.norm(e1) < 1e-6: e1 = np.array([1.0, 0, 0])
        self.e1 = e1 / np.linalg.norm(e1); self.e2 = np.cross(self.d, self.e1)
        # Cells of the leading face's cross-section, 0.1 m.
        h = 0.1
        if shape == 'disk':
            R = size; g = np.arange(-R + h / 2, R, h); U, V = np.meshgrid(g, g); keep = U ** 2 + V ** 2 <= R * R
        else:
            W, Hlo, Hhi = size
            U, V = np.meshgrid(np.arange(-W / 2 + h / 2, W / 2, h), np.arange(Hlo + h / 2, Hhi, h)); keep = np.ones_like(U, bool)
        self.cells = np.stack([U[keep], V[keep]], 1)

    def contacts(self, st, alive, s_new):
        """First surface per cell within the sweep: {node: (cells, mean contact point)}."""
        corners = np.stack([np.where(np.array([(c >> k) & 1 for k in range(3)])[None, :], st.hi, st.lo) for c in range(8)], 1)
        near = (corners @ self.d).min(1) - self.aim @ self.d
        cu = corners @ self.e1 - self.aim @ self.e1; cv = corners @ self.e2 - self.aim @ self.e2
        ulo, uhi, vlo, vhi = cu.min(1), cu.max(1), cv.min(1), cv.max(1)
        U, V = self.cells[:, 0][:, None], self.cells[:, 1][:, None]
        cover = (U >= ulo) & (U <= uhi) & (V >= vlo) & (V <= vhi) & alive[None, :] & st.free[None, :]
        depth = np.where(cover, near[None, :], np.inf)
        first = depth.argmin(1); fd = depth[np.arange(len(first)), first]
        hit = fd <= s_new
        out = {}
        for c in np.nonzero(hit)[0]:
            out.setdefault(int(first[c]), []).append(c)
        pts = {}
        for node, cells in out.items():
            uv = self.cells[cells].mean(0)
            pts[node] = (len(cells), self.aim + self.d * near[node] + self.e1 * uv[0] + self.e2 * uv[1])
        return pts, near

# ---------------------------------------------------------------------------
# One tick's verdict per model
# ---------------------------------------------------------------------------

def gravity_loads(st):
    F = np.zeros((st.n, 3)); F[:, 1] = -st.mass * G; return F


def contact_loads(st, contacts, total, d):
    """Contact force (N) split over the contact nodes by the cells each covers."""
    Fc = np.zeros((st.n, 3)); Xc = st.pos.copy(); Tc = np.zeros((st.n, 3))
    cells = sum(c for c, _ in contacts.values())
    for node, (c, x) in contacts.items():
        Fc[node] = d * total * c / cells; Xc[node] = x; Tc[node] = np.cross(x - st.pos[node], Fc[node])
    return Fc, Tc, Xc


def verdict_static(st, active, alive, contacts, total, d, damage, crush):
    """A and C: one solve at the full load; every bond past fatal breaks; C crushes."""
    sol = Solver(st, active, alive)
    Fc, Tc, Xc = contact_loads(st, contacts, total, d)
    J, _ = sol.solve(gravity_loads(st) + Fc, Tc)
    a = active & alive[st.b0] & alive[st.b1]
    u = utilisation(st, J)
    broken = a & (u >= 1.0)
    crushed = np.zeros(st.n, bool)
    if crush:
        p, q = node_stress(st, J, a, Fc, Xc)
        ex = crush_excess(st, p, q)
        for i in np.nonzero(ex > 0)[0]:
            c = st.crush[i]; damage[i] += ex[i] ** 2 * DT / (c['viscosity'] * c['energy'])
        crushed = alive & (damage >= 1.0)
    return dict(broken=broken, crushed=crushed, yielded=np.zeros(st.m, bool), solves=1, events=0, delivered=total * DT, lam=1.0)


def verdict_plastic(st, active, alive, contacts, total, d, damage, crush, impactor=None):
    """E (and C+E): one tick as an impact of rigid chunks joined by joints of finite capacity.

    Moreau / Gauss: the post-tick motion minimises kinetic energy over the joint
    and contact impulses admissible for the tick (the dual of maximum plastic
    dissipation), so a joint below its capacity holds its two chunks together,
    a joint at capacity carries exactly its capacity and lets them move apart,
    and whatever its joints cannot carry accelerates a chunk instead of going
    on into the structure (d'Alembert). Capacity is the solver's own stress
    formula against the fatal limits (characteristic strengths), as convex
    cones. Among the impulses with that motion, the elastic one (min-norm, the
    native solve's) is taken -- below capacity everywhere that is today's
    answer exactly; past it, the elastic-perfectly-plastic one (Haar-Karman).
    A brittle joint at capacity fractures and the tick is solved again without
    it; a ductile one breaks when its slip over the tick passes ULTIMATE_SLIP.
    `impactor=(M, u)`: the impactor joins the problem as a body with its
    momentum and a unilateral contact (the coupled contact); otherwise the
    contact is the trial's, M u / dt on the struck chunks."""
    import cvxpy as cp
    active = active.copy(); alive = alive.copy(); contacts = dict(contacts)
    broken = np.zeros(st.m, bool); crushed = np.zeros(st.n, bool); yielded = np.zeros(st.m, bool)
    solves = 0; u_new = None; delivered = 0.0
    S = 1e3  # impulse scale (N s) for conditioning
    # The tick's contact impulse grows from nothing to its full value; brittle
    # joints break in the order their capacity is reached. The ramp is
    # discretised in factors of RAMP (convergence: --ramp).
    levels = [RAMP ** -k for k in range(RAMP_LEVELS - 1, -1, -1)]
    li = 0
    while True:
        lam = levels[li]; final = li == len(levels) - 1
        live = active & alive[st.b0] & alive[st.b1]
        idx = np.nonzero(live)[0]; K = len(idx)
        col = -np.ones(st.m, dtype=int); col[idx] = np.arange(K)
        sel = col[st.cK] >= 0
        wcol = np.where(st.cC < 3, st.w[st.cK], st.w[st.cK] * st.Ls)
        # B: the joint impulses' net force and torque on each free chunk (A without its column weights).
        Bm = sp.csr_matrix((st.cV[sel] / wcol[sel], (st.cR[sel], 6 * col[st.cK[sel]] + st.cC[sel])), shape=(6 * st.nf, 6 * K))
        rows = st.row
        free_alive = st.free & alive
        # Generalised inverse mass: 1/m for force rows, 1/I for torque rows; dead chunks out.
        invm = np.zeros(6 * st.nf)
        fr = rows[st.free]
        invm[(6 * fr[:, None] + np.arange(3)).ravel()] = np.repeat(np.where(free_alive[st.free], 1 / np.maximum(st.mass[st.free], 1e-9), 0.0), 3)
        invm[(6 * fr[:, None] + 3 + np.arange(3)).ravel()] = np.where(np.repeat(free_alive[st.free], 3), 1 / np.maximum(st.inertia[st.free].ravel(), 1e-9), 0.0)
        # Gravity impulse over the tick (and the trial contact when uncoupled).
        p = np.zeros(6 * st.nf)
        p[6 * fr + 1] = -st.mass[st.free] * G * DT
        cn = [k for k in contacts if alive[k]]
        if impactor is None and cn:
            Fc, Tc, _ = contact_loads(st, {k: contacts[k] for k in cn}, total * lam, d)
            for k in cn:
                p[6 * rows[k]:6 * rows[k] + 3] += Fc[k] * DT; p[6 * rows[k] + 3:6 * rows[k] + 6] += Tc[k] * DT
            delivered = total * lam * DT
        p /= S
        Jf = cp.Variable(6 * K)
        cons = []
        n = st.bn[idx]; a_ = st.ba[idx]
        e = np.where(np.abs(n[:, 0:1]) < 0.9, np.array([[1.0, 0, 0]]), np.array([[0, 1.0, 0]]))
        t1 = np.cross(n, e); t1 /= np.linalg.norm(t1, axis=1)[:, None]; t2 = np.cross(n, t1)
        comp = lambda off, v: cp.multiply(v[:, 0], Jf[off + 0::6]) + cp.multiply(v[:, 1], Jf[off + 1::6]) + cp.multiply(v[:, 2], Jf[off + 2::6])
        if K:
            ln, lt1, lt2 = comp(0, n), comp(0, t1), comp(0, t2)
            an, at1, at2 = comp(3, n), comp(3, t1), comp(3, t2)
            gt = np.minimum(4.81 / np.sqrt(a_), 3.0); gb = np.minimum(6.0 / np.sqrt(a_), 3.0)
            cap = lambda x: x * a_ * DT / S   # stress limit -> impulse capacity over the tick
            s1 = cp.Variable(K); s2 = cp.Variable(K)
            cons += [cp.SOC((cap(st.cF[idx]) - ln) / gb, cp.vstack([at1, at2]), axis=0),
                     cp.SOC((cap(st.tF[idx]) + ln) / gb, cp.vstack([at1, at2]), axis=0),
                     cp.SOC(s1, cp.vstack([lt1, lt2]), axis=0), s2 >= an, s2 >= -an, s1 + cp.multiply(gt, s2) <= cap(st.sF[idx])]
        resid = p + (Bm @ Jf if K else 0)
        if impactor is not None and cn:
            M, u = impactor
            u = u * lam
            Cm = np.zeros((6 * st.nf, len(cn)))
            for j, k in enumerate(cn):
                x = contacts[k][1]; Cm[6 * rows[k]:6 * rows[k] + 3, j] = d; Cm[6 * rows[k] + 3:6 * rows[k] + 6, j] = np.cross(x - st.pos[k], d)
            Pc = cp.Variable(len(cn)); cons += [Pc >= 0]
            resid = resid + Cm @ Pc
            imp_mom = (M * u) / S - cp.sum(Pc)
            kinetic = cp.sum(cp.multiply(invm, cp.square(resid))) + cp.square(imp_mom) / M
        else:
            Pc = None
            kinetic = cp.sum(cp.multiply(invm, cp.square(resid)))
        prob = cp.Problem(cp.Minimize(kinetic), cons)
        prob.solve(solver=cp.CLARABEL); solves += 1
        best = prob.value
        # Elastic tie-break among impulses with that motion.
        wv = np.zeros(6 * K)
        if K:
            wv[0::6] = wv[1::6] = wv[2::6] = 1 / st.w[idx] ** 2
            for c in (3, 4, 5): wv[c::6] = 1 / (st.w[idx] * st.Ls) ** 2
            prob2 = cp.Problem(cp.Minimize(cp.sum(cp.multiply(wv / wv.mean(), cp.square(Jf)))), cons + [kinetic <= best * (1 + 1e-4) + 1e-7])
            try:
                prob2.solve(solver=cp.CLARABEL); solves += 1
                if prob2.status not in ('optimal', 'optimal_inaccurate'): prob.solve(solver=cp.CLARABEL)
            except cp.error.SolverError:
                prob.solve(solver=cp.CLARABEL)
        J = np.zeros((st.m, 6))
        if K: J[idx] = (Jf.value * S / DT).reshape(K, 6)
        r = (p + (Bm @ Jf.value if K else 0) + (Cm @ Pc.value if Pc is not None else 0)) * S   # momentum per chunk after the tick
        if Pc is not None:
            delivered = float(Pc.value.sum() * S); u_new = (impactor[0] * u - delivered) / impactor[0]
        util = utilisation(st, J) * live
        at_cap = live & (util >= 1 - 2e-3)
        # Velocity of a point of a chunk after the tick.
        def vel(node, x):
            if not st.free[node] or not alive[node]: return np.zeros(3)
            q = 6 * rows[node]; v = r[q:q + 3] / st.mass[node]; w = r[q + 3:q + 6] / np.maximum(st.inertia[node], 1e-9)
            return v + np.cross(w, x - st.pos[node])
        newly = np.zeros(st.m, bool)
        for k in np.nonzero(at_cap)[0]:
            if st.brittle[k]: newly[k] = True
            else:
                rel = vel(st.b1[k], st.bc[k]) - vel(st.b0[k], st.bc[k])
                yielded[k] = True
                if final and 0.5 * np.linalg.norm(rel) * DT > ULTIMATE_SLIP: newly[k] = True
        new_crush = np.zeros(st.n, bool)
        if crush:
            Fcn = np.zeros((st.n, 3)); Xc = st.pos.copy()
            if cn:
                if Pc is not None:
                    for j, k in enumerate(cn): Fcn[k] = d * Pc.value[j] * S / DT; Xc[k] = contacts[k][1]
                else:
                    Fcn, _, Xc = contact_loads(st, {k: contacts[k] for k in cn}, total, d)
            pr, q = node_stress(st, J, live, Fcn, Xc)
            ex = crush_excess(st, pr, q)
            for i in np.nonzero((ex > 0) & alive)[0]:
                c = st.crush[i]
                if damage[i] + ex[i] ** 2 * DT * lam / (c['viscosity'] * c['energy']) >= 1.0: new_crush[i] = True
        if not newly.any() and not new_crush.any():
            if not final: li += 1; continue
            if crush:   # damage short of crushing carries over
                for i in np.nonzero((ex > 0) & alive)[0]:
                    c = st.crush[i]; damage[i] += ex[i] ** 2 * DT / (c['viscosity'] * c['energy'])
            break
        broken |= newly; active &= ~newly
        crushed |= new_crush; alive &= ~new_crush
        for i in np.nonzero(new_crush)[0]: contacts.pop(int(i), None); damage[i] = 1.0
        if solves > 200: print('  [plastic] 100 rounds', file=sys.stderr); break
    return dict(broken=broken, crushed=crushed, yielded=yielded & ~broken, solves=solves, events=solves // 2,
                delivered=delivered, lam=1.0, u_new=u_new)


def utilisation_sub(st, rows, JJ):
    sub = Structure.__new__(Structure)
    sub.bn, sub.ba, sub.cF, sub.tF, sub.sF = st.bn[rows], st.ba[rows], st.cF[rows], st.tF[rows], st.sF[rows]
    return utilisation(sub, JJ)


def utilisation_row(st, k, JJ):
    return float(utilisation_sub(st, np.array([k]), JJ[None, :])[0])

# ---------------------------------------------------------------------------
# The event, tick by tick
# ---------------------------------------------------------------------------

def held_nodes(st, active, alive):
    a = active & alive[st.b0] & alive[st.b1]
    ff = a & st.free[st.b0] & st.free[st.b1]
    adj = sp.coo_matrix((np.ones(ff.sum()), (st.b0[ff], st.b1[ff])), shape=(st.n, st.n))
    nc, lab = connected_components(adj, directed=False)
    held = np.zeros(nc, bool)
    fa = a & (st.free[st.b0] ^ st.free[st.b1])
    held[lab[np.where(st.free[st.b0[fa]], st.b0[fa], st.b1[fa])]] = True
    return st.free & alive & held[lab], lab


def settle(st, active, alive, rounds=30):
    """Gravity alone on what is left: every bond past fatal breaks, groups no longer held fall away."""
    broken = 0
    for _ in range(rounds):
        held, _ = held_nodes(st, active, alive)
        alive = alive & (held | ~st.free)
        sol = Solver(st, active, alive)
        J, _ = sol.solve(gravity_loads(st), np.zeros((st.n, 3)))
        a = active & alive[st.b0] & alive[st.b1]
        over = a & (utilisation(st, J) >= 1.0)
        if not over.any(): break
        active = active & ~over; broken += int(over.sum())
    held, _ = held_nodes(st, active, alive)
    return active, alive & (held | ~st.free), broken


def run(st, imp, option, coupled=False, max_ticks=90, log=None):
    active = np.ones(st.m, bool); alive = np.ones(st.n, bool)
    damage = np.zeros(st.n)
    M, u = imp.M, imp.u
    crush = option in ('C', 'C+E')
    events_model = option in ('E', 'C+E', 'Ci+E')
    impact_crush = option == 'Ci+E'
    t0 = time.time()
    # Start one tick before the leading face reaches the first surface it covers.
    pts, near = imp.contacts(st, alive, 1e9)
    if not pts: return dict(error='misses')
    s = min(near[k] for k in pts) - 1e-3
    broke_at = np.full(st.m, -1); crushed_total = np.zeros(st.n, bool); plowed = np.zeros(st.n, bool)
    ticks = []; stopped_by = None; delivered = 0.0
    for tick in range(max_ticks):
        if u <= 0.05: break
        s_new = s + u * DT
        contacts, _ = imp.contacts(st, alive, s_new)
        if not contacts:
            s = s_new; ticks.append(dict(tick=tick, contacts=0, u=u))
            if s > 12: break
            continue
        tt = time.time()
        crushed_now = np.zeros(st.n, bool)
        if impact_crush:
            # Ci: the impact pressure on each struck crushable chunk, the 1-D
            # elastic impact stress Z1 Z2 / (Z1 + Z2) v (capped by what the
            # impactor's own structure delivers), as a uniaxial stress through
            # the native crush law. A crushed layer is gone and its comminution
            # energy is the impactor's; the next layer in this tick's sweep is
            # struck in turn.
            for _ in range(8):
                hit = []
                for k in list(contacts):
                    c = st.crush[k]; Zt = IMPEDANCE.get(st.nmat[k])
                    if c is None or Zt is None or not alive[k]: continue
                    sigma = min(imp.Z * Zt / (imp.Z + Zt) * u, imp.pressure_cap)
                    ex = max(sigma - (c['cohesion'] + c['slope'] * sigma / 3), sigma / 3 - c['cap'], 0.0)
                    if damage[k] + ex * ex * DT / (c['viscosity'] * c['energy']) >= 1.0: hit.append(k)
                if not hit: break
                for k in hit:
                    alive[k] = False; crushed_now[k] = True; damage[k] = 1.0
                    # Comminution energy of what the impactor's section sweeps out
                    # of the chunk (the native stage removes the whole chunk).
                    depth = float(np.abs(imp.d) @ (st.hi[k] - st.lo[k]))
                    swept = min(st.vol[k], contacts[k][0] * 0.01 * depth)
                    u = math.sqrt(max(u * u - 2 * st.crush[k]['energy'] * swept / M, 0.0))
                if u <= 0.05: break
                contacts, _ = imp.contacts(st, alive, s_new)
            crushed_total |= crushed_now
            gone = active & ~(alive[st.b0] & alive[st.b1])
            broke_at[gone] = tick; active &= ~gone
            if not contacts or u <= 0.05:
                s = s_new; ticks.append(dict(tick=tick, contacts=0, crushed=int(crushed_now.sum()), u=u)); continue
        total = M * u / DT
        if events_model:
            v = verdict_plastic(st, active, alive, contacts, total, imp.d, damage, crush, impactor=(M, u) if coupled else None)
        else:
            v = verdict_static(st, active, alive, contacts, total, imp.d, damage, crush)
        ms = (time.time() - tt) * 1e3
        delivered += v['delivered']
        newly = v['broken'] & active
        broke_at[newly] = tick; active &= ~v['broken']
        Ec = 0.0
        if v['crushed'].any():
            crushed_total |= v['crushed']; alive &= ~v['crushed']
            if option == 'C+E':
                Ec = sum(st.crush[i]['energy'] * st.vol[i] for i in np.nonzero(v['crushed'])[0])
                u = math.sqrt(max(u * u - 2 * Ec / M, 0.0))
        held, lab = held_nodes(st, active, alive)
        remaining = [k for k in contacts if alive[k]]
        anchored_contact = [k for k in remaining if held[k]]
        # Groups set free in the path ride ahead of the impactor; the rest fall away.
        free_groups = {lab[k] for k in remaining if not held[k]}
        push = st.free & alive & ~held & np.isin(lab, list(free_groups)) if free_groups else np.zeros(st.n, bool)
        mp = st.mass[push].sum()
        rec = dict(tick=tick, contacts=len(contacts), u=u, broken=int(newly.sum()), crushed=int(v['crushed'].sum() + crushed_now.sum()),
                   yielded=int(v['yielded'].sum()), solves=v['solves'], events=v['events'], ms=round(ms, 1),
                   lam=round(v['lam'], 4), anchoredContacts=len(anchored_contact), pushed=round(float(mp), 1))
        if coupled and v.get('u_new') is not None:
            # The coupled solve already moved the impactor (and what it struck)
            # by the impulses the structure could actually take.
            u = math.sqrt(max(max(v['u_new'], 0.0) ** 2 - 2 * Ec / M, 0.0)); M = M + mp
            if anchored_contact and u < 0.05: stopped_by = [st.types[k] for k in anchored_contact][:6]
        elif anchored_contact:
            # The corrected pass meets a chunk still held to the anchors: infinite mass.
            u = 0.0; stopped_by = [st.types[k] for k in anchored_contact][:6]
        else:
            # Momentum shared with what it pushes.
            u = max(M * u / (M + mp), 0.0); M = M + mp
        plowed |= push
        alive &= ~push
        # Everything else no longer held falls away (debris).
        held, _ = held_nodes(st, active, alive)
        alive &= held | ~st.free
        rec['uAfter'] = u; ticks.append(rec)
        if log: log(rec)
        s = s_new
        if s > 12: break
    impact_broken = active.copy()
    active2, alive2, settle_broken = settle(st, active, alive)
    broke_at[(~active2) & (broke_at < 0)] = 999
    wall = time.time() - t0
    return summarize(st, imp, option, active2, alive2, broke_at, crushed_total, ticks, stopped_by, s, u, M, wall, settle_broken, delivered)


def summarize(st, imp, option, active, alive, broke_at, crushed, ticks, stopped_by, s, u, M, wall, settle_broken, delivered):
    broken = ~active
    nb = int(broken.sum())
    impact = (broke_at >= 0) & (broke_at < 999)
    dist = np.linalg.norm(st.bc - imp.aim, axis=1)
    bins = [0, 1, 2, 4, 8, 99]
    hist = {f'{bins[i]}-{bins[i+1]}m': int((impact & (dist >= bins[i]) & (dist < bins[i + 1])).sum()) for i in range(len(bins) - 1)}
    held, _ = held_nodes(st, active, alive)
    sm = np.array([t in STRUCTURAL for t in st.types]) & st.free
    roof = np.array([t in ROOF for t in st.types])
    out = dict(
        option=option, scenario=imp.name,
        bonds=st.m, broken=nb, brokenFrac=round(nb / st.m, 4),
        impactBroken=int(impact.sum()), settleBroken=int(settle_broken),
        structuralBroken=int((broken & st.structural_bond).sum()), cosmeticBroken=int((broken & ~st.structural_bond).sum()),
        structuralBonds=int(st.structural_bond.sum()),
        byDistance=hist,
        medianBreakDistance=round(float(np.median(dist[impact])), 2) if impact.any() else None,
        crushed=int(crushed.sum()),
        structuralHeld=round(float(st.mass[sm & held].sum() / st.mass[sm].sum()), 3),
        roofHeld=round(float(st.mass[roof & held].sum() / st.mass[roof].sum()), 3),
        stoppedBy=stopped_by,
        penetration=round(float(s), 2), exitSpeed=round(float(u), 2), pushedMass=round(float(M - imp.M), 1),
        deliveredImpulse=round(delivered, 1), infiniteMassImpulse=round(imp.M * imp.u, 1),
        ticks=len([t for t in ticks if t.get('contacts')]),
        solvesPerTick=max([t.get('solves', 0) for t in ticks] + [0]), eventsMax=max([t.get('events', 0) for t in ticks] + [0]),
        impactTickMs=max([t.get('ms', 0) for t in ticks] + [0]), wallSeconds=round(wall, 1),
        trace=ticks,
        brokenBonds=[[int(k), int(broke_at[k])] for k in np.nonzero(broken)[0]],
        crushedNodes=[int(i) for i in np.nonzero(crushed)[0]],
    )
    return out

# ---------------------------------------------------------------------------
# Scenarios (house-local frame: x along the house, z front (-) to back, y up;
# the lab places the bungalow at (124, 0, 24): lab = local + that)
# ---------------------------------------------------------------------------

# Impactors' impedance: steel rho 7850, c = sqrt(210 GPa / rho) = 5170 m/s; the
# meteor's rock at the server's 3300 kg/m3 with basalt's E ~60 GPa (4260 m/s).
# The truck delivers no more than its front's crush pressure: EN 1991-1-7
# Annex C, F = v sqrt(k m), k = 300 kN/m -> 0.84 MN at 21.7 m/s for 5 t, over
# its 3.3 x 1.6 m front: 0.16 MPa.
STEEL_Z = 7850 * math.sqrt(210e9 / 7850)
ROCK_Z = 3300 * math.sqrt(60e9 / 3300)
TRUCK_PRESSURE = 21.7 * math.sqrt(300e3 * 5000) / (3.3 * 1.6)


def scenarios():
    ball_r = (10650 / 7850 * 3 / (4 * math.pi)) ** (1 / 3)
    small_r = (100 / 7850 * 3 / (4 * math.pi)) ** (1 / 3)
    meteor_dir = np.array([0, -0.3, 1.0])
    out = {
        # The lab's cannonball-framed-house: [122, 1.4, 20.1] square on.
        'cannonball': Impactor('cannonball', 10650, 60, [0, 0, 1], [-2.0, 1.4, -4.5], 'disk', ball_r, impedance=STEEL_Z),
        # meteor-framed-house: [124, 2.0, 20.1] from 140 m out at slope 0.3.
        'meteor': Impactor('meteor', 110e3, 140, meteor_dir, [0, 2.0, -3.9] - meteor_dir / np.linalg.norm(meteor_dir) * 0.6, 'disk', 2.0, impedance=ROCK_Z),
        # framed-house: the monster truck (5000 kg) at 21.7 m/s into the front
        # wall's middle; its front 3.3 m wide (57 in tyres outboard) and from
        # 0.3 to 1.9 m up (bumper to bonnet line).
        'truck': Impactor('truck', 5000, 21.7, [0, 0, 1], [0.0, 0.0, -4.5], 'rect', (3.3, 0.3, 1.9), impedance=STEEL_Z, pressure_cap=TRUCK_PRESSURE),
        # The same truck centred on the front-left corner (x -5).
        'truck-corner': Impactor('truck-corner', 5000, 21.7, [0, 0, 1], [-5.0, 0.0, -4.5], 'rect', (3.3, 0.3, 1.9), impedance=STEEL_Z, pressure_cap=TRUCK_PRESSURE),
    }
    # Smaller hits: a 100 kg steel ball (r 0.146 m) at 60 m/s between studs
    # (front wall studs at x -1.80, -1.24, -0.64, -0.04, 0.56, 1.16).
    for x in (-1.52, -0.34, 0.86):
        out[f'small{x:+.2f}'] = Impactor(f'small{x:+.2f}', 100, 60, [0, 0, 1], [x, 1.2, -4.5], 'disk', small_r, impedance=STEEL_Z)
    return out


def rest_check(st):
    sol = Solver(st, np.ones(st.m, bool), np.ones(st.n, bool))
    J, _ = sol.solve(gravity_loads(st), np.zeros((st.n, 3)))
    u = utilisation(st, J)
    p, q = node_stress(st, J, np.ones(st.m, bool), np.zeros((st.n, 3)), st.pos.copy())
    ex = crush_excess(st, p, q)
    use = np.zeros(st.n)
    for i, c in enumerate(st.crush):
        if c is None or not st.free[i] or p[i] <= 0: continue
        use[i] = max(q[i] / (c['cohesion'] + c['slope'] * p[i]), p[i] / c['cap'])
    return dict(maxBondFatalUtilisation=round(float(u.max()), 3), bondsPastFatal=int((u >= 1).sum()),
                maxCrushUtilisation=round(float(use.max()), 4), crushOverstressNodes=int((ex > 0).sum()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pack'); ap.add_argument('--scenario', nargs='*'); ap.add_argument('--options', default='A,C,E,C+E')
    ap.add_argument('--coupled', action='store_true', help='E and C+E with the physically coupled contact instead of the trial\'s infinite mass')
    ap.add_argument('--json'); ap.add_argument('--verbose', action='store_true'); ap.add_argument('--trace-events', action='store_true'); ap.add_argument('--max-ticks', type=int, default=90); ap.add_argument('--ramp', type=float, nargs=2, help='ramp factor and levels (default 2 9)')
    a = ap.parse_args()
    st = Structure(a.pack)
    if a.ramp:
        global RAMP, RAMP_LEVELS
        RAMP, RAMP_LEVELS = a.ramp[0], int(a.ramp[1])
    print(f'{a.pack}: {st.n} nodes ({st.nf} free), {st.m} bonds ({int(st.structural_bond.sum())} structural), mass {st.mass.sum():.0f} kg')
    rest = rest_check(st); print('at rest:', rest)
    results = dict(pack=a.pack, rest=rest, runs=[])
    sc = scenarios()
    for name in a.scenario or list(sc):
        for opt in a.options.split(','):
            for coupled in ([False, True] if a.coupled and opt in ('E', 'C+E', 'Ci+E') else [False]):
                label = opt + (' coupled' if coupled else '')
                if a.trace_events: TRACE_EVENTS[:] = [sc[name].aim]
                r = run(st, sc[name], opt, coupled=coupled, max_ticks=a.max_ticks, log=(lambda rec: print('   ', rec)) if a.verbose else None)
                r['option'] = label
                results['runs'].append(r)
                print(f"{name:14} {label:12} broken {r['broken']:5} ({100*r['brokenFrac']:5.1f}%) impact {r['impactBroken']:4} settle {r['settleBroken']:4} "
                      f"struct {r['structuralBroken']:4} cosm {r['cosmeticBroken']:4} crushed {r['crushed']:3} dist {r['byDistance']} "
                      f"held {r['structuralHeld']:.2f} roof {r['roofHeld']:.2f} pen {r['penetration']:6.2f} exit {r['exitSpeed']:6.2f} "
                      f"stop {r['stoppedBy']} impulse {r['deliveredImpulse']:.0f}/{r['infiniteMassImpulse']:.0f} solves {r['solvesPerTick']} {r['wallSeconds']}s", flush=True)
    if a.json:
        json.dump(results, open(a.json, 'w'), indent=1, default=lambda o: o.tolist() if hasattr(o, 'tolist') else str(o))


if __name__ == '__main__':
    main()
