import {readFile,writeFile} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
import {readArtifact} from './artifacts.mjs';
import {sha} from './provenance.mjs';
process.chdir(KIT);
const results=[];
for(const asset of ['neighborhood-library','art-deco-cinema','fire-station'].flatMap(n=>[n,n+'-mirror']).concat(['book-stack','cinema-seat'])){
 const m=JSON.parse(await readFile(`out/${asset}.meta.json`)),bytes=await readArtifact(`out/${asset}.json`),hash=sha(bytes),modes=m.kind==='prop'?['stability','furniture']:['stability','traverse','glazing','wall','furniture','collapse'];
 const modeMetadata=(x,mode)=>({storeys:x.options?.storeys,furnished:x.options?.furnished,buildingType:x.buildingType,...(mode==='traverse'?{route:x.route}:{}),...(!['stability','traverse'].includes(mode)?{shots:x.shots?.[mode],group:x.shotGroups?.[mode]}:{})});
 for(const mode of modes){
  try{
   const dir=`out/reviews/${asset}-${mode}`,r=JSON.parse(await readFile(`${dir}/report.json`)),input=JSON.parse(await readFile(`${dir}/asset.meta.json`));
   const current=r.packSha256===hash&&JSON.stringify(modeMetadata(m,mode))===JSON.stringify(modeMetadata(input,mode));
   results.push({asset,mode,current,passed:current&&r.passed,error:current?(r.error??null):'Review belongs to different asset or case inputs',brokenBonds:r.destruction?.brokenBonds??r.stability?.brokenBonds??null,checkpoints:r.traversal?.checkpoints?.length??null});
  }catch(e){if(e.code!=='ENOENT')throw e;results.push({asset,mode,current:false,passed:false,error:'Not yet measured'});}
 }
}
const visual=[];
for(const asset of ['neighborhood-library','art-deco-cinema','fire-station']){
 const m=JSON.parse(await readFile(`out/${asset}.meta.json`)),v=JSON.parse(await readFile(`out/reviews/${asset}-visual/visual-report.json`));
 visual.push({asset,assetMatches:v.hash===m.assetSha256,complete:!v.pending&&v.errors?.length===0,captures:v.captures??[]});
}
const report={readyForImport:false,nativePassed:results.filter(r=>r.passed).length,nativeRequired:results.length,results,visual};
await writeFile('out/reviews/civic-status.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
