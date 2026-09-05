#!/usr/bin/env python3
import csv,gzip,io,json,statistics
from pathlib import Path
root=Path(__file__).resolve().parent/'settling-controls'
def read(p):return p.read_text() if p.exists() else gzip.open(str(p)+'.gz','rt').read()
runs={}
for arm in ('baseline','qualified'):
 for trial in range(1,4):
  label=f'{arm}-{trial}'
  meta=json.loads(read(root/(label+'-run.json')))
  rows=list(csv.DictReader(io.StringIO(read(root/(label+'.csv')))))
  assert len(rows)==3600 and meta['exit_code']==0
  def window(end):
   selected=[r for r in rows if 0<int(r['tick'])<end]
   tail=selected[-300:] # Same five-second median as scenario-suite.sh.
   peak=max(int(r['awake']) for r in selected)
   awake=statistics.median(int(r['awake']) for r in tail)
   return dict(peak=peak,tail_median_awake=awake,awake_ratio=awake/max(peak,1),guard_pass=awake/max(peak,1)<=.10,final_awake=int(selected[-1]['awake']),final_bonds=int(selected[-1]['bonds']))
  runs[label]={'40_seconds':window(2400),'60_seconds':window(3600),'metadata':meta}
(root/'summary.json').write_text(json.dumps({'scope':'Independent collapse trajectories; exact scenario five-second median at 40 and 60 simulated seconds. Failed bands remain failures; no setting was changed to force settling.','runs':runs},indent=2)+'\n')
for k,r in runs.items():print(k,{w:{f:v for f,v in r[w].items() if f!='metadata'} for w in ('40_seconds','60_seconds')})
