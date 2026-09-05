#!/usr/bin/env python3
"""Summarize same-binary trials without treating chaotic trajectories as matched states."""
import gzip,json,statistics
from pathlib import Path
root=Path(__file__).resolve().parent
def read(path):
 return path.read_text() if path.exists() else gzip.open(str(path)+'.gz','rt').read()
def stat(values):
 values=sorted(values)
 return dict(n=len(values),mean=statistics.mean(values),p50=values[(len(values)-1)//2],p95=values[int((len(values)-1)*.95)],p99=values[int((len(values)-1)*.99)],max=values[-1]) if values else None
runs={}
for campaign,ticks in [('',600),('heavy-',1200)]:
 for arm in ('cpu','gpu'):
  for trial in range(1,4):
   label=f'{campaign}{arm}-{trial}'
   if not (root/(label+'-run.json')).exists(): continue
   meta=json.loads(read(root/(label+'-run.json')))
   rows=[json.loads(l) for l in read(root/(label+'.jsonl')).splitlines()]
   assert len(rows)==ticks and meta['exit_code']==0
   assert meta['env']['VIBE_PHYSX_GPU_CONTACT_ORDER_VERIFY']=='0'
   for row in rows:
    row['ordering_ms']=row['physx/direct_contact_sort_ms']+row['physx/direct_contact_gpu_order_ms']
    row['contact_pipeline_ms']=sum(row['physx/direct_contact_'+phase+'_ms'] for phase in ('copy','ownership','validate','sort','gpu_order','reduce','route'))
   fields=['sim','physx','awake','bodies','bonds','ordering_ms','contact_pipeline_ms']+[k for k in rows[0] if k.startswith('physx/direct_')]
   groups={'all':rows,
    'awake_2000_4000':[r for r in rows if 2000<=r['awake']<4000],
    'awake_5000_7000':[r for r in rows if 5000<=r['awake']<7000],
    'contacts_30000_60000':[r for r in rows if 30000<=r['physx/direct_contact_count']<60000],
    'contacts_80000_120000':[r for r in rows if 80000<=r['physx/direct_contact_count']<120000]}
   runs[label]={'metadata':meta,'final':{k:rows[-1][k] for k in ['awake','bodies','bonds']},'groups':{g:{k:stat([r[k] for r in rs]) for k in fields} for g,rs in groups.items()}}
summary={'scope':'CPU is the legacy four-key std::sort; GPU adds source-pair provenance to formerly unspecified ties. First-step spans and whole simulation, no encoder/transport. Same binary and physics settings, independent trajectories; population bands are not identical replay states.','runs':runs,'median_trial_means':{}}
fields=['sim','physx','awake','bodies','bonds','ordering_ms','contact_pipeline_ms','physx/direct_contact_count','physx/direct_contact_sort_ms','physx/direct_contact_gpu_order_ms','physx/direct_contact_order_ambiguous']
for campaign in ('','heavy-'):
 labels=[f'{campaign}{arm}-{i}' for arm in ('cpu','gpu') for i in range(1,4)]
 if not all(l in runs for l in labels): continue
 assert len({runs[l]['metadata']['binary_sha256'] for l in labels})==1
 configs=[{k:v for k,v in runs[l]['metadata']['env'].items() if k != 'VIBE_PHYSX_GPU_CONTACT_ORDER'} for l in labels]
 assert all(c == configs[0] for c in configs), 'Physics settings differ between performance arms'
 for l in labels:
  assert runs[l]['metadata']['env']['VIBE_PHYSX_GPU_CONTACT_ORDER'] == ('0' if 'cpu-' in l else '1')
 for group in ('all','awake_2000_4000','awake_5000_7000','contacts_30000_60000','contacts_80000_120000'):
  by_arm={}
  for arm in ('cpu','gpu'):
   trials=[runs[f'{campaign}{arm}-{i}']['groups'][group] for i in range(1,4)]
   if all(t['sim'] for t in trials):
    by_arm[arm]={k:statistics.median(t[k]['mean'] for t in trials) for k in fields}
  if len(by_arm)==2: summary['median_trial_means'][campaign+group]=by_arm
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary['median_trial_means'],indent=2))
