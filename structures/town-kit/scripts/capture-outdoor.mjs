import {spawn} from 'node:child_process';
import {KIT} from '../src/dependencies.mjs';
const cases=[['outdoor-gallery','', 'hero,shade-0,street-0,conifer-0,ornamental-0,sapling-0'],
 ['outdoor-residential-run','','hero,street'],['outdoor-market-encounter','','hero,street'],['outdoor-service-yard','','hero,street'],
 ['tree-shade-0','furniture','hero,front'],['tree-shade-0','collapse','hero,front'],['bayline-outdoor-town','','garden-dressing,street-dressing']];
for(const [asset,mode,cameras]of cases){
 const code=await new Promise(resolve=>{const child=spawn(process.execPath,['scripts/screenshots.mjs',asset,...(mode?[mode]:[])],{cwd:KIT,env:{...process.env,TOWN_KIT_CAMERAS:cameras},stdio:'inherit'});child.on('error',()=>resolve(-1));child.on('exit',resolve);});
 if(code!==0)throw Error(`Capture failed for ${asset}/${mode}`);
}
