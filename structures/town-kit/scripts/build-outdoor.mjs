import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {OUTDOOR_PROP_TYPES,buildOutdoorProp} from '../src/outdoor-props.mjs';
import {TREE_FAMILIES,buildTree} from '../src/tree.mjs';
import {buildOutdoorGallery,buildOutdoorEncounter,buildTreeReuseFixture,buildDressedBayline,ENCOUNTERS} from '../src/outdoor-scenes.mjs';
import {composeVisuals,assetHash} from '../src/outdoor-visuals.mjs';
import {validate} from '../src/validate.mjs';
import {sourceProvenance} from './provenance.mjs';
const args=new Set(process.argv.slice(2)),out=path.join(KIT,'out'),sha=b=>createHash('sha256').update(b).digest('hex');
await mkdir(out,{recursive:true});const provenance=await sourceProvenance(),catalog=[];
async function save(name,asset){
 const {pack,metadata}=asset,report=validate(pack);
 if(!report.passed)throw Error(`${name}: ${report.errors.join('\n')}`);
 metadata.validation=report;metadata.assetSha256=assetHash(pack);metadata.provenance=provenance;
 metadata.acceptance={readyForRelease:false,native:'not-run',note:'Geometry passes; native stability/destruction and frame-time qualification are separate.'};
 if(asset.visuals){
  const visuals=asset.visuals.physicsSha256?asset.visuals:composeVisuals([asset],pack),bytes=JSON.stringify(visuals),file=`${name}.visuals.json`;
  await writeFile(path.join(out,file+'.gz'),gzipSync(bytes,{level:6}));metadata.visuals={version:1,file,sha256:sha(bytes)};
 }
 await writeFile(path.join(out,`${name}.json.gz`),gzipSync(JSON.stringify(pack),{level:6}));
 await writeFile(path.join(out,`${name}.meta.json`),JSON.stringify(metadata,null,2));
 const entry={name,chunks:report.chunks,bonds:report.bonds,components:report.components,visualAttachments:asset.visuals?.attachments.length??0,geometryPassed:true};catalog.push(entry);console.log(JSON.stringify(entry));
}
if(!args.has('--town-only')){
 if(!args.has('--scenes-only')){
 for(const family of TREE_FAMILIES)for(let variant=0;variant<3;variant++)await save(`tree-${family}-${variant}`,buildTree({family,variant}));
 for(const type of OUTDOOR_PROP_TYPES)await save(`outdoor-${type}`,buildOutdoorProp(type));
 }
 await save('outdoor-gallery',buildOutdoorGallery());
 for(const kind of ENCOUNTERS)await save(`outdoor-${kind}`,buildOutdoorEncounter(kind));
 await save('outdoor-tree-reuse',buildTreeReuseFixture());
}
if(args.has('--town')||args.has('--town-only')){const town=buildDressedBayline();await save('bayline-outdoor-baseline',town.baseline);await save('bayline-outdoor-town',town);}
let previous=[];try{previous=JSON.parse(await readFile(path.join(out,'outdoor-catalog.json'),'utf8')).assets;}catch{}
await writeFile(path.join(out,'outdoor-catalog.json'),JSON.stringify({assets:[...previous.filter(a=>!catalog.some(b=>a.name===b.name)),...catalog],nativeAcceptance:'see outdoor-native-matrix.json',source:provenance.contentHash},null,2));
