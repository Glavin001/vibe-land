import path from 'node:path';
import {createReadStream} from 'node:fs';
import {readdir,readFile,stat} from 'node:fs/promises';

export const reviewInputs=(m,mode)=>JSON.stringify([m?.shots?.[mode],m?.shotGroups?.[mode],m?.collapseNodes,m?.route,m?.options,m?.fractureReview]);
async function artifact(file){for(const suffix of ['',...(file.endsWith('.json')?['.gz','.br']:[])]){try{if((await stat(file+suffix)).isFile())return {file:file+suffix,suffix};}catch(e){if(e.code!=='ENOENT')throw e;}}return null;}
export async function previewCatalog(root){
 const assets=[];
 for(const file of (await readdir(root)).sort()){
  if(!file.endsWith('.meta.json'))continue;const name=file.slice(0,-10);
  if(!/^[a-z0-9-]+$/.test(name)||!await artifact(path.join(root,name+'.json')))continue;
  const meta=JSON.parse(await readFile(path.join(root,file),'utf8'));if(meta.previewHidden)continue;
  const recordings=[];
  for(const mode of ['stability','traverse','glazing','wall','furniture','fence','collapse','cannon']){
   const dir=path.join(root,'reviews',`${name}-${mode}`);
   try{
    const report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'));
    const reviewed=JSON.parse(await readFile(path.join(dir,'asset.meta.json'),'utf8'));
    const current=report.packSha256===meta.assetSha256&&reviewInputs(meta,mode)===reviewInputs(reviewed,mode);
    const available=!!await artifact(path.join(dir,'recording.json'));
    recordings.push({mode,passed:report.passed===true,current,available,error:report.error??null});
   }catch(e){if(e.code!=='ENOENT')throw e;}
  }
  assets.push({name,recordings});
 }
 return {assets};
}
export function previewOutput(root){
 root=path.resolve(root);
 return async(req,res)=>{
  const json=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  try{
   let url;try{url=decodeURIComponent((req.url??'').split('?')[0]);}catch{return json(400,{error:'Invalid asset URL'});}
   if(url==='/catalog.json')return json(200,await previewCatalog(root));
   const file=path.resolve(root,`.${url}`);if(!file.startsWith(root+path.sep))return json(403,{error:'Invalid asset path'});
   const target=await artifact(file);if(!target)return json(404,{error:`Not built or recorded: ${url.slice(1)}`});
   const type={'.json':'application/json','.html':'text/html','.png':'image/png','.webm':'video/webm'}[path.extname(file)]??'application/octet-stream';
   res.setHeader('Content-Type',type);res.setHeader('Cache-Control','no-store');
   if(target.suffix)res.setHeader('Content-Encoding',target.suffix==='.gz'?'gzip':'br');
   createReadStream(target.file).on('error',e=>res.destroy(e)).pipe(res);
  }catch(e){json(500,{error:`Unable to read preview artifact: ${e.message}`});}
 };
}
