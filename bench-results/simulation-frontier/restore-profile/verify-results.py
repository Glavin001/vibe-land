#!/usr/bin/env python3
"""Verify attribution evidence, keeping the unresolved numerical case visible."""
from pathlib import Path
import hashlib,json,statistics,re
root=Path(__file__).resolve().parent
s=json.loads((root/'summary.json').read_text())
assert s['city_release_ready'] is False
assert s['independent_processes_per_arm']==1
for name,digest in s['evidence_sha256'].items():
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest
for name,expected in s['cases'].items():
    lines=(root/name).read_text().splitlines()
    rows=[json.loads(l) for l in lines if l.startswith('{')]
    bench=[r for r in rows if r.get('restore_bench')]
    profiles=[r for r in rows if r.get('resim_restore_profile')]
    assert [r['trial'] for r in bench]==list(range(12))
    assert all(r['bodies']==expected['bodies'] and r['height']==10 for r in bench)
    assert statistics.median(r['restore_ms'] for r in bench[2:])==expected['restore_ms_median']
    assert not any('mismatch' in l or 'failed' in l for l in lines)
    if profiles:
        assert len(profiles)==12
        for p in profiles:
            assert p['captured']==p['current']==p['restored']==p['cleared_bodies']==expected['bodies']
            assert p['skipped']==p['rederived']==0
            assert p['restored_shapes']==(expected['bodies']-1)*2
            assert all(v>=0 for k,v in p.items() if k.endswith('_ms'))
            assert sum(p[k] for k in ('preparation_ms','bodies_ms','children_ms'))<=p['total_ms']+1e-7
            assert sum(p[k] for k in ('pose_ms','velocity_ms','clears_ms','sleep_ms'))<=p['bodies_ms']+1e-7
    else:
        assert name=='gpu-unprofiled.log'
for name in ('cpu-snapshot-profiled.log','cpu-snapshot-unprofiled.log'):
    assert 'resim snapshot test passed' in (root/name).read_text()
profiled=[json.loads(l) for l in (root/'cpu-snapshot-profiled.log').read_text().splitlines() if l.startswith('{')]
assert any(r['rederived']==5 and r['skipped']==1 for r in profiled)
assert 'resim_restore_profile' not in (root/'cpu-snapshot-unprofiled.log').read_text()
known=(root/'gpu-coordinate-failure.log').read_text()
error=float(re.search(r'position=([0-9.e+-]+)',known)[1])
assert error==s['known_failure']['position_error_m'] and error>0.0002
assert 'linear=0 angular=0' in known
assert 'replayed motion differs from one effective step' in known
assert 'Original city deployment restored and healthy' in known
state=json.loads((root/'city-state.json').read_text())
assert state['exe_sha256']==state['release_env']['VIBE_RELEASE_BINARY_SHA256']=='9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
assert state['release_env']['VIBE_PHYSX_DIRECT_GPU']=='1'
assert state['release_env']['BLAST_RESIM_PROFILE'] is None
v=json.loads((root/'city-verification.json').read_text())
assert v['local_http']==v['public_https']=='passed'
assert v['browser']['ok'] and v['browser']['transport']=='webtransport'
assert v['browser']['errors']==[]
assert v['browser_city']['rendered'] and v['browser_city']['chunksTotal']==96420
assert v['browser']['publicUdpVerified'] is False
print('PASS: restore attribution and motion checks verified; known coordinate failure retained. NOT A CITY RELEASE PASS.')
