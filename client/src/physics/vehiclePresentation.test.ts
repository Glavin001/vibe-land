import {describe,it,expect} from 'vitest';
import {VehiclePresentationPredictor,extrapolateVehicle,moveVehicle,vehicleProxy,type Sweep,type VehicleProxy,type VehiclePredictionEvent} from './vehiclePresentation';
import {VehicleInterpolator,type VehicleSample} from '../net/interpolation';
import {BTN_JUMP,type InputCmd} from '../net/protocol';
import {defaultConfiguration} from '../vehicles/configuration.mjs';
const proxy:VehicleProxy={half:[.7,.2,1.2],wheels:[[-.9,-.25,1.2],[.9,-.25,1.2],[-.9,-.25,-1.2],[.9,-.25,-1.2]],radius:.4,wheelbase:2.4,acceleration:6,speed:30,grip:1.4,braking:1,lock:.5,response:1};
const state=(patch:Partial<VehicleSample>={}):VehicleSample=>({serverTimeUs:0,position:[0,.652,0],quaternion:[0,0,0,1],linearVelocity:[0,0,0],angularVelocity:[0,0,0],wheelData:[0,0,0,0],driverPlayerId:1,flags:0,...patch});
const input=(seq:number,moveY=127,moveX=0,buttons=0):InputCmd=>({seq:seq&65535,clientTick:0,buttons,moveX,moveY,yaw:0,pitch:0});
// Independent analytical road/wall sweeps for these upright traces. Native
// query tests below the WASM boundary exercise real geometry and tilted ramps.
const sweep:Sweep=(p,_q,d,h,r=0)=>{
  const hits:{fraction:number;normal:[number,number,number]}[]=[];
  if(d[1]<0)hits.push({fraction:Math.max(0,(p[1]-(r||h[1])-.002)/-d[1]),normal:[0,1,0]});
  if(d[0]>0)hits.push({fraction:Math.max(0,(10-p[0]-(r||h[0])-.002)/d[0]),normal:[-1,0,0]});
  return hits.filter(h=>h.fraction<=1).sort((a,b)=>a.fraction-b.fraction)[0]??null;
};
describe('collision-aware Vehicle2 presentation',()=>{
  it('stops fast landings and slides along walls instead of tunnelling',()=>{
    const landed=extrapolateVehicle(state({position:[0,2,0],linearVelocity:[0,-18,12]}),.25,proxy,sweep);
    expect(landed.position[1]).toBeCloseTo(.652,3);expect(landed.linearVelocity[1]).toBe(0);
    expect(landed.position[2]).toBeCloseTo(3);
    const hit=moveVehicle([0,.652,0],[0,0,0,1],[20,0,5],proxy,sweep);
    expect(hit.position[0]).toBeLessThanOrEqual(8.71);expect(hit.position[2]).toBeCloseTo(5);
  });
  it('preserves Vehicle2 rest height within the suspension support margin',()=>{
    const rest=state({position:[0,.675,0]});
    expect(extrapolateVehicle(rest,.25,proxy,sweep).position).toEqual(rest.position);
  });
  it('leaves real gaps open, applies airborne gravity, and bounds stale tracks',()=>{
    const start=state({position:[0,10,0],linearVelocity:[0,0,20]});
    const fall=extrapolateVehicle(start,5,proxy,()=>null);
    expect(fall.position[1]).toBeLessThan(9.8);expect(fall.position[2]).toBeCloseTo(5);
    expect(extrapolateVehicle(start,.25,proxy,()=>null)).toEqual(fall);
  });
  it('does not apply engine thrust or steering while airborne',()=>{
    const driver=new VehiclePresentationPredictor(()=>null);
    driver.observe(1,state({position:[0,10,0]}),0,proxy,0);
    driver.record(1,[input(1,127,127)]);driver.update(1/60,16);
    expect(driver.pose()!.position[2]).toBe(0);expect(driver.pose()!.quaternion).toEqual([0,0,0,1]);
  });
  it('responds before server replies and handles ack wrap, old packets and changing drivers',()=>{
    const driver=new VehiclePresentationPredictor(sweep);driver.observe(1,state(),65534,proxy,0);
    driver.record(1,[input(65535),input(0),input(1)]);driver.update(.05,50);
    expect(driver.pose()!.position[2]).toBeGreaterThan(0);
    const before=driver.pose()!;
    driver.observe(1,state({serverTimeUs:16667}),65535,proxy,60);
    expect(driver.pendingCount).toBe(2);expect(driver.pose()!.position[2]).toBeCloseTo(before.position[2]);
    const reconciled=driver.pose();
    driver.observe(1,state({serverTimeUs:1000,position:[100,100,100]}),65534,proxy,61);
    expect(driver.pose()).toEqual(reconciled);expect(driver.resendWindow().map(i=>i.seq)).toEqual([0,1]);
    driver.record(2,[input(2)]);expect(driver.pose()).toBeNull();
  });
  it('records actual reconciliation once and input presentation only after a render-facing read',()=>{
    const events:VehiclePredictionEvent[]=[];
    const driver=new VehiclePresentationPredictor(sweep,e=>events.push(e));
    driver.observe(1,state(),0,proxy,0);
    driver.record(1,[input(1)]);driver.update(1/60,16);
    driver.pose();expect(events).toHaveLength(0);
    driver.presented(performance.now()+20);driver.presented(performance.now()+30);
    expect(events.filter(e=>e.type==='vehicle_input_presented')).toHaveLength(1);
    driver.observe(1,state({serverTimeUs:16667,position:[2,.652,0]}),1,proxy,20);
    driver.observe(1,state({serverTimeUs:16667}),1,proxy,21);
    const corrections=events.filter(e=>e.type==='vehicle_reconcile');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({vehicleId:1,hard:true});
    driver.reset();driver.presented(50);expect(events).toHaveLength(2);
  });
  it('handbrakes oppose motion and do not add engine thrust',()=>{
    const drive=new VehiclePresentationPredictor(sweep),brake=new VehiclePresentationPredictor(sweep);
    for(const d of [drive,brake])d.observe(1,state({linearVelocity:[0,0,12]}),0,proxy,0);
    drive.record(1,[input(1)]);brake.record(1,[input(1,127,0,BTN_JUMP)]);
    drive.update(1/60,16);brake.update(1/60,16);
    expect(brake.pose()!.position[2]).toBeLessThan(drive.pose()!.position[2]);
  });
  it.each([80,180,300])('delayed landings at %i ms RTT stay above the road with jitter, loss and reordering',rtt=>{
    const interpolator=new VehicleInterpolator();interpolator.extrapolate=(_,s,t)=>extrapolateVehicle(s,t,proxy,sweep);
    const packets=Array.from({length:31},(_,i)=>{
      const t=i/30,y=Math.max(.652,4-10*t-4.905*t*t);
      return {arrival:i*1000/30+rtt/2+(i%3-1)*20,sample:state({serverTimeUs:i*1e6/30,
        position:[0,y,8*t],linearVelocity:[0,y===.652?0:-10-9.81*t,8]})};
    }).filter((_,i)=>i%7!==3).sort((a,b)=>a.arrival-b.arrival);
    let observed=0;
    for(let ms=0;ms<1300;ms+=1000/60) {
      while(packets[0]?.arrival<=ms)interpolator.push(1,packets.shift()!.sample);
      const rendered=interpolator.sample(1,ms*1000);
      if(rendered){observed++;expect(rendered.position[1]).toBeGreaterThanOrEqual(.6519);}
    }
    expect(observed).toBeGreaterThan(50);
  });
  it('renders motion between fixed input ticks without consuming another input',()=>{
    const driver=new VehiclePresentationPredictor(sweep);
    driver.observe(1,state({linearVelocity:[0,0,12]}),0,proxy,0);
    expect(driver.pose(1/120)!.position[2]-driver.pose()!.position[2]).toBeCloseTo(.1);
    expect(driver.pendingCount).toBe(0);
  });
  it('bounds history and freezes during prolonged blackout',()=>{
    const driver=new VehiclePresentationPredictor(sweep);driver.observe(1,state(),0,proxy,0);
    for(let tick=1;tick<=120;tick++){driver.record(1,[input(tick)]);driver.update(1/60,tick*1000/60);}
    const stopped=driver.pose();
    for(let tick=121;tick<=1000;tick++){driver.record(1,[input(tick)]);driver.update(1/60,tick*1000/60);}
    expect(driver.pose()).toEqual(stopped);expect(driver.pose(1/120)).toEqual(stopped);expect(driver.pendingCount).toBeLessThanOrEqual(128);
  });
  it('uses shared geometry and customized two-wheel traction limits',()=>{
    const configuration=defaultConfiguration();configuration.driving.drivetrain='fwd';
    const p=vehicleProxy({...state(),id:1,driverId:1,vehicleType:0,customVehicle:{configuration,assetHash:'x',geometryHash:'g'}});
    expect(p.radius).toBe(configuration.dimensions.tireRadius);
    expect(p.acceleration).toBeCloseTo(.8*configuration.driving.grip*9.81/2);
  });
});
