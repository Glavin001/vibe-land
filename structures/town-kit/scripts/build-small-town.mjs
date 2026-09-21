import {gzipSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
import {buildBaylineSmallTown,SMALL_TOWN_KEY} from '../src/bayline-small-town.mjs';
import {validate} from '../src/validate.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
process.chdir(KIT);
const {pack,metadata,templates}=buildBaylineSmallTown();
for(const t of templates){const result=validate(t.pack);if(!result.passed)throw Error(`${t.key}: ${JSON.stringify(result.errors)}`);}
metadata.validation=validate(pack);if(!metadata.validation.passed)throw Error(JSON.stringify(metadata.validation.errors));
metadata.provenance=await sourceProvenance();const bytes=JSON.stringify(pack);metadata.assetSha256=sha(bytes);
await mkdir('out',{recursive:true});await writeFile(`out/${SMALL_TOWN_KEY}.json.gz`,gzipSync(bytes,{level:6}));await writeFile(`out/${SMALL_TOWN_KEY}.meta.json`,JSON.stringify(metadata,null,2));
// Only the two newly introduced shop interior families need separate exports;
// district templates already cover the other building families.
for(const [name,signText]of [['strip-shop','BOOKS'],['strip-cafe','CAFE']]){const {buildStripShop}=await import('../src/strip-shop.mjs');const a=buildStripShop({signText}),data=JSON.stringify(a.pack);await writeFile(`out/${name}.json.gz`,gzipSync(data));await writeFile(`out/${name}.meta.json`,JSON.stringify({...a.metadata,validation:validate(a.pack),assetSha256:sha(data),provenance:metadata.provenance},null,2));}
console.log(JSON.stringify({asset:SMALL_TOWN_KEY,...metadata.composition,rooms:metadata.rooms.length,routePoints:metadata.route.length,...metadata.validation,sha256:metadata.assetSha256},null,2));
