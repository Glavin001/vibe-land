import {chromium} from '../../../client/node_modules/playwright-core/index.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {KIT} from '../src/dependencies.mjs';
import {readArtifact} from './artifacts.mjs';
const asset=process.argv[2]??'tree-shade-0',modes=process.argv.slice(3);
if(!modes.length)modes.push('furniture','collapse');
const browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-angle=metal']:['--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
try{
 for(const mode of modes){
  const root=`${KIT}/out/reviews/${asset}-${mode}`,report=JSON.parse(await readFile(`${root}/report.json`)),recording=JSON.parse(await readArtifact(`${root}/recording.json`));
  if(!report.passed||!recording.passed)throw Error(`Cannot label failed ${asset}/${mode} as a verified motion review`);
  const out=`${root}/motion`;await mkdir(out,{recursive:true});
  const page=await browser.newPage({viewport:{width:960,height:720}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:6174/?asset=${asset}&clean`);
  await page.waitForFunction(()=>window.__TOWN_KIT__?.error||(window.__TOWN_KIT__?.ready&&window.__VIBE_CITY_TEX_READY__),null,{timeout:60000});
  const error=await page.evaluate(()=>window.__TOWN_KIT__.error);if(error)throw Error(error);
  await page.evaluate(async mode=>{await window.__TOWN_KIT__.loadRecording(mode);window.__TOWN_KIT__.setCamera({position:[12,8,-17],target:[0,3,2]});},mode);
  const start=report.shots[0].tick/60,names=[];
  for(const offset of [-.2,.1,.3,.6,1.2,2,4,8]){
   const time=start+offset,name=`${offset<0?'before':`after-${offset.toFixed(1)}s`}`;names.push(name);
   await page.evaluate(t=>window.__TOWN_KIT__.seek(t),time);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.screenshot({path:`${out}/${name}.png`});
  }
  if(errors.length)throw Error(errors.join('\n'));
  const html=`<!doctype html><title>${asset} / ${mode} motion review</title><style>body{background:#1b2822;color:#fff;font:16px system-ui}main{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}img{width:100%}</style><h1>${asset} / ${mode}</h1><p>Actual native stress-solver poses. ${JSON.stringify(report.destruction.treeFractures)}. No root breaks.</p><main>${names.map(n=>`<section><img src="${n}.png"><p>${n}</p></section>`).join('')}</main>`;
  await writeFile(`${out}/index.html`,html);
  const result=spawnSync(process.env.TOWN_KIT_PYTHON??'python3',[`${KIT}/scripts/contact-sheet.py`,out,JSON.stringify(names),`${asset} / ${mode} / recorded stress fracture`],{stdio:'inherit'});if(result.status!==0)throw Error('Contact sheet failed');
  await writeFile(`${out}/report.json`,JSON.stringify({asset,mode,packHash:recording.packHash,frames:names,errors},null,2));
  await page.close();console.log(out);
 }
}finally{await browser.close();}
