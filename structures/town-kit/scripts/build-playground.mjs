import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {buildOutdoorGallery} from '../src/outdoor-scenes.mjs';
import {buildPorchHouse} from '../src/porch-house.mjs';
import {composeScene} from '../src/geometry.mjs';
import {composeVisuals} from '../src/outdoor-visuals.mjs';
import {validate} from '../src/validate.mjs';
import {TREE_FAMILIES} from '../src/tree.mjs';

const gallery=buildOutdoorGallery(),house=buildPorchHouse();
// These tree variants pass the native stability review. Other variants remain
// in the authoring viewer until their stress-topology failures are resolved.
const stableTrees=new Set(['tree-shade-0','tree-street-0','tree-ornamental-1']);
const exhibits=gallery.placements.map((p,i)=>({placement:p,catalog:gallery.metadata.catalog[i]})).filter(({catalog:c})=>!TREE_FAMILIES.includes(c.type)||stableTrees.has(`tree-${c.type}-${c.variant}`));
const placements=[...exhibits.map(({placement:p},i)=>({...p,position:[(i%5-2)*13,0,Math.floor(i/5)*13-32]})),{...house,position:[0,0,40],group:'porch-house@playground'}];
const pack=composeScene(placements,{key:'town-kit-playground',title:'Bayline · Town kit playground'});
const validation=validate(pack);if(!validation.passed)throw Error(validation.errors.join('\n'));
const bytes=JSON.stringify(pack),hash=createHash('sha256').update(bytes).digest('hex');
const visuals=composeVisuals(placements,pack);
const labels=placements.map((p,i)=>({title:i<exhibits.length?`${exhibits[i].catalog.type.replaceAll('-',' ')} ${(exhibits[i].catalog.variant??0)+1}`:'Juniper porch house',position:[p.position[0],.45,p.position[2]-2.8]}));
const out=path.join(KIT,'out/playground');await mkdir(out,{recursive:true});
await writeFile(path.join(out,'town-kit-playground.json'),bytes);
await writeFile(path.join(out,'town-kit-playground.visuals.json'),JSON.stringify({...visuals,labels,title:pack.title,nodeCount:pack.scenario.nodes.length}));
await writeFile(path.join(out,'build.json'),JSON.stringify({physicsSha256:hash,chunks:pack.scenario.nodes.length,bonds:pack.scenario.bonds.length,assets:labels.length,validation},null,2));
console.log(JSON.stringify({out,assets:labels.length,chunks:pack.scenario.nodes.length,bonds:pack.scenario.bonds.length,physicsSha256:hash}));
