import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {KIT} from '../../src/dependencies.mjs';
const root=process.env.TOWN_KIT_AUTOBOND_ROOT??'/root/workspace/physx-2/blast/blast-stress-solver';
const require=createRequire(`${root}/package.json`),THREE=require('three');
const {generateAutoBondsFromChunks}=await import(`${root}/dist/three.js`);
function box(alternate){
 const g=new THREE.BoxGeometry(1,1,1);
 if(alternate){const indices=[];for(let i=0;i<6;i++){const b=i*4;indices.push(b,b+2,b+3,b,b+3,b+1);}g.setIndex(indices);}
 return g;
}
const results=[];
for(const offset of [0,.25,.5])for(const diagonals of [[false,false],[true,false],[false,true],[true,true]]){
 const a=box(diagonals[0]),b=box(diagonals[1]);b.translate(1,offset,0);
 const bonds=await generateAutoBondsFromChunks([{geometry:a},{geometry:b}],{mode:'exact'});
 if(!bonds)throw Error('Native generation failed');
 const expected={centroid:{x:.5,y:offset/2,z:0},area:1-offset};
 const centroidErrorM=bonds.length===1?Math.hypot(bonds[0].centroid.x-.5,bonds[0].centroid.y-offset/2,bonds[0].centroid.z):null;
 results.push({offset,diagonals,expected,bonds,centroidErrorM,passed:centroidErrorM!==null&&centroidErrorM<1e-5&&Math.abs(bonds[0].area-expected.area)<1e-5});
 a.dispose();b.dispose();
}
const output=`${KIT}/out/reviews/autobond-placements`;
mkdirSync(output,{recursive:true});writeFileSync(`${output}/analytic-contacts.json`,JSON.stringify({sourceRoot:root,toleranceM:1e-5,results},null,2));
console.log(JSON.stringify(results.map(({offset,diagonals,centroidErrorM,passed,bonds})=>({offset,diagonals,centroidErrorM,passed,centroid:bonds[0]?.centroid})),null,2));
// A failed measurement is an experiment result, not silently a passing oracle.
process.exitCode=results.every(r=>r.passed)?0:1;
