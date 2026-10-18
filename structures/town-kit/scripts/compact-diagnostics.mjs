import {readdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {KIT} from '../src/dependencies.mjs';
import {sha} from './provenance.mjs';
import path from 'node:path';
const results=[];
for(const name of await readdir(path.join(KIT,'out'))){
 if(!/^(?:diag-|cal-|lab-|final-|district-template-).*\.json$/.test(name)||name.endsWith('.meta.json'))continue;
 const file=path.join(KIT,'out',name),bytes=await readFile(file),compressed=gzipSync(bytes,{level:6});
 if(compressed.length>=bytes.length)continue;
 await writeFile(file+'.gz.partial',compressed);
 if(sha(gunzipSync(await readFile(file+'.gz.partial')))!==sha(bytes))throw Error(`Compression verification failed: ${name}`);
 await rename(file+'.gz.partial',file+'.gz');await unlink(file);
 results.push({name,sha256:sha(bytes),savedBytes:bytes.length-compressed.length});
}
await writeFile(path.join(KIT,'out/reviews',`compact-inputs-${Date.now()}.json`),JSON.stringify(results,null,2));console.log({files:results.length,savedMiB:results.reduce((n,r)=>n+r.savedBytes,0)/1024**2});
