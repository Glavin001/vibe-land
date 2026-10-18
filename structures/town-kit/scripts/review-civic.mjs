import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
process.chdir(KIT);
const modes=process.argv.slice(2);const selected=process.env.TOWN_KIT_CIVIC_ASSETS?.split(',');if(!modes.length)modes.push('stability','traverse','glazing','wall','furniture','collapse');
const results=[],keepGoing=process.env.TOWN_KIT_CONTINUE==='1';let aborted=false;
for(const asset of ['neighborhood-library','art-deco-cinema','fire-station'].flatMap(n=>[n,n+'-mirror']).concat(['book-stack','cinema-seat'])){
 if(selected&&!selected.includes(asset))continue;
 const m=JSON.parse(await readFile(`out/${asset}.meta.json`));
 for(const mode of modes){
  if(m.kind==='prop'&&mode!=='stability'&&!m.shots[mode])continue;
  const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['scripts/review.mjs',asset,mode],{stdio:'inherit',env:{...process.env,TOWN_KIT_COMPACT_GPU:'1'}});p.on('error',reject);p.on('exit',(code,signal)=>resolve(signal?1:code));});
  results.push({asset,mode,passed:code===0});
  await writeFile('out/reviews/civic-native-run.json',JSON.stringify({requestedAssets:selected??'all',requestedModes:modes,complete:false,passed:false,results},null,2));
  if(code!==0){process.exitCode=1;if(!keepGoing){aborted=true;break;}}
 }
 if(aborted)break;
}
if(!aborted)await writeFile('out/reviews/civic-native-run.json',JSON.stringify({requestedAssets:selected??'all',requestedModes:modes,complete:true,passed:results.every(r=>r.passed),results},null,2));
