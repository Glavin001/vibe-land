import {spawn} from 'node:child_process';
import {readFile,writeFile,open} from 'node:fs/promises';
import {readFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
process.chdir(KIT);
const lockPath=path.join(KIT,'out/native-review.lock');
const lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,purpose:'sequential-town-captures',started:new Date().toISOString()}));await lock.close();
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lockPath,'utf8')).pid===process.pid)unlinkSync(lockPath);}catch{}});
const bases=['porch-house','corner-grocery','workshop'],intactOnly=process.argv.includes('--intact-only'),results=[];
async function capture(script,args){
 const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[`scripts/${script}.mjs`,...args],{stdio:'inherit'});p.on('error',reject);p.on('exit',resolve);});
 results.push({script,args,passed:code===0});
 await writeFile('out/reviews/town-captures.json',JSON.stringify({recordedAt:new Date().toISOString(),passed:results.every(r=>r.passed),results},null,2));
}
for(const asset of bases)for(const name of [asset,`${asset}-mirror`])await capture('screenshots',[name]);
if(!intactOnly)for(const asset of bases){
 for(const mode of ['glazing','wall','furniture','collapse',...(asset==='porch-house'?['fence']:[])])await capture('screenshots',[asset,mode]);
 for(const mode of ['traverse','wall','collapse']){
  const r=JSON.parse(await readFile(`out/reviews/${asset}-${mode}/report.json`));
  if(mode==='wall'&&!r.wallTraversal?.passed)continue;
  await capture('record',[asset,mode,...(r.passed?[]:['--diagnostic'])]);
 }
}
if(results.some(r=>!r.passed))process.exitCode=1;
