#!/usr/bin/env python3
"""Summarize repeat runs; compare like populations without claiming identical trajectories."""
import gzip,json,statistics
from pathlib import Path
root=Path(__file__).resolve().parent
def read(path):
 return path.read_text() if path.exists() else gzip.open(str(path)+'.gz','rt').read()
def stat(values):
 values=sorted(values)
 return dict(n=len(values),mean=statistics.mean(values),p50=values[(len(values)-1)//2],p95=values[int((len(values)-1)*.95)],p99=values[int((len(values)-1)*.99)]) if values else None
runs={}
for arm in ('baseline','candidate','final','qualified'):
 for trial in range(1,4):
  label=f'{arm}-{trial}'
  meta=json.loads(read(root/(label+'-run.json')))
  rows=[json.loads(l) for l in read(root/(label+'.jsonl')).splitlines()]
  assert len(rows)==600 and meta['exit_code']==0
  fields=['sim','physx','awake','bodies','bonds']+[k for k in rows[0] if k.startswith('physx/direct_')]
  groups={'all':rows,'awake_2000_4000':[r for r in rows if 2000<=r['awake']<4000], 'contacts_30000_60000':[r for r in rows if 30000<=r['physx/direct_contact_count']<60000]}
  runs[label]={'metadata':meta,'final':{k:rows[-1][k] for k in ['awake','bodies','bonds']},'groups':{g:{k:stat([r[k] for r in rs]) for k in fields} for g,rs in groups.items()}}
summary={'scope':'candidate and final denote rejected builds (kinematic and stationary-active query regressions); qualified denotes the inactive-only optimization. First physics-step spans plus complete simulation time, grid 2, 600 ticks. No encoder/transport capture. Independent trajectories; population bands are not matched replay states.', 'runs':runs,'median_trial_means':{}}
for group in ('all','awake_2000_4000','contacts_30000_60000'):
 summary['median_trial_means'][group]={arm:{k:statistics.median(runs[f'{arm}-{i}']['groups'][group][k]['mean'] for i in range(1,4)) for k in ['sim','awake','physx/direct_host_mirror_ms','physx/direct_contact_sort_ms','physx/direct_contact_count']} for arm in ('baseline','candidate','final','qualified')}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary['median_trial_means'],indent=2))
