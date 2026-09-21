import {readFile} from 'node:fs/promises';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
/** Read logical artifact bytes; hashes remain identical across lossless storage. */
export async function readArtifact(file,encoding){
 let bytes;
 try{bytes=await readFile(file);}catch(error){
  if(error.code!=='ENOENT')throw error;
  try{bytes=gunzipSync(await readFile(`${file}.gz`));}catch(gzipError){
   if(gzipError.code!=='ENOENT')throw gzipError;
   bytes=brotliDecompressSync(await readFile(`${file}.br`));
  }
 }
 return encoding?bytes.toString(encoding):bytes;
}
