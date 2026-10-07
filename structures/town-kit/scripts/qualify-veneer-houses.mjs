#!/usr/bin/env node
// The brick-veneer houses' structural qualification, rerunnable:
//
//   node structures/town-kit/scripts/qualify-veneer-houses.mjs [--storeys 1,2] [--ticks 300]
//
// Builds each house and its two variants (build-veneer-houses.mjs) and
// qualifies each alone at rest on the GPU under the app's stress settings
// (scripts/perf/qualify_structures.py: the city's 16-iteration cap, FP32,
// PASS at <= 10% unconverged ticks and <= 0.5% bonds broken). Expected:
//
//   as built                          PASS
//   --frame (veneer and board off)    PASS: the frame carries the house alone
//   --no-front-studs                  comes down: >= 4x the at-rest gate
//                                     (2% of its bonds) broken, whatever the
//                                     solve's verdict (a collapsing structure
//                                     re-solves every tick)
//
// Takes the shared GPU lock (target/native-bundle.lock) for the whole run and
// releases it however the run ends; VIBE_GPU_SHARED=1 shares the GPU instead. Writes target/qualify-structures/veneer-houses.json.
// Exit 1 when an expectation fails.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import {KIT,REPO} from '../src/dependencies.mjs';

const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const storeys=arg('--storeys','1,2'),ticks=arg('--ticks','300');
const COLLAPSE_SHARE=2.0;

execFileSync('node',[path.join(KIT,'scripts/build-veneer-houses.mjs'),'--storeys',storeys],{stdio:'inherit'});
const out=path.join(KIT,'out/veneer-houses'),keys=storeys.split(',').map(n=>n==='1'?'veneer-bungalow':'veneer-house');
// The two-storey also without its ground floor's front studs only: reported,
// no expectation (does the upper storey bridge the gap?).
const packs=keys.flatMap(k=>['',  '--frame','--no-front-studs',...(k==='veneer-house'?['--no-ground-front-studs']:[])].map(v=>path.join(out,`${k}${v}.json`)));

const lock=path.join(REPO,'target/native-bundle.lock'),json=path.join(REPO,'target/qualify-structures/veneer-houses.json');
mkdirSync(path.dirname(json),{recursive:true});
const sleep=s=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,s*1000);
// VIBE_GPU_SHARED=1: a correctness run may share the GPU (gpu-run.sh); no lock.
const shared=process.env.VIBE_GPU_SHARED==='1';
if(!shared){
 for(;;){try{mkdirSync(lock);break;}catch{sleep(15);}}
 writeFileSync(path.join(lock,'owner'),`qualify-veneer-houses ${process.pid} ${new Date().toISOString()}\n`);
}
const release=()=>{if(!shared&&existsSync(lock))rmSync(lock,{recursive:true,force:true});};
process.on('exit',release);for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{release();process.exit(130);});
try{
 try{execFileSync('python3',[path.join(REPO,'scripts/perf/qualify_structures.py'),...packs,'--ticks',ticks,'--json',json],{cwd:REPO,stdio:'inherit'});}
 catch{/* exit 1 is expected: the collapse variant fails the gate */}
}finally{release();}

const results=JSON.parse(readFileSync(json,'utf8'));let failed=0;
console.log('\nexpectations:');
for(const r of results){
 if(r.structure.endsWith('--no-ground-front-studs')){console.log(`info ${r.structure.padEnd(32)} ${r.broken_pct?.toFixed(2)}% broken (unconverged ${r.unconverged_pct?.toFixed(1)}%)`);continue;}
 const collapse=r.structure.endsWith('--no-front-studs');
 const ok=collapse?r.broken_pct!=null&&r.broken_pct>=COLLAPSE_SHARE:r.verdict==='PASS';
 if(!ok)failed++;
 console.log(`${ok?'ok  ':'FAIL'} ${r.structure.padEnd(32)} ${collapse?`comes down: ${r.broken_pct?.toFixed(2)}% broken (>= ${COLLAPSE_SHARE}%)`:`stands: ${r.verdict}`}  (unconverged ${r.unconverged_pct?.toFixed(1)}%, broken ${r.broken_pct?.toFixed(2)}%)`);
}
process.exitCode=failed?1:0;
