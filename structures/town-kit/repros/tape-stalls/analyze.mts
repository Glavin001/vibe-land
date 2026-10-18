import {readFileSync,writeFileSync} from 'node:fs';
import {decodeCityTape} from '../../../../client/src/city/cityTape.ts';
import {decodeChunksDatagram,decodeBaseline,decodeTopology} from '../../../../client/src/city/wire.ts';
const root=new URL('../../out/reviews/tape-stalls/',import.meta.url),tape=decodeCityTape(readFileSync('/root/.codex/attachments/15ca05df-ddcd-4c89-8239-2ce96113e2c1/city-2026-09-21T08-47-01-252Z.vltape'));
const seconds=Array.from({length:71},(_,second)=>({second,packets:0,records:0,moved:0,bodies:new Set<number>(),modes:{} as any,flags:{} as any,topology:0,breaks:0})),bodies=new Map<number,any>(),bases=new Map<number,Map<number,any>>(),stats:any[]=[],meteor:any[]=[],rawFrames:any[]=[];
for(let i=0;i<tape.packets.length;i++){
 const t=tape.times[i],p=tape.packets[i],s=seconds[Math.floor(t/1000)];s.packets++;
 if(p[0]===121){const b=decodeBaseline(p);let m=bases.get(b.baselineId);if(!m){m=new Map();bases.set(b.baselineId,m);}for(const r of b.records)m.set(r.bodyEntity,r);}
 if(p[0]===124){try{let off=1;while(off<16&&p[off]!==123)off++;stats.push({t,...JSON.parse(new TextDecoder().decode(p.subarray(off)))});}catch{}}
 if(p[0]===130)meteor.push({t});
 if(p[0]===120){const q=decodeTopology(p);s.topology++;s.breaks+=q.batches.reduce((a,b)=>a+b.brokenBondIndices.length,0);}
 if(p[0]!==119)continue;
 const d=decodeChunksDatagram(p);let moved=0;
 for(const r of d.records){s.records++;s.bodies.add(r.bodyEntity);s.modes[r.mode]=(s.modes[r.mode]??0)+1;s.flags[r.flags]=(s.flags[r.flags]??0)+1;
  let pos=r.position;if(r.mode===1||r.mode===3){const b=bases.get(d.baselineId)?.get(r.bodyEntity);if(!b)continue;pos=pos.map((v,k)=>v+b.position[k]) as any;}
  let body=bodies.get(r.bodyEntity);if(!body){body={id:r.bodyEntity,updates:[],moves:[],last:pos,rotation:r.rotation};bodies.set(r.bodyEntity,body);}
  const distance=Math.hypot(...pos.map((v,k)=>v-body.last[k]));const angle=1-Math.abs(r.rotation.reduce((a,v,k)=>a+v*body.rotation[k],0));
  body.updates.push({t,tick:d.simTick,mode:r.mode,flags:r.flags,pos,velocity:r.linearVelocity});
  if(distance>.001||angle>1e-5){s.moved++;moved++;body.moves.push(t);}body.last=pos;body.rotation=r.rotation;
 }
 rawFrames.push({t,tick:d.simTick,records:d.records.length,moved});
}
const percentile=(a:number[],f:number)=>a.sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*f))]??0;
const bodyRows=[...bodies.values()].map(b=>{const u=b.updates.filter((u:any)=>u.t>=56000&&u.t<61000),g=u.slice(1).map((v:any,i:number)=>v.t-u[i].t);return {id:b.id,updates:u.length,moves:b.moves.filter((t:number)=>t>=56000&&t<61000).length,maxGap:Math.max(0,...g),gapP50:percentile(g,.5),example:u.slice(0,3)};}).sort((a,b)=>b.maxGap-a.maxGap);
const summary={header:tape.header,frames:{p50:percentile([...tape.frames!.frameMs],.5),p95:percentile([...tape.frames!.frameMs],.95)},seconds:seconds.map(s=>({...s,bodies:s.bodies.size})),meteor,lateBodies:bodyRows,stats};
writeFileSync(new URL('packet-analysis.json',root),JSON.stringify(summary,null,2));writeFileSync(new URL('decoded-bodies.json',root),JSON.stringify([...bodies.values()]));writeFileSync(new URL('packet-frames.json',root),JSON.stringify(rawFrames));
console.log(JSON.stringify({frames:summary.frames,seconds:summary.seconds.filter(s=>s.second>=54&&s.second<=62),bodyExamples:bodyRows.slice(0,5),statsKeys:Object.keys(stats[0]??{}),meteor},null,2));
