#!/usr/bin/env python3
"""Check and summarize the retained v3 CUDA campaign; no GPU use."""
import hashlib
import json
from pathlib import Path
import statistics

root=Path(__file__).resolve().parent
cases=['anchored-double','anchored-mixed','free-double','free-mixed','reused-mixed','large-load-mixed','small-load-mixed']
summary={'scope':'Standalone CUDA stress-graph proof; not city performance or deployment qualification.','cases':{}}
for case in cases:
 path=root/'logs'/('multilevel-cuda-'+case+'-v3.log')
 rows=[json.loads(line) for line in path.read_text().splitlines() if line.startswith('{')]
 trials=[row for row in rows if 'trial' in row]
 assert len(trials)==4 and all(row['passed'] and not row['failed'] for row in trials),case
 summary['cases'][case]={'metadata':rows[0],'trials':trials,'median_warm_cuda_ms':statistics.median(row['cuda_solve_ms'] for row in trials[1:]),'phases':[row for row in rows if 'phase' in row],'log_sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
negative=[json.loads(line) for line in (root/'logs/multilevel-cuda-incomplete-negative-control-v3.log').read_text().splitlines() if line.startswith('{')][-1]
assert not negative['passed'] and negative['iterations']==1 and negative['failed']==0 and negative['force_residual']>1
summary['incomplete_solve_rejected']=negative
memory=(root/'logs/multilevel-cuda-memcheck-v3.log').read_text()
assert 'ERROR SUMMARY: 0 errors' in memory and '0 bytes leaked in 0 allocations' in memory
summary['memcheck']={'errors':0,'leaked_bytes':0,'timings_excluded':True}
fixtures=json.loads((root/'fixtures.json').read_text())
assert len(fixtures)==5 and all(row['sha256']==row['reproduced_sha256'] for row in fixtures)
summary['fixtures_reproduced_byte_for_byte']=5
summary['deployment_eligible']=False
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'passed_trials':28,'negative_control':'rejected as expected','memcheck_errors':0,'reproduced_fixtures':5,'median_warm_cuda_ms':{name:item['median_warm_cuda_ms'] for name,item in summary['cases'].items()}},indent=2))
