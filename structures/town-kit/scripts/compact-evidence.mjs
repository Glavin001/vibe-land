import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {gunzipSync,brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {sha} from './provenance.mjs';
import {KIT} from '../src/dependencies.mjs';
import path from 'node:path';
const results=[];
for(const name of process.argv.slice(2)){
 if(!/^[a-z0-9-]+$/.test(name))throw Error('Expected a completed review name');
 const base=path.join(KIT,'out/reviews',name),source=path.join(base,'recording.json.gz');
 const compressed=await readFile(source),raw=gunzipSync(compressed),hash=sha(raw);
 const bytes=brotliCompressSync(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:4}});
 if(bytes.length>=compressed.length)continue;
 const dest=path.join(base,'recording.json.br'),temporary=dest+'.partial';
 await writeFile(temporary,bytes);
 if(sha(brotliDecompressSync(await readFile(temporary)))!==hash)throw Error('Compression verification failed');
 await rename(temporary,dest);await unlink(source);
 const reportPath=path.join(base,'report.json');try{const report=JSON.parse(await readFile(reportPath));report.recordingEncoding='brotli';await writeFile(reportPath,JSON.stringify(report,null,2));}catch(e){if(e.code!=='ENOENT')throw e;}
 results.push({name,sha256:hash,savedBytes:compressed.length-bytes.length});console.log(JSON.stringify(results.at(-1)));
}
await writeFile(path.join(KIT,'out/reviews',`compression-${Date.now()}.json`),JSON.stringify(results,null,2));
