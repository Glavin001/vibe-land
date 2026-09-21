import {KIT} from '../src/dependencies.mjs';
process.chdir(KIT);
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {sha} from './provenance.mjs';
const keys=['porch-house','corner-grocery','workshop'],modes=process.argv.slice(2);if(!modes.length)modes.push('stability','traverse','glazing','wall','furniture','collapse');
const results=[];
for(const asset of keys)for(const mode of modes){
 const exitCode=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['scripts/review.mjs',asset,mode],{stdio:'inherit'});p.on('error',reject);p.on('exit',code=>resolve(code));});
 let report;try{report=JSON.parse(await readFile(`out/reviews/${asset}-${mode}/report.json`));}catch{}
 const packHash=sha(await readFile(`out/${asset}.json`)),metadataHash=sha(await readFile(`out/${asset}.meta.json`));
 results.push({asset,mode,exitCode,passed:exitCode===0&&report?.passed===true&&report.packSha256===packHash&&report.metadataSha256===metadataHash,packHash,metadataHash,error:report?.error??(exitCode?'review did not complete':undefined)});
 await writeFile('out/reviews/town-review.json',JSON.stringify({recordedAt:new Date().toISOString(),passed:results.length===keys.length*modes.length&&results.every(r=>r.passed),modes,results},null,2));
}
if(results.some(r=>!r.passed))process.exitCode=1;
