#!/usr/bin/env python3
"""Verify the deployed streaming change without claiming physics performance."""
from pathlib import Path
import gzip,hashlib,json,re
root=Path(__file__).resolve().parent
s=json.loads((root/'summary.json').read_text())
assert s['deployed'] and s['simulation_performance_claim'] is False
assert s['public_udp_verified'] is False
for name,digest in s['evidence_sha256'].items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,name
for name,count in [('outbound-tests.log.gz',7),('snapshot-tests.log.gz',10)]:
 log=gzip.decompress((root/name).read_bytes()).decode()
 assert f'test result: ok. {count} passed; 0 failed' in log
assert 'real_webtransport_datagrams_progress_while_peer_stalls_reliable_reads ... ok' in gzip.decompress((root/'outbound-tests.log.gz').read_bytes()).decode()
q=json.loads((root/'qualification.json').read_text())
d=json.loads((root/'deployment.json').read_text())
assert q['passed'] and d['passed'] and q['sha256']==d['sha256']==s['live_binary_sha256']
assert all(t['exit_code']==0 for t in q['tests'])
assert d['simulation_env_changes']=={}
assert d['previous_sha256']=='9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
for name in ['private-bootstrap.json','private-destruction.json']:
 b=json.loads((root/name).read_text());c=b['city']
 assert b['ok'] and b['transport']=='webtransport' and b['errors']==[]
 assert c['rendered'] and c['chunksTotal']==96420
 assert all(c[k]==0 for k in ['topoSeqGaps','structureRepairs','hashMismatches','orphanedChunks','orphanedByRetire','settleRejects'])
b=json.loads((root/'private-destruction.json').read_text());c=b['city']
assert b['shotsFired']-b['before']['shotsFired']==4
assert c['brokenBonds']==945 and c['brokenBonds']>b['before']['city']['brokenBonds']
assert c['hashChecks']>b['before']['city']['hashChecks'] and c['datagramsReceived']==364
assert c['chunksBelowGround']==2 and c['minChunkY'] < -0.75 and c['deepest'] is None
m=json.loads((root/'private-metrics.json').read_text())
assert m['physics_backend']=='physx_gpu' and m['physics_gpu_active']
assert m['physics_gpu_warning_count']==0
assert all(m['network'][k]==0 for k in ['dropped_outbound_packets','dropped_outbound_snapshots','malformed_packets','datagram_fallbacks'])
e=json.loads((root/'server-events.json').read_text())
hits=[line for line in e['lines'] if 'city shot routing' in line]
assert len(hits)==3 and all('shots=1 hits=1' in line for line in hits)
assert len(e['lines'])==3
v=d['verification'];b=v['browser'];c=b['city']
assert v['local_http']==v['public_https']=='passed'
assert b['ok'] and b['transport']=='webtransport' and b['errors']==[]
assert c['rendered'] and c['chunksTotal']==96420 and c['structureRepairs']==c['hashMismatches']==0
assert b['publicUdpVerified'] is False
state=json.loads((root/'live-state.json').read_text());f=state['flags']
assert state['exe_sha256']==f['VIBE_RELEASE_BINARY_SHA256']==s['live_binary_sha256']
assert f['VIBE_PHYSX_DIRECT_GPU']=='1'
assert f['BLAST_RESIM_PROFILE'] is None and f['BLAST_RESIM_BATCH_CUDA_CONTEXT'] is None
assert f['VIBE_RELEASE_GAME_REVISION']==s['release_game_commit']
assert f['VIBE_RELEASE_SOLVER_REVISION']==s['release_solver_commit']
print('PASS: streaming qualification and deployment verified; below-ground readings retained; no physics-speed claim.')
