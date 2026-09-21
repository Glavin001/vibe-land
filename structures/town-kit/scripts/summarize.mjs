import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {sha} from './provenance.mjs';
const json=async p=>JSON.parse(await readFile(path.join(KIT,p),'utf8'));
const matrix=await json('out/reviews/matrix.json');
for(const row of matrix.results){
 try{
  const data=await readFile(path.join(KIT,`out/${row.asset}.json`)),mb=await readFile(path.join(KIT,`out/${row.asset}.meta.json`)),m=JSON.parse(mb);
  row.assetSha256=sha(data);row.metadataSha256=sha(mb);
  if(row.mode==='geometry')row.passed=m.validation.passed&&m.assetSha256===row.assetSha256;
  else {const r=await json(`out/reviews/${row.asset}-${row.mode}/report.json`);row.passed=r.passed&&r.packSha256===row.assetSha256&&r.metadataSha256===row.metadataSha256;row.error=row.passed?undefined:r.error??'stale or absent evidence';}
 }catch(e){row.passed=false;row.error=String(e);}
}
try{matrix.restAuditPassed=(await json('out/reviews/rest-audit.json')).passed;}catch{matrix.restAuditPassed=false;}
matrix.passed=matrix.results.every(r=>r.passed)&&matrix.restAuditPassed;matrix.reconciledAt=new Date().toISOString();
await writeFile(path.join(KIT,'out/reviews/matrix.json'),JSON.stringify(matrix,null,2));
const readiness={ready:false,recordedAt:new Date().toISOString(),matrix,default:[]};
const hash=sha(await readFile(path.join(KIT,'out/victorian-corner.json'))),metadataHash=sha(await readFile(path.join(KIT,'out/victorian-corner.meta.json')));
for(const mode of ['stability','traverse','glazing','wall','furniture','fence','collapse']){
 try{const r=await json(`out/reviews/victorian-corner-${mode}/report.json`);readiness.default.push({mode,passed:r.passed&&r.packSha256===hash&&r.metadataSha256===metadataHash,error:r.error,hash:r.packSha256});}
 catch(e){readiness.default.push({mode,passed:false,error:String(e)});}
}
readiness.physicsPassed=matrix.passed&&readiness.default.every(r=>r.passed);
// This summary never grants visual acceptance or writes staged assets.
await writeFile(path.join(KIT,'out/reviews/readiness.json'),JSON.stringify(readiness,null,2));
console.log(JSON.stringify({matrixPassed:matrix.passed,failures:matrix.results.filter(r=>!r.passed),default:readiness.default},null,2));
