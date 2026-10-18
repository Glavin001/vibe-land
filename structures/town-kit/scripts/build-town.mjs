import {KIT} from '../src/dependencies.mjs';
process.chdir(KIT);
import {mkdir,writeFile} from 'node:fs/promises';
import {buildPorchHouse,buildCornerGrocery,buildWorkshop,validate} from '../src/index.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
const builders={'porch-house':buildPorchHouse,'corner-grocery':buildCornerGrocery,workshop:buildWorkshop};
const selected=process.argv[2]?.startsWith('--')?null:process.argv[2],mirror=process.argv.includes('--mirror');
if(selected&&!builders[selected])throw Error(`Unknown town building: ${selected}`);
await mkdir('out',{recursive:true});let failed=false;
for(const [key,build] of Object.entries(builders)){
 if(selected&&selected!==key)continue;
 const {pack,metadata}=build({mirrored:mirror}),bytes=JSON.stringify(pack),name=key+(mirror?'-mirror':'');metadata.validation=validate(pack);metadata.assetSha256=sha(bytes);metadata.provenance=await sourceProvenance();
 await writeFile(`out/${name}.json`,bytes);await writeFile(`out/${name}.meta.json`,JSON.stringify(metadata,null,2));console.log(name,JSON.stringify(metadata.validation));failed||=!metadata.validation.passed;
}
if(failed)process.exitCode=1;
