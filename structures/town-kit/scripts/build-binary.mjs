import {readFileSync,writeFileSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {KIT,REPO,AUTHORING} from '../src/dependencies.mjs';
import {buildBaylineCivicTown,CIVIC_TOWN_KEY} from '../src/bayline-civic-town.mjs';
import {encodeSceneBundle,decodeSceneBundle,inspectSceneBundle} from '../src/scene-binary.mjs';
import {validate} from '../src/validate.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
process.chdir(KIT);
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
for(let i=0;i<args.length;i++){if(['--seed','--out'].includes(args[i])){if(!args[++i]||args[i].startsWith('--'))throw Error('Missing option value');}else if(!['--json','--force','--no-furniture'].includes(args[i]))throw Error(`Unknown option ${args[i]}`);}
const seed=Number(option('--seed')??20260920);if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw Error('Seed must be a u32');
const options={seed,furnished:!args.includes('--no-furniture')},started=performance.now(),source=await sourceProvenance();
const buildKey=sha(JSON.stringify({recipe:CIVIC_TOWN_KEY,options,source:source.contentHash,vibeRevision:source.vibeRevision,authoringRevision:source.authoringRevision,format:1}));
const output=path.resolve(option('--out')??`out/${CIVIC_TOWN_KEY}.vlsp`),cache=path.join(KIT,'out/binary-cache');
const atomic=(file,data)=>{mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}`;try{writeFileSync(tmp,data,{flag:'wx'});renameSync(tmp,file);}finally{try{unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}};
const debug=bytes=>{const {pack,metadata}=decodeSceneBundle(bytes);atomic(output.replace(/\.vlsp$/,'')+'.json',JSON.stringify(pack));atomic(output.replace(/\.vlsp$/,'')+'.meta.json',JSON.stringify(metadata,null,2));};
let existing;try{existing=readFileSync(output);}catch(e){if(e.code!=='ENOENT')throw e;}
if(existing&&!args.includes('--force')){
 try{const {header,expandedNodes,expandedBonds}=inspectSceneBundle(existing);if(header.provenance.buildKey===buildKey){if(args.includes('--json'))debug(existing);console.log(JSON.stringify({output,unchanged:true,bytes:existing.length,chunks:expandedNodes,bonds:expandedBonds,milliseconds:performance.now()-started}));process.exit(0);}}catch(e){console.error(`Rebuilding invalid/stale bundle: ${e.message}`);}
}
const roots={house:'porch-house',bungalow:'bungalow',cafe:'victorian',grocery:'corner-grocery',workshop:'workshop',shop:'strip-shop',library:'neighborhood-library',cinema:'art-deco-cinema','fire-station':'fire-station','small-town-ground':'bayline-small-town'};
const closureCache=new Map(),external=Object.fromEntries(Object.entries(source.files).filter(([p])=>p.startsWith('../')));
function closure(file,seen=new Set()){
 if(seen.has(file))return {};seen.add(file);const text=readFileSync(file,'utf8'),files={[path.relative(REPO,file)]:sha(text)};
 for(const match of text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g))if(match[1].startsWith('.'))Object.assign(files,closure(path.resolve(path.dirname(file),match[1]),seen));
 return files;
}
let hits=0,misses=0;
function resolveAsset(name,opts,build){
 if(!roots[name])throw Error(`Missing cache dependencies for ${name}`);
 if(!closureCache.has(name))closureCache.set(name,{...closure(path.join(KIT,'src',roots[name]+'.mjs')),...closure(path.join(KIT,'src/validate.mjs')),...closure(path.join(KIT,'src/scene-binary.mjs')),...external});
 const key=sha(JSON.stringify({cacheSchema:2,name,opts,files:closureCache.get(name)})),file=path.join(cache,key+'.vlsp');
 try{const bytes=readFileSync(file),a=decodeSceneBundle(bytes);if(a.provenance.cacheKey!==key||!a.provenance.sourcePackSha256||!a.metadata.validation?.passed)throw Error('Cache identity mismatch');hits++;return {...a,hash:a.provenance.sourcePackSha256};}catch(e){if(e.code!=='ENOENT')console.error(`Rebuilding template ${name}: ${e.message}`);}
 const asset=build(),validation=validate(asset.pack);if(!validation.passed)throw Error(`${name}: ${validation.errors.join('; ')}`);
 asset.hash=sha(JSON.stringify(asset.pack));asset.metadata={...asset.metadata,validation};atomic(file,encodeSceneBundle([{pack:asset.pack}],{key:asset.pack.key,title:asset.pack.title,metadata:asset.metadata,provenance:{cacheKey:key,sourcePackSha256:asset.hash}}));misses++;return asset;
}
const asset=buildBaylineCivicTown({...options,assemble:false,resolveAsset});
const bytes=encodeSceneBundle(asset.placements,{key:CIVIC_TOWN_KEY,title:'Bayline · Civic town',metadata:asset.metadata,provenance:{recipe:CIVIC_TOWN_KEY,options,buildKey,generatorFingerprint:source.contentHash,vibeRevision:source.vibeRevision,authoringRevision:source.authoringRevision}});
atomic(output,bytes);if(args.includes('--json'))debug(bytes);
const {header,expandedNodes,expandedBonds}=inspectSceneBundle(bytes);
console.log(JSON.stringify({output,unchanged:false,bytes:bytes.length,uniqueTemplates:header.templates.length,instances:header.instances.length,storedChunks:header.sections.nodes.bytes/112,storedBonds:header.sections.bonds.bytes/72,chunks:expandedNodes,bonds:expandedBonds,cacheHits:hits,cacheMisses:misses,milliseconds:performance.now()-started},null,2));
