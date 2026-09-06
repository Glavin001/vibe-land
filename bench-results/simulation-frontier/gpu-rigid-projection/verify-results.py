#!/usr/bin/env python3
"""Check archived results; explicitly preserve the FAILED split release gate."""
from pathlib import Path
import hashlib,json,statistics
root=Path(__file__).resolve().parent
for name,entry in json.loads((root/'index.json').read_text()).items():
    data=(root/name).read_bytes()
    assert len(data)==entry['bytes'] and hashlib.sha256(data).hexdigest()==entry['sha256'],name

def rows(path):return [json.loads(s) for s in path.read_text().splitlines() if s.startswith('{')]
commands=json.loads((root/'projection-final/commands.json').read_text())
assert len(commands)==4 and all(c['exit']==0 for c in commands)
states=0
for c in commands:
    data=rows(root/'projection-final'/(c['name']+'.log'))
    projections=[r for r in data if 'projection_step' in r]
    assert len(projections)==12 and all(r['passed'] and r['projection_relative_error']<2e-11 for r in projections)
    assert data[-2]['stale_projector_rejected']
    assert data[-1]['stale_membership_rejected'] and data[-1]['half_response_rejected']
    if c['name']!='sanitizer-small':states+=len(projections)
assert states==36
summary=json.loads((root/'summary.json').read_text())
assert summary['production_release_gate_passed'] is False
commands=json.loads((root/'solve-final/commands.json').read_text())
assert len(commands)==12 and all(c['exit']==c['expected'] for c in commands)
static=0
for c in commands:
    data=rows(root/'solve-final'/(c['name']+'.log'));trials=[r for r in data if 'trial' in r]
    if len(trials)==4:
        assert all(r['passed'] for r in trials);static+=4
        assert summary['static_solves'][c['name']]['warm_median_cuda_ms']==statistics.median(r['cuda_solve_ms'] for r in trials[1:])
    else:
        updates=[r for r in data if 'topology_and_rhs_update_ms' in r]
        assert len(updates)==8 and all(not r['hierarchy_rebuilt'] and not r['coupling_reuploaded'] and not r['graph_recaptured'] for r in updates)
        if c['name'].startswith('sequence-'):
            assert len(trials)==16
            assert [r['trial'] for r in trials if not r['passed']]==[4,5]
            assert all(r['iterations']==256 and r['force_residual']>2e-7 for r in trials if not r['passed'])
        elif c['name']=='diagnostic-sequence-1024':
            assert len(trials)==16 and all(r['passed'] for r in trials)
            assert max(r['iterations'] for r in trials)==326
        else:
            assert c['name']=='incomplete-negative' and len(trials)==8
            assert [r['trial'] for r in trials if r['passed']]==[3]
assert static==32
for p in [root/'projection-final/sanitizer-small.log',root/'integrated-sanitizer.log']:
    text=p.read_text();assert 'ERROR SUMMARY: 0 errors' in text and '0 bytes leaked in 0 allocations' in text
reproduced=json.loads((root/'reference-reproduction.json').read_text())
assert reproduced['byte_identical']
assert reproduced['sha256']==json.loads((root/'fracture-sequence-manifest.json').read_text())['file_sha256']
city=json.loads((root/'city-after-validation.json').read_text())
assert city['binary_sha256']=='9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
assert city['settings']['VIBE_PHYSX_DIRECT_GPU']=='1' and city['settings']['VIBE_PHYSX_GPU_CONTACT_ORDER'] is None
assert city['settings']['VIBE_RELEASE_GAME_REVISION']=='ed9c2ad'
print('Evidence verified: 36 topology states, 32 static solves, memory checks, reference reproduction and restored city.')
print('RELEASE GATE FAILED: split does not converge at 256 iterations; 326-iteration diagnostic is not a performance qualification.')
