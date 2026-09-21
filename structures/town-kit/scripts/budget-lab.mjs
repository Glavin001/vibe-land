import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {buildProp,validate} from '../src/index.mjs';
import {KIT} from '../src/dependencies.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
process.chdir(KIT);const results=[];
for(const prop of ['chair','bed','sofa','refrigerator']){
 const {pack,metadata}=buildProp(prop),bytes=JSON.stringify(pack);metadata.validation=validate(pack);metadata.assetSha256=sha(bytes);metadata.provenance=await sourceProvenance();metadata.diagnostic='Identical prop input compared at two stress iteration budgets, with unchanged gravity, contacts, and material strengths.';
 const mb=JSON.stringify(metadata,null,2);
 for(const iterations of [16,2048]){
  const asset=`lab-budget-${prop}-${iterations}`;await writeFile(`out/${asset}.json`,bytes);await writeFile(`out/${asset}.meta.json`,mb);
  const exitCode=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['scripts/review.mjs',asset,'stability'],{stdio:'inherit',env:{...process.env,TOWN_KIT_ITERATIONS:String(iterations)}});p.on('error',reject);p.on('exit',resolve);});
  const r=JSON.parse(await readFile(`out/reviews/${asset}-stability/report.json`));results.push({asset,prop,iterations,exitCode,passed:r.passed,error:r.error,packSha256:metadata.assetSha256,metadataSha256:sha(mb),chunks:pack.scenario.nodes.length,bonds:pack.scenario.bonds.length});
  await writeFile('out/reviews/budget-lab.json',JSON.stringify({results},null,2));
  if(iterations===16&&!r.passed)throw Error(`${prop} baseline failed`);
  if(iterations===2048&&!r.passed){console.log('Reduced budget discrepancy to',prop,pack.scenario.nodes.length,'chunks');process.exit(0);}
 }
}
console.log('No isolated prop reproduced the furnished-assembly failure.');
