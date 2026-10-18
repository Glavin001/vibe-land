/** Replay a native Vehicle2 trace against browser WASM collision queries.
 * Generate with VIBE_VEHICLE_NET_TRACE=/tmp/vehicle-net-trace.json cargo test
 * -p web-fps-server --features native-destruction export_vehicle_netcode_trace -- --ignored
 * Run from client: node --import tsx scripts/verify-vehicle-netcode.mts /tmp/vehicle-net-trace.json
 */
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import init,{WasmSimWorld} from '../src/wasm/pkg/vibe_land_shared.js';
import {VehicleInterpolator,type VehicleSample} from '../src/net/interpolation';
import {VehiclePresentationPredictor,extrapolateVehicle,vehicleProxy,type Sweep} from '../src/physics/vehiclePresentation';
import type {InputCmd} from '../src/net/protocol';
await init({module_or_path:readFileSync(new URL('../src/wasm/pkg/vibe_land_shared_bg.wasm',import.meta.url))});
const trace=JSON.parse(readFileSync(process.argv[2], 'utf8')) as {world:unknown;frames:{input:InputCmd;sample:VehicleSample}[]};
const sim=new WasmSimWorld();sim.loadWorldDocument(JSON.stringify(trace.world));sim.rebuildBroadPhase();
const sweep:Sweep=(p,q,d,h,r=0)=>{
  const hit=sim.sweepVehicleStatic(p[0],p[1],p[2],q[0],q[1],q[2],q[3],d[0],d[1],d[2],h[0],h[1],h[2],r);
  return hit.length?{fraction:hit[0],normal:[hit[1],hit[2],hit[3]]}:null;
};
const proxy=vehicleProxy({...trace.frames[0].sample,id:7,driverId:10,vehicleType:0});
const p95=(values:number[])=>values.sort((a,b)=>a-b)[Math.floor(values.length*.95)];
const dist=(a:readonly number[],b:readonly number[])=>Math.hypot(...a.map((v,i)=>v-b[i]));
const results=[];
for(const rtt of [80,180,300]) {
  const old=new VehicleInterpolator(),fixed=new VehicleInterpolator(),driver=new VehiclePresentationPredictor(sweep);
  fixed.extrapolate=(_,s,t)=>extrapolateVehicle(s,t,proxy,sweep);
  const packets=trace.frames.filter((_,i)=>i%2===0 && i%17!==3).map((f,i)=>({f,arrival:f.sample.serverTimeUs/1000+rtt+(i%3-1)*20})).sort((a,b)=>a.arrival-b.arrival);
  const rawErrors:number[]=[],fixedErrors:number[]=[],driverErrors:number[]=[],cost:number[]=[],rawVertical:number[]=[],fixedVertical:number[]=[];
  const worst:any[]=[];
  for(const frame of trace.frames) {
    const now=frame.sample.serverTimeUs/1000;const start=performance.now();driver.record(7,[frame.input]);
    while(packets[0]?.arrival<=now) {
      const {f}=packets.shift()!;old.push(7,f.sample);fixed.push(7,f.sample);
      driver.observe(7,f.sample,f.input.seq,proxy,now);
    }
    driver.update(1/60,now);const predicted=driver.pose();cost.push(performance.now()-start);
    const before=old.sample(7,now*1000),after=fixed.sample(7,now*1000);
    if(before&&after&&predicted) {
      rawErrors.push(dist(before.position,frame.sample.position));fixedErrors.push(dist(after.position,frame.sample.position));driverErrors.push(dist(predicted.position,frame.sample.position));
      rawVertical.push(Math.max(0,frame.sample.position[1]-before.position[1]));fixedVertical.push(Math.max(0,frame.sample.position[1]-after.position[1]));
      worst.push({error:dist(predicted.position,frame.sample.position),predicted:predicted.position,before:before.position,after:after.position,truth:frame.sample.position,velocity:frame.sample.linearVelocity,t:now});
      assert(predicted.position.every(Number.isFinite));
    }
  }
  const result={rttMs:rtt,oldPositionP95:p95(rawErrors),contactPositionP95:p95(fixedErrors),driverPositionP95:p95(driverErrors),oldBelowAuthorityMax:Math.max(...rawVertical),contactBelowAuthorityMax:Math.max(...fixedVertical),driverTotalMsP95:p95(cost)};
  results.push(result);console.log(JSON.stringify(result));
  if(process.env.VEHICLE_TRACE_DETAILS)console.log(JSON.stringify(worst.sort((a,b)=>b.error-a.error).slice(0,3)));
  assert(result.contactBelowAuthorityMax < result.oldBelowAuthorityMax, 'collision-aware extrapolation must improve delayed landings');
  assert(result.driverPositionP95<1.5,'bounded driver prediction exceeded position error budget');
}
sim.free();
