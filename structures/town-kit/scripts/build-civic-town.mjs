import {gzipSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
import {buildBaylineCivicTown,CIVIC_TOWN_KEY} from '../src/bayline-civic-town.mjs';
import {validate} from '../src/validate.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
process.chdir(KIT);
const {pack,metadata}=buildBaylineCivicTown();
metadata.validation=validate(pack);
if(!metadata.validation.passed)throw Error(JSON.stringify(metadata.validation.errors));
// Verify all placements keep their own destruction graph after composition.
const s=pack.scenario,owners=new Int16Array(s.nodes.length).fill(-1);
for(const [i,instance]of metadata.instances.entries()){
 owners.fill(i,instance.nodeStart,instance.nodeStart+instance.nodeCount);
 for(let n=instance.nodeStart;n<instance.nodeStart+instance.nodeCount;n++)if(!s.nodeGroups[n].endsWith('@'+instance.id))throw Error(`Lost instance identity ${instance.id}`);
}
for(const b of s.bonds)if(owners[b.node0]!==owners[b.node1])throw Error('Cross-instance bond');
metadata.provenance=await sourceProvenance();const bytes=JSON.stringify(pack);metadata.assetSha256=sha(bytes);
await mkdir('out',{recursive:true});
await writeFile(`out/${CIVIC_TOWN_KEY}.json.gz`,gzipSync(bytes,{level:6}));
await writeFile(`out/${CIVIC_TOWN_KEY}.meta.json`,JSON.stringify(metadata,null,2));
console.log(JSON.stringify({asset:CIVIC_TOWN_KEY,...metadata.composition,rooms:metadata.rooms.length,routePoints:metadata.route.length,...metadata.validation,sha256:metadata.assetSha256},null,2));
