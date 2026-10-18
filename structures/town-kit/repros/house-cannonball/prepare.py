"""Extract exact town instances, preserving materials and all internal bonds."""
import copy, json, hashlib, collections
from pathlib import Path
KIT=Path(__file__).resolve().parents[2]; REPO=KIT.parents[1]
OUT=KIT/'out/reviews/house-cannonball';OUT.mkdir(parents=True,exist_ok=True)
def read(p):return json.loads(p.read_text())
def save(p,v):p.write_text(json.dumps(v,separators=(',',':')))
def center(pack,delta):
 for rows,key in [(pack['scenario']['nodes'],'centroid'),(pack['scenario']['bonds'],'centroid')]:
  for row in rows:
   for k,d in zip('xyz',delta):row[key][k]=round(row[key][k]-d,6)
 return pack
summary={}
def emit(name,p,shot,origin):
 d=OUT/name;d.mkdir(exist_ok=True);save(d/'asset.json',p);save(d/'shot.json',shot)
 s=p['scenario'];m=p['defaults']['solver']['materials']; masses=sorted(n['mass'] for n in s['nodes'] if n['mass']>0)
 summary[name]={'source':origin,'sha256':hashlib.sha256((d/'asset.json').read_bytes()).hexdigest(),'chunks':len(s['nodes']),'bonds':len(s['bonds']),'types':dict(collections.Counter(s['nodeTypes'])),'fixed':sum(n['mass']==0 for n in s['nodes']),'massKg':sum(masses),'under1kg':sum(x<1 for x in masses),'under5kg':sum(x<5 for x in masses),'medianMassKg':masses[len(masses)//2],'bondMaterials':dict(collections.Counter(m[b.get('m',0)].get('name','?') for b in s['bonds']))}
town=read(REPO/'destruction/assets/scenes/fractured-town.json');ts=town['scenario']
for name in ['house-1story','house-2story']:
 h=read(REPO/f'destruction/assets/scenes/{name}.json');n=h['scenario']['nodes'];count=len(n)
 i=next(i for i,(x,t) in enumerate(zip(ts['nodes'],ts['nodeTypes'])) if t=='foundation' and x['volume']==n[0]['volume'])
 delta=[ts['nodes'][i]['centroid'][k]-n[0]['centroid'][k] for k in 'xyz']
 assert max(abs(ts['nodes'][i+j]['centroid'][k]-d-q['centroid'][k]) for j,q in enumerate(n) for k,d in zip('xyz',delta))<1e-4
 external=[b for b in ts['bonds'] if (i<=b['node0']<i+count)!=(i<=b['node1']<i+count)]
 assert not external,external[:3]
 p=copy.deepcopy(town);p['key']=name+'-extracted';s=p['scenario']={k:copy.deepcopy(v[i:i+count]) for k,v in ts.items() if k.startswith('node')};s['bonds']=[dict(copy.deepcopy(b),node0=b['node0']-i,node1=b['node1']-i) for b in ts['bonds'] if i<=b['node0']<i+count and i<=b['node1']<i+count]
 if 'shapeLibrary' in ts:s['shapeLibrary']=copy.deepcopy(ts['shapeLibrary'])
 emit(name,center(p,delta),{'position':[-9,1.5,0],'direction':[1,0,0]},'fractured-town.json nodes '+str(i)+':'+str(i+count))
audit=Path(read(KIT/'out/reviews/building-audit-latest.json')['root'])
for name,instance in [('bungalow','15-garden-bungalow-16'),('porch-house','1-garden-house-2')]:
 candidates=list(audit.glob('*porch*')) if name=='porch-house' else []
 src=audit/instance
 if not src.exists():src=candidates[0]
 meta=read(src/'asset.meta.json');p=center(read(src/'asset.json'),meta['instance']['position'])
 emit(name,p,{'position':[-9,1.5,0],'direction':[1,0,0]},str(src))
save(OUT/'comparison.json',summary)
print(json.dumps(summary,indent=2))
