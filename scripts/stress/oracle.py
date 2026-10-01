#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Stress oracle: what the native GPU stress solve was given, what it did, and
what it should have produced -- from the solver's own captured system.

Reads captures of the diagnostic SDK (scripts/perf/build-stress-capture-sdk.sh;
PhysX blast/.../stressgpu/detail/StressProblemCapture.cuh, version 2) and, per
captured solve and component:

  check     the captured warm residual against an independent assembly of the
            bond operator B (A = B B^T), and the GPU's final lambda against
            lambda0 + B^T mu (the capture is self-consistent or the run stops);
  replay    the native recurrence exactly (identity at iteration 0, the fixed
            block polynomial after, beta restart, projection of the rigid
            modes, the mixed-space test ||B^T r||^2 <= tol^2 ||b||^2 with
            true-residual verification) in FP64 and emulated FP32, compared
            iteration by iteration with the GPU's recorded history;
  spectrum  condition numbers of A, of block-Jacobi and of the polynomial
            preconditioned A on the projected space; the slowest modes with the
            chunks they live on; the rigid-mode energies (is a near-null
            rotation left unprojected?);
  decide    each bond's damage verdict (PxgDestructionMaterial's rule) from the
            GPU's final lambda and from the converged truth: the bonds whose
            verdict an unconverged solve got wrong, and the iteration after
            which the replay's verdicts stop changing;
  bench     remedies on the same system: polynomial from iteration 0,
            block-Jacobi, rigid-group deflation, more iterations.

FP64 and extra iterations here are measurements, never the product's fix.

  uv run scripts/stress/oracle.py target/stress-capture/m1 --metadata <car metadata.json>
  uv run scripts/stress/oracle.py --self-test
"""
import argparse, json, math, sys
from collections import defaultdict
from pathlib import Path
import numpy as np
import scipy.linalg as la
import scipy.sparse as sp

NODE = np.dtype([('inertia', '<f4', (2,)), ('rhs', '<f4', (6,)), ('residual', '<f4', (6,)),
                 ('threshold', '<f4'), ('component', '<u4')])
BOND = np.dtype([('first', '<u4'), ('second', '<u4'), ('offset0', '<f4', (3,)), ('offset1', '<f4', (3,)),
                 ('health', '<f4'), ('scale', '<f4'), ('warm', '<f4', (6,))])
COMPONENT = np.dtype([('id', '<u4'), ('nodes', '<u4'), ('anchored', '<u4'), ('rotations', '<u4'), ('closure', '<u4'),
                      ('iterations', '<u4'), ('converged', '<u4'), ('active', '<u4'), ('failed', '<u4'),
                      ('tolerance2', '<f4'), ('residual2', '<f4'), ('gamma', '<f4'), ('direction', '<f4'), ('pad', '<f4', (3,))])
SOLUTION = np.dtype([('mu', '<f8', (6,)), ('residual', '<f4', (6,)), ('component', '<u4'), ('pad', '<u4')])
LAMBDA = np.dtype([('angular', '<f4', (4,)), ('linear', '<f4', (4,))])
INVALID = 2**32 - 1
POLY_A, POLY_B = 0.5779388123770052, 2.6335678180143502


def require(ok, why):
    if not ok:
        raise ValueError(why)


def skew(v):
    x, y, z = v
    return np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]], dtype=np.float64)


# ---------------------------------------------------------------- capture ---

class Capture:
    """One captured solve: the system before iteration and the state after."""

    def __init__(self, meta_path):
        meta = json.loads(Path(meta_path).read_text())
        require(meta['endian'] == 'little' and meta['record_bytes'] == 64, 'unsupported capture layout')
        base = str(meta_path)[:-5]
        self.meta, self.path = meta, Path(meta_path)
        self.nodes = np.fromfile(base + '.nodes.bin', dtype=NODE)
        self.bonds = np.fromfile(base + '.bonds.bin', dtype=BOND)
        require(len(self.nodes) == meta['node_count'] and len(self.bonds) == meta['bond_count'], 'truncated capture')
        self.version = meta['version']
        if self.version >= 2:
            self.components = np.fromfile(base + '.components.bin', dtype=COMPONENT)
            self.solution = np.fromfile(base + '.solution.bin', dtype=SOLUTION)
            raw = np.fromfile(base + '.lambda.bin', dtype=LAMBDA)
            self.lam = np.concatenate([raw['angular'][:, :3], raw['linear'][:, :3]], axis=1).astype(np.float64)
            limit = meta['history_limit']
            self.history = np.fromfile(base + '.history.bin', dtype='<f4').reshape(-1, limit, 3)
            self.length_scale, self.mass_scale = meta['length_scale'], meta['mass_scale']
        else:
            self.components = np.zeros(0, dtype=COMPONENT)
            self.solution = self.lam = self.history = None
        self.solve = meta['solve']

    def component_ids(self):
        ids = [int(i) for i in np.unique(self.nodes['component']) if i != INVALID]
        return ids

    def record(self, identity):
        hit = self.components[self.components['id'] == identity]
        return hit[0] if len(hit) else None


class System:
    """One component's node-space system, assembled independently."""

    def __init__(self, cap, identity):
        nodes, bonds = cap.nodes, cap.bonds
        members = np.flatnonzero(nodes['component'] == identity)
        require(len(members) > 0, 'empty component')
        labels = nodes['component']
        live = bonds['health'] > 0
        selected = np.flatnonzero(live & ((labels[bonds['first']] == identity) | (labels[bonds['second']] == identity)))
        local = np.full(len(nodes), -1, dtype=np.int64)
        local[members] = np.arange(len(members))
        rows, cols, values = [], [], []
        anchored = False
        for edge, source in enumerate(selected):
            bond = bonds[source]
            for side, key in enumerate(('first', 'second')):
                node = int(bond[key])
                index = local[node]
                if index < 0:
                    require(np.all(nodes['inertia'][node] == 0), 'live bond crosses distinct dynamic components')
                    anchored = True
                    continue
                block = np.eye(6)
                block[:3, 3:] = -skew(bond['offset' + str(side)])
                block[:3] *= float(nodes['inertia'][node][0])
                block[3:] *= float(nodes['inertia'][node][1])
                block *= float(bond['scale']) * (1 if side == 0 else -1)
                r, c = np.nonzero(block)
                rows.extend((6 * index + r).tolist())
                cols.extend((6 * edge + c).tolist())
                values.extend(block[r, c].tolist())
        self.B = sp.coo_matrix((values, (rows, cols)), shape=(6 * len(members), 6 * len(selected))).tocsr()
        self.A = (self.B @ self.B.T).toarray()
        self.members, self.selected, self.local, self.anchored = members, selected, local, anchored
        # (first node, second node, colScale) per selected bond, global node ids
        self.bonds_of = [(int(bonds[i]['first']), int(bonds[i]['second']), float(bonds[i]['scale'])) for i in selected]
        self.identity = identity
        self.n = len(members)
        self.rhs = nodes['rhs'][members].astype(np.float64).ravel()
        self.warm = bonds['warm'][selected].astype(np.float64).ravel()
        self.r0 = self.rhs - self.B @ self.warm
        captured = nodes['residual'][members].astype(np.float64).ravel()
        cancellation = np.abs(self.rhs) + abs(self.B) @ np.abs(self.warm) + 1
        self.warm_discrepancy = float(np.max(np.abs(captured - self.r0) / cancellation))
        require(self.warm_discrepancy <= 8 * np.finfo(np.float32).eps,
                f'captured warm residual disagrees with the independent assembly ({self.warm_discrepancy:.3g})')
        thresholds = nodes['threshold'][members]
        require(np.all(thresholds == thresholds[0]), 'inconsistent component threshold')
        self.threshold = float(thresholds[0])
        self.d = nodes['inertia'][members].astype(np.float64)
        self.modes = None

    # Rigid motions in the solver's scaled node space. Positions come from the
    # bond offsets over a spanning tree; the sign convention is the one whose
    # modes the operator annihilates (B^T v = 0).
    def rigid_basis(self, bonds):
        n = self.n
        adjacency = defaultdict(list)
        for source in self.selected:
            b = bonds[source]
            a, c = self.local[int(b['first'])], self.local[int(b['second'])]
            if a >= 0 and c >= 0:
                o0, o1 = b['offset0'].astype(np.float64), b['offset1'].astype(np.float64)
                adjacency[a].append((c, o0 - o1))
                adjacency[c].append((a, o1 - o0))
        best = None
        for sign in (1.0, -1.0):
            x = np.full((n, 3), np.nan)
            for root in range(n):
                if not np.isnan(x[root, 0]):
                    continue
                x[root] = 0
                stack = [root]
                while stack:
                    u = stack.pop()
                    for v, delta in adjacency[u]:
                        if np.isnan(x[v, 0]):
                            x[v] = x[u] + sign * delta
                            stack.append(v)
            x -= x.mean(axis=0)
            V = np.zeros((6 * n, 6))
            for k in range(3):
                e = np.eye(3)[k]
                for i in range(n):
                    V[6 * i + 3:6 * i + 6, k] = e / self.d[i, 1]                 # translation
                    V[6 * i:6 * i + 3, 3 + k] = e / self.d[i, 0]                 # rotation
                    V[6 * i + 3:6 * i + 6, 3 + k] = np.cross(e, x[i]) / self.d[i, 1]
            energy = np.array([float(V[:, k] @ self.A @ V[:, k]) / float(V[:, k] @ V[:, k]) for k in range(6)])
            if best is None or energy[3:].sum() < best[1][3:].sum():
                best = (V, energy, x)
        self.rigid, self.rigid_energy, self.positions = best
        return best

    def projector(self, rotations, bonds):
        """The kernel's projection: translations, plus `rotations` (0, 1, 3)."""
        if self.anchored:
            return None
        V, energy, _ = self.rigid_basis(bonds)
        if rotations == 3:
            basis = V
        elif rotations == 0:
            basis = V[:, :3]
        else:
            # One rotation about the closure axis: the least-energy rotation.
            R = V[:, 3:]
            gram = R.T @ self.A @ R
            w, v = la.eigh(gram, R.T @ R)
            basis = np.column_stack([V[:, :3], R @ v[:, 0]])
        Q, _ = np.linalg.qr(basis)
        return Q


def project(Q, v):
    return v if Q is None else v - Q @ (Q.T @ v)


# ---------------------------------------------------------------- replay ----

def block_inverse(A, n):
    blocks = np.array([A[6 * i:6 * i + 6, 6 * i:6 * i + 6] for i in range(n)])
    return np.linalg.inv(blocks), blocks


def make_polynomial(A, n):
    inverse, blocks = block_inverse(A, n)
    E = A - la.block_diag(*blocks)

    def M(v):
        return np.einsum('nij,nj->ni', inverse, v.reshape(n, 6)).ravel()

    def apply(r):
        z = M(r)
        return (POLY_A + POLY_B - POLY_A * POLY_B) * z - POLY_A * POLY_B * M(E @ z)
    return apply, M


def replay(system, Q, threshold, warm=True, limit=64, dtype=np.float64, first='identity', precondition=None,
           deflation=None, decide=None, kind='polynomial'):
    """The native small-component recurrence (first='identity': a projected
    steepest-descent step, then restarted PCG; 'polynomial': PCG from 0).
    kind selects the preconditioner (the native fixed polynomial, or plain
    block-Jacobi). Returns per-iteration (residual2, gamma, direction), the
    iterate, and decide(x) per iteration when given."""
    A, B = system.A.astype(dtype), system.B
    poly, jacobi = precondition or make_polynomial(system.A, system.n)
    apply = jacobi if kind == 'jacobi' else poly
    r0 = project(Q, system.r0).astype(dtype)
    x = np.zeros_like(r0)
    r = r0.copy()
    p = np.zeros_like(r0)
    previous = 0.0
    history, verdicts = [], []
    converged, stopped = False, limit
    for it in range(limit + 1):
        r = project(Q, r).astype(dtype)
        g = (B.T @ r).astype(dtype)
        e = float(np.dot(g, g))
        if (it or warm) and threshold > 0 and e <= threshold:
            r = project(Q, (r0 - A @ x)).astype(dtype)
            g = (B.T @ r).astype(dtype)
            e = float(np.dot(g, g))
            previous = 0.0
            if e <= threshold:
                history.append((e, math.nan, math.nan))
                converged, stopped = True, it
                break
        if decide is not None:
            verdicts.append(decide(x))
        if it == limit:
            history.append((e, math.nan, math.nan))
            break
        polynomial_now = it > 0 or first != 'identity'
        if polynomial_now:
            z = apply(r.astype(np.float64))
            if deflation is not None:
                z = z + deflation(r.astype(np.float64))
        else:
            z = r.astype(np.float64)
        z = project(Q, z).astype(dtype)
        gamma = float(np.dot(r, z))
        restart_at = 1 if first == 'identity' else 0
        beta = gamma / previous if (it > restart_at and previous > 0) else 0.0
        p = (z + dtype(beta) * p).astype(dtype)
        q = (A @ p).astype(dtype)
        bp = B.T @ p
        den = float(np.dot(bp, bp))
        history.append((e, gamma, den))
        if not (den > 0 and math.isfinite(den) and gamma > 0):
            stopped = it
            break
        alpha = gamma / den
        x = (x + dtype(alpha) * p).astype(dtype)
        r = (r - dtype(alpha) * q).astype(dtype)
        previous = gamma
    return dict(history=np.array(history), x=x.astype(np.float64), converged=converged, iterations=stopped, verdicts=verdicts)


def truth(system, Q):
    """The converged answer: x* with A x* = P r0 on the projected space."""
    r0 = project(Q, system.r0)
    if Q is None:
        return la.solve(system.A, r0, assume_a='pos')
    n6 = system.A.shape[0]
    C = la.null_space(Q.T)                      # orthonormal complement of the rigid modes
    Ar = C.T @ system.A @ C
    return C @ la.solve(Ar, C.T @ r0, assume_a='pos')


# --------------------------------------------------------------- spectrum ---

def spectrum(system, Q, names):
    A, n = system.A, system.n
    C = np.eye(6 * n) if Q is None else la.null_space(Q.T)
    Ar = C.T @ A @ C
    w, v = la.eigh(Ar)
    lam_max, lam_min = float(w[-1]), float(w[0])
    poly, jacobi = make_polynomial(A, n)
    P = np.column_stack([poly(C[:, k]) for k in range(C.shape[1])])
    J = np.column_stack([jacobi(C[:, k]) for k in range(C.shape[1])])
    Pr, Jr = C.T @ P, C.T @ J
    pw = np.sort(np.real(la.eigvals(Pr @ Ar)))
    jw = np.sort(np.real(la.eigvals(Jr @ Ar)))

    def where(vec, top=4):
        full = (C @ vec).reshape(n, 6)
        share = (full ** 2).sum(axis=1)
        share /= share.sum()
        order = np.argsort(-share)[:top]
        return [dict(chunk=names(int(system.members[i])), share=round(float(share[i]), 3)) for i in order]

    def strained(vec, top=4):
        # The bonds a mode deforms: each bond's share of the mode's energy
        # ||(B^T v)_j||^2. A slow mode's bonds are what holds it softly.
        energy = ((system.B.T @ (C @ vec)).reshape(-1, 6) ** 2).sum(axis=1)
        energy /= max(energy.sum(), 1e-300)
        order = np.argsort(-energy)[:top]
        b = system.bonds_of
        return [dict(bond=f"{names(int(b[k][0]))} - {names(int(b[k][1]))}", share=round(float(energy[k]), 3), scale=round(float(b[k][2]), 4)) for k in order]
    # slowest modes under the polynomial (what PCG actually fights)
    pv_w, pv_v = la.eig(Pr @ Ar)
    order = np.argsort(np.real(pv_w))
    slow = [dict(eigenvalue=float(np.real(pv_w[k])), relative=float(np.real(pv_w[k]) / pw[-1]),
                 chunks=where(np.real(pv_v[:, k])), bonds=strained(np.real(pv_v[:, k]))) for k in order[:6]]
    raw_slow = [dict(eigenvalue=float(w[k]), relative=float(w[k] / lam_max), chunks=where(v[:, k])) for k in range(6)]
    out = dict(kappa_raw=lam_max / lam_min, kappa_jacobi=float(jw[-1] / jw[0]), kappa_polynomial=float(pw[-1] / pw[0]),
               poly_range=[float(pw[0]), float(pw[-1])], lambda_max=lam_max, lambda_min=lam_min,
               slowest_polynomial=slow, slowest_raw=raw_slow)
    if not system.anchored and system.modes is not None:
        out['rigid_energy_relative'] = [float(e / lam_max) for e in system.rigid_energy]
    return out


# --------------------------------------------------------------- decisions --

class Verdicts:
    """PxgDestructionMaterial's bond verdict from solver-scaled lambda."""

    def __init__(self, cap, system, metadata, bend_gain=3.0, fibres=True):
        self.cap, self.system = cap, system
        L, M = cap.length_scale, cap.mass_scale
        self.ang_scale, self.lin_scale = L * L * M, L * M
        sel = system.selected
        self.scale = cap.bonds['scale'][sel].astype(np.float64)
        self.area = cap.bonds['health'][sel].astype(np.float64)
        parts = metadata['parts']
        center = np.array([p['massProperties']['center'] for p in parts], dtype=np.float64)
        mb = [metadata['bonds'][int(i)] for i in sel]
        index = {p['id']: k for k, p in enumerate(parts)}
        a = np.array([index[b['a']] for b in mb])
        c = np.array([index[b['b']] for b in mb])
        disp = center[c] - center[a]
        normal = np.array([b['normal'] for b in mb], dtype=np.float64)
        normal *= np.sign(np.einsum('ij,ij->i', normal, disp))[:, None]
        normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-20)[:, None]
        self.normal, self.distance = normal, np.linalg.norm(disp, axis=1)
        s = [b['strength'] for b in mb]
        self.limits = {k: np.array([x[k] for x in s], dtype=np.float64) for k in s[0]}
        self.bend_gain, self.fibres = bend_gain, fibres
        self.names = [f"{parts[a[k]]['name']} - {parts[c[k]]['name']}" for k in range(len(mb))]

    def multiplier(self, lam):
        lam = lam.reshape(-1, 6)
        ang = lam[:, :3] * (self.scale * self.ang_scale)[:, None]
        lin = lam[:, 3:] * (self.scale * self.lin_scale)[:, None]
        n, area = self.normal, self.area
        ln = np.einsum('ij,ij->i', lin, n)
        normal = ln / area
        shear = np.linalg.norm(lin - ln[:, None] * n, axis=1) / area
        an = np.einsum('ij,ij->i', ang, n)
        twist = np.abs(an) / area
        bend = np.linalg.norm(ang - an[:, None] * n, axis=1) / area
        if self.bend_gain > 0:
            shear = shear + twist * np.minimum(4.81 / np.sqrt(np.maximum(area, 1e-6)), self.bend_gain)
            bend = bend * np.minimum(6.0 / np.sqrt(np.maximum(area, 1e-6)), self.bend_gain)
        else:
            shear = shear + twist * 2.0 / self.distance
            normal = normal + np.copysign(bend * 2.0 / self.distance, normal)
            bend = np.zeros_like(bend)
        if self.fibres:
            tension, compression = np.maximum(normal + bend, 0), np.maximum(bend - normal, 0)
        else:
            combined = normal + np.copysign(bend, normal)
            tension, compression = np.maximum(combined, 0), np.maximum(-combined, 0)
        L = self.limits

        def over(value, elastic, fatal):
            return np.where(value > elastic, (value - elastic) / np.where(fatal - elastic > 0, fatal - elastic, 1.0), 0.0)
        axial = np.maximum(over(compression, L['compressionElastic'], L['compressionFatal']),
                           over(tension, L['tensionElastic'], L['tensionFatal']))
        return axial + over(shear, L['shearElastic'], L['shearFatal'])

    @staticmethod
    def classify(m):
        return np.where(m >= 1, 2, np.where(m > 0, 1, 0))

    def lam_of(self, x):
        return self.system.warm + self.system.B.T @ x


# ------------------------------------------------------------ calibration --

def calibrate(system, Q, x_star, limit, precondition):
    """Per iteration of the FP32 replay: the true bond-force error, and the
    candidate stopping measures the solver could compute itself -- the native
    ||B^T r||^2 / threshold, the node residual relative to the load, and the
    iteration's change in bond forces relative to the forces."""
    lam_true = (system.warm + system.B.T @ x_star).reshape(-1, 6)
    peak = max(float(np.max(np.linalg.norm(lam_true, axis=1))), 1e-30)
    load = max(float(np.linalg.norm(project(Q, system.rhs))), 1e-30)

    def measure(x):
        lam = (system.warm + system.B.T @ x).reshape(-1, 6)
        error = float(np.max(np.linalg.norm(lam - lam_true, axis=1))) / peak
        node = float(np.linalg.norm(project(Q, system.r0 - system.A @ x))) / load
        return error, node, float(np.linalg.norm(lam))
    run = replay(system, Q, 0.0, limit=limit, dtype=np.float32, precondition=precondition, decide=measure)
    rows = []
    for k, (error, node, norm) in enumerate(run['verdicts']):
        e, gamma, den = run['history'][k] if k < len(run['history']) else (math.nan,) * 3
        step = gamma / math.sqrt(den) / norm if den > 0 and norm > 0 else math.nan
        rows.append(dict(iteration=k, force_error=error, native=e / system.threshold if system.threshold > 0 else math.nan,
                         node_relative=node, step_relative=step))
    return rows


# ------------------------------------------------------------------ bench ---

def group_deflation(system, groups):
    """Additive coarse correction Z (Z^T A Z)^+ Z^T on rigid modes of groups."""
    V = system.rigid
    cols = []
    for g in sorted(set(groups)):
        mask = np.repeat(np.array(groups) == g, 6)
        for k in range(6):
            col = np.where(mask, V[:, k], 0.0)
            if np.linalg.norm(col) > 0:
                cols.append(col)
    Z = np.column_stack(cols)
    coarse = la.pinvh(Z.T @ system.A @ Z)
    return lambda r: Z @ (coarse @ (Z.T @ r))


# ------------------------------------------------------------------- main ---

def analyse(cap, identity, metadata, names, groups_of, limit, bench):
    record = cap.record(identity)
    system = System(cap, identity)
    out = dict(solve=cap.solve, component=identity, nodes=system.n, bonds=len(system.selected), anchored=system.anchored,
               warm_residual_discrepancy=system.warm_discrepancy, threshold=system.threshold)
    rotations = int(record['rotations']) if record is not None else 3
    if record is not None:
        out.update(gpu=dict(iterations=int(record['iterations']), converged=bool(record['converged']), rotations=rotations,
                            residual_over_tolerance=float(math.sqrt(record['residual2'] / record['tolerance2'])) if record['tolerance2'] > 0 else None))
    Q = system.projector(rotations, cap.bonds)
    if not system.anchored:
        system.modes = True
        out['rigid_energy_relative_to_lambda_max'] = None
    # GPU self-consistency: lambda_final = lambda0 + B^T mu
    if cap.lam is not None:
        mu = cap.solution['mu'][system.members].ravel()
        lam_gpu = cap.lam[system.selected].ravel()
        predicted = system.warm + system.B.T @ mu
        scale = np.abs(system.warm) + abs(system.B.T) @ np.abs(mu) + 1e-30
        out['gpu_lambda_discrepancy'] = float(np.max(np.abs(lam_gpu - predicted) / scale))
    spec = spectrum(system, Q, names)
    out['spectrum'] = spec
    if not system.anchored:
        out['rigid_energy_relative_to_lambda_max'] = [float(e / spec['lambda_max']) for e in system.rigid_energy]
    # replay vs GPU history
    gpu_hist = cap.history[identity] if cap.history is not None and identity < len(cap.history) else None
    pre = make_polynomial(system.A, system.n)
    r64 = replay(system, Q, system.threshold, limit=limit, precondition=pre)
    r32 = replay(system, Q, system.threshold, limit=limit, dtype=np.float32, precondition=pre)
    out['replay'] = dict(fp64=dict(converged=r64['converged'], iterations=r64['iterations']),
                         fp32=dict(converged=r32['converged'], iterations=r32['iterations']))
    if gpu_hist is not None:
        k = min(8, len(r32['history']), np.sum(np.isfinite(gpu_hist[:, 0])))
        g = gpu_hist[:k, 0].astype(np.float64)
        out['replay']['first_iterations'] = dict(gpu=g.tolist(), fp32=r32['history'][:k, 0].tolist(), fp64=r64['history'][:k, 0].tolist(),
                                                 max_relative_difference_fp32=float(np.max(np.abs(r32['history'][:k, 0] - g) / np.maximum(g, 1e-30))) if k else None)
    # truth and decisions
    x_star = truth(system, Q)
    out['truth_residual_over_tolerance'] = float(math.sqrt(np.sum((system.B.T @ project(Q, system.r0 - system.A @ x_star)) ** 2) / system.threshold)) if system.threshold > 0 else None
    # What the native threshold means, and how accurate the GPU's forces are.
    # The test compares a bond-space norm with a node-space reference
    # (tol^2 ||b||^2); the same tolerance against the bond-space reference
    # ||B^T b||^2 is the scale-invariant reading.
    bond_rhs2 = float(np.sum((system.B.T @ project(Q, system.rhs)) ** 2))
    out['accuracy'] = dict(effective_bond_relative_tolerance=math.sqrt(system.threshold / bond_rhs2) if bond_rhs2 > 0 else None)
    if cap.solution is not None:
        mu = cap.solution['mu'][system.members].ravel()
        r_gpu = project(Q, system.r0 - system.A @ mu)
        bond_res2 = float(np.sum((system.B.T @ r_gpu) ** 2))
        lam_true, lam_gpu = system.warm + system.B.T @ x_star, system.warm + system.B.T @ mu
        out['accuracy'].update(
            gpu_bond_residual_relative=math.sqrt(bond_res2 / bond_rhs2) if bond_rhs2 > 0 else None,
            gpu_lambda_relative_error=float(np.linalg.norm(lam_gpu - lam_true) / max(np.linalg.norm(lam_true), 1e-30)),
            gpu_lambda_max_bond_error=float(np.max(np.linalg.norm((lam_gpu - lam_true).reshape(-1, 6), axis=1))
                                            / max(np.max(np.linalg.norm(lam_true.reshape(-1, 6), axis=1)), 1e-30)))
    if metadata is not None and cap.lam is not None:
        V = Verdicts(cap, system, metadata)
        m_true = V.multiplier(V.lam_of(x_star))
        m_gpu = V.multiplier(cap.lam[system.selected].ravel())
        c_true, c_gpu = V.classify(m_true), V.classify(m_gpu)
        wrong = np.flatnonzero(c_true != c_gpu)
        worst = np.argsort(-np.abs(m_gpu - m_true))[:5]
        out['decisions'] = dict(
            truth=dict(gradual=int(np.sum(c_true == 1)), fatal=int(np.sum(c_true == 2))),
            gpu=dict(gradual=int(np.sum(c_gpu == 1)), fatal=int(np.sum(c_gpu == 2))),
            wrong=len(wrong), spurious_fatal=int(np.sum((c_gpu == 2) & (c_true < 2))), missed_fatal=int(np.sum((c_gpu < 2) & (c_true == 2))),
            max_multiplier_error=float(np.max(np.abs(m_gpu - m_true))) if len(m_true) else 0.0,
            worst=[dict(bond=V.names[i], gpu=round(float(m_gpu[i]), 3), truth=round(float(m_true[i]), 3)) for i in worst])

        def settles(first, extra=None, deflation=None):
            run = replay(system, Q, system.threshold, limit=limit * 4, dtype=np.float32, first=first, precondition=pre,
                         deflation=deflation, decide=lambda x: tuple(V.classify(V.multiplier(V.lam_of(x)))))
            target = tuple(c_true)
            hit = next((i for i in range(len(run['verdicts'])) if all(v == target for v in run['verdicts'][i:])), None)
            return dict(converged=run['converged'], iterations=run['iterations'], verdicts_settle_at=hit)
        out['decision_iterations'] = settles('identity')
        rows = calibrate(system, Q, x_star, limit * 4, pre)
        out['calibration'] = rows
        def first(level):
            return next((r for r in rows if r['force_error'] < level and all(q['force_error'] < level for q in rows[r['iteration']:])), None)
        out['force_error_reached'] = {str(level): first(level) for level in (1e-2, 1e-3)}
        if bench:
            b = {}
            b['polynomial_first'] = settles('polynomial')
            if groups_of is not None and not system.anchored:
                groups = [groups_of(int(i)) for i in system.members]
                b['group_deflation'] = settles('identity', deflation=group_deflation(system, groups))
                b['group_deflation']['groups'] = len(set(groups))
            out['bench'] = b
    return out


def audit(prefix, caps, metadata):
    """Every captured, iterated component: did the GPU's stopping point give
    the converged forces and verdicts? Prints the distribution."""
    rows = []
    for cap in caps:
        for identity in cap.component_ids():
            rec = cap.record(identity)
            if rec is None or (rec['converged'] and rec['iterations'] == 0):
                continue
            system = System(cap, identity)
            Q = system.projector(int(rec['rotations']), cap.bonds)
            x_star = truth(system, Q)
            mu = cap.solution['mu'][system.members].ravel()
            lam_true = (system.warm + system.B.T @ x_star).reshape(-1, 6)
            lam_gpu = (system.warm + system.B.T @ mu).reshape(-1, 6)
            peak = max(float(np.max(np.linalg.norm(lam_true, axis=1))), 1e-30)
            row = dict(prefix=prefix, solve=cap.solve, component=identity, iterations=int(rec['iterations']), converged=bool(rec['converged']),
                       force_error=float(np.max(np.linalg.norm(lam_gpu - lam_true, axis=1))) / peak)
            if metadata is not None:
                V = Verdicts(cap, system, metadata)
                m_true, m_gpu = V.multiplier(lam_true.ravel()), V.multiplier(lam_gpu.ravel())
                c_true, c_gpu = V.classify(m_true), V.classify(m_gpu)
                row.update(wrong=int(np.sum(c_true != c_gpu)), spurious_fatal=int(np.sum((c_gpu == 2) & (c_true < 2))),
                           missed_fatal=int(np.sum((c_gpu < 2) & (c_true == 2))), fatal=int(np.sum(c_true == 2)),
                           max_multiplier_error=float(np.max(np.abs(m_gpu - m_true))) if len(m_true) else 0.0)
            rows.append(row)
    if not rows:
        print(f'== {prefix}: no iterated solves captured')
        return rows
    err = np.array([r['force_error'] for r in rows])
    conv = [r for r in rows if r['converged']]
    q = lambda v, p: float(np.quantile(v, p)) if len(v) else math.nan
    ce = np.array([r['force_error'] for r in conv])
    print(f"== {prefix}: {len(rows)} iterated solves, {len(conv)} converged; force error vs truth: converged median {q(ce, .5):.1e} p90 {q(ce, .9):.1e} max {q(ce, 1):.1e}; "
          f"all median {q(err, .5):.1e} max {q(err, 1):.1e}")
    early = [r for r in conv if r['iterations'] <= 2]
    if early:
        ee = np.array([r['force_error'] for r in early])
        print(f"   converged within 2 iterations: {len(early)}, force error median {q(ee, .5):.1e} max {q(ee, 1):.1e}")
    if metadata is not None:
        print(f"   verdicts: {sum(r['wrong'] for r in rows)} wrong ({sum(r['spurious_fatal'] for r in rows)} spurious fatal, {sum(r['missed_fatal'] for r in rows)} missed) "
              f"of {sum(r['fatal'] for r in rows)} fatal; max multiplier error {max(r['max_multiplier_error'] for r in rows):.3g}")
    worst = sorted(rows, key=lambda r: -r['force_error'])[:3]
    for r in worst:
        print(f"   worst: solve {r['solve']} {'converged' if r['converged'] else 'capped'} at {r['iterations']}, force error {r['force_error']:.1e}")
    return rows


def summary_line(r):
    s = r['spectrum']
    parts = [f"solve {r['solve']} comp {r['component']}: {r['nodes']} nodes, {'anchored' if r['anchored'] else 'free'}"]
    if 'gpu' in r:
        g = r['gpu']
        parts.append(f"GPU {'converged' if g['converged'] else 'unconverged'} at {g['iterations']} ({g['residual_over_tolerance']:.3g}x tol, rotations {g['rotations']})")
    parts.append(f"kappa raw {s['kappa_raw']:.3g} jacobi {s['kappa_jacobi']:.3g} poly {s['kappa_polynomial']:.3g}")
    rp = r['replay']
    parts.append(f"replay fp64 {'conv' if rp['fp64']['converged'] else 'cap'} {rp['fp64']['iterations']}, fp32 {'conv' if rp['fp32']['converged'] else 'cap'} {rp['fp32']['iterations']}")
    if rp.get('first_iterations'):
        parts.append(f"fp32 replay vs GPU history (first {len(rp['first_iterations']['gpu'])}): max rel diff {rp['first_iterations']['max_relative_difference_fp32']:.2g}")
    if 'gpu_lambda_discrepancy' in r:
        parts.append(f"GPU lambda = lambda0 + B^T mu to {r['gpu_lambda_discrepancy']:.1e}")
    a = r.get('accuracy', {})
    if a.get('gpu_bond_residual_relative') is not None:
        parts.append(f"tolerance means {a['effective_bond_relative_tolerance']:.1e} of ||B^T b||; GPU reached {a['gpu_bond_residual_relative']:.1e}; "
                     f"GPU force error {a['gpu_lambda_relative_error']:.1e} overall, {a['gpu_lambda_max_bond_error']:.1e} worst bond (of the largest)")
    for level, row in (r.get('force_error_reached') or {}).items():
        parts.append(f"force error < {level} from iteration {row['iteration']} (native {row['native']:.3g}x, node {row['node_relative']:.1e}, step {row['step_relative']:.1e})" if row else f"force error never < {level}")
    if 'decisions' in r:
        d = r['decisions']
        parts.append(f"verdicts wrong {d['wrong']} (spurious fatal {d['spurious_fatal']}, missed {d['missed_fatal']}), max dm {d['max_multiplier_error']:.3g}")
        parts.append(f"verdicts settle at {r['decision_iterations']['verdicts_settle_at']}")
    return '; '.join(parts)


def self_test():
    # A free three-node chain with a balanced load (nothing net): converges,
    # the rigid basis is exactly null, the replay reproduces a dense solve.
    nodes = np.zeros(3, dtype=NODE)
    nodes['inertia'] = [[1, 1], [1.5, 2], [1, 1]]
    nodes['component'] = 7
    bonds = np.zeros(2, dtype=BOND)
    bonds['first'], bonds['second'] = [0, 1], [1, 2]
    bonds['offset0'], bonds['offset1'] = [[.5, 0, 0], [.5, .1, 0]], [[-.5, 0, 0], [-.5, -.1, 0]]
    bonds['scale'], bonds['health'] = [1, 2], 1
    load = np.array([[0, 0, 0, 0, 1, 0], [0, 0, 0, 0, -2, 0], [0, 0, 0, 0, 1, 0]], dtype=np.float32)
    nodes['rhs'] = load
    nodes['residual'] = load
    nodes['threshold'] = 1e-12

    class Fake:
        pass
    cap = Fake()
    cap.nodes, cap.bonds = nodes, bonds
    s = System(cap, 7)
    require(not s.anchored, 'free chain classified as anchored')
    V, energy, _ = s.rigid_basis(bonds)
    require(np.max(energy) < 1e-12, f'rigid modes of a tree are not null: {energy}')
    Q = s.projector(3, bonds)
    x = truth(s, Q)
    require(np.allclose(s.A @ x, project(Q, s.r0), atol=1e-10), 'truth does not solve the projected system')
    run = replay(s, Q, 1e-20, limit=200)
    require(run['converged'], 'replay failed on a well-posed free chain')
    # A corrupted warm residual is rejected.
    nodes2 = nodes.copy()
    nodes2['residual'][1, 4] += 1
    cap.nodes = nodes2
    try:
        System(cap, 7)
    except ValueError:
        pass
    else:
        raise ValueError('corrupted capture accepted')
    print('oracle self-test: free chain null modes, projected truth, replay convergence, corruption rejection passed')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('captures', nargs='*', type=Path, help='capture directories or .solve-N.json files')
    p.add_argument('--metadata', type=Path, help='vehicle metadata.json (bond strengths, names) for verdicts')
    p.add_argument('--fixtures', type=Path, help='vehicle build fixtures: metadata per car, by the capture prefix <scenario>-<car>')
    p.add_argument('--audit', action='store_true',
                   help='every captured solve, quickly: the GPU forces against the converged truth (no spectrum, replay or bench)')
    p.add_argument('--select', choices=['worst', 'breaks'], default='worst',
                   help='worst: the N largest GPU residuals; breaks: solves whose GPU forces give a fatal verdict (and the N worst)')
    p.add_argument('--limit', type=int, default=64, help='iteration cap of the replay (the product cap)')
    p.add_argument('--worst', type=int, default=3, help='analyse the N worst GPU solves per capture prefix')
    p.add_argument('--bench', action='store_true', help='also run the remedy bench')
    p.add_argument('--output', type=Path, help='write all results as JSON')
    p.add_argument('--self-test', action='store_true')
    args = p.parse_args()
    self_test()
    if args.self_test:
        return
    files = []
    for c in args.captures:
        files += sorted(c.glob('*.solve-*.json')) if c.is_dir() else [c]
    fixed = json.loads(args.metadata.read_text()) if args.metadata else None
    fixtures = {e['name']: e['metadataPath'] for e in json.loads(args.fixtures.read_text())} if args.fixtures else {}
    by_prefix = defaultdict(list)
    for f in files:
        by_prefix[f.name.rsplit('.solve-', 1)[0]].append(f)
    results = []
    for prefix, paths in sorted(by_prefix.items()):
        car = prefix.rsplit('-', 1)[-1]
        metadata = fixed if fixed is not None else (json.loads(Path(fixtures[car]).read_text()) if car in fixtures else None)
        chunks_path = paths[0].parent / f'{prefix}.chunks.json'
        chunk_rows = json.loads(chunks_path.read_text()) if chunks_path.exists() else None
        names = (lambda i: chunk_rows[i]['name']) if chunk_rows else (lambda i: f'node {i}')
        groups_of = None
        if metadata is not None and chunk_rows:
            motion = {k: (p.get('motion') or {}).get('corner') or 'body' for k, p in enumerate(metadata['parts'])}
            groups_of = lambda i: motion.get(chunk_rows[i]['node'], 'body')
        caps = [Capture(f) for f in paths]
        if args.audit:
            results += audit(prefix, caps, metadata)
            continue
        candidates = []
        for cap in caps:
            for identity in cap.component_ids():
                rec = cap.record(identity)
                # A settled component is not re-solved: its residual buffer is
                # the last solve's, not this system's.
                if rec is not None and rec['converged'] and rec['iterations'] == 0:
                    continue
                excess = (rec['residual2'] / rec['tolerance2']) if rec is not None and rec['tolerance2'] > 0 else 0
                candidates.append((-float(excess), cap.solve, cap, identity))
        candidates.sort(key=lambda c: (c[0], c[1]))
        chosen = candidates[:args.worst]
        if args.select == 'breaks' and metadata is not None:
            fatal = []
            for c in candidates:
                system = System(c[2], c[3])
                V = Verdicts(c[2], system, metadata)
                if np.any(V.classify(V.multiplier(c[2].lam[system.selected].ravel())) == 2):
                    fatal.append(c)
            print(f'   GPU fatal verdicts in solves {sorted(c[1] for c in fatal)}')
            chosen = sorted(fatal + [c for c in chosen if c not in fatal], key=lambda c: c[1])
        print(f'== {prefix}: {len(caps)} solves captured')
        for _, _, cap, identity in chosen:
            r = analyse(cap, identity, metadata, names, groups_of, args.limit, args.bench)
            r['prefix'] = prefix
            results.append(r)
            print('  ' + summary_line(r))
            for mode in r['spectrum']['slowest_polynomial'][:3]:
                print(f"     slow mode {mode['relative']:.2e} of the top: " + ', '.join(f"{c['chunk']} {c['share']:.0%}" for c in mode['chunks']))
                print("        deforms: " + '; '.join(f"{b['bond']} {b['share']:.0%} (w {b['scale']})" for b in mode['bonds']))
            if 'rigid_energy_relative_to_lambda_max' in r and r['rigid_energy_relative_to_lambda_max']:
                print('     rigid-mode energy / lambda_max: ' + ' '.join(f'{e:.1e}' for e in r['rigid_energy_relative_to_lambda_max']))
            if 'decisions' in r:
                for w in r['decisions']['worst'][:3]:
                    print(f"     verdict multiplier gpu {w['gpu']} vs truth {w['truth']}: {w['bond']}")
            if 'bench' in r:
                for name, b in r['bench'].items():
                    print(f"     bench {name}: {'converged' if b['converged'] else 'capped'} at {b['iterations']}, verdicts settle at {b['verdicts_settle_at']}")
    if args.output:
        args.output.write_text(json.dumps(results, indent=1, default=float))
        print(args.output)


if __name__ == '__main__':
    main()
