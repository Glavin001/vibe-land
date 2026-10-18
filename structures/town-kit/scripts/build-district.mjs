import {gzipSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
import {buildBaylineDistrict,DISTRICT_KEY} from '../src/bayline-district.mjs';
import {validate} from '../src/validate.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
process.chdir(KIT);
const {pack,metadata,templates}=buildBaylineDistrict(),provenance=await sourceProvenance();
await mkdir('out',{recursive:true});
for(const [index,a]of templates.entries()){
 const name=`district-template-${index}`,validation=validate(a.pack);if(!validation.passed)throw Error(`${name}: ${JSON.stringify(validation.errors)}`);
 const bytes=JSON.stringify(a.pack);await writeFile(`out/${name}.json.gz`,gzipSync(bytes,{level:6}));await writeFile(`out/${name}.meta.json`,JSON.stringify({...a.metadata,validation,assetSha256:sha(bytes),provenance},null,2));
}
metadata.validation=validate(pack);if(!metadata.validation.passed)throw Error(JSON.stringify(metadata.validation.errors));
const bytes=JSON.stringify(pack);metadata.assetSha256=sha(bytes);metadata.provenance=provenance;
await writeFile(`out/${DISTRICT_KEY}.json`,bytes);await writeFile(`out/${DISTRICT_KEY}.meta.json`,JSON.stringify(metadata,null,2));
await writeFile('out/district-templates.json',JSON.stringify(templates.map((a,index)=>({asset:`district-template-${index}`,key:a.key,hash:a.hash})),null,2));
console.log(JSON.stringify({asset:DISTRICT_KEY,...metadata.composition,rooms:metadata.rooms.length,routePoints:metadata.route.length,...metadata.validation,sha256:metadata.assetSha256},null,2));
