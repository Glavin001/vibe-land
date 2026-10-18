// Controlled collider representation test, keeping physical geometry and bonds.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {KIT} from '../../src/dependencies.mjs';
import {cornerReferencedHulls} from '../../src/parts/hull-origins.mjs';
import {validate} from '../../src/validate.mjs';
const root=path.join(KIT,'out/reviews/house-cannonball');
for(const name of process.argv.slice(2)){
 const p=JSON.parse(readFileSync(path.join(root,name,'asset.json'))),s=p.scenario;let converted=0;
 s.nodeColliders=s.nodeColliders.map((c,i)=>{
  if(c.kind!=='cuboid'||s.nodeGroups[i]!=='building'||s.nodes[i].mass===0)return c;
  const h=['x','y','z'].map(k=>c.halfExtents[k]);if(Math.max(...h)/Math.min(...h)>50)return c;
  const points=[];for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])points.push(x*h[0],y*h[1],z*h[2]);converted++;return {kind:'convex_hull',points};
 });cornerReferencedHulls(p);const dir=path.join(root,name+'-panel-hulls');mkdirSync(dir,{recursive:true});const validation=validate(p);writeFileSync(path.join(dir,'asset.json'),JSON.stringify(p));writeFileSync(path.join(dir,'shot.json'),readFileSync(path.join(root,name,'shot.json')));writeFileSync(path.join(dir,'representation.json'),JSON.stringify({converted,validation}));console.log(name,converted,validation);if(!validation.passed)process.exitCode=1;
}
