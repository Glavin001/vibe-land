import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Writable} from 'node:stream';
import {gzipSync,gunzipSync} from 'node:zlib';
import {previewOutput,previewCatalog} from '../scripts/preview-output.mjs';

test('missing preview artifacts return JSON errors instead of falling through to the SPA',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'town-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const handler=previewOutput(root);
 async function request(url){
  const chunks=[],headers={};const response=new Writable({write(chunk,_,done){chunks.push(chunk);done();}});response.statusCode=200;response.setHeader=(k,v)=>headers[k]=v;
  const done=new Promise((resolve,reject)=>{response.on('finish',resolve);response.on('error',reject);});await handler({url},response);await done;
  return {status:response.statusCode,headers,body:Buffer.concat(chunks)};
 }
 for(const file of ['/absent.json','/absent.meta.json','/reviews/absent-collapse/recording.json']){
  const r=await request(file);assert.equal(r.status,404);assert.match(r.headers['Content-Type'],/application\/json/);assert.match(JSON.parse(r.body).error,/Not built or recorded/);
 }
 assert.equal((await request('/../../secret')).status,403);assert.equal((await request('/%broken')).status,400);
 await writeFile(path.join(root,'asset.json.gz'),gzipSync('{"ok":true}'));
 const r=await request('/asset.json');assert.equal(r.status,200);assert.equal(r.headers['Content-Encoding'],'gzip');assert.deepEqual(JSON.parse(gunzipSync(r.body)),{ok:true});
});

test('the menu catalog includes only built visible assets and marks stale recordings',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'town-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const meta={assetSha256:'current',shots:{collapse:[{momentum:10}]}};
 for(const [name,extra]of [['ready',{}],['hidden',{previewHidden:true}],['missing',{}]]){
  await writeFile(path.join(root,`${name}.meta.json`),JSON.stringify({...meta,...extra}));if(name!=='missing')await writeFile(path.join(root,`${name}.json.gz`),gzipSync('{}'));
 }
 const dir=path.join(root,'reviews','ready-collapse');await mkdir(dir,{recursive:true});
 await writeFile(path.join(dir,'report.json'),JSON.stringify({passed:true,packSha256:'current'}));
 await writeFile(path.join(dir,'asset.meta.json'),JSON.stringify({...meta,shots:{collapse:[{momentum:999}]}}));
 await writeFile(path.join(dir,'recording.json.gz'),gzipSync('{}'));
 const c=await previewCatalog(root);assert.deepEqual(c.assets.map(a=>a.name),['ready']);assert.equal(c.assets[0].recordings[0].current,false);
 await writeFile(path.join(dir,'asset.meta.json'),JSON.stringify(meta));assert.equal((await previewCatalog(root)).assets[0].recordings[0].current,true);
});
