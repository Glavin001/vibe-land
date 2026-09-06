#!/usr/bin/env python3
"""Keep attribution distinct from a qualified optimization or deterministic replay."""
import csv,gzip,hashlib,io,json,statistics
from pathlib import Path
root=Path(__file__).resolve().parent
s=json.loads((root/'summary.json').read_text())
assert s['city_release_ready'] is False and s['optimization_enabled_in_city'] is False
assert s['adaptive_aim'] is True and s['identical_shot_inputs_verified'] is False
assert s['independent_processes_per_profile_arm']==1
for name,digest in s['evidence_sha256'].items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,name
runs={}
for label,expected in s['cases'].items():
 p=root/label
 rows=list(csv.DictReader(io.StringIO(gzip.decompress((p/'metrics.csv.gz').read_bytes()).decode())))
 assert [int(r['tick']) for r in rows]==list(range(1200))
 replay=[r for r in rows if float(r['resim_passes'])>0]
 assert len(replay)==expected['replay_ticks']
 assert statistics.median(float(r['resim_restore']) for r in replay)==expected['restore_ms_replay_median']
 assert max(int(r['awake']) for r in rows)==expected['max_awake']
 assert statistics.mean(float(r['sim']) for r in rows)==expected['simulation_wall_ms_mean']
 assert statistics.mean(float(r['cpu_ms']) for r in rows)==expected['process_cpu_ms_mean']
 profiles=[json.loads(l) for l in gzip.decompress((p/'native.log.gz').read_bytes()).decode().splitlines() if l.startswith('{"resim_restore_profile"')]
 assert len(profiles)==expected['profile_rows']==4*len(replay)
 large=[r for r in profiles if r['restored']>=1000]
 assert len(large)==expected['large_restore_rows']
 for key,total in expected['large_restore_sums'].items():assert sum(r[key] for r in large)==total
 for r in profiles:
  assert r['restored']+r['skipped']==r['captured']
  assert sum(r[k] for k in ('pose_ms','velocity_ms','clears_ms','sleep_ms'))<=r['bodies_ms']+1e-7
 runs[label]=json.loads((p/'run.json').read_text())
 assert runs[label]['exit_code']==0 and runs[label]['profile']=='1'
 assert runs[label]['simulation_env']['VIBE_PHYSX_DIRECT_GPU']=='1'
 assert runs[label]['game_diff_sha256']==runs[label]['solver_diff_sha256']==hashlib.sha256(b'').hexdigest()
a,b=runs['profile-off'],runs['profile-on']
for key in ('binary_sha256','game_revision','solver_revision','scene_sha256','simulation_env'):assert a[key]==b[key]
assert a['batch']=='0' and b['batch']=='1'
assert json.loads((root/'profile-off/scenario.json').read_text())!=json.loads((root/'profile-on/scenario.json').read_text())
for flag in ('0','1'):
 assert 'resim snapshot test passed' in (root/f'cpu-snapshot-{flag}.log').read_text()
 for kind,count in [('cpu-bench',65),('gpu',6001)]:
  rows=[json.loads(l) for l in (root/f'{kind}-{flag}.log').read_text().splitlines() if l.startswith('{"restore_bench"')]
  assert [r['trial'] for r in rows]==list(range(12))
  assert all(r['bodies']==count and r['height']==10 for r in rows)
state=json.loads((root/'city-state.json').read_text())
assert state['exe_sha256']=='9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
assert state['flags']['VIBE_PHYSX_DIRECT_GPU']=='1'
assert state['flags']['BLAST_RESIM_BATCH_CUDA_CONTEXT'] is None
assert state['flags']['BLAST_RESIM_PROFILE'] is None
assert 'BLAST_RESTORE_BENCH_CUDA_CONTEXT_CHECKS' in gzip.decompress((root/'native-bench-flags.make.gz').read_bytes()).decode()
v=json.loads((root/'city-verification.json').read_text())
assert v['local_http']==v['public_https']=='passed'
assert v['browser']['ok'] and v['browser']['transport']=='webtransport' and v['browser']['errors']==[]
assert v['browser']['city']['rendered'] and v['browser']['city']['chunksTotal']==96420
assert v['browser']['city']['structureRepairs']==v['browser']['city']['hashMismatches']==0
assert v['browser']['publicUdpVerified'] is False
assert json.loads((root/'failed-native-profiler-run.json').read_text())['exit_code']==143
print('PASS: context lifecycle/replay checks and attribution verified. NO QUALIFIED SPEEDUP; NOT A CITY RELEASE PASS.')
