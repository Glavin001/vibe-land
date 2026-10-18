import { boundsFor,candidates,a } from './geometry.mjs';
import { hullsOverlap } from './dependencies.mjs';
export function validate(pack) {
 const s=pack.scenario,n=s.nodes.length,errors=[],warnings=[];
 const check=(ok,msg)=>{if(!ok)errors.push(msg);};
 for(const k of ['nodeColliders','nodeSizes','nodeTypes','nodePieces','nodeGroups'])check(s[k]?.length===n,`${k} count mismatch`);
 const colliders=s.nodeColliders.map(c=>c.kind==='shape'?s.shapeLibrary[c.shape]:c);
 const bounds=s.nodes.map((x,i)=>boundsFor(x,colliders[i]));
 const parent=Array.from({length:n},(_,i)=>i),find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
 for(let i=0;i<n;i++){
  const x=s.nodes[i],c=colliders[i];check(x.volume>0&&Number.isFinite(x.mass)&&x.mass>=0,`bad mass/volume ${i}`);check(x.m<pack.defaults.solver.materials.length,`bad material ${i}`);
  check(x.mass!==0||s.nodeTypes[i]==='foundation',`above-ground anchor ${i}`);
  if(c.kind==='convex_hull')check(c.points.length/3<=64&&c.points.length>=12&&c.points.every(Number.isFinite),`bad hull ${i}`);
 }
 for(const [i,b] of s.bonds.entries()){
  if(!(b.node0<n&&b.node1<n)){errors.push(`bond ${i} out of range`);continue;}
  check(b.area>0&&Number.isFinite(b.area),`bond ${i} bad area`);check(b.m<pack.defaults.solver.materials.length,`bond ${i} bad material`);
  check(Math.abs(Math.hypot(...a(b.normal))-1)<1e-4,`bond ${i} bad normal`);parent[find(b.node0)]=find(b.node1);
 }
 const components=new Map();for(let i=0;i<n;i++){const r=find(i),list=components.get(r)??[];list.push(i);components.set(r,list);}
 for(const nodes of components.values()){
  const fixed=nodes.some(i=>s.nodes[i].mass===0),g=s.nodeGroups[nodes[0]];
  if(g.startsWith('building')||g.includes('fence')||g.includes('gate'))check(fixed,`unanchored ${g}: ${nodes.length} chunks, first ${nodes.slice(0,4).map(i=>`${i}:${s.nodeTypes[i]}@${JSON.stringify(s.nodes[i].centroid)}`).join(' ')}`);
  else if(nodes.length===1)warnings.push(`single-piece prop component ${nodes[0]} ${g}`);
 }
 const vertices=i=>{const c=colliders[i],p=a(s.nodes[i].centroid);if(c.kind==='convex_hull')return Array.from({length:c.points.length/3},(_,j)=>c.points.slice(j*3,j*3+3).map((x,k)=>x+p[k]));const h=a(c.halfExtents),out=[];for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])out.push([p[0]+x*h[0],p[1]+y*h[1],p[2]+z*h[2]]);return out;};
 let overlapCount=0;
 for(const [i,j] of candidates(bounds)){
  const [lo,hi]=bounds[i],[lo2,hi2]=bounds[j];const ov=lo.map((x,k)=>Math.min(hi[k],hi2[k])-Math.max(x,lo2[k]));
  if(ov.some(x=>x<=.001))continue;
  if(colliders[i].kind==='cuboid'&&colliders[j].kind==='cuboid'||hullsOverlap(vertices(i),vertices(j),.001)){
   overlapCount++;if(overlapCount<=30)errors.push(`overlap ${i}:${s.nodeTypes[i]} ${j}:${s.nodeTypes[j]} (${s.nodeGroups[i]} / ${s.nodeGroups[j]})`);
  }
 }
 if(overlapCount>30)errors.push(`${overlapCount} total overlaps`);
 return {passed:errors.length===0,chunks:n,bonds:s.bonds.length,components:components.size,shapes:s.shapeLibrary?.length??0,overlapCount,errors,warnings};
}
