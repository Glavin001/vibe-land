"""Measure whole-building damage from native chunk poses, not bond counts alone."""
import gzip,json,math,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
FRAME={'frame-post','frame-beam','floor','ceiling','roof-rafter','roof-ridge','roof-post','stair','ceiling-joist'}
def measure(name):
 d=ROOT/name;r=json.loads((d/'report.json').read_text())
 result={'case':name,'intact':r.get('intact',{}).get('passed',False),'completed':r['completed'],'error':r.get('error')}
 if not r['completed']:return result
 pack=json.loads((d/'asset.json').read_text());s=pack['scenario']
 recording=d/'recording.json.gz'
 frames=json.loads(gzip.decompress(recording.read_bytes()) if recording.exists() else (d/'recording.json').read_bytes())['frames']
 initial={p[0]:p[1] for p in frames[0]['poses']};final={p[0]:p for p in frames[-1]['poses']};bodies={b['id']:b for b in frames[-1]['bodies']}
 def metrics(ids):
  total=sum(s['nodes'][i]['mass'] for i in ids)
  detached=[i for i in ids if i in final and not bodies[final[i][2]]['kinematic']]
  displaced=[i for i in ids if i in final and math.dist(initial[i][:3],final[i][1][:3])>.5]
  return {'chunks':len(ids),'massKg':round(total,2),'detachedChunks':len(detached),'displacedChunks':len(displaced),'detachedMassPct':round(100*sum(s['nodes'][i]['mass'] for i in detached)/total,2) if total else 0,'displacedMassPct':round(100*sum(s['nodes'][i]['mass'] for i in displaced)/total,2) if total else 0,'displacedChunkPct':round(100*len(displaced)/len(ids),2) if ids else 0}
 # Loose furniture is excluded: it is already detached in an intact building.
 ids=[i for i,n in enumerate(s['nodes']) if n['mass']>0 and s.get('nodeGroups',['building']*len(s['nodes']))[i]=='building']
 result['construction']=metrics(ids);result['frame']=metrics([i for i in ids if s['nodeTypes'][i] in FRAME]);result['roof']=metrics([i for i in ids if s['nodeTypes'][i].startswith('roof') or s['nodeTypes'][i].startswith('ceiling')])
 series=json.loads((d/'series.json').read_text());idx=next((i for i,t in enumerate(series) if t['broken']),None)
 if idx is not None:
  result['firstImpact']={'tick':series[idx]['tick'],'before':series[max(0,idx-1)]['projectile'],'after':series[idx]['projectile']}
 result['broken']=r['impact']['broken'];result['escapedBodies']=r['impact']['escapedBodies'];result['settled']=r['impact']['settledCasePassed']
 return result
if __name__=='__main__':
 for name in sys.argv[1:]:
  result=measure(name);(ROOT/name/'damage-measurements.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
