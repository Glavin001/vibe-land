/** Feed the supplied bytes through the real CityClient at recorded arrival times. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {decodeCityTape} from '../../../../client/src/city/cityTape.ts';
import {decodeBinaryManifest} from '../../../../client/src/city/manifestBinary.ts';
let now=0;(globalThis.performance as {now:()=>number}).now=()=>now;
const {CityClient}=await import('../../../../client/src/city/cityClient.ts');
const {bodyKey}=await import('../../../../client/src/city/topology.ts');
const root=new URL('../../out/reviews/tape-stalls/',import.meta.url);
const tape=decodeCityTape(readFileSync('/root/.codex/attachments/15ca05df-ddcd-4c89-8239-2ce96113e2c1/city-2026-09-21T08-47-01-252Z.vltape'));
const buf=readFileSync(new URL('manifest.bin',root));const manifest=decodeBinaryManifest(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength));
const config={manifest,hashHex:tape.header.manifestHash,totalChunks:manifest.structures.reduce((n,s)=>n+s.chunks.length,0),totalBonds:manifest.structures.reduce((n,s)=>n+(s.bondCount??s.bonds?.length??0),0)};
const mode=process.argv[2]??'current';
if(existsSync(new URL(`client-${mode}.json`,root)))throw new Error('Preserve existing evidence: choose a new run label');
const client=new CityClient(config,()=>{}),ids=[2147484367,2149581715,2149581745,2149581519,2149581529];
const audit=Array.from({length:4},(_,structure)=>({structure,attempts:0,matched:0,unmatched:0}));
const apply=(client as any).applyRecord.bind(client);(client as any).applyRecord=(d:any,r:any)=>{const sid=Math.floor((r.bodyEntity-0x80000000)/0x100000),a=audit[sid];if(a){a.attempts++;if(client.topology.body(r.bodyEntity))a.matched++;else a.unmatched++;}return apply(d,r);};
const samples:any[]=[], patched=new WeakSet();let packet=0;
for(let frame=0;frame<=61*120;frame++){
 const frameTime=frame*1000/120;
 while(packet<tape.times.length&&tape.times[packet]<=frameTime){now=tape.times[packet];client.handlePacket(tape.packets[packet]);packet++;}
 if(mode==='gravity'||mode==='horizon')for(const state of (client as any).bodies.values())if(!patched.has(state.track)){state.track.config.gravity=[0,-9.81,0];if(mode==='horizon')state.track.config.maxExtrapolationTicks=32;patched.add(state.track);}
 now=frameTime;const changed=client.samplePresentation(now);
 if(now>=56000)for(const id of ids){const key=bodyKey(Math.floor((id-0x80000000)/0x100000),(id-0x80000000)%0x100000),state=(client as any).bodies.get(key),body=client.topology.body(key);if(!state||!body)continue;const ss=state.track.snapshots,last=ss[ss.length-1];samples.push({t:now,id,key,pos:[...body.position],rot:[...body.rotation],lastTick:last?.tick,lastPos:last?.position,lastVel:last?.linearVelocity,class:last?.class,kinetic:(client as any).kinetic.has(key),changed:changed.has(key),...client.presentationClock(),delay:state.track.config.interpolationDelayTicks});}
}
const summary=ids.map(id=>{const rows=samples.filter(r=>r.id===id),runs:any[]=[];let run:any=null;for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i],d=Math.hypot(...b.pos.map((v:number,k:number)=>v-a.pos[k]));if(d<1e-7){if(!run)run={start:a.t,end:b.t,pos:a.pos,lastTick:a.lastTick};run.end=b.t;}else if(run){if(run.end-run.start>=50)runs.push({...run,duration:run.end-run.start,nextMoveM:d});run=null;}}if(run&&run.end-run.start>=50)runs.push({...run,duration:run.end-run.start,continuesAtEnd:true});return {id,rows:rows.length,holds:runs};});
writeFileSync(new URL(`client-${mode}.json`,root),JSON.stringify(samples));writeFileSync(new URL(`client-${mode}-summary.json`,root),JSON.stringify(summary,null,2));writeFileSync(new URL(`client-${mode}-audit.json`,root),JSON.stringify(audit,null,2));console.log(JSON.stringify({summary,audit},null,2));
