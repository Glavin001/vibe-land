import {mkdirSync,writeFileSync} from 'node:fs';
import {buildFramedPorchHouse,buildFramedBungalow} from '../../src/framed-houses.mjs';
import {validate} from '../../src/validate.mjs';
const root=new URL('../../out/reviews/house-cannonball/',import.meta.url);
const label=process.argv[2]??'matched-v1';
const impactProfile=process.argv[3]??'residential-v1';
for(const [kind,builder,options]of [['porch',buildFramedPorchHouse,{palette:'sage',mirrored:true,windowStyle:'paired'}],['bungalow',buildFramedBungalow,{palette:'blue',mirrored:false,porch:'full',windowStyle:'paired'}]]){
 const {pack,metadata}=builder({...options,impactProfile}),validation=validate(pack);
 console.log(kind,JSON.stringify(validation));
 if(!validation.passed)throw Error('Geometry validation failed');
 for(const weapon of ['meteor','cannonball']){
  const dir=new URL(`roof-response-${label}-${kind}-${weapon}/`,root);mkdirSync(dir);
  writeFileSync(new URL('asset.json',dir),JSON.stringify(pack));writeFileSync(new URL('asset.meta.json',dir),JSON.stringify({...metadata,validation}));
  writeFileSync(new URL('shot.json',dir),JSON.stringify({kind:weapon,position:weapon==='meteor'?[0,2,0]:[-9,1.5,0],direction:[1,0,0],seed:20260921,sampleTicks:12,durationTicks:900}));
 }
}
