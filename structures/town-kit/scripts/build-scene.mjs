import {mkdir,writeFile} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
import {buildBaylineTown,TOWN_KEY} from '../src/bayline-town.mjs';
import {validate} from '../src/validate.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
process.chdir(KIT);
const {pack,metadata}=buildBaylineTown();
metadata.validation=validate(pack);
for(const instance of metadata.instances){instance.sourceSha256=sha(JSON.stringify(instance.sourcePack));delete instance.sourcePack;delete instance.shots;delete instance.shotGroups;}
if(!metadata.validation.passed)throw Error(JSON.stringify(metadata.validation.errors));
const bytes=JSON.stringify(pack);metadata.assetSha256=sha(bytes);metadata.provenance=await sourceProvenance();
await mkdir('out',{recursive:true});
await writeFile(`out/${TOWN_KEY}.json`,bytes);await writeFile(`out/${TOWN_KEY}.meta.json`,JSON.stringify(metadata,null,2));
console.log(JSON.stringify({asset:TOWN_KEY,buildings:metadata.instances.length,rooms:metadata.rooms.length,routePoints:metadata.route.length,...metadata.validation,sha256:metadata.assetSha256},null,2));
