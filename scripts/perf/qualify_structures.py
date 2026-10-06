#!/usr/bin/env python3
"""Does each structure in a scene converge at rest? One at a time, a few seconds each.

    scripts/perf/qualify_structures.py [--ticks 300] [--max-unconverged 10] PACK|SCENE ...

A scene pack is split into its structures by node group -- `building@juniper-house`
and its furniture `sink-4@juniper-house` are one structure, `juniper-house`;
ungrouped nodes (streets, footings) are `ground`; a pack without groups is one
structure -- and each is qualified alone (structure_qualification.rs
`city_structures_qualify`) for `--ticks` server ticks at rest, under the native
app's stress settings. A structure whose stress solve does not converge keeps
the GPU solving it every idle tick (the stage skips only converged ones), so the
unconverged share is one test, PASS at or under --max-unconverged percent.
It is per tick, not per solve: unconverged solves over the ticks at rest, so
one component that never converges is 100% however many converged fences and
chairs (each its own component, each solved every tick) sit beside it -- the
per-solve share hid exactly that (a bare bungalow 99%, fenced 35%, furnished
12%). It is what the GPU repeats every idle tick: 100% is one component
re-solved every tick. The other is that it stands: a structure can converge and fall down
(Bayline's billboard), so bonds broken at rest must stay at or under
--max-broken percent of its bonds (0.5%, the authored-structure gate in
authored_structures_sim.rs).

SCENE is a file in destruction/assets/scenes (e.g. `parking-garage`); PACK is a
path. Structures with no anchor (free-standing props) are listed and skipped:
there is nothing to stress-solve at rest. Takes the GPU lock per structure.

Measured 2026-10-05 (5 s each, per tick): the default city building
converges in <= 2 iterations; Bayline's porch houses ~110% (their house never
converges), the town-kit bungalow 99%, the skyline houses 0.7-2.3%.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCENES = os.path.join(ROOT, 'destruction', 'assets', 'scenes')
TARGET = os.path.join(ROOT, 'target', 'qualify-structures')
PHYSX_ROOT = os.environ.get('PHYSX_ROOT', os.path.join(os.path.dirname(ROOT), 'PhysX', 'out', 'install', 'garage-multihull'))
# The native app's stress settings (sim-native/src/city.rs apply_app_defaults).
APP_ENV = {
    'VIBE_NATIVE_STRESS_FORCE_TOLERANCE': '0.001',
    'BLAST_STRESS_INCREMENTAL_MOTION': '1',
    'PX_DESTRUCTION_INCREMENTAL_TOPOLOGY': '1',
    'BLAST_STRESS_BALANCED_OPERATOR': '1',
}


def structure_of(group):
    """`building@juniper-house` -> `juniper-house`; ungrouped -> `ground`."""
    return group.split('@', 1)[1] if '@' in group else 'ground'


def split(pack_path, out_dir):
    """Write one pack per structure; returns [(name, path, anchors, nodes, label)]."""
    pack = json.load(open(pack_path))
    s = pack['scenario']
    groups = s.get('nodeGroups') or ['ground'] * len(s['nodes'])
    names = sorted({structure_of(g) for g in groups})
    stem = os.path.splitext(os.path.basename(pack_path))[0]
    if len(names) == 1:
        anchors = sum(1 for n in s['nodes'] if n['mass'] == 0)
        return [(stem, pack_path, anchors, len(s['nodes']), stem)]
    out = []
    for name in names:
        keep = [i for i, g in enumerate(groups) if structure_of(g) == name]
        remap = {old: new for new, old in enumerate(keep)}
        part = json.loads(json.dumps({k: v for k, v in pack.items() if k != 'scenario'}))
        part['scenario'] = {}
        for key, value in s.items():
            if isinstance(value, list) and len(value) == len(s['nodes']):
                part['scenario'][key] = [value[i] for i in keep]
            elif key == 'bonds':
                part['scenario'][key] = [dict(b, node0=remap[b['node0']], node1=remap[b['node1']])
                                         for b in value if b['node0'] in remap and b['node1'] in remap]
            else:
                part['scenario'][key] = value
        nodes = part['scenario']['nodes']
        if not any(n['mass'] > 0 for n in nodes):
            continue  # static only: nothing to solve
        path = os.path.join(out_dir, f'{stem}--{name}.json')
        json.dump(part, open(path, 'w'))
        kinds = sorted({g.split('@')[0].rstrip('-0123456789') for g in part['scenario']['nodeGroups']})
        label = kinds[0] if name.startswith('gardens-market') or name.startswith('prop') else name
        out.append((name, path, sum(1 for n in nodes if n['mass'] == 0), len(nodes), label))
    return out


def build():
    """The test binary holding city_structures_qualify, built against the app's SDK."""
    env = dict(os.environ, PHYSX_ROOT=PHYSX_ROOT, CARGO_TARGET_DIR=TARGET)
    result = subprocess.run(
        ['cargo', 'test', '-p', 'web-fps-server', '--release', '--features', 'native-destruction',
         '--no-run', '--message-format=json'],
        cwd=ROOT, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr[-4000:])
        sys.exit('build failed')
    for line in result.stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        exe = message.get('executable')
        if exe and os.path.basename(exe).startswith('web_fps_server-'):
            listed = subprocess.run([exe, '--list', '--ignored'], capture_output=True, text=True).stdout
            if 'city_structures_qualify' in listed:
                return exe
    sys.exit('no test binary with city_structures_qualify')


def qualify(binary, pack_path, ticks, solver_env='app'):
    """(unconverged % per tick, broken %, awake bodies, detail)."""
    env = dict(os.environ, **(APP_ENV if solver_env == 'app' else {}),
               VIBE_CITY_SCENE=pack_path, VIBE_CITY_GRID='1', VIBE_CITY_VARIED_HEIGHTS='0',
               VIBE_QUALIFY_REST_TICKS=str(ticks), VIBE_QUALIFY_IMPACT_TICKS='0',
               VIBE_DESTRUCTION_ASSET_DIR=SCENES,
               # Alone: the city world otherwise parks two stock cars on its
               # spawn ring, at (+-r, +-8) -- inside Vibe Town's cafe-143 and
               # mailbox-69, which then failed only where those cars stood.
               VIBE_CITY_VEHICLES='0',
               CUMETAL_CACHE_DIR=os.path.join(ROOT, 'target', 'cumetal-cache-vehicles'))
    result = subprocess.run(
        [os.path.join(ROOT, 'scripts', 'perf', 'gpu-run.sh'), 'qualify-structures', binary,
         'city_structures_qualify', '--ignored', '--nocapture', '--test-threads=1'],
        cwd=os.path.join(ROOT, 'server'), env=env, capture_output=True, text=True)
    text = result.stdout + result.stderr
    stands = re.search(r'stands at rest: broken bonds (\d+) of (\d+) \(([\d.]+)%\), awake bodies (\d+)', text)
    broken = float(stands.group(3)) if stands else None
    awake = int(stands.group(4)) if stands else None
    rest = re.search(r'at rest: ((?!broken).*)', text)
    if rest is None:
        return None, broken, awake, 'no verdict (see a run by hand)'
    line = rest.group(1)
    if line.startswith('converges'):
        return 0.0, broken, awake, line
    m = re.match(r'(\d+) of (\d+) solves unconverged', line)
    # The first tick at rest is the settling solve, not one at rest.
    return (100.0 * int(m.group(1)) / max(1, ticks - 1) if m else None), broken, awake, line


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('packs', nargs='+')
    parser.add_argument('--ticks', type=int, default=300, help='server ticks at rest per structure (300 = 5 s)')
    parser.add_argument('--max-unconverged', type=float, default=10.0, help='PASS at or under this percent')
    parser.add_argument('--max-broken', type=float, default=0.5, help='PASS at or under this percent of bonds broken at rest')
    parser.add_argument('--solver-env', choices=['app', 'default'], default='app',
                        help="the native app's stress settings (default), or the solver's own defaults")
    parser.add_argument('--only', help='comma list: qualify only these structures of a split pack')
    parser.add_argument('--json', help='also write the results here')
    args = parser.parse_args()

    binary = build()
    results = []
    with tempfile.TemporaryDirectory(prefix='qualify-structures-') as tmp:
        for spec in args.packs:
            # Absolute: the qualification runs from server/, so a relative pack path would not resolve.
            path = os.path.abspath(spec) if os.path.exists(spec) else os.path.join(SCENES, spec if spec.endswith('.json') else spec + '.json')
            only = set(args.only.split(',')) if args.only else None
            for name, part, anchors, nodes, label in split(path, tmp):
                if only and name not in only:
                    continue
                if anchors == 0:
                    results.append({'pack': spec, 'structure': name, 'label': label, 'nodes': nodes,
                                    'verdict': 'FREE', 'unconverged_pct': None, 'broken_pct': None, 'awake_bodies': None,
                                    'detail': 'no anchor: a free body, nothing to solve at rest'})
                else:
                    pct, broken, awake, detail = qualify(binary, part, args.ticks, args.solver_env)
                    if pct is None or broken is None:
                        verdict = 'ERROR'
                    elif pct > args.max_unconverged:
                        verdict = 'FAIL'
                    elif broken > args.max_broken:
                        verdict = 'FALLS'
                    else:
                        verdict = 'PASS'
                    results.append({'pack': spec, 'structure': name, 'label': label, 'nodes': nodes,
                                    'verdict': verdict, 'unconverged_pct': pct, 'broken_pct': broken,
                                    'awake_bodies': awake, 'detail': detail})
                r = results[-1]
                pct = '-' if r['unconverged_pct'] is None else f"{r['unconverged_pct']:.1f}%"
                brk = '-' if r['broken_pct'] is None else f"{r['broken_pct']:.2f}%"
                print(f"{r['verdict']:5} unconv {pct:>6} broken {brk:>6}  {r['structure'][:26]:26} {r['label'][:14]:14} {r['nodes']:6} chunks  {r['detail'][:70]}", flush=True)
    if args.json:
        json.dump(results, open(args.json, 'w'), indent=1)
    failed = [r for r in results if r['verdict'] in ('FAIL', 'FALLS', 'ERROR')]
    print(f"{len(results) - len(failed)} of {len(results)} structures pass "
          f"(<= {args.max_unconverged}% unconverged, <= {args.max_broken}% bonds broken, over {args.ticks} ticks at rest)")
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
