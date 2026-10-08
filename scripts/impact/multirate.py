#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""Multi-rate (asynchronous) explicit steps on the GPU step's own patches: sizing, stability and fidelity.

    uv run scripts/impact/multirate.py PATCH.exd [PATCH.exd ...] [--long-ticks 10] [--json OUT]

PATCH.exd: an explicit patch as its window starts, written by the PhysX capture replay
(IMPACT_EXPLICIT_DUMP=PREFIX; PREFIX-p<p>.exd, with PREFIX-p<p>.gpu, the GPU window's outcome).

The scheme (explicit-step.py run(levels=...)): every joint j gets a level L_j, the largest L with
2^L h0 omega~_j <= 0.9 x 2, i.e. omega~_j <= omega / 2^L for h0 = 0.9 x 2 / omega (the window's
bound), where omega~_j^2 = lambda_max(k^1/2 B_j^T (deg M^-1) B_j k^1/2) is the joint's element
frequency on split masses (each node's inverse mass times its live-joint count: by the element
eigenvalue theorem the assembled lambda_max is at most the largest such element's, so each joint
is stable on its own period). Joint j fires on the finest steps n with 2^L_j | n: its relative
displacement since its last firing from the nodes' displacement accumulators (u += h0 v each finest
step), then its law (trial, fracture, radial return); its force is held between firings. Rows and
nodes step every finest step.

The gate, per patch, against the uniform reference (every joint every step, h0) and that
reference's own spread (the same at h0 / 2):
  broken joints' Jaccard, the impactors' momentum change, the energy invariant (fracture + plastic
  <= impactors' KE loss + the joints' elastic energy at rest + the dead load's work), locality
  (median / max distance of the broken joints from the first contact), the break times' shift
  (quantisation to a joint's period), and stability: elastic runs (no fracture or yield) over
  --long-ticks ticks, E_dev = 1/2 v^T M v + 1/2 sum (J - J0)^2 / k, no growth (a resonance of
  commensurate steps, Fong, Darve & Lew 2008, would grow).
"""
import argparse, importlib.util, json, pathlib, sys
import numpy as np
import scipy.sparse as sp

H = pathlib.Path(__file__).resolve().parent
_s = importlib.util.spec_from_file_location('explicit_step', H / 'explicit-step.py')
xs = importlib.util.module_from_spec(_s); _s.loader.exec_module(xs)

LIVE, DUCTILE, BROKEN = 1, 2, 8
HELD = 0xffffffff


class ExDump:
    """An explicit patch (.exd) in the attributes explicit-step.py's Explicit reads."""

    def __init__(self, path):
        b = pathlib.Path(path).read_bytes(); o = 0
        def u32(n):
            nonlocal o; v = np.frombuffer(b, np.uint32, n, o).astype(np.int64); o += 4 * n; return v
        def f32(n):
            nonlocal o; v = np.frombuffer(b, np.float32, n, o).astype(np.float64); o += 4 * n; return v
        nn, nj, nr, _ = u32(4); dt, band, h, omega = f32(4)
        self.h_gpu, self.omega_gpu = h, omega
        chunk = np.zeros(nn, np.int64); tensor = np.zeros(nn, bool); im = np.zeros(nn); Iinv = np.zeros((nn, 6)); v = np.zeros((nn, 6))
        for i in range(nn):
            c, t = u32(2); f = f32(13); chunk[i], tensor[i] = c, bool(t); im[i] = f[0]; Iinv[i] = f[1:7]; v[i] = f[7:13]
        J = [(u32(4), f32(39)) for _ in range(nj)]; R = [(u32(2), f32(19)) for _ in range(nr)]
        assert o == len(b), 'dump size'
        nl = nj + nr; self.nn, self.nl, self.dt, self.band = nn, nl, dt, band
        self.index = {int(c): i for i, c in enumerate(chunk)}
        held = lambda l: int(2 ** 40 + l)   # a chunk id no node has: the end is held
        cid = lambda e, l: int(chunk[e]) if e != HELD else held(l)
        link_u = np.zeros((nl, 4), np.int64); link_f = np.zeros((nl, 14)); J0 = np.zeros((nl, 6)); comp = np.zeros((nl, 6))
        frames = np.zeros((nl, 15)); cen = np.zeros((nl, 3)); state = np.zeros(nl, np.int64)
        self.bond = np.full(nl, -1, np.int64); self.slip_before = np.zeros(nl); self.slip_limit = np.zeros(nl)
        for l, (u, f) in enumerate(J):
            link_u[l] = [l, cid(u[1], l), cid(u[2], l), 0]; self.bond[l] = u[0]; state[l] = u[3]
            frames[l] = f[:15]; kk = np.array([f[15], f[15], f[15], f[16], f[17], f[18]])
            kk = np.where((kk > 0) & (kk < 1e30), kk, 0.0); comp[l] = kk * dt * dt
            link_f[l, :9] = f[19:28]; link_f[l, 9:13] = f[15:19]; J0[l] = f[28:34]
            self.slip_before[l], self.slip_limit[l] = f[34], f[35]; cen[l] = f[36:39]
        for r, (u, f) in enumerate(R):
            l = nj + r; link_u[l] = [l, cid(u[0], l), cid(u[1], l), 0]; frames[l] = f[:15]; link_f[l, 13] = f[15]; cen[l] = f[16:19]
        self.joint = np.arange(nl) < nj; self.contact = ~self.joint
        self.alive0 = np.where(self.joint, (state & (LIVE | BROKEN)) != 0, True)
        self.ductile = self.joint & ((state & DUCTILE) != 0)
        self.comp, self.J0 = comp, J0
        self.d = dict(link_u=link_u, link_f=link_f, node_tensor=tensor, node_f=np.c_[im, Iinv[:, 0], Iinv, np.zeros((nn, 6))])
        # B: node dof <- link component, end 0 (+) and end 1 (-): a force q along R_q at the arm o
        # gives (s R_q, s o x R_q); a moment q gives (0, -s R_q) (exWrench)
        rows, cols, vals = [], [], []; blocks = np.zeros((nl, 72))
        for l in range(nl):
            Rq = frames[l, :9].reshape(3, 3)
            for e, c in ((0, link_u[l, 1]), (1, link_u[l, 2])):
                i = self.index.get(int(c)); sgn = 1.0 if e == 0 else -1.0
                o_ = frames[l, 9:12] if e == 0 else frames[l, 12:15]
                blk = np.zeros((6, 6))
                for q in range(3):
                    blk[:3, q] = sgn * Rq[q]; blk[3:, q] = sgn * np.cross(o_, Rq[q]); blk[3:, 3 + q] = -sgn * Rq[q]
                blocks[l, 36 * e:36 * e + 36] = blk.reshape(-1)
                if i is None: continue
                for a in range(6):
                    for q in range(6):
                        if blk[a, q] != 0.0: rows.append(6 * i + a); cols.append(6 * l + q); vals.append(blk[a, q])
        self.d['B'] = blocks
        self.B = sp.csr_matrix((vals, (rows, cols)), shape=(6 * nn, 6 * nl)); self.Bt = self.B.T.tocsr()
        Mi = np.zeros((6 * nn, 6 * nn)); M = np.zeros((6 * nn, 6 * nn))
        for i in range(nn):
            Mi[6 * i:6 * i + 3, 6 * i:6 * i + 3] = np.eye(3) * im[i]
            if tensor[i]:
                S = Iinv[i]; T = np.array([[S[0], S[3], S[4]], [S[3], S[1], S[5]], [S[4], S[5], S[2]]])
            else:
                T = np.diag(Iinv[i, :3])
            Mi[6 * i + 3:6 * i + 6, 6 * i + 3:6 * i + 6] = T
            M[6 * i:6 * i + 3, 6 * i:6 * i + 3] = np.eye(3) / im[i] if im[i] > 0 else 0.0
            M[6 * i + 3:6 * i + 6, 6 * i + 3:6 * i + 6] = np.linalg.pinv(T)
        self.Mi, self.M = sp.csr_matrix(Mi), sp.csr_matrix(M)
        self.mass = np.where(im > 0, 1.0 / np.where(im > 0, im, 1.0), 0.0)
        self.imp = [i for i in range(nn) if tensor[i]] or [0]
        self.v_init = v.reshape(-1); self.v0 = v[self.imp[0], :3].copy(); self.m_imp = self.mass[self.imp[0]]
        self.cen = cen; self.hit = cen[nj] if nr else cen[:nj].mean(0)
        self.tensor = tensor

    def dist(self, links):
        return np.array([np.linalg.norm(self.cen[int(self.d['link_u'][l, 0])] - self.hit) for l in links])


def element_levels(X, P, omega):
    """Each joint's level: the largest L with omega~_j <= omega / 2^L (omega~_j: its element on split masses)."""
    live = P.alive0 & P.joint & X.inpatch
    deg = np.zeros(P.nn)
    for l in np.where(live)[0]:
        for c in P.d['link_u'][l, 1:3]:
            i = P.index.get(int(c))
            if i is not None: deg[i] += 1
    Mi = X.Mi.tocsr(); L = np.zeros(P.nl, np.int64); w = np.zeros(P.nl)
    for l in np.where(live)[0]:
        A = np.zeros((6, 6)); k = X.k[l]; sk = np.sqrt(k)
        for e in (0, 1):
            i = P.index.get(int(P.d['link_u'][l, 1 + e]))
            if i is None: continue
            Bl = P.d['B'][l, 36 * e:36 * e + 36].reshape(6, 6)
            mi = Mi[6 * i:6 * i + 6, 6 * i:6 * i + 6].toarray() * deg[i]
            A += Bl.T @ mi @ Bl
        A = sk[:, None] * A * sk[None, :]
        w[l] = np.sqrt(max(np.linalg.eigvalsh(A).max(), 0.0))
        Ll = 0
        while Ll < 10 and w[l] * (1 << (Ll + 1)) <= omega: Ll += 1
        L[l] = Ll
    return L, w


def summary(P, X, R, h, label):
    imp = [i for i in range(P.nn) if P.tensor[i]]
    v = R['v'].reshape(P.nn, 6); v0 = P.v_init.reshape(P.nn, 6)
    dp = float(np.sum([P.mass[i] * np.linalg.norm(v[i, :3] - v0[i, :3]) for i in imp]))
    Mt = P.M.tocsr()
    ke = lambda vv, nodes: sum(0.5 * float(vv[i] @ (Mt[6 * i:6 * i + 6, 6 * i:6 * i + 6].toarray() @ vv[i])) for i in nodes)
    ke_in, ke_out = ke(v0, imp), ke(v, imp)
    k = X.k; u0 = 0.5 * float(np.sum(np.where(k > 0, P.J0 ** 2 / np.where(k > 0, k, 1.0), 0.0)[P.joint & P.alive0 & X.inpatch]))
    deficit = R['brittle_energy'] + R['plastic_work'] > (ke_in - ke_out) + u0 + max(R['dead'], 0.0) + 1e-9
    broken = sorted(R['broke_at']); dist = P.dist(broken) if broken else np.zeros(1)
    return dict(label=label, h_us=h * 1e6, steps=R['steps'], joint_updates=int(R['fired']) if R['fired'] else int(R['steps'] * (P.joint & P.alive0).sum()),
                broken=[int(P.bond[l]) for l in broken], times={int(P.bond[l]): R['broke_at'][l] for l in broken}, n_broken=len(broken),
                dp=dp, ke_in=ke_in, ke_out=ke_out, fracture=R['brittle_energy'], plastic=R['plastic_work'], dead=R['dead'], u0=u0,
                deficit=bool(deficit), med_m=float(np.median(dist)), max_m=float(np.max(dist)))


def jac(a, b):
    a, b = set(a), set(b); return len(a & b) / max(1, len(a | b))


def growth(edev):
    """E_dev's largest value over the last third of the run against the first third's."""
    if len(edev) < 6: return float('nan')
    e = np.array([x[1] for x in edev]); n = len(e) // 3
    return float(e[-n:].max() / max(e[:n].max(), 1e-30))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('dumps', nargs='+'); ap.add_argument('--long-ticks', type=float, default=10.0)
    ap.add_argument('--json'); ap.add_argument('--fp64', action='store_true')
    a = ap.parse_args(); out = []
    for path in a.dumps:
        P = ExDump(path)
        X = xs.Explicit(P, dtype=np.float64 if a.fp64 else np.float32, cone='coulomb'); X.jacobi = True
        T = P.dt; h0 = P.h_gpu; omega = 0.9 * 2.0 / h0
        wb = X.omega_bound()
        L, w = element_levels(X, P, omega)
        live = P.alive0 & P.joint & X.inpatch
        lv = np.bincount(L[live], minlength=8)[:8]
        work = float(np.sum(2.0 ** -L[live]) / max(1, live.sum()))
        print(f'{pathlib.Path(path).name}: {P.nn} nodes, {int(live.sum())} joints, {int(P.contact.sum())} rows; h0 {h0 * 1e6:.2f} us (GPU bound {P.omega_gpu:.4g}, harness {wb:.4g} rad/s); '
              f'element omega~ max {w.max():.4g}; levels {list(map(int, lv))}; joint work {work:.3f} of uniform', flush=True)
        ref = summary(P, X, X.run(T, h0), h0, 'reference')
        half = summary(P, X, X.run(T, h0 / 2), h0 / 2, 'h/2')
        mr = summary(P, X, X.run(T, h0, levels=L), h0, 'multirate')
        gpu = pathlib.Path(path[:-4] + '.gpu')
        gb = []
        if gpu.exists():
            g = gpu.read_bytes(); n = int(np.frombuffer(g, np.uint32, 1, 0)[0]); gb = [int(x) for x in np.frombuffer(g, np.uint32, 2 * n, 4)[0::2]]
        common = set(ref['times']) & set(mr['times'])
        shift = np.array([abs(mr['times'][b] - ref['times'][b]) for b in common]) * 1e3 if common else np.zeros(1)
        for r in (ref, half, mr):
            print(f"  {r['label']:9s} h {r['h_us']:6.2f} us, {r['steps']} steps, joint updates {r['joint_updates']}: broken {r['n_broken']}, dp {r['dp']:.1f} N s, "
                  f"med/max {r['med_m']:.2f}/{r['max_m']:.2f} m; energy: KE {r['ke_in']:.4g} -> {r['ke_out']:.4g} J, fracture {r['fracture']:.4g}, plastic {r['plastic']:.4g}, dead {r['dead']:.4g}, deficit {r['deficit']}", flush=True)
        print(f"  Jaccard: reference vs h/2 {jac(ref['broken'], half['broken']):.3f}; reference vs multirate {jac(ref['broken'], mr['broken']):.3f}"
              + (f"; harness reference vs GPU {jac(ref['broken'], gb):.3f} ({len(gb)} broken on the GPU)" if gpu.exists() else '')
              + f"; break-time shift on the {len(common)} in both: median {np.median(shift):.3f} ms, max {shift.max():.3f} ms", flush=True)
        # stability: elastic (no fracture, no yield) over long windows
        el_ref = X.run(a.long_ticks * T, h0, elastic=True, energy_every=10, record=())
        el_mr = X.run(a.long_ticks * T, h0, levels=L, elastic=True, energy_every=10, record=())
        g_ref, g_mr = growth(el_ref['edev']), growth(el_mr['edev'])
        print(f"  stability ({a.long_ticks:g} ticks, elastic): E_dev late/early max, reference {g_ref:.3f}, multirate {g_mr:.3f}", flush=True)
        out.append(dict(dump=path, levels=list(map(int, lv)), work=work, reference=ref, half=half, multirate=mr, gpu_broken=gb,
                        jac_half=jac(ref['broken'], half['broken']), jac_mr=jac(ref['broken'], mr['broken']), shift_med_ms=float(np.median(shift)),
                        shift_max_ms=float(shift.max()), growth_ref=g_ref, growth_mr=g_mr,
                        edev_ref=el_ref['edev'][::10], edev_mr=el_mr['edev'][::10]))
    if a.json: pathlib.Path(a.json).write_text(json.dumps(out, indent=1, default=float))


if __name__ == '__main__':
    sys.exit(main())
