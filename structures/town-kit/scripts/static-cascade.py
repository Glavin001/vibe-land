#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Quasi-static progressive failure of an authored structure, on the CPU.

stress-share.py answers "where does the load go"; this answers "what follows
once something is past its capacity". Each round is the engine's at-rest rule
under the high profile (VIBE_STRENGTH_SHORT_TERM: a bond holds below its fatal
limit and breaks at it): the converged min-norm solve of stress-share.py
(--bending section --angular section, the engine's high-profile model), every
bond past fatal broken at once, every piece no longer connected to an anchor
dropped (it falls), and solve again, until a round breaks nothing.

It is a static proxy: no inertia, no impact, no debris landing on anything.
A structure that stands here can still fall dynamically (a sudden removal
overshoots in a real structure, though not on the stage: rigid chunks store
no strain energy), and a cascade here is the elastic answer to "and then?".

    uv run structures/town-kit/scripts/static-cascade.py PACK [--rounds 40] [--structural TYPES]

Prints per round the bonds broken by connection kind and member pair (the
first round's in full, with their utilisation), and at the end the share of
the structural members' mass still anchored.
"""
import argparse, collections, importlib.util, json, os, sys
import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('stress_share', os.path.join(here, 'stress-share.py'))
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)

# veneer-houses.mjs STRUCTURAL_TYPES (the frame) when the pack's metadata does not say.
FRAME = {'foundation', 'stud', 'king-stud', 'jack-stud', 'cripple-stud', 'junction-stud', 'bottom-plate', 'top-plate',
         'top-plate-lower', 'top-plate-upper', 'header', 'sill-trimmer', 'rim-joist', 'ceiling-joist', 'floor-joist',
         'rafter', 'ridge-board', 'gable-frame'}


def anchored(n, bonds, alive, fixed):
    """Nodes connected to a fixed node through live bonds."""
    adj = collections.defaultdict(list)
    for b, bd in enumerate(bonds):
        if alive[b]: adj[bd['node0']].append(bd['node1']); adj[bd['node1']].append(bd['node0'])
    seen = np.zeros(n, bool); stack = [i for i in range(n) if fixed[i]]
    for i in stack: seen[i] = True
    while stack:
        i = stack.pop()
        for j in adj[i]:
            if not seen[j]: seen[j] = True; stack.append(j)
    return seen


def cascade(pack_path, rounds=40, bending='section', angular='section', structural=FRAME, quiet=False):
    pack, s, mats, pos, mass = ss.load(pack_path)
    sections = ss.bond_sections(s)
    if angular == 'section': sections = ss.fastener_twist(s, mats, sections)
    n, bonds = len(s['nodes']), s['bonds']
    fixed = mass == 0
    alive = np.ones(len(bonds), bool)
    t = s['nodeTypes']
    frame_mass = sum(mass[i] for i in range(n) if t[i] in structural)
    history = []
    for r in range(rounds):
        keep = anchored(n, bonds, alive, fixed)
        live = [b for b in range(len(bonds)) if alive[b] and keep[bonds[b]['node0']] and keep[bonds[b]['node1']]]
        sub = dict(s); sub['bonds'] = [bonds[b] for b in live]
        m2 = np.where(keep, mass, 0.0)
        J, resid = ss.solve(sub, mats, pos, m2, None, angular=angular, sections=[sections[b] for b in live])
        st = ss.stresses(sub, mats, J, bending=bending, sections=[sections[b] for b in live], pos=pos)
        over = [(live[k], st[k]) for k in range(len(live)) if st[k][1] > 1.0]
        anchored_frame = sum(mass[i] for i in range(n) if t[i] in structural and keep[i]) / max(frame_mass, 1e-9)
        history.append({'round': r, 'live': len(live), 'broken': len(over), 'residual': float(resid), 'frameAnchored': anchored_frame,
                        'bonds': [{'bond': b, 'kind': mats[bonds[b]['m']]['name'], 'pair': sorted((t[bonds[b]['node0']], t[bonds[b]['node1']])),
                                   'fatal': float(x[1]), 'centroid': [bonds[b]['centroid'][k] for k in 'xyz']} for b, x in sorted(over, key=lambda q: -q[1][1])]})
        if not quiet:
            kinds = collections.Counter(f"{h['kind']} {'/'.join(h['pair'])}" for h in history[-1]['bonds'])
            print(f"round {r}: {len(live)} live bonds, {len(over)} past fatal, frame anchored {anchored_frame:.3f} (residual {resid:.1e})")
            if r == 0:
                for h in history[-1]['bonds'][:25]:
                    c = h['centroid']
                    print(f"    {h['fatal']:7.2f} x fatal  {h['kind']:24} {'/'.join(h['pair']):34} at ({c[0]:.2f}, {c[1]:.2f}, {c[2]:.2f})")
            for k, c in kinds.most_common(8): print(f"    {c:4}  {k}")
        if not over: break
        for b, _ in over: alive[b] = False
    keep = anchored(n, bonds, alive, fixed)
    final = sum(mass[i] for i in range(n) if t[i] in structural and keep[i]) / max(frame_mass, 1e-9)
    broken = int((~alive).sum())
    if not quiet: print(f"total: {broken} bonds broken over {len(history)} rounds; frame anchored {final:.3f}")
    return {'broken': broken, 'frameAnchored': final, 'rounds': history}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('pack'); p.add_argument('--rounds', type=int, default=40)
    p.add_argument('--bending', choices=['capped', 'section'], default='section')
    p.add_argument('--angular', choices=['uniform', 'section'], default='section')
    p.add_argument('--json', help='write the rounds here')
    a = p.parse_args()
    out = cascade(a.pack, a.rounds, a.bending, a.angular)
    if a.json: json.dump(out, open(a.json, 'w'))


if __name__ == '__main__':
    main()
