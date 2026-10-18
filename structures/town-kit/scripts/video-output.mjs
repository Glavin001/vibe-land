import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Local canvas recorder sink. No caller-selected paths or remote uploads. */
export function videoOutput(root){return async(req,res)=>{
 const reply=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
 if(req.method!=='POST'||req.url!=='/gardens-market')return reply(404,{error:'Unknown recording'});
 if(req.headers.origin!==`http://${req.headers.host}`)return reply(403,{error:'Same-origin recorder required'});
 if(req.headers['content-type']!=='video/webm')return reply(415,{error:'WebM required'});
 try{
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>256*1024*1024)return reply(413,{error:'Recording exceeds 256 MB'});chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);if(bytes.length<1024||bytes.readUInt32BE(0)!==0x1a45dfa3)return reply(400,{error:'Invalid WebM recording'});
  const file=`gardens-market-cannon-tour-${Date.now()}.webm`,dir=path.join(root,'films');
  await mkdir(dir,{recursive:true});await writeFile(path.join(dir,file),bytes,{flag:'wx'});
  reply(201,{file,url:`/kit/films/${file}`,bytes:size});
 }catch(error){reply(500,{error:String(error.message??error)});}
};}
