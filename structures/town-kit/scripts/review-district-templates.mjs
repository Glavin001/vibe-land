import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {KIT} from '../src/dependencies.mjs';
process.chdir(KIT);
const templates=JSON.parse(await readFile('out/district-templates.json')),results=[];
for(const t of templates){
 const modes=['stability'];
 if(t.key.includes('"bungalow"')||t.asset==='district-template-3')modes.push('traverse');
 for(const mode of modes){
  const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['scripts/review.mjs',t.asset,mode],{stdio:'inherit',env:{...process.env,TOWN_KIT_COMPACT_GPU:'1'}});p.on('error',reject);p.on('exit',resolve);});
  results.push({asset:t.asset,mode,passed:code===0});
  await writeFile('out/reviews/district-template-status.json',JSON.stringify({passed:results.every(r=>r.passed),complete:results.length===28,results},null,2));
  if(code!==0){console.error('Stopped at failing template',t.asset,mode);process.exitCode=1;break;}
 }
 if(process.exitCode)break;
}
