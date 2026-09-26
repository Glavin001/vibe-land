import { describe, expect, it } from 'vitest';
import { scoreVehicleLab, vehicleLabHref } from './vehicleLab';
import type { RecorderEvent } from './recorder';
const event=(type:RecorderEvent['type'],data:RecorderEvent['data'],i=0):RecorderEvent=>({type,data,tMs:i*20,seq:i});
function capture(role='driver'):RecorderEvent[] {
  return Array.from({length:1600},(_,i)=>event('vehicle_frame',{role,vehicleId:7,dtMs:20,speed:5,delayMs:150,extrapolated:false,frozen:false,residualM:.01},i));
}
function driver():RecorderEvent[] {return [...capture(),event('vehicle_reconcile',{vehicleId:7,errorM:.02,hard:false}),event('vehicle_input_presented',{vehicleId:7,delayMs:17})];}
describe('vehicle net lab scoring',()=>{
  it('does not pass an idle or unmeasured driver',()=>{
    expect(scoreVehicleLab(capture())[0].verdict).toBe('insufficient');
    expect(scoreVehicleLab(driver().map(e=>e.type==='vehicle_frame'?{...e,data:{...e.data,speed:0}}:e))[0].verdict).toBe('insufficient');
    expect(scoreVehicleLab([])).toEqual([]);
  });
  it('counts corrections once rather than at frame rate; fails rubberbanding',()=>{
    const good=scoreVehicleLab(driver())[0];expect(good.verdict).toBe('within-targets');
    const bad=scoreVehicleLab([...driver(),event('vehicle_reconcile',{vehicleId:7,errorM:1,hard:true})])[0];
    expect(bad.verdict).toBe('needs-work');
    expect(bad.metrics.find(m=>m.unit==='/min')?.value).toBeCloseTo(60/32);
  });
  it('separates spectators and driver; intentional delay alone is not failure',()=>{
    const scores=scoreVehicleLab([...driver(),...capture('observer')]);
    expect(scores).toHaveLength(2);expect(scores[1].verdict).toBe('within-targets');
    expect(scores[1].metrics.find(m=>m.label==='Presentation delay p95')?.value).toBe(150);
  });
  it('fails observer buffer underruns and driver outages',()=>{
    expect(scoreVehicleLab(capture('observer').map(e=>({...e,data:{...e.data,extrapolated:true}})))[0].verdict).toBe('needs-work');
    expect(scoreVehicleLab(driver().map(e=>e.type==='vehicle_frame'?{...e,data:{...e.data,frozen:true}}:e))[0].verdict).toBe('needs-work');
  });
  it('does not credit a background tab pause as test duration',()=>{
    const frames=Array.from({length:5},()=>event('vehicle_frame',{role:'observer',vehicleId:7,dtMs:10000,speed:10}));
    expect(scoreVehicleLab(frames)[0].seconds).toBe(.5);
    expect(scoreVehicleLab(frames)[0].verdict).toBe('insufficient');
  });
  it('preserves independent session query and removes impairment for baseline',()=>{
    expect(vehicleLabHref('baseline','?observe=garage-abc&impair=lte')).toContain('observe=garage-abc');
    expect(vehicleLabHref('baseline','?impair=lte')).not.toContain('impair=');
    expect(vehicleLabHref('lte')).toContain('netlab=1');
  });
});
