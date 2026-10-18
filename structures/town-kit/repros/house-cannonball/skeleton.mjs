import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {KIT} from '../../src/dependencies.mjs';
import {validate} from '../../src/validate.mjs';
const root=path.join(KIT,'out/reviews/house-cannonball');
for(const name of process.argv.slice(2)){
 const pack=JSON.parse(readFileSync(path.join(root,name,'asset.json'))),s=pack.scenario;
 const structural=new Set(['foundation','floor','ceiling','frame-post','frame-beam','roof','roof-ridge','roof-rafter','roof-post','roof-fascia','gable-batten','stair','porch-deck','porch-post','porch-ceiling','porch-roof']);
 const keep=s.nodes.map((_,i)=>i).filter(i=>s.nodeGroups[i]!=='building'||structural.has(s.nodeTypes[i])),map=new Map(keep.map((i,j)=>[i,j]));
 const removed=s.nodes.length-keep.length;
 s.bonds=s.bonds.filter(b=>map.has(b.node0)&&map.has(b.node1)).map(b=>({...b,node0:map.get(b.node0),node1:map.get(b.node1)}));
 for(const k of Object.keys(s))if(k.startsWith('node'))s[k]=keep.map(i=>s[k][i]);
 const dir=path.join(root,name+'-skeleton');mkdirSync(dir,{recursive:true});const validation=validate(pack);writeFileSync(path.join(dir,'asset.json'),JSON.stringify(pack));writeFileSync(path.join(dir,'shot.json'),JSON.stringify({mode:'idle'}));writeFileSync(path.join(dir,'asset.meta.json'),JSON.stringify({validation,removed,retains:'Roof covering, structural floors, stairs, all furnishings and fences'}));console.log(name,removed,JSON.stringify(validation));if(!validation.passed)process.exitCode=1;
}
