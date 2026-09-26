import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {GARDENS_MARKET_KEY as key} from '../src/bayline-gardens-market.mjs';
const out=path.join(KIT,'out'),dir=path.join(out,'reviews',`${key}-cannon`);
const pack=JSON.parse(await readFile(path.join(out,`${key}.json`),'utf8'));
const meta=JSON.parse(await readFile(path.join(out,`${key}.meta.json`),'utf8'));
const report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'));
const recording=JSON.parse(gunzipSync(await readFile(path.join(dir,'recording.json.gz'))));
if(!report.passed||recording.packHash!==meta.assetSha256)throw Error(report.error??'Stale or failed native recording');
// JSON number parsers differ at the final binary digit; compare at sub-micron precision.
const canonical=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='number'?Math.round(v*1e8)/1e8:v));
if(!isDeepStrictEqual(canonical(report.shots.map(s=>s.input)),canonical(meta.shots.cannon)))throw Error('Recording does not match the current cannon tour');
const base=report.shots[0].tick-meta.shots.cannon[0].tick;
const results=meta.cannonTour.chapters.map(c=>({type:c.type,title:c.title,broken:new Set(),moved:new Set(),maxMovement:0,chapter:c}));
const targetOf=new Map();results.forEach((r,index)=>{for(let n=r.chapter.nodeStart;n<r.chapter.nodeStart+r.chapter.nodeCount;n++)targetOf.set(n,index);});
for(const f of recording.frames){
 const tick=f.time*60-base;
 for(const id of f.broken??[]){const b=pack.scenario.bonds[id];for(const node of [b.node0,b.node1]){const index=targetOf.get(node);if(index===undefined)continue;const r=results[index];if(tick>=r.chapter.startTick&&tick<=r.chapter.endTick)r.broken.add(id);}}
 for(const [node,p]of f.poses??[]){const index=targetOf.get(node);if(index===undefined)continue;const r=results[index],n=pack.scenario.nodes[node];if(tick<r.chapter.startTick||tick>r.chapter.endTick||n.mass<=0)continue;const d=Math.hypot(p[0]-n.centroid.x,p[1]-n.centroid.y,p[2]-n.centroid.z);r.maxMovement=Math.max(r.maxMovement,d);if(d>.1)r.moved.add(node);}
}
const summary=results.map(({chapter,broken,moved,...r})=>({...r,brokenBonds:broken.size,movedChunks:moved.size,passed:broken.size>0&&moved.size>0}));
const audit={passed:summary.every(r=>r.passed),assetSha256:meta.assetSha256,nativePassed:report.passed,shots:report.shots.length,results:summary};
await copyFile(path.join(out,`${key}.meta.json`),path.join(dir,'asset.meta.json'));
await writeFile(path.join(dir,'tour-check.json'),JSON.stringify(audit,null,2));
console.log(JSON.stringify(audit,null,2));if(!audit.passed)process.exitCode=1;
