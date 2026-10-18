import {KIT} from '../src/dependencies.mjs';
process.chdir(KIT);
import {writeFile} from 'node:fs/promises';
import {buildPorchHouse,buildCornerGrocery,buildWorkshop,composeScene,validate} from '../src/index.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
const builders={'porch-house':buildPorchHouse,'corner-grocery':buildCornerGrocery,workshop:buildWorkshop};
if(process.argv[2]&&!builders[process.argv[2]])throw Error(`Unknown town building: ${process.argv[2]}`);
async function save(name,{pack,metadata}){metadata.validation=validate(pack);if(!metadata.validation.passed)throw Error(`${name}: ${metadata.validation.errors.join('; ')}`);const bytes=JSON.stringify(pack);metadata.assetSha256=sha(bytes);metadata.provenance=await sourceProvenance();await writeFile(`out/${name}.json`,bytes);await writeFile(`out/${name}.meta.json`,JSON.stringify(metadata,null,2));console.log(name,pack.scenario.nodes.length);}
for(const [name,build] of Object.entries(builders)){
 if(process.argv[2]&&process.argv[2]!==name)continue;
 await save(`${name}-mirror`,build({mirrored:true}));
 const base=build({furnished:false,fence:false}),pack=composeScene([{pack:base.pack,position:[-20,0,0],yaw:90,group:'building-a'},{pack:base.pack,position:[20,0,0],yaw:270,group:'building-b'}],{key:`${name}-reuse`,title:`Independent rotated ${name} pair`});
 const transform=([x,y,z])=>[z-20,y,-x];
 await save(`${name}-reuse`,{pack,metadata:{kind:'scene',options:{furnished:false},protectedGroups:['building-b'],rooms:[],entrances:[],route:[],cameras:{hero:{position:[-28,24,-38],target:[0,3,0]}},shots:{wall:base.metadata.shots.wall.map(s=>({...s,from:transform(s.from),to:transform(s.to)}))},shotGroups:{wall:'building-a'}}});
}
