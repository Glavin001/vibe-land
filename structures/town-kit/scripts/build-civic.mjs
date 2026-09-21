import {mkdir,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {KIT} from '../src/dependencies.mjs';
import {buildNeighborhoodLibrary} from '../src/neighborhood-library.mjs';
import {buildArtDecoCinema} from '../src/art-deco-cinema.mjs';
import {buildFireStation} from '../src/fire-station.mjs';
import {buildBookStack} from '../src/book-stack.mjs';
import {buildCinemaSeat} from '../src/cinema-seat.mjs';
import {validate} from '../src/validate.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
process.chdir(KIT);
export const builders={'neighborhood-library':buildNeighborhoodLibrary,'art-deco-cinema':buildArtDecoCinema,'fire-station':buildFireStation};
const selected=process.argv[2]?.startsWith('--')?null:process.argv[2],mirrored=process.argv.includes('--mirror');
if(selected&&!builders[selected])throw Error('Unknown civic building');
await mkdir('out',{recursive:true});const provenance=await sourceProvenance();
for(const [key,build]of Object.entries(builders)){
 if(selected&&selected!==key)continue;
 const {pack,metadata}=build({mirrored}),bytes=JSON.stringify(pack),name=key+(mirrored?'-mirror':'');
 const validation=validate(pack);console.log(name,JSON.stringify(validation));
 // Failed candidates remain inspectable but cannot enter native review.
 await writeFile(`out/${name}.json.gz`,gzipSync(bytes));
 await writeFile(`out/${name}.meta.json`,JSON.stringify({...metadata,validation,assetSha256:sha(bytes),provenance},null,2));
 if(!validation.passed)process.exitCode=1;
}

if(!selected&&!mirrored)for(const [name,build]of [['book-stack',buildBookStack],['cinema-seat',buildCinemaSeat]]){
 const {pack,metadata}=build(),bytes=JSON.stringify(pack),validation=validate(pack);
 await writeFile(`out/${name}.json.gz`,gzipSync(bytes));
 await writeFile(`out/${name}.meta.json`,JSON.stringify({...metadata,validation,assetSha256:sha(bytes),provenance},null,2));
 if(!validation.passed)process.exitCode=1;
}
