import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {sha} from './provenance.mjs';
import {readArtifact} from './artifacts.mjs';
const bases=['porch-house','corner-grocery','workshop'];
const read=async p=>JSON.parse(await readFile(path.join(KIT,p),'utf8'));
const rest=await read('out/reviews/town-rest-audit.json');if(!rest.passed)throw Error('New town assets require a passing upright/rest audit');
const manifest={createdAt:new Date().toISOString(),assets:[]};
async function checkNative(asset,mode){
 const bytes=await readFile(path.join(KIT,`out/${asset}.json`)),mb=await readFile(path.join(KIT,`out/${asset}.meta.json`)),meta=JSON.parse(mb),hash=sha(bytes);
 const r=await read(`out/reviews/${asset}-${mode}/report.json`);
 if(!meta.validation?.passed||meta.assetSha256!==hash||!r.passed||r.packSha256!==hash||r.metadataSha256!==sha(mb))throw Error(`${asset}: ${mode} is missing, failed or stale`);
 if(mode==='wall'&&!r.wallOpening?.passed)throw Error(`${asset}: no verified wall opening`);
 if(mode==='stability'){const audit=rest.results.find(x=>x.asset===asset);if(!audit?.passed||audit.assetSha256!==hash||audit.recordingSha256!==sha(await readArtifact(path.join(KIT,`out/reviews/${asset}-stability/recording.json`))))throw Error(`${asset}: stale pose audit`);}
 return {hash,meta,metadataHash:sha(mb)};
}
for(const base of bases){
 for(const mode of ['stability','traverse','glazing','wall','furniture','collapse',...(base==='porch-house'?['fence']:[])])await checkNative(base,mode);
 for(const mode of ['stability','traverse'])await checkNative(`${base}-mirror`,mode);
 for(const mode of ['stability','wall'])await checkNative(`${base}-reuse`,mode);
 for(const asset of [base,`${base}-mirror`]){
  const {hash,meta,metadataHash}=await checkNative(asset,'stability'),v=await read(`out/reviews/${asset}-visual/visual-report.json`);
  if(v.hash!==hash||v.metadataSha256!==metadataHash||v.errors.length||Object.keys(meta.cameras).some(k=>!v.captures.includes(k)))throw Error(`${asset}: incomplete or stale visual capture`);
  manifest.assets.push({asset,sha256:hash,metadataSha256:metadataHash});
 }
 const approval=await read(`out/reviews/${base}-acceptance.json`),{hash}=await checkNative(base,'stability');
 if(!approval.accepted||approval.assetSha256!==hash)throw Error(`${base}: current actual-image review has not approved the asset`);
 for(const mode of ['wall','glazing','furniture','collapse']){
  const v=await read(`out/reviews/${base}-${mode}/visual-report.json`);if(v.hash!==hash||v.errors.length||!v.captures.length||!v.nativeStatus?.startsWith('PASS')||v.recordingSha256!==sha(await readArtifact(path.join(KIT,`out/reviews/${base}-${mode}/recording.json`))))throw Error(`${base}: ${mode} images missing, failed or stale`);
 }
 for(const mode of ['traverse','collapse']){
  const v=await read(`out/reviews/${base}-${mode}/video-report.json`);if(!v.passed||v.packHash!==hash||v.errors.length||v.recordingSha256!==sha(await readArtifact(path.join(KIT,`out/reviews/${base}-${mode}/recording.json`)))||v.videoSha256!==sha(await readFile(path.join(KIT,`out/reviews/${base}-${mode}/${mode}.webm`))))throw Error(`${base}: ${mode} video missing, failed or stale`);
 }
}
const dest=path.join(KIT,'staged/town');await mkdir(dest,{recursive:true});
for(const {asset} of manifest.assets)for(const ext of ['json','meta.json'])await copyFile(path.join(KIT,`out/${asset}.${ext}`),path.join(dest,`${asset}.${ext}`));
await writeFile(path.join(dest,'acceptance.json'),JSON.stringify(manifest,null,2));console.log('Staged six fully reviewed building variants.');
