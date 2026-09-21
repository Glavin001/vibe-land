import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {buildProp,PROP_TYPES,composeScene,validate} from '../src/index.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
const placements=PROP_TYPES.map((type,i)=>({pack:buildProp(type).pack,position:[(i%7-3)*3.5,0,Math.floor(i/7)*4-2],group:type}));
const pack=composeScene(placements,{key:'town-props-gallery'}),data=JSON.stringify(pack);
const cameras={hero:{position:[17,13,-18],target:[0,.5,0]}};
for(const [i,type]of PROP_TYPES.entries()){const p=placements[i].position;cameras[type]={position:[p[0]+2.4,1.9,p[2]-2.5],target:[p[0],.6,p[2]]};}
await mkdir(path.join(KIT,'out'),{recursive:true});
await writeFile(path.join(KIT,'out/props-gallery.json'),data);
await writeFile(path.join(KIT,'out/props-gallery.meta.json'),JSON.stringify({kind:'review-gallery',assetSha256:sha(data),validation:validate(pack),provenance:await sourceProvenance(),cameras},null,2));
