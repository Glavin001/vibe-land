"""Compare CPU/GPU collision-shape origins to native chunk reference origins by stable shape index."""
import gzip,json,math,sys,collections
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
name=sys.argv[1];d=ROOT/name
frames=json.loads(gzip.decompress((d/'recording.json.gz').read_bytes()))['frames'];native={round(f['time']*60):f for f in frames}
path=d/'collision-shapes.ndjson';stream=path.open() if path.exists() else gzip.open(str(path)+'.gz','rt')
rows=[json.loads(line) for line in stream];stream.close();initial=native[0]['poses'];bins=collections.defaultdict(list)
key=lambda p:tuple(round(x,3) for x in p)
for i,p,b in initial:bins[key(p[:3])].append((i,p,b))
mapping={};ambiguities=[]
for row in rows[0]['shapes']:
 hits=bins[key(row[3:6])]
 if len(hits)!=1:
  hits=sorted(initial,key=lambda p:math.dist(row[3:6],p[1][:3]))[:1]
  if math.dist(row[3:6],hits[0][1][:3])>.001:ambiguities.append(row)
 mapping[row[0]]=hits[0][0]
assert not ambiguities,ambiguities[:1]
assert len(set(mapping.values()))==len(mapping)
assert len(mapping)==len(initial),'Incomplete initial shape coverage'
assert all({s[0] for s in r['shapes']}==set(mapping) for r in rows),'Audit dropped migrated shapes'
worst=[];gpuErrors=[];firstBelow={};pack=json.loads((d/'asset.json').read_text());s=pack['scenario']
for r in rows:
 poses={i:p for i,p,b in native[r['tick']]['poses']}
 for shape in r['shapes']:
  i=mapping[shape[0]];gpuErrors.append(math.dist(shape[3:6],shape[12:15]));error=math.dist(shape[3:6],poses[i][:3])
  if error>.001:worst.append({'tick':r['tick'],'node':i,'type':s['nodeTypes'][i],'errorM':error,'collisionOrigin':shape[3:6],'nativeOrigin':poses[i][:3]})
  if s['nodes'][i]['mass']>0 and shape[10]<-.1 and i not in firstBelow:
   firstBelow[i]={'tick':r['tick'],'node':i,'type':s['nodeTypes'][i],'shape':shape,'nativeOrigin':poses[i][:3]}
result={'case':name,'mappedShapes':len(mapping),'observations':len(rows),'completeShapeCoverage':True,'maximumCpuGpuOriginErrorM':max(gpuErrors),'belowGroundMeaning':'Entire AABB below surface by 0.1 m at a sampled frame; includes transient penetration, not necessarily permanent escape','mismatchesAbove1mm':len(worst),'worst':sorted(worst,key=lambda x:x['errorM'],reverse=True)[:10],'firstBelowGround':list(firstBelow.values())}
(d/'collision-analysis.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
