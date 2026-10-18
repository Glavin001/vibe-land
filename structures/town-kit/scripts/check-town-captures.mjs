import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {sha} from './provenance.mjs';
import {readArtifact} from './artifacts.mjs';
const bases=['porch-house','corner-grocery','workshop'],results=[];
const read=async p=>JSON.parse(await readFile(path.join(KIT,p),'utf8'));
for(const base of bases){
 for(const asset of [base,`${base}-mirror`]){
  try{
   const hash=sha(await readFile(path.join(KIT,`out/${asset}.json`))),mb=await readFile(path.join(KIT,`out/${asset}.meta.json`)),meta=JSON.parse(mb),v=await read(`out/reviews/${asset}-visual/visual-report.json`);
   if(v.hash!==hash||v.metadataSha256!==sha(mb)||v.errors.length||v.finish!=='fine'||Object.keys(meta.cameras).some(k=>!v.captures.includes(k)))throw Error('Missing, stale, or incomplete intact capture');
   results.push({asset,kind:'intact',passed:true,images:v.captures.length});
  }catch(e){results.push({asset,kind:'intact',passed:false,error:String(e)});}
 }
 for(const mode of ['glazing','wall','furniture','collapse',...(base==='porch-house'?['fence']:[]),'traverse']){
  try{
   const hash=sha(await readFile(path.join(KIT,`out/${base}.json`))),mh=sha(await readFile(path.join(KIT,`out/${base}.meta.json`))),dir=`out/reviews/${base}-${mode}`,r=await read(`${dir}/report.json`),rh=sha(await readArtifact(path.join(KIT,`${dir}/recording.json`)));
   if(r.packSha256!==hash||r.metadataSha256!==mh)throw Error('Stale native evidence');
   if(mode!=='traverse'){
    const v=await read(`${dir}/visual-report.json`);
    if(v.hash!==hash||v.metadataSha256!==mh||v.recordingSha256!==rh||v.errors.length||v.finish!=='fine'||!v.captures.length||!v.nativeStatus.startsWith(r.passed?'PASS':'FAIL'))throw Error('Stale images or incorrect pass/failure label');
    results.push({asset:base,kind:mode,passed:true,nativePassed:r.passed,images:v.captures.length});
   }
   if(['traverse','collapse'].includes(mode)||(mode==='wall'&&r.wallTraversal?.passed)){
    const v=await read(`${dir}/video-report.json`),file=`${dir}/${mode}${r.passed?'':'-failed'}.webm`;
    if(v.packHash!==hash||v.recordingSha256!==rh||v.passed!==r.passed||v.finish!=='fine'||v.errors.length||v.videoSha256!==sha(await readFile(path.join(KIT,file))))throw Error('Stale video or incorrect native status');
    results.push({asset:base,kind:`${mode}-video`,passed:true,nativePassed:r.passed,file});
   }
  }catch(e){results.push({asset:base,kind:mode,passed:false,error:String(e)});}
 }
}
const result={recordedAt:new Date().toISOString(),passed:results.every(r=>r.passed),scope:'Capture consistency only; failed physics is expected to remain visibly labelled and does not gain acceptance.',results};
await writeFile(path.join(KIT,'out/reviews/town-capture-audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,checks:results.length,failures:results.filter(r=>!r.passed)},null,2));if(!result.passed)process.exitCode=1;
