#!/usr/bin/env python3
"""Validate retained evidence only; never starts a server or GPU workload."""
from pathlib import Path
import hashlib,json,statistics
root=Path(__file__).resolve().parent
for name,entry in json.loads((root/'index.json').read_text()).items():
    data=(root/name).read_bytes()
    assert len(data)==entry['bytes'] and hashlib.sha256(data).hexdigest()==entry['sha256'],name
summary=json.loads((root/'summary.json').read_text())
for variant in ['initial-fullwarp','final']:
    commands=json.loads((root/variant/'commands.json').read_text())
    assert len(commands)==12 and all(c['exit']==c['expected'] for c in commands)
    solves=transitions=0
    for command in commands:
        text=(root/variant/(command['name']+'.log')).read_text()
        rows=[json.loads(line) for line in text.splitlines() if line.startswith('{')]
        trials=[r for r in rows if 'trial' in r]
        if command['name']=='incomplete-negative':
            assert command['expected']==1 and len(trials)==1 and not trials[0]['passed']
        elif trials:
            assert len(trials)==4 and all(r['passed'] for r in trials)
            assert all(r['force_residual']<2e-7 and r['moment_residual']<2e-7 for r in trials)
            assert summary[variant][command['name']]['warm_median_cuda_ms']==statistics.median(r['cuda_solve_ms'] for r in trials[1:])
            solves+=len(trials)
        else:
            states=[r for r in rows if 'step' in r]
            assert len(states)==12 and all(r['passed'] and r['operator_relative_error']<2e-11 and r['bond_relative_error']<2e-11 for r in states)
            assert rows[-1]['stale_membership_rejected'] and rows[-1]['half_response_rejected']
            assert rows[-1]['completed_graph_preserves_output'] and rows[-1]['empty_cases_passed']
            if command['name'].startswith('transitions-'):transitions+=len(states)
            else:assert 'ERROR SUMMARY: 0 errors' in text and '0 bytes leaked in 0 allocations' in text
    assert solves==32 and transitions==24
city=json.loads((root/'city-after-validation.json').read_text())
assert city['binary_sha256']=='9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
assert city['settings']['VIBE_PHYSX_DIRECT_GPU']=='1' and city['settings']['VIBE_PHYSX_GPU_CONTACT_ORDER'] is None
assert city['settings']['VIBE_RELEASE_GAME_REVISION']=='ed9c2ad'
print('PASS: final 24 transitions, 16 resident + 16 control solves, negative controls, memory check and restored city; initial experiment retained.')
