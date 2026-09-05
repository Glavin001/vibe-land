#!/usr/bin/env python3
"""Reproduce fidelity counters, original gate result and settling controls."""
import csv,gzip,io,json,re,statistics
from pathlib import Path
root=Path(__file__).resolve().parent

def read(path):
 return path.read_text() if path.exists() else gzip.open(str(path)+'.gz','rt').read()
def jsonread(path):return json.loads(read(path))
result={'audits':{},'settling_controls':{},'scope':'Exact-input contact checks are separate from legacy scenario expectations. Preserve failed gates; control trials do not recalibrate them.'}
for label,ticks in [('provenance-audit',900),('heavy-audit',1200)]:
 meta=jsonread(root/(label+'-run.json'))
 rows=[json.loads(x) for x in read(root/(label+'.jsonl')).splitlines()]
 csvrows=list(csv.DictReader(io.StringIO(read(root/(label+'.csv')))))
 assert meta['exit_code']==0 and len(rows)==ticks and len(csvrows)==ticks
 keys=('order_verify_checks','order_verify_mismatches','legacy_threshold_checks','legacy_threshold_mismatches','legacy_sum_max_ulp')
 audit={k:int(rows[-1]['physx/direct_contact_'+k]) for k in keys}
 audit.update(ticks=ticks,ambiguous_ticks=int(sum(r['physx/direct_contact_order_ambiguous'] for r in rows)),max_awake=max(r['awake'] for r in rows),max_contacts=max(r['physx/direct_contact_count'] for r in rows),replay_passes=sum(int(r['resim_passes']) for r in csvrows))
 assert audit['order_verify_mismatches']==audit['legacy_threshold_mismatches']==0
 log=read(root/(label+'.log'))
 assert not re.search(r'mismatches[=: ]+[1-9]',log)
 result['audits'][label]=audit
q=root/'qualification'
native=read(q/'native.log')
assert '100% tests passed, 0 tests failed out of 6' in native
result['native']={'passed':6,'failed':0,'manifest':jsonread(q/'native-run.json')}
log=read(q/'direct-full-tests-release.log')
counts=[tuple(map(int,m)) for m in re.findall(r'test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;',log)]
result['integration']={k:sum(t[i] for t in counts) for i,k in enumerate(('passed','failed','ignored'))}
assert result['integration']==dict(passed=176,failed=0,ignored=27)
meta=jsonread(q/'direct-scenario-release.json')
log=read(q/'direct-scenario-release.log')
measured=json.loads(re.search(r'^measured: (.*)$',log,re.M).group(1))
result['scenario']={'exit_code':meta['exit_code'],'measured':measured,'checks':[x.strip() for x in log.splitlines() if re.match(r'\s*(PASS|FAIL)\s',x)],'at_rest_total_bonds':int(re.search(r'bonds broken total: (\d+)',log).group(1)),'at_rest_final_third_bonds':int(re.search(r'broken in final third: (\d+)',log).group(1))}
for arm in ('cpu','gpu'):
 for trial in range(1,10):
  label=f'direct-collapse-release-{arm}-{trial}'
  path=q/(label+'.json')
  if not path.exists():continue
  meta=jsonread(path)
  if 'exit_code' not in meta:continue
  assert meta['exit_code']==0
  rows=list(csv.DictReader(io.StringIO(read(q/(label+'.csv')))))
  assert len(rows)==3600
  control={'binary_sha256':meta['record-city-trace_sha256'],'gpu_order':meta['env']['VIBE_PHYSX_GPU_CONTACT_ORDER'],'windows':{}}
  assert control['gpu_order']==('0' if arm=='cpu' else '1')
  for seconds in (40,60):
   prefix=[r for r in rows if 0<float(r['tick'])<seconds*60]
   tail=prefix[-300:]
   peak=max(float(r['awake']) for r in prefix)
   awake=statistics.median(float(r['awake']) for r in tail)
   retired=statistics.median(float(r['frozen'])+float(r['sleeping']) for r in tail)/max(float(prefix[-1]['bodies']),1)
   control['windows'][str(seconds)]={'awake_peak':peak,'awake_tail_median':awake,'awake_end_over_peak':round(awake/max(peak,1),3),'retired_fraction':round(retired,3),'final_bodies':float(prefix[-1]['bodies']),'final_bonds':float(prefix[-1]['bonds'])}
  result['settling_controls'][f'{arm}-{trial}']=control
result['settling_complete']=len(result['settling_controls'])==18
if result['settling_complete']:
 assert len({v['binary_sha256'] for v in result['settling_controls'].values()})==1
 result['settling_40s_gate_failures']={arm:sum(result['settling_controls'][f'{arm}-{i}']['windows']['40']['awake_end_over_peak']>.1 for i in range(1,10)) for arm in ('cpu','gpu')}
if result['settling_complete']:
 result['settling_60s_gate_failures']={arm:sum(result['settling_controls'][f'{arm}-{i}']['windows']['60']['awake_end_over_peak']>.1 for i in range(1,10)) for arm in ('cpu','gpu')}
(root/'qualification-summary.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ('native',)},indent=2))
