"""Diagnostic ablations, never production exports or strength recommendations."""
import copy,json
from pathlib import Path
R=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
for base in ['bungalow','porch-house']:
 original=json.loads((R/base/'asset.json').read_text())
 import sys
 for mode in sys.argv[1:] or ['wood-joints','fused-floors']:
  p=copy.deepcopy(original);s=p['scenario'];table=p['defaults']['solver']['materials'];mi={m['name']:i for i,m in enumerate(table)}
  if mode=='wood-joints':
   for b in s['bonds']:
    if b['m']==mi['timber-joint']:b['m']=mi['structure-timber']
  else:
   # Two coplanar layers forming the same floor cell become one full-thickness
   # timber fragment. Preserve mass, geometry, contacts and all support flags.
   pairs={}
   for b in s['bonds']:
    i,j=b['node0'],b['node1'];a,c=s['nodes'][i],s['nodes'][j];ca,cc=s['nodeColliders'][i],s['nodeColliders'][j]
    if mode=='fused-floors-only' and s['nodeTypes'][i]=='ceiling':continue
    if mode=='fused-ceilings-only' and s['nodeTypes'][i]!='ceiling':continue
    if s['nodeTypes'][i] not in ['floor','floor-finish','ceiling'] or s['nodeTypes'][j] not in ['floor','floor-finish','ceiling']:continue
    if ca['kind']!='cuboid' or cc['kind']!='cuboid':continue
    if abs(a['centroid']['x']-c['centroid']['x'])>1e-5 or abs(a['centroid']['z']-c['centroid']['z'])>1e-5:continue
    if any(abs(ca['halfExtents'][k]-cc['halfExtents'][k])>1e-5 for k in ['x','z']):continue
    thin,thick=(i,j) if ca['halfExtents']['y']<cc['halfExtents']['y'] else (j,i)
    if abs(s['nodeColliders'][thin]['halfExtents']['y']-.006)>1e-5:continue
    pairs[thin]=thick
   for thin,thick in pairs.items():
    a,c=s['nodes'][thick],s['nodes'][thin];ha=s['nodeColliders'][thick]['halfExtents'];hc=s['nodeColliders'][thin]['halfExtents'];low=min(a['centroid']['y']-ha['y'],c['centroid']['y']-hc['y']);high=max(a['centroid']['y']+ha['y'],c['centroid']['y']+hc['y']);a['centroid']['y']=(low+high)/2;ha['y']=(high-low)/2;s['nodeSizes'][thick]['y']=high-low;a['mass']+=c['mass'];a['volume']+=c['volume']
   keep=[i for i in range(len(s['nodes'])) if i not in pairs];remap={i:j for j,i in enumerate(keep)}
   bonds={}
   for b in s['bonds']:
    i=remap[pairs.get(b['node0'],b['node0'])];j=remap[pairs.get(b['node1'],b['node1'])]
    if i==j:continue
    if i>j:i,j=j,i;b['normal']={k:-v for k,v in b['normal'].items()}
    key=(i,j)
    if key in bonds:
     prev=bonds[key];area=prev['area']+b['area'];prev['centroid']={k:(prev['centroid'][k]*prev['area']+b['centroid'][k]*b['area'])/area for k in 'xyz'};prev['area']=area
    else:bonds[key]=dict(b,node0=i,node1=j)
   for k in list(s):
    if k.startswith('node'):s[k]=[s[k][i] for i in keep]
   s['bonds']=list(bonds.values())
  dest=R/(base+'-'+mode);dest.mkdir(exist_ok=True);(dest/'asset.json').write_text(json.dumps(p,separators=(',',':')));(dest/'shot.json').write_bytes((R/base/'shot.json').read_bytes())
  print(dest.name,len(s['nodes']),len(s['bonds']))
