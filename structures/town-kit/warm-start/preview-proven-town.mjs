import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {KIT} from '../src/dependencies.mjs';
import {decodeSceneBundle} from '../src/scene-binary.mjs';
import {validate} from '../src/validate.mjs';
import {hash} from './bundle.mjs';
const base=`${KIT}/out/bayline-proven-36`,{pack,metadata:m}=decodeSceneBundle(readFileSync(base+'.vlsp'));
const raw=Buffer.from(JSON.stringify(pack));m.assetSha256=hash(raw);m.validation=validate(pack);
m.cameras={hero:{position:[214,205,228],target:[0,0,28]},aerial:{position:[-185,230,215],target:[0,0,28]},'garden-street':{position:[-136,6,92],target:[-104,2.5,74]},'high-street':{position:[-88,5,6],target:[-55,2.6,-13]}};
writeFileSync(base+'.json.gz',gzipSync(raw));writeFileSync(base+'.meta.json',JSON.stringify(m,null,2));
const root=JSON.parse(readFileSync(`${KIT}/out/reviews/proven-36-latest.json`)).root;
for(const [mode,folder] of [['stability','verify'],['furniture','damage']]){
 let report,recording;try{report=JSON.parse(readFileSync(`${root}/${folder}/report.json`));recording=JSON.parse(gunzipSync(readFileSync(`${root}/${folder}/recording.json.gz`)));}catch{continue;}
 if(!report.passed)continue;
 recording.packHash=m.assetSha256;const dir=`${KIT}/out/reviews/bayline-proven-36-${mode}`;mkdirSync(dir,{recursive:true});
 writeFileSync(`${dir}/recording.json.gz`,gzipSync(Buffer.from(JSON.stringify(recording))));writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));
}
console.log({preview:'http://127.0.0.1:6174/?asset=bayline-proven-36',geometry:m.validation});
