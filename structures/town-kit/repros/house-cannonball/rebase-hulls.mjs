// Diagnostic equivalent representation: keep every world-space vertex, mass,
// material, bond surface and support flag, but use the hull's local AABB corner
// as its shape origin. Native PhysX derives COM from the shape geometry.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {KIT} from '../../src/dependencies.mjs';
import {validate} from '../../src/validate.mjs';
const root=path.join(KIT,'out/reviews/house-cannonball');
for(const name of process.argv.slice(2)){
 const pack=JSON.parse(readFileSync(path.join(root,name,'asset.json'))),s=pack.scenario;let count=0,maxWorldVertexDifference=0;
 s.nodeColliders=s.nodeColliders.map((ref,i)=>{
  const c=ref.kind==='shape'?s.shapeLibrary[ref.shape]:ref;if(c.kind!=='convex_hull')return c;
  const old={...s.nodes[i].centroid},origin=[0,1,2].map(k=>Math.min(...c.points.filter((_,j)=>j%3===k)));
  for(let k=0;k<3;k++)s.nodes[i].centroid['xyz'[k]]+=origin[k];
  const points=c.points.map((v,j)=>{const k=j%3,newValue=v-origin[k];maxWorldVertexDifference=Math.max(maxWorldVertexDifference,Math.abs(old['xyz'[k]]+v-s.nodes[i].centroid['xyz'[k]]-newValue));return newValue;});count++;return {kind:'convex_hull',points};
 });delete s.shapeLibrary;
 const dest=path.join(root,name+'-rebased');mkdirSync(dest,{recursive:true});const validation=validate(pack);writeFileSync(path.join(dest,'asset.json'),JSON.stringify(pack));writeFileSync(path.join(dest,'shot.json'),readFileSync(path.join(root,name,'shot.json')));writeFileSync(path.join(dest,'representation.json'),JSON.stringify({count,maxWorldVertexDifference,validation}));console.log(name,{count,maxWorldVertexDifference,validation});
 if(!validation.passed||maxWorldVertexDifference>1e-12)process.exitCode=1;
}
