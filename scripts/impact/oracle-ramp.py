#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""The impact solve's ramp, continued in FP64 from a capped level to the full
load (a diagnostic oracle, never a runtime path): does the converged model
let the impactor through?

    PhysX destruction_impact_capture_replay CAPTURE.impc with IMPACT_DUMP=PREFIX
        writes PREFIX-island<id>.bin (the capped level's problem, see
        oracle-level.py) and PREFIX-island<id>.ramp.bin (the ramp's state)
    uv run scripts/impact/oracle-ramp.py PREFIX-island<id>.bin

The ramp as PxgDestructionImpact.cuh runs it (stepIslands), from the capped
solve's start: at level L the load fraction is lambda = min(1, first f^L);
the trial is T = J (no elastic increment once plastic, Settings::
elasticIncrementAfterYield false; an island with impactors is plastic from
its first level); the solve is oracle-level.py's problem with the node load
q = (1 - lambda) pb + lambda pf - r, solved exactly (Clarabel); then
u = M^-1 ((1 - lambda) pb + lambda pf + B J), r = M u; joints at capacity
(utilisation >= 1 - capacityBand) fail when brittle, and ductile ones at
the full load when their slip 1/2 |(B^T u)_lin| dt^2 plus their earlier
slip passes their ultimate slip; a failure re-solves the level, none moves
to the next level, and the full load with none publishes.
Reports each solve, the broken set, each contact's impulse and the
impactor's end velocity (u dt) against its start.
"""
import argparse, importlib.util, pathlib, sys, time
import numpy as np
import scipy.sparse as sp
import cvxpy as cp

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('oracle_level', HERE / 'oracle-level.py')
ol = importlib.util.module_from_spec(spec); spec.loader.exec_module(ol)
ALIVE, CONTACT, DUCTILE = ol.ALIVE, ol.CONTACT, ol.DUCTILE


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dump')
    ap.add_argument('--max-solves', type=int, default=400)
    ap.add_argument('--release-crushed', action='store_true',
                    help="remove the trial's stop by chunks the crush law crushed this tick from the impactor's load "
                         "(as the coupled rows' are): the stage pays their crush energy apart (payCrushEnergy)")
    a = ap.parse_args()
    d = ol.load(a.dump)
    rb = open(a.dump[:-4] + '.ramp.bin', 'rb').read()
    nn, nl, dt, band = d['nn'], d['nl'], d['dt'], d['band']
    head = np.frombuffer(rb, np.float32, 8, 0).astype(np.float64)
    first, factor, max_rounds, rounds, level, inc_after_yield = head[:6]
    rounds, level, max_rounds = int(rounds), int(level), int(max_rounds)
    assert inc_after_yield == 0, 'the elastic increment after yield is not ported'
    nodes = np.frombuffer(rb, np.float32, 18 * nn, 32).astype(np.float64).reshape(nn, 18)
    pb, pf, r = nodes[:, :6].reshape(-1), nodes[:, 6:12].reshape(-1), nodes[:, 12:18].reshape(-1)
    links = np.frombuffer(rb, np.float32, 2 * nl, 32 + 72 * nn).astype(np.float64).reshape(nl, 2)
    slip_limit, slip_before = links[:, 0], links[:, 1]
    index = {int(c): i for i, c in enumerate(d['node_chunk'])}
    # The contact rows: the uncoupled ones' trial forces stay in the impactor's load.
    rr = open(a.dump[:-4] + '.rows.bin', 'rb').read(); nrows = int(np.frombuffer(rr, np.uint32, 1, 0)[0])
    for i in range(nrows):
        off = 4 + 64 * i
        chunk, body, crushed = np.frombuffer(rr, np.uint32, 3, off)
        load, torque, vel, dv = (np.frombuffer(rr, np.float32, 3, off + 12 + 12 * k).astype(np.float64) for k in range(4))
        coupled = any(int(d['link_u'][l, 1]) == int(chunk) and (d['link_u'][l, 3] & CONTACT) for l in range(d['nl']))
        print(f"  row {i}: chunk {chunk}{' crushed' if crushed else ''}{' coupled' if coupled else ''}: trial stop {np.linalg.norm(load) * d['dt']:.4g} N s")
        if a.release_crushed and crushed and not coupled:
            n = [k for k in range(d['nn']) if d['node_tensor'][k]][0]
            pf_fix = np.zeros(6); pf_fix[:3] += load; pf_fix[3:] -= torque
            d.setdefault('pf_fix', []).append((n, pf_fix))
    for n, fix in d.get('pf_fix', []): pf[6 * n:6 * n + 6] += fix
    if d.get('pf_fix'): print(f"  released {len(d['pf_fix'])} crushed rows' stops from the impactor's load")
    # B (node rows by link columns) and the blocks per link for B^T u.
    rows, cols, vals = [], [], []
    for l in range(nl):
        _, c0, c1, _ = d['link_u'][l]
        for end, c in ((0, c0), (1, c1)):
            n = index.get(int(c))
            if n is None: continue
            blk = d['B'][l, 36 * end:36 * end + 36].reshape(6, 6)
            for k in range(6):
                for q in range(6):
                    if blk[k, q] != 0.0: rows.append(6 * n + k); cols.append(6 * l + q); vals.append(blk[k, q])
    Bm = sp.csr_matrix((vals, (rows, cols)), shape=(6 * nn, 6 * nl))
    # M^-1 and M^-1/2 per node.
    Mi = sp.lil_matrix((6 * nn, 6 * nn)); Sh = sp.lil_matrix((6 * nn, 6 * nn))
    for n in range(nn):
        f = d['node_f'][n]; im, ii = f[0], f[1]
        for k in range(3): Mi[6 * n + k, 6 * n + k] = im; Sh[6 * n + k, 6 * n + k] = np.sqrt(im)
        if d['node_tensor'][n]:
            I = ol.sym(f[2:8]); w, V = np.linalg.eigh(I); R = V @ np.diag(np.sqrt(np.maximum(w, 0))) @ V.T
            for i in range(3):
                for j in range(3): Mi[6 * n + 3 + i, 6 * n + 3 + j] = I[i, j]; Sh[6 * n + 3 + i, 6 * n + 3 + j] = R[i, j]
        else:
            for k in range(3): Mi[6 * n + 3 + k, 6 * n + 3 + k] = ii; Sh[6 * n + 3 + k, 6 * n + 3 + k] = np.sqrt(ii)
    Mi = Mi.tocsr(); Sh = Sh.tocsr()
    kk = d['link_f'][:, 9:13]; kfull = np.stack([kk[:, 0], kk[:, 0], kk[:, 0], kk[:, 1], kk[:, 2], kk[:, 3]], 1)
    contact = (d['link_u'][:, 3] & CONTACT) != 0; ductile = (d['link_u'][:, 3] & DUCTILE) != 0
    alive = (d['link_u'][:, 3] & ALIVE) != 0
    finite = np.isfinite(kfull) & (kfull < 1e30)
    wgt = np.where(finite, 1.0 / (np.where(finite, kfull, 1.0) * dt * dt), 0.0).reshape(-1)
    # The problem, parametrised (DPP) in the node load and the trial; rebuilt
    # when joints break (the live set).
    x = cp.Variable(6 * nl); X = cp.reshape(x, (nl, 6), order='C')
    qP = cp.Parameter(6 * nn); TP = cp.Parameter(6 * nl); scaleP = cp.Parameter(nonneg=True)
    obj = 0.5 * cp.sum_squares(Sh @ qP + (Sh @ Bm) @ x) + 0.5 * cp.sum_squares(cp.multiply(np.sqrt(wgt), x) - cp.multiply(np.sqrt(wgt), TP))
    J_ = np.where(~contact)[0]; C_ = np.where(contact)[0]
    obj = scaleP * obj
    def build(alive):
        cons = []
        dead = np.where(~alive)[0]
        if len(dead): cons.append(X[dead, :] == 0)
        Jl = np.where(alive & ~contact)[0]; Cl = np.where(alive & contact)[0]
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
    prob = build(alive)
    J = d['J'].copy(); J[~alive] = 0.0
    broken = []; solves = 0; lam_prev = None
    print(f"{a.dump}: {nn} nodes, {nl} links; ramp from level {level} (first {first:.4g}, factor {factor:g}), {rounds} rounds so far")
    while solves < a.max_solves:
        lam = min(1.0, first * factor ** level); final = lam >= 1.0
        qP.value = (1 - lam) * pb + lam * pf - r
        TP.value = J.reshape(-1)
        w0 = Sh @ (qP.value + Bm @ J.reshape(-1)); scaleP.value = 1.0 / max(1.0, 0.5 * float(w0 @ w0))
        t0 = time.time(); prob.solve(solver='CLARABEL', warm_start=True); solves += 1; rounds += 1
        if prob.status not in ('optimal', 'optimal_inaccurate'):
            print(f"  solve {solves}: level {level} lambda {lam:.4g}: {prob.status}"); return 1
        status, value = prob.status, prob.value / scaleP.value if prob.value is not None else None
        J = x.value.reshape(nl, 6).copy(); J[~alive] = 0.0
        u = Mi @ ((1 - lam) * pb + lam * pf + Bm @ J.reshape(-1))
        r = (1 - lam) * pb + lam * pf + Bm @ J.reshape(-1)   # M u
        newly = []
        for l in J_:
            if not alive[l]: continue
            if ol.utilisation(d['link_f'][l], J[l]) < 1 - band: continue
            fails = not ductile[l]
            if not fails and final:
                e = np.zeros(6)
                for end, c in ((0, d['link_u'][l, 1]), (1, d['link_u'][l, 2])):
                    n = index.get(int(c))
                    if n is None: continue
                    e += d['B'][l, 36 * end:36 * end + 36].reshape(6, 6).T @ u[6 * n:6 * n + 6]
                fails = slip_before[l] + 0.5 * np.linalg.norm(e[:3]) * dt * dt > slip_limit[l]
            if fails: newly.append(l)
        for l in newly: alive[l] = False; J[l] = 0.0; broken.append((l, lam))
        if newly: prob = build(alive)
        imp = [i for i in range(nn) if d['node_tensor'][i]]
        vend = [u[6 * n:6 * n + 3] * dt for n in imp]
        print(f"  solve {solves} (round {rounds}): level {level} lambda {lam:.4g}: {status}, objective {value:.6g}, {len(newly)} broken, {time.time() - t0:.1f} s;"
              f" impactor end velocity {' '.join(f'({v[0]:.2f} {v[1]:.2f} {v[2]:.2f})' for v in vend)} m/s", flush=True)
        if rounds >= max_rounds: print(f"  the round budget ({max_rounds}) is spent: E fails the evaluation here"); break
        if newly: continue
        if final: break
        level += 1
    total = np.zeros(3)
    for l in C_:
        F = d['B'][l, :36].reshape(6, 6) @ J[l]; total += F[:3] * dt
    print(f"  broken in this ramp: {len(broken)} joints: {sorted(int(d['link_u'][l, 0]) for l, _ in broken)}")
    print(f"  contact impulse on the struck chunks: ({total[0]:.5g} {total[1]:.5g} {total[2]:.5g}) N s, |.| {np.linalg.norm(total):.5g}")
    for n in [i for i in range(nn) if d['node_tensor'][i]]:
        m = 1.0 / d['node_f'][n, 0]; v = u[6 * n:6 * n + 3] * dt
        print(f"  impactor node {n} ({m:.0f} kg): end velocity ({v[0]:.3f} {v[1]:.3f} {v[2]:.3f}) m/s, |.| {np.linalg.norm(v):.3f} (relative to the struck cluster)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
