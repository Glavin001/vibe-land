"""Summarize immutable raw reports; never turn completion into qualification."""
import json,collections
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]/'out/reviews/house-cannonball';rows=[]
structural={'frame-post','frame-beam','roof-post','roof-ridge','roof-rafter','floor','ceiling','stair'}
for file in sorted(ROOT.glob('*/report.json')):
 report=json.loads(file.read_text());pack=json.loads((file.parent/'asset.json').read_text());s=pack['scenario']
 row={'case':file.parent.name,'assetSha256':report['assetSha256'],'chunks':len(s['nodes']),'bonds':len(s['bonds']),**{k:report.get(k) for k in ['intact','impact','completed','error','stressTopologyFailure','runtime']}}
 if (file.parent/'events.json').exists():
  events=json.loads((file.parent/'events.json').read_text());bone=[]
  for e in events:
   b=s['bonds'][e['bond']&0xfffff];types=[s['nodeTypes'][b['node0']],s['nodeTypes'][b['node1']]]
   if all(t in structural for t in types):bone.append({'tick':e['tick'],'types':types,'material':pack['defaults']['solver']['materials'][b['m']]['name']})
  row['brokenStructuralConnections']=len(bone);row['structuralBreakExamples']=bone[:5]
  frame=json.loads((file.parent/'recording.json').read_text())['frames'][-1];kin={b['id']:b['kinematic'] for b in frame['bodies']}
  row['releasedArchitecture']=dict(collections.Counter(s['nodeTypes'][i] for i,pose,body in frame['poses'] if s.get('nodeGroups',['building']*len(s['nodes']))[i]=='building' and not kin[body]))
  series=json.loads((file.parent/'series.json').read_text());quiet=0
  for step in reversed(series):
   if step['awake']!=0 or not step['converged']:break
   quiet+=1
  row['convergedRestTicksAtEnd']=quiet
  row['shotRestCheckPassed']=quiet>=60 and report['impact']['escapedBodies']==0 and report['impact']['broken']>0
 rows.append(row)
(HERE/'results.json').write_text(json.dumps({'qualification':'Experimental: no town promotion; intact and shot-specific results only','exclusiveGpu':False,'caseRoot':str(ROOT),'cases':rows},indent=2))
print(f'Summarized {len(rows)} completed or explicitly failed diagnostic cases.')
