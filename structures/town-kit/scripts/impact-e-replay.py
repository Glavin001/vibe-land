#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""The impact study's first contact tick, as a problem for the native GPU stage's
impact-capacity solve (E), and the oracle's answer to compare it with. A test
oracle, never a runtime path: the engine is the native GPU stage only.

    uv run structures/town-kit/scripts/impact-e-replay.py export PACK OUT_DIR [--scenario NAME ...]
        writes OUT_DIR/NAME.impe (the problem: the bungalow, the tick's loads,
        the elastic solutions at rest and under the tick's load, in the stage's
        conventions) and OUT_DIR/NAME.oracle.json (E's verdict from
        impact-study.py's verdict_plastic, uncoupled, on the same problem)
    PhysX destruction_impact_replay OUT_DIR/NAME.impe OUT_DIR/NAME.gpu
        runs the stage's solve on it (a GPU test binary, see
        physx/source/gpudestruction/tests/impact_replay.cu)
    uv run structures/town-kit/scripts/impact-e-replay.py compare PACK OUT_DIR/NAME
        the two verdicts side by side: bonds broken, frame bonds, overlap

The problem is the oracle's with one change: each chunk's inertia is the
stage's scalar (the trace of its tensor over 3, as physx-bridge passes it), in
both the export and the oracle's run, so the two solve the same equations.
"""
import argparse, importlib.util, json, pathlib, struct, sys, time
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('impact_study', HERE / 'impact-study.py')
study = importlib.util.module_from_spec(spec); spec.loader.exec_module(study)


def first_tick(st, imp):
    alive = np.ones(st.n, bool); active = np.ones(st.m, bool)
    pts, near = imp.contacts(st, alive, 1e9)
    s = min(near[k] for k in pts) - 1e-3
    contacts, _ = imp.contacts(st, alive, s + imp.u * study.DT)
    return active, alive, contacts, imp.M * imp.u / study.DT


def stage_wrench(st, k, J):
    """Oracle bond wrench (J_lin on node1 at the centroid, couple J_ang on node1)
    -> the stage's (lin: force on chunk0 = min node, at the solver's application
    point P; ang: the couple on chunk1, so chunk0 gets -ang)."""
    b0, b1 = st.b0[k], st.b1[k]; c = st.bc[k]
    c0, c1 = min(b0, b1), max(b0, b1)
    sign = -1.0 if c0 == b0 else 1.0           # oracle force on chunk0
    F0 = sign * J[k, :3]; C0 = sign * J[k, 3:]
    m0, m1 = st.mass[c0] > 0, st.mass[c1] > 0
    P = 0.5 * (st.pos[c0] + st.pos[c1]) if (m0 and m1) else c
    return F0, -C0 + np.cross(P - c, F0)


def export(a):
    st = study.Structure(a.pack)
    st.inertia[:] = st.inertia.mean(1, keepdims=True)   # the stage's scalar inertia
    # Evidence runs (the oracle is not ground truth): the oracle with the
    # problem's tie stiffness in its elastic tie-break, and/or its ramp refined.
    authored_w = st.w.copy(); oracle_w = st.w.copy()
    if a.oracle_tie_stiffness:
        oracle_w[np.array([m == 'wall-tie' for m in st.bmat])] = np.sqrt(a.tie_stiffness / 30e9)
    if a.oracle_ramp:
        study.RAMP, study.RAMP_LEVELS = a.oracle_ramp[0], int(a.oracle_ramp[1])
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    sc = study.scenarios()
    for name in a.scenario or ['cannonball', 'truck', 'truck-corner', 'meteor', 'small+0.86']:
        imp = sc[name]
        active, alive, contacts, total = first_tick(st, imp)
        sol = study.Solver(st, active, alive)
        zero = np.zeros((st.n, 3))
        Jg, _ = sol.solve(study.gravity_loads(st), zero)
        Fc, Tc, Xc = study.contact_loads(st, contacts, total, imp.d)
        F = study.gravity_loads(st) + Fc
        Jf, _ = sol.solve(F, Tc)
        t0 = time.time()
        st.w = oracle_w   # the elastic solves above keep the authored weights (the stress solve's)
        v = None if a.problem_only else study.verdict_plastic(st, active.copy(), alive.copy(), dict(contacts), total, imp.d, np.zeros(st.n), False)
        st.w = authored_w
        wall = time.time() - t0
        L = float(st.Ls)
        with open(out / f'{name}.impe', 'wb') as f:
            f.write(struct.pack('<4sIIII', b'IMPE', 1, st.n, st.m, st.m))
            f.write(struct.pack('<ff', study.DT, 3.0))
            for i in range(st.n):
                I = float(st.inertia[i, 0]) if st.mass[i] > 0 else 0.0
                f.write(struct.pack('<11f', *st.pos[i], float(st.mass[i]), I, *F[i], *Tc[i]))
            for k in range(st.m):
                f.write(struct.pack('<4f', st.cF[k], st.tF[k], st.sF[k], 0.0 if st.brittle[k] else study.ULTIMATE_SLIP))
            for k in range(st.m):
                b0, b1 = st.b0[k], st.b1[k]; c0, c1 = min(b0, b1), max(b0, b1)
                n = st.pos[c1] - st.pos[c0]; nrm = st.bn[k] * (1.0 if np.dot(st.bn[k], n) >= 0 else -1.0)
                w = st.w[k]
                if a.tie_stiffness and st.bmat[k] == 'wall-tie':
                    w = np.sqrt(a.tie_stiffness / 30e9)   # k = 30 GPa w^2
                f.write(struct.pack('<3I8f', c0, c1, k, *st.bc[k], *nrm, st.ba[k], w))
            for J in (Jg, Jf):
                for k in range(st.m):
                    lin, ang = stage_wrench(st, k, J)
                    f.write(struct.pack('<6f', *lin, *ang))
            f.write(struct.pack('<f', L))
        if v is None:
            print(f"{name}: problem written (oracle kept)", flush=True); continue
        # The oracle's final joint forces (stage convention) and each chunk's
        # post-tick velocity (its momentum over its mass), for diagnosis.
        with open(out / f'{name}.oracle.bin', 'wb') as f:
            for k in range(st.m):
                lin, ang = stage_wrench(st, k, v['J'])
                f.write(struct.pack('<6f', *lin, *ang))
            rows = st.row
            for i in range(st.n):
                if st.free[i]:
                    q = 6 * rows[i]; mom = v['momentum'][q:q + 6]
                    f.write(struct.pack('<6f', *(mom[:3] / st.mass[i]), *(mom[3:] / np.maximum(st.inertia[i], 1e-9))))
                else:
                    f.write(struct.pack('<6f', *([0.0] * 6)))
        util = study.utilisation(st, Jf)
        rec = dict(scenario=name, n=st.n, m=st.m, contacts=len(contacts), totalForce=total,
                   elasticPastCapacity=int((util >= 1).sum()),
                   broken=[int(k) for k in np.nonzero(v['broken'])[0]],
                   yielded=[int(k) for k in np.nonzero(v['yielded'])[0]],
                   structural=[int(k) for k in np.nonzero(st.structural_bond)[0]],
                   solves=v['solves'], seconds=round(wall, 1))
        json.dump(rec, open(out / f'{name}.oracle.json', 'w'))
        print(f"{name}: {len(contacts)} contact chunks, {total/1e6:.2f} MN; elastic past capacity {rec['elasticPastCapacity']}; "
              f"oracle E broken {len(rec['broken'])} (frame {int(st.structural_bond[v['broken']].sum())}), "
              f"yielded {len(rec['yielded'])}, {v['solves']} solves, {wall:.0f} s", flush=True)


def compare(a):
    st = study.Structure(a.pack)
    base = pathlib.Path(a.base)
    oracle = json.load(open(str(base) + '.oracle.json'))
    raw = open(str(base) + '.gpu', 'rb').read()
    m = st.m
    verdict = np.frombuffer(raw[:4 * m], dtype='<u4')
    gpu_broken = verdict == 3; gpu_yield = verdict == 2
    ob = np.zeros(m, bool); ob[oracle['broken']] = True
    oy = np.zeros(m, bool); oy[oracle['yielded']] = True
    frame = st.structural_bond
    both = (ob & gpu_broken).sum(); union = (ob | gpu_broken).sum()
    dist = np.linalg.norm(st.bc - study.scenarios()[oracle['scenario']].aim, axis=1)
    def far(x): return int((x & (dist > 4)).sum())
    # In kind: what is left standing once the damaged house settles under
    # gravity (the study's own settle and summary), from each verdict.
    def standing(broken):
        active, alive, _ = study.settle(st, ~broken, np.ones(st.n, bool))
        held, _ = study.held_nodes(st, active, alive)
        sm = np.array([t in study.STRUCTURAL for t in st.types]) & st.free
        roof = np.array([t in study.ROOF for t in st.types])
        return float(st.mass[sm & held].sum() / st.mass[sm].sum()), float(st.mass[roof & held].sum() / st.mass[roof].sum())
    of, orf = standing(ob); gf, grf = standing(gpu_broken)
    print(f"{oracle['scenario']}: oracle broken {ob.sum()} (frame {int((ob & frame).sum())}, >4 m {far(ob)}), "
          f"GPU broken {gpu_broken.sum()} (frame {int((gpu_broken & frame).sum())}, >4 m {far(gpu_broken)}); "
          f"both {both}, Jaccard {both / max(union, 1):.2f}; yielded oracle {oy.sum()} GPU {gpu_yield.sum()}; "
          f"after settling frame held {of:.2f} / {gf:.2f}, roof held {orf:.2f} / {grf:.2f} (oracle / GPU)")
    return dict(scenario=oracle['scenario'], oracle=int(ob.sum()), gpu=int(gpu_broken.sum()),
                oracleFrame=int((ob & frame).sum()), gpuFrame=int((gpu_broken & frame).sum()), jaccard=both / max(union, 1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    e = sub.add_parser('export'); e.add_argument('pack'); e.add_argument('out'); e.add_argument('--scenario', nargs='*')
    e.add_argument('--problem-only', action='store_true', help='rewrite the .impe only, keep the oracle files')
    e.add_argument('--tie-stiffness', type=float, help="the wall ties' stiffness (N/m) in the problem's weights")
    e.add_argument('--oracle-tie-stiffness', action='store_true', help="the oracle's elastic tie-break with the same tie stiffness (needs --tie-stiffness)")
    e.add_argument('--oracle-ramp', type=float, nargs=2, help="the oracle's ramp factor and levels (default 2 9: from 1/256)")
    c = sub.add_parser('compare'); c.add_argument('pack'); c.add_argument('base')
    a = ap.parse_args()
    export(a) if a.cmd == 'export' else compare(a)


if __name__ == '__main__':
    main()
