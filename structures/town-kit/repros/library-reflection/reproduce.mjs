import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {KIT} from '../../src/dependencies.mjs';
import {buildNeighborhoodLibrary,composeScene,validate} from '../../src/index.mjs';
import {sha,sourceProvenance} from '../../scripts/provenance.mjs';
process.chdir(KIT);
const base=buildNeighborhoodLibrary({furnished:false}),provenance=await sourceProvenance(),results=[];
for(const [name,pack]of [['diag-library-shell',base.pack],['diag-library-shell-reflection',composeScene([{pack:base.pack,mirror:true}],{key:'library-reflection-control'})]]){
 const bytes=JSON.stringify(pack);await writeFile(`out/${name}.json.gz`,gzipSync(bytes));await writeFile(`out/${name}.meta.json`,JSON.stringify({...base.metadata,validation:validate(pack),assetSha256:sha(bytes),provenance},null,2));
 const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['scripts/review.mjs',name,'stability'],{stdio:'inherit',env:{...process.env,TOWN_KIT_COMPACT_GPU:'1'}});p.on('error',reject);p.on('exit',resolve);});
 const report=JSON.parse(await readFile(`out/reviews/${name}-stability/report.json`));results.push({name,exitCode:code,report});
}
await mkdir('out/reviews',{recursive:true});
const reproduced=results[0].report.passed===true&&results[1].report.passed===false&&results[1].report.nativeFailure?.includes('error: 64');
await writeFile('out/reviews/library-reflection-repro.json',JSON.stringify({reproduced,results},null,2));
console.log(JSON.stringify({reproduced,results:results.map(({name,report})=>({name,passed:report.passed,error:report.error??null}))},null,2));
