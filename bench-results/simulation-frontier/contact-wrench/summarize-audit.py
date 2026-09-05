#!/usr/bin/env python3
"""Reproduce observed contact invariants; do not equate relative gates with convergence."""
import csv,gzip,io,json,re
from pathlib import Path
root=Path(__file__).resolve().parent
q=root/'qualification'
def read(p):
 return p.read_text() if p.exists() else gzip.open(str(p)+'.gz','rt').read()
label='direct-audit-release-gpu-order'
meta=json.loads(read(q/(label+'.json')))
rows=[json.loads(l) for l in read(q/(label+'.jsonl')).splitlines()]
metrics=list(csv.DictReader(io.StringIO(read(q/(label+'.csv')))))
assert meta['exit_code']==0 and len(rows)==len(metrics)==900
assert meta['env']['VIBE_PHYSX_BONDLESS_HOIST_VERIFY']=='0'
fields=('wrench_checks','wrench_mismatches','wrench_max_force_error','wrench_max_moment_error','order_verify_checks','order_verify_mismatches','legacy_threshold_checks','legacy_threshold_mismatches','legacy_sum_max_ulp')
summary={'ticks':len(rows),'audit':{k:max(x['physx/direct_contact_'+k] for x in rows) for k in fields},'replay_passes':sum(int(r['resim_passes']) for r in metrics),'peak':{k:max(x[k] for x in rows) for k in ('awake','bodies','bonds','physx/direct_contact_count')}}
log=read(q/(label+'.log'))
assert not re.search(r'mismatches[=: ]+[1-9]',log,re.I)
assert summary['audit']['wrench_mismatches']==summary['audit']['order_verify_mismatches']==summary['audit']['legacy_threshold_mismatches']==0
# This diagnostic counts state-matched bodies whose pose comparison PREVENTED
# a skip; those bodies follow restoreBodyMotion. It is not a skipped-body error.
checks=re.findall(r'scoped skip: checked=\d+ moved=\d+ \(cumulative (\d+) / (\d+)\)',log)
summary['restore_pose_guard']={'checked':int(checks[-1][0]),'moved_and_restored':int(checks[-1][1])}
checks=re.findall(r'\[drain-parallel\] ticks=(\d+) calls=(\d+) mismatches=(\d+)',log)
summary['parallel_drain_last_report']=dict(zip(('ticks','calls','mismatches'),map(int,checks[-1])))
counts=[tuple(map(int,m)) for m in re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;',read(q/'direct-full-tests-release-cpu-order.log'))]
summary['integration']=dict(zip(('passed','failed','ignored'),map(sum,zip(*counts))))
summary['scenarios']={}
for order in ('cpu','gpu'):
 label=f'direct-scenario-release-{order}-order'
 meta=json.loads(read(q/(label+'.json'))); log=read(q/(label+'.log'))
 summary['scenarios'][order]={'exit_code':meta['exit_code'],'measurements':json.loads(re.search(r'^measured: (.*)$',log,re.M).group(1)),'checks':[s.strip() for s in log.splitlines() if re.match(r'\s*(PASS|FAIL)\s',s)],'at_rest_bonds':int(re.search(r'bonds broken total: (\d+)',log).group(1)),'at_rest_final_third_bonds':int(re.search(r'broken in final third: (\d+)',log).group(1))}
(root/'audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
