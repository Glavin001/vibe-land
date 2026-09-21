import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {sha} from './provenance.mjs';
const bases=['porch-house','corner-grocery','workshop'];
const results=[];
for(const base of bases)for(const [asset,modes] of [
 [base,['stability','traverse','glazing','wall','furniture','collapse',...(base==='porch-house'?['fence']:[])]],
 [`${base}-mirror`,['stability','traverse']],
 [`${base}-reuse`,['stability','wall']],
]){
 const hash=sha(await readFile(path.join(KIT,`out/${asset}.json`))),metadataHash=sha(await readFile(path.join(KIT,`out/${asset}.meta.json`)));
 for(const mode of modes){
  let report;try{report=JSON.parse(await readFile(path.join(KIT,`out/reviews/${asset}-${mode}/report.json`)));}catch{}
  const current=report?.packSha256===hash&&report?.metadataSha256===metadataHash;
  const opening=mode!=='wall'||report?.wallOpening?.passed===true;
  results.push({asset,mode,current,passed:current&&report?.passed===true&&opening,packHash:hash,error:!report?'Missing review':!current?'Stale review':report.error??(!opening?'No measured doorway-sized wall opening':null)});
 }
}
const result={recordedAt:new Date().toISOString(),nativePassed:results.every(r=>r.passed),readyForImport:false,scope:'Native gate inventory only; staging separately requires current pose audits, actual image approval, and recordings.',results};
await writeFile(path.join(KIT,'out/reviews/town-status.json'),JSON.stringify(result,null,2));
for(const base of bases){const rows=results.filter(r=>r.asset===base);console.log(`${base}: ${rows.filter(r=>r.passed).length}/${rows.length} native gates`);for(const r of rows.filter(r=>!r.passed))console.log(`  ${r.mode}: ${r.error}`);}
if(!result.nativePassed)process.exitCode=1;
