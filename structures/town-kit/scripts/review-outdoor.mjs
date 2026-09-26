import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {KIT} from '../src/dependencies.mjs';
import {OUTDOOR_PROP_TYPES} from '../src/outdoor-props.mjs';
import {TREE_FAMILIES} from '../src/tree.mjs';
import {reviewInputs} from './preview-output.mjs';
const trees=TREE_FAMILIES.flatMap(f=>[0,1,2].map(v=>`tree-${f}-${v}`));
const tasks=[...trees,...OUTDOOR_PROP_TYPES.map(t=>`outdoor-${t}`)].map(asset=>({asset,modes:['stability']}));
for(const family of TREE_FAMILIES)tasks.push({asset:`tree-${family}-0`,modes:['furniture','collapse']});
for(const type of OUTDOOR_PROP_TYPES)tasks.push({asset:`outdoor-${type}`,modes:['furniture']});
for(const type of ['bus-shelter','market-stall','carport','scaffold','billboard'])tasks.push({asset:`outdoor-${type}`,modes:['collapse']});
for(const kind of ['residential-run','market-encounter','service-yard'])tasks.push({asset:`outdoor-${kind}`,modes:['stability','traverse']});
const results=[];
const retryFailed=process.argv.includes('--retry-failed'),fresh=process.argv.includes('--fresh');
for(const {asset,modes}of tasks)for(const mode of modes){
 const metadata=JSON.parse(await readFile(`${KIT}/out/${asset}.meta.json`,'utf8'));let cached,reviewedMetadata;
 try{cached=JSON.parse(await readFile(`${KIT}/out/reviews/${asset}-${mode}/report.json`,'utf8'));reviewedMetadata=JSON.parse(await readFile(`${KIT}/out/reviews/${asset}-${mode}/asset.meta.json`,'utf8'));}catch{}
 const inputs=m=>reviewInputs(m,mode);
 if(fresh||!cached||cached.interrupted||(retryFailed&&!cached.passed)||cached.packSha256!==metadata.assetSha256||inputs(reviewedMetadata)!==inputs(metadata)){
  const code=await new Promise(resolve=>{const child=spawn(process.execPath,['scripts/review.mjs',asset,mode],{cwd:KIT,stdio:'inherit'});child.on('error',()=>resolve(-1));child.on('exit',code=>resolve(code));});
  try{cached=JSON.parse(await readFile(`${KIT}/out/reviews/${asset}-${mode}/report.json`,'utf8'));}catch{cached={passed:false,error:`Review exited ${code}`};}
 }
 results.push({asset,mode,passed:cached.passed===true,hash:metadata.assetSha256,error:cached.error??null,wallTimeSeconds:cached.wallTimeSeconds});
 await writeFile(`${KIT}/out/outdoor-native-matrix.json`,JSON.stringify({complete:false,results},null,2));
 console.log('OUTDOOR_REVIEW',JSON.stringify(results.at(-1)));
}
await writeFile(`${KIT}/out/outdoor-native-matrix.json`,JSON.stringify({complete:true,passed:results.every(r=>r.passed),results},null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
