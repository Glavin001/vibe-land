import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url)),kit=path.resolve(here,'../..'),manifest=JSON.parse(await readFile(path.join(here,'manifest.json')));
const asset=gunzipSync(await readFile(path.join(here,'chair.json.gz'))),metadata=await readFile(path.join(here,'chair.meta.json')),sha=b=>createHash('sha256').update(b).digest('hex');
if(sha(asset)!==manifest.assetSha256||sha(metadata)!==manifest.metadataSha256)throw Error('Reproduction snapshot hash mismatch');
const results=[];
for(const iterations of [16,2048]){
 const slug=`repro-budget-chair-${iterations}`;await writeFile(path.join(kit,`out/${slug}.json`),asset);await writeFile(path.join(kit,`out/${slug}.meta.json`),metadata);
 const env={...process.env,TOWN_KIT_ITERATIONS:String(iterations),TOWN_KIT_PRESERVE_CONTACTS:'1',TOWN_KIT_GPU_ISLAND_REPAIR:'1',TOWN_KIT_TILED_GROUND:'0',VIBE_CITY_NATIVE_CORRECTION_LIMIT:'1'};delete env.TOWN_KIT_CONTACT_ITERATIONS;delete env.TOWN_KIT_CONTACT_OFFSET;
 const exitCode=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['scripts/review.mjs',slug,'stability'],{cwd:kit,env,stdio:'inherit'});p.on('error',reject);p.on('exit',resolve);});
 const r=JSON.parse(await readFile(path.join(kit,`out/reviews/${slug}-stability/report.json`)));results.push({iterations,exitCode,passed:r.passed,error:r.error,spontaneousBonds:r.spontaneousBonds?.length??0,lastStatus:r.lastStatus});
}
const reproduced=results[0].passed&&!results[1].passed&&results[1].spontaneousBonds>0;
await writeFile(path.join(kit,'out/reviews/native-budget-reproduction.json'),JSON.stringify({reproduced,assetSha256:manifest.assetSha256,results},null,2));console.log({reproduced,results});if(!reproduced)process.exitCode=1;
