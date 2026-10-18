import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {KIT} from '../../src/dependencies.mjs';
process.chdir(KIT);
const selections=process.argv.slice(2);
if(!selections.length)throw Error('Specify asset:mode pairs, e.g. victorian:centroids');
const results=[];
for(const selection of selections){
 const [asset,mode]=selection.split(':');
 if(!['victorian','workshop'].includes(asset)||!['baseline','centroids','matched-topology'].includes(mode))throw Error('Invalid selection');
 const slug=`lab-autobond-${asset}-${mode}`,meta=JSON.parse(readFileSync(`out/${slug}.meta.json`));
 if(!meta.validation.passed){results.push({asset,mode,skipped:'Geometry gate failed',validation:meta.validation});continue;}
 const exit=await new Promise((resolve,reject)=>{
  const p=spawn('timeout',['300s',process.execPath,'scripts/review.mjs',slug,'stability'],{stdio:'inherit',env:{...process.env,TOWN_KIT_COMPACT_GPU:'1'}});
  p.on('error',reject);p.on('exit',(code,signal)=>resolve({code,signal}));
 });
 const file=`out/reviews/${slug}-stability/report.json`;
 results.push({asset,mode,...exit,report:existsSync(file)?JSON.parse(readFileSync(file)):null});
 mkdirSync('out/reviews/autobond-placements',{recursive:true});
 writeFileSync('out/reviews/autobond-placements/review-run.json',JSON.stringify({exclusiveGpu:false,results},null,2));
 // A timeout can leave a child shutting down; never overlap another GPU case.
 if(exit.code===124||exit.signal)throw Error('Review timed out; inspect ownership before continuing');
}
