import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {PROP_TYPES,buildVictorianCorner,composeScene,validate} from '../src/index.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
const run=args=>new Promise(resolve=>{const p=spawn(process.execPath,args,{cwd:KIT,stdio:'inherit'});p.on('exit',code=>resolve(code===0));});
const results=[],quick=process.argv.includes('--geometry-only'),buildingsOnly=process.argv.includes('--buildings-only');
await mkdir(path.join(KIT,'out/reviews'),{recursive:true});
if(buildingsOnly){const previous=JSON.parse(await readFile(path.join(KIT,'out/reviews/matrix.json'),'utf8'));results.push(...previous.results.filter(r=>PROP_TYPES.includes(r.asset)));}
else{await run(['scripts/build.mjs','--props']);for(const type of PROP_TYPES)if(!quick)for(const mode of ['stability',type==='fence'||type==='gate'?'fence':'furniture'])results.push({asset:type,mode,passed:await run(['scripts/review.mjs',type,mode])});}
for(const storeys of [2,3])for(const mirror of [false,true])for(const palette of ['sage','blue','ochre']){
 const asset=`victorian-${storeys}f-${mirror?'mirror':'normal'}-${palette}`;
 const passed=await run(['scripts/build.mjs','--name',asset,'--storeys',String(storeys),'--palette',palette,...(mirror?['--mirror']:[])]);
 results.push({asset,mode:'geometry',passed});
 if(!quick&&passed){for(const mode of ['stability',...(palette==='sage'?['traverse']:[])])results.push({asset,mode,passed:await run(['scripts/review.mjs',asset,mode])});}
}
for(const furnished of [false,true])for(const fence of [false,true]){
 const asset=`victorian-options-${furnished?'furnished':'empty'}-${fence?'fenced':'open'}`;
 const passed=await run(['scripts/build.mjs','--name',asset,...(furnished?[]:['--empty']),...(fence?[]:['--no-fence'])]);
 results.push({asset,mode:'geometry',passed});if(!quick&&passed)results.push({asset,mode:'stability',passed:await run(['scripts/review.mjs',asset,'stability'])});
}
const source=buildVictorianCorner({storeys:2,furnished:false,fence:false}),pack=composeScene([{pack:source.pack,position:[-15,0,0],group:'building-left'},{pack:source.pack,position:[15,0,0],yaw:90,group:'building-right'}],{key:'reuse-buildings'}),data=JSON.stringify(pack);
await writeFile(path.join(KIT,'out/reuse-buildings.json'),data);await writeFile(path.join(KIT,'out/reuse-buildings.meta.json'),JSON.stringify({validation:validate(pack),assetSha256:sha(data),provenance:await sourceProvenance(),shots:{wall:[{from:[-16.475,1.4,-9],to:[-16.475,1.4,-7.9],momentum:2000000,radius:.25,speed:20,tick:0}]},shotGroups:{wall:'building-left'},protectedGroups:['building-right'],cameras:{hero:{position:[-40,22,-44],target:[0,4,0]}}},null,2));
if(!quick)for(const mode of ['stability','wall'])results.push({asset:'reuse-buildings',mode,passed:await run(['scripts/review.mjs','reuse-buildings',mode])});
const report={passed:results.every(r=>r.passed),geometryOnly:quick,recordedAt:new Date().toISOString(),results};
await writeFile(path.join(KIT,'out/reviews/matrix.json'),JSON.stringify(report,null,2));if(!quick){report.restAuditPassed=await run(['scripts/audit-rest.mjs']);report.passed=report.passed&&report.restAuditPassed;await writeFile(path.join(KIT,'out/reviews/matrix.json'),JSON.stringify(report,null,2));}if(!report.passed)process.exitCode=1;
