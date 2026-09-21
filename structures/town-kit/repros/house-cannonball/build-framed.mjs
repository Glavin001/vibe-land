import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {buildFramedPorchHouse,buildFramedBungalow} from '../../src/framed-houses.mjs';
import {validate} from '../../src/validate.mjs';
import {KIT} from '../../src/dependencies.mjs';
import path from 'node:path';
const root=path.join(KIT,'out/reviews/house-cannonball');
for(const [name,builder,options]of [['porch-house-framed-v5',buildFramedPorchHouse,{palette:'sage',mirrored:true,windowStyle:'paired'}],['bungalow-framed-v5',buildFramedBungalow,{palette:'cream',mirrored:true,porch:'entry',windowStyle:'wide'}]]){
 const {pack,metadata}=builder(options),validation=validate(pack),dir=path.join(root,name);mkdirSync(dir,{recursive:true});
 writeFileSync(path.join(dir,'asset.json'),JSON.stringify(pack));writeFileSync(path.join(dir,'asset.meta.json'),JSON.stringify({...metadata,validation}));writeFileSync(path.join(dir,'shot.json'),JSON.stringify({position:[-9,1.5,0],direction:[1,0,0]}));
 console.log(name,JSON.stringify(validation));if(!validation.passed)process.exitCode=1;
}
