import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {KIT} from '../../src/dependencies.mjs';
import {buildVictorianCorner,buildWorkshop,validate} from '../../src/index.mjs';
import {boundsFor} from '../../src/geometry.mjs';
import {sourceProvenance} from '../../scripts/provenance.mjs';

const asset=process.argv[2]??'victorian';
const builders={victorian:buildVictorianCorner,workshop:buildWorkshop};
if(!builders[asset])throw Error('Expected victorian or workshop');
const root=process.env.TOWN_KIT_AUTOBOND_ROOT??'/root/workspace/physx-2/blast/blast-stress-solver';
const require=createRequire(path.join(root,'package.json'));
const THREE=require('three');
const {ConvexGeometry}=await import(pathToFileURL(require.resolve('three/examples/jsm/geometries/ConvexGeometry.js')));
const {generateAutoBondsFromChunks}=await import(pathToFileURL(path.join(root,'dist/three.js')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pair=(a,b)=>`${Math.min(a,b)}:${Math.max(a,b)}`;
const xyz=v=>[v.x,v.y,v.z];
const distance=(a,b)=>Math.hypot(...xyz(a).map((v,i)=>v-xyz(b)[i]));
const quantiles=values=>{const a=[...values].sort((a,b)=>a-b);return {count:a.length,min:a[0]??null,median:a[Math.floor(a.length/2)]??null,p95:a[Math.floor(a.length*.95)]??null,max:a.at(-1)??null};};
const revisions=[];
for(const checkout of ['blast-stress-solver','blast-stress-solver-2','physx-2','physx-2-deployed','physx-2-vehicle']){
 const repo=path.join('/root/workspace',checkout),file='blast/blast-stress-solver/structures/lib/autobond.mjs',p=path.join(repo,file);
 if(existsSync(p))revisions.push({checkout,revision:execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),lastScriptChange:execFileSync('git',['-C',repo,'log','-1','--format=%h %cs %s','--',file],{encoding:'utf8'}).trim(),scriptSha256:hash(readFileSync(p))});
}
const {pack,metadata}=builders[asset]();
const s=pack.scenario;
// This diagnostic measures the complete small prefab, including furniture.
// Native-only cross-group candidates are reported, never automatically attached.
if(s.nodes.length>9000)throw Error('Use bounded prefab inputs (<=9000 chunks)');
const colliders=s.nodeColliders.map(c=>c.kind==='shape'?s.shapeLibrary[c.shape]:c);
const bounds=s.nodes.map((n,i)=>boundsFor(n,colliders[i]));
const chunks=s.nodes.map((n,i)=>{
 const c=colliders[i];let geometry;
 if(c.kind==='cuboid'){const h=c.halfExtents;geometry=new THREE.BoxGeometry(h.x*2,h.y*2,h.z*2);}
 else geometry=new ConvexGeometry(Array.from({length:c.points.length/3},(_,j)=>new THREE.Vector3(...c.points.slice(j*3,j*3+3))));
 geometry.translate(n.centroid.x,n.centroid.y,n.centroid.z);
 return {geometry};
});
console.log(`Measuring ${asset}: ${s.nodes.length} chunks, ${s.bonds.length} authored bonds`);
const started=performance.now();
const native=await generateAutoBondsFromChunks(chunks,{mode:'exact',label:'town-kit placement comparison'});
for(const c of chunks)c.geometry.dispose();
if(!native)throw Error('Native auto-bonding failed');
const map=new Map();let duplicates=0;
for(const b of native){
 assert(b.node0<s.nodes.length&&b.node1<s.nodes.length&&b.node0!==b.node1);
 assert(xyz(b.centroid).every(Number.isFinite));
 const key=pair(b.node0,b.node1);if(map.has(key))duplicates++;else map.set(key,b);
}
const original=new Map(s.bonds.map(b=>[pair(b.node0,b.node1),b]));
assert.equal(original.size,s.bonds.length,'Duplicate authored bond');
const matches=[],missing=[],extra=[];
const label=b=>({node0:b.node0,node1:b.node1,roles:[s.nodeTypes[b.node0],s.nodeTypes[b.node1]],groups:[s.nodeGroups[b.node0],s.nodeGroups[b.node1]]});
for(const b of s.bonds){
 const n=map.get(pair(b.node0,b.node1));if(!n){missing.push(label(b));continue;}
 const dot=xyz(b.normal).reduce((v,x,i)=>v+x*xyz(n.normal)[i],0);
 const shift=distance(b.centroid,n.centroid);
 matches.push({...label(b),centroidShiftM:shift,normalAbsoluteDot:Math.abs(dot),areaRatio:n.area/b.area,authoredCentroid:b.centroid,nativeCentroid:n.centroid});
}
for(const b of map.values())if(!original.has(pair(b.node0,b.node1)))extra.push({...label(b),area:b.area,centroid:b.centroid});
const out=path.join(KIT,'out/reviews/autobond-placements',asset);mkdirSync(out,{recursive:true});
const report={asset,nodes:s.nodes.length,authoredBonds:s.bonds.length,nativeBonds:native.length,nativeUniquePairs:map.size,duplicateNativePairs:duplicates,matched:matches.length,authoredOnly:missing.length,nativeOnly:extra.length,nativeOnlyAcrossGroups:extra.filter(b=>b.groups[0]!==b.groups[1]).length,centroidShiftM:quantiles(matches.map(b=>b.centroidShiftM)),shiftsOver1mm:matches.filter(b=>b.centroidShiftM>.001).length,normalAbsoluteDot:quantiles(matches.map(b=>b.normalAbsoluteDot)),areaRatiosNotApplied:quantiles(matches.map(b=>b.areaRatio)),milliseconds:performance.now()-started,revisions,dependencies:Object.fromEntries(['dist/three.js','dist/stress_solver.cjs','dist/stress_solver.wasm'].map(f=>[f,hash(readFileSync(path.join(root,f)))])),sourceRoot:root,candidates:[]};
writeFileSync(path.join(out,'differences.json'),JSON.stringify({largestShifts:matches.sort((a,b)=>b.centroidShiftM-a.centroidShiftM).slice(0,30),missing,extra},null,2));
const provenance=await sourceProvenance();
for(const mode of ['baseline','centroids','matched-topology']){
 const p=structuredClone(pack);
 if(mode!=='baseline')p.scenario.bonds=p.scenario.bonds.flatMap(b=>{
  const n=map.get(pair(b.node0,b.node1));
  if(!n)return mode==='matched-topology'?[]:[b];
  // Only the location changes. Preserve authored area, normal and material.
  return [{...b,centroid:{...n.centroid}}];
 });
 assert.deepEqual(p.defaults,pack.defaults);
 assert.deepEqual({...p.scenario,bonds:[]},{...s,bonds:[]});
 for(const b of p.scenario.bonds){const old=original.get(pair(b.node0,b.node1));assert.deepEqual({...b,centroid:null},{...old,centroid:null});}
 const validation=validate(p),slug=`lab-autobond-${asset}-${mode}`,bytes=JSON.stringify(p);
 const m={...metadata,validation,assetSha256:hash(bytes),provenance,diagnostic:{mode,unchanged:'Geometry, mass, gravity, anchors, material strengths, elastic modulus, bond areas and normals',nativeRoot:root}};
 writeFileSync(path.join(KIT,'out',`${slug}.json`),bytes);
 writeFileSync(path.join(KIT,'out',`${slug}.meta.json`),JSON.stringify(m,null,2));
 report.candidates.push({mode,slug,bonds:p.scenario.bonds.length,sha256:m.assetSha256,validation});
}
writeFileSync(path.join(out,'comparison.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,revisions:undefined,dependencies:undefined,candidates:report.candidates.map(c=>({...c,validation:{passed:c.validation.passed,components:c.validation.components,errors:c.validation.errors.slice(0,5)}}))},null,2));
