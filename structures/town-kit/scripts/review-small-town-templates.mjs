import {mkdir,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {KIT} from '../src/dependencies.mjs';
import {buildBaylineSmallTown} from '../src/bayline-small-town.mjs';
import {validate} from '../src/validate.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
process.chdir(KIT);
const start=Number(process.env.TOWN_KIT_TEMPLATE_START??0),only=process.env.TOWN_KIT_TEMPLATE_ONLY;
if(!Number.isInteger(start)||start<0)throw Error('Invalid template start index');
const {templates}=buildBaylineSmallTown(),provenance=await sourceProvenance(),results=[];
await mkdir('out/reviews',{recursive:true});
for(const [index,t]of templates.entries()){
 if(index<start||only&&!only.split(',').map(Number).includes(index))continue;
 const asset=`small-town-template-${index}`,bytes=JSON.stringify(t.pack),validation=validate(t.pack);
 if(!validation.passed)throw Error(JSON.stringify(validation.errors));
 await writeFile(`out/${asset}.json.gz`,gzipSync(bytes));
 await writeFile(`out/${asset}.meta.json`,JSON.stringify({...t.metadata,validation,assetSha256:sha(bytes),provenance},null,2));
 for(const mode of ['stability','traverse']){
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/review.mjs',asset,mode],{stdio:'inherit',env:{...process.env,TOWN_KIT_COMPACT_GPU:'1'}});child.on('error',reject);child.on('exit',(code,signal)=>resolve(signal?1:code));});
  results.push({index,asset,templateKey:t.key,assetSha256:sha(bytes),mode,passed:code===0});
  await writeFile('out/reviews/small-town-template-run.json',JSON.stringify({startedAtTemplate:start,only:only??null,complete:!only&&start===0&&results.length===templates.length*2,passed:results.every(r=>r.passed),results},null,2));
  if(code!==0){process.exitCode=1;break;}
 }
 if(process.exitCode)break;
}
