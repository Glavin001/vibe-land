import {readArtifact} from './artifacts.mjs';
import {readFile,mkdir,copyFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {PROP_TYPES} from '../src/props.mjs';
import {sha} from './provenance.mjs';
const json=async p=>JSON.parse(await readFile(path.join(KIT,p),'utf8'));
const matrix=await json('out/reviews/matrix.json');
if(!matrix.passed||matrix.geometryOnly)throw Error('A passing complete native matrix is required');
const rest=await json('out/reviews/rest-audit.json');if(!rest.passed)throw Error('The measured upright/rest audit must pass');
const assets=[...new Set(['victorian-corner',...PROP_TYPES,...matrix.results.map(r=>r.asset)])],manifest={createdAt:new Date().toISOString(),assets:[]};
for(const asset of assets){
 const bytes=await readFile(path.join(KIT,'out',`${asset}.json`)),hash=sha(bytes),meta=await json(`out/${asset}.meta.json`);
 if(hash!==meta.assetSha256||!meta.validation.passed)throw Error(`${asset}: invalid current geometry/hash`);
 const poseAudit=rest.results.find(r=>r.asset===asset);if(!poseAudit?.passed||poseAudit.assetSha256!==hash||poseAudit.recordingSha256!==sha(await readArtifact(path.join(KIT,`out/reviews/${asset}-stability/recording.json`))))throw Error(`${asset}: stale or failed upright/rest audit`);
 const modes=[...new Set([...(asset==='victorian-corner'?['stability','traverse','glazing','wall','furniture','fence','collapse']:['stability']),...matrix.results.filter(r=>r.asset===asset&&r.mode!=='geometry').map(r=>r.mode)])];
 const metadataHash=sha(await readFile(path.join(KIT,'out',`${asset}.meta.json`)));
 for(const mode of modes){const r=await json(`out/reviews/${asset}-${mode}/report.json`);if(!r.passed||r.packSha256!==hash||r.metadataSha256!==metadataHash)throw Error(`${asset}: ${mode} failed, absent, or stale`);}
 if(asset==='victorian-corner'){
  for(const mode of ['visual','wall','glazing','furniture','fence','collapse']){
   const r=await json(`out/reviews/${asset}-${mode}/visual-report.json`);if(r.hash!==hash||r.metadataSha256!==metadataHash||r.errors.length||!r.captures.length)throw Error(`Stale or failed ${mode} visual capture`);
   if(mode!=='visual'&&(r.recordingSha256!==sha(await readArtifact(path.join(KIT,`out/reviews/${asset}-${mode}/recording.json`)))||!r.nativeStatus?.startsWith('PASS')))throw Error(`Stale or failed ${mode} native images`);
  }
  const intact=await json(`out/reviews/${asset}-visual/visual-report.json`);if(Object.keys(meta.cameras).some(c=>!intact.captures.includes(c)))throw Error('The intact visual capture is incomplete');
  const review=await json('out/reviews/visual-acceptance.json');if(!review.accepted||review.assetSha256!==hash)throw Error('Actual visual inspection has not approved this revision');
  for(const mode of ['traverse','collapse']){
   const v=await json(`out/reviews/${asset}-${mode}/video-report.json`);
   if(!v.passed||v.packHash!==hash||v.errors.length||v.recordingSha256!==sha(await readArtifact(path.join(KIT,`out/reviews/${asset}-${mode}/recording.json`)))||v.videoSha256!==sha(await readFile(path.join(KIT,`out/reviews/${asset}-${mode}/${mode}.webm`))))throw Error(`Stale or failed ${mode} video`);
  }
 }
 manifest.assets.push({asset,sha256:hash,modes});
}
await mkdir(path.join(KIT,'staged'),{recursive:true});
for(const {asset}of manifest.assets)for(const ext of ['json','meta.json'])await copyFile(path.join(KIT,'out',`${asset}.${ext}`),path.join(KIT,'staged',`${asset}.${ext}`));
await writeFile(path.join(KIT,'staged/acceptance.json'),JSON.stringify(manifest,null,2));console.log('Staged assets passed all required current-hash gates.');
