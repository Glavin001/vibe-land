#!/usr/bin/env python3
"""Phase 1 gate: GPU (both flags, a converged diagnostic solve) vs the CPU oracle.

    QUALIFY_TARGET_DIR=... python3 oracle_gate.py OUT_DIR PACK[:part,part] ...
"""
import os, subprocess, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../perf'))
import qualify_structures as q

_run = q.subprocess.run
_last = {}
def _stash(*a, **k):
    r = _run(*a, **k)
    _last['text'] = (r.stdout or '') + (r.stderr or '') if k.get('capture_output') else ''
    return r
q.subprocess.run = _stash

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
binary = q.build()
here = os.path.dirname(os.path.abspath(__file__))
with tempfile.TemporaryDirectory(prefix='oracle-gate-') as tmp:
    for spec in sys.argv[2:]:
        path, _, only = spec.partition(':')
        only = set(only.split(',')) if only else None
        path = os.path.abspath(path)
        for name, part, anchors, nodes, label in q.split(path, tmp):
            if only and name not in only:
                continue
            rows = os.path.join(out, f'{label}.rows.json'.replace('/', '_'))
            # GATE_UNBREAKABLE=1: the GPU runs a copy whose limits are 1e6x, so
            # its rows are the intact solve; the oracle keeps the real limits.
            gpu_part = part
            if os.environ.get('GATE_UNBREAKABLE') == '1':
                import json
                pack = json.load(open(part))
                for m in pack['defaults']['solver']['materials']:
                    for k in list(m):
                        if k.endswith('Elastic') or k.endswith('Fatal'):
                            m[k] = m[k] * 1e6
                gpu_part = os.path.join(tmp, os.path.basename(part).replace('.json', '--unbreakable.json'))
                json.dump(pack, open(gpu_part, 'w'))
            os.environ['VIBE_QUALIFY_BOND_ROWS'] = rows
            pct, broken, awake, detail = q.qualify(binary, gpu_part, int(os.environ.get('GATE_TICKS', '30')), os.environ.get('GATE_SOLVER_ENV', 'default'))
            print(f'== {label}: GPU broken {broken}% at rest, {detail}', flush=True)
            if 'no verdict' in detail:
                print('\n'.join(l for l in _last.get('text', '').splitlines()[-15:] if 'warning' not in l), flush=True)
            if os.path.exists(rows):
                for snap in os.environ.get('GATE_SNAPSHOTS', '0').split(','):
                    subprocess.run(['uv', 'run', os.path.join(here, 'oracle_compare.py'), part, rows, '--snapshot', snap], check=False)
