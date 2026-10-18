import {writeFile} from 'node:fs/promises';
import {buildNeighborhoodLibrary,buildArtDecoCinema,buildFireStation} from '../src/index.mjs';
import {boundsFor} from '../src/geometry.mjs';
import {hullsOverlap} from '../src/dependencies.mjs';
import {KIT} from '../src/dependencies.mjs';
process.chdir(KIT);
const corners=(lo,hi)=>[0,1,2,3,4,5,6,7].map(i=>[0,1,2].map(k=>(i>>k)&1?hi[k]:lo[k]));
const results=[];
for(const build of [buildNeighborhoodLibrary,buildArtDecoCinema,buildFireStation])for(const mirrored of [false,true]){
 const {pack,metadata:m}=build({mirrored}),s=pack.scenario;
 const shapes=s.nodes.map((n,i)=>{const c=s.nodeColliders[i].kind==='shape'?s.shapeLibrary[s.nodeColliders[i].shape]:s.nodeColliders[i],bounds=boundsFor(n,c);return {bounds,vertices:c.kind==='cuboid'?corners(...bounds):Array.from({length:c.points.length/3},(_,j)=>c.points.slice(j*3,j*3+3).map((v,k)=>v+[n.centroid.x,n.centroid.y,n.centroid.z][k]))};});
 const failures=[];let checked=0,skipped=0;
 for(let j=1;j<m.route.length;j++){
  const from=m.route[j-1],to=m.route[j];
  // This static smoke test cannot certify stair climbing or contact settling.
  if(/stair|landing/.test(from.name+' '+to.name)||Math.abs(from.at[1]-to.at[1])>.25){skipped++;continue;}
  const length=Math.hypot(...from.at.map((v,k)=>v-to.at[k])),steps=Math.max(1,Math.ceil(length/.15));
  let hit=false;
  for(let k=0;k<=steps&&!hit;k++){
   const p=from.at.map((v,d)=>v+(to.at[d]-v)*k/steps),lo=[p[0]-.35,p[1]+.3,p[2]-.35],hi=[p[0]+.35,p[1]+2.1,p[2]+.35],body=corners(lo,hi);checked++;
   for(let i=0;i<shapes.length;i++){
    const q=shapes[i];if(q.bounds[0].some((v,d)=>Math.min(q.bounds[1][d],hi[d])-Math.max(v,lo[d])<=.003))continue;
    if(hullsOverlap(body,q.vertices,.003)){failures.push({from:from.name,to:to.name,at:p,node:i,type:s.nodeTypes[i]});hit=true;break;}
   }
  }
 }
 results.push({asset:pack.key,mirrored,passed:!failures.length,checkedSamples:checked,skippedStairSegments:skipped,failures});
}
const report={method:'Conservative 0.7 m box sweep above 0.3 m step height; 2.1 m overhead clearance. Static geometry only, stairs skipped. Not native capsule acceptance.',passed:results.every(r=>r.passed),results};
await writeFile('out/reviews/civic-static-routes.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
