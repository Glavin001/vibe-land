import {writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {buildArtDecoCinema} from '../../src/art-deco-cinema.mjs';
import {validate} from '../../src/validate.mjs';
import {sha,sourceProvenance} from '../../scripts/provenance.mjs';
const {pack,metadata}=buildArtDecoCinema();
pack.key='cinema-mortar-review';
const table=pack.defaults.solver.materials,index=table.length;
table.push({...table.find(m=>m.name==='brick-plinth'),name:'civic-mortar-joint',compressionElastic:8e6,compressionFatal:16e6,tensionElastic:1.5e5,tensionFatal:3e5,shearElastic:2.5e5,shearFatal:5e5,elasticModulus:1e9});
let joints=0;for(const b of pack.scenario.bonds)if([b.node0,b.node1].every(n=>pack.scenario.nodeTypes[n]==='masonry-wall')){b.m=index;joints++;}
// The original low round has less floor clearance than its radius.
// Clear the slab with a smaller radius and cover a real doorway-sized area.
metadata.shots.wall=[];
for(const height of [.50,1.3,2.1])for(const lateral of [0,-.4,.4])for(let repeat=0;repeat<2;repeat++)metadata.shots.wall.push({from:[-7,height,lateral],to:[-5.9,height,lateral],momentum:700000,radius:.26,speed:30,tick:metadata.shots.wall.length*60});
metadata.validation=validate(pack);metadata.provenance=await sourceProvenance();const bytes=JSON.stringify(pack);metadata.assetSha256=sha(bytes);
await writeFile(`out/${pack.key}.json.gz`,gzipSync(bytes));await writeFile(`out/${pack.key}.meta.json`,JSON.stringify(metadata,null,2));
console.log(JSON.stringify({joints,...metadata.validation}));if(!metadata.validation.passed)process.exitCode=1;
