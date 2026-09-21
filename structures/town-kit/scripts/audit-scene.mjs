import {readFile,writeFile} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
import {readArtifact} from './artifacts.mjs';
import {sha} from './provenance.mjs';
process.chdir(KIT);
const asset=JSON.parse(await readFile('out/bayline-town.json')),bytes=await readFile('out/bayline-town.json'),meta=JSON.parse(await readFile('out/bayline-town.meta.json'));
const results=[];
for(const mode of ['stability','traverse','wall']){
 try{
  const root=`out/reviews/bayline-town-${mode}`,r=JSON.parse(await readFile(`${root}/report.json`)),recording=JSON.parse(await readArtifact(`${root}/recording.json`)),input=JSON.parse(await readFile(`${root}/asset.meta.json`));
  // Compare the inputs this native case consumes. An unrelated furniture shot
  // label or an added launch script cannot invalidate measured walking poses.
  const inputs=m=>({options:m.options,buildingType:m.buildingType,route:mode==='traverse'?m.route:null,shots:mode==='wall'?m.shots.wall:null,shotGroup:mode==='wall'?m.shotGroups.wall:null,protected:mode==='wall'?m.protectedGroups:null});
  if(!r.passed||r.packSha256!==sha(bytes)||recording.packHash!==sha(bytes)||sha(JSON.stringify(inputs(input)))!==sha(JSON.stringify(inputs(meta))))throw Error('Failed/stale native case');
  const entry={mode,passed:true,assetSha256:r.packSha256,recordingSha256:sha(await readArtifact(`${root}/recording.json`)),exactReviewMetadataSha256:r.metadataSha256,relevantInputsMatch:true};
  if(mode==='stability'){
   const poses=new Map();for(const f of recording.frames)for(const [i,p]of f.poses)poses.set(i,p);
   if(poses.size!==asset.scenario.nodes.length)throw Error('Missing observed poses');
   let displacement=0,rotation=0;
   for(const [i,p]of poses){const n=asset.scenario.nodes[i];displacement=Math.max(displacement,Math.hypot(p[0]-n.centroid.x,p[1]-n.centroid.y,p[2]-n.centroid.z));rotation=Math.max(rotation,2*Math.acos(Math.min(1,Math.abs(p[6]))));}
   if(displacement>.035||rotation>.03)throw Error('Intact pose drift exceeds review tolerance');
   Object.assign(entry,{maximumDisplacement:displacement,maximumRotationRadians:rotation,idleSeconds:r.stability.idleSeconds});
  }
  if(mode==='traverse')entry.checkpoints=r.traversal.checkpoints.length;
  if(mode==='wall')Object.assign(entry,{breachTraversable:r.wallTraversal?.passed,independentInstances:r.independentInstances});
  results.push(entry);
 }catch(e){results.push({mode,passed:false,error:String(e)});}
}
const summary={scene:'bayline-town',passed:results.every(r=>r.passed),readyForFullDestructionAcceptance:false,note:'Combined intact stability, connected walking and one local breach only; full-collapse qualification remains open.',results};
await writeFile('out/reviews/bayline-town-audit.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));if(!summary.passed)process.exitCode=1;
