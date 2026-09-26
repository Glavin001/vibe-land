import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {describe,it,expect} from 'vitest';
import {garageHeightfieldReference} from './heightfieldReplay';
import {heightfieldCoverage,HEIGHTFIELD_LIMITS} from './heightfield';
import {evaluateVehicleQuality} from './evaluate';
import {VEHICLE_QUALITY_SCENARIOS} from './scenarios';
import {QUALITY_VERSION,type QualityEvidence} from './contracts';
import {packetSchedule} from './schedule';
import type {NativeTrace} from './replay';
const trace=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/native-course.json.gz',import.meta.url))).toString()) as NativeTrace;
const hash='a'.repeat(64);
const reference=garageHeightfieldReference(trace,hash);
const contract=VEHICLE_QUALITY_SCENARIOS.find(s=>s.id==='garage-fast-heightfield')!;
// Perfect presentation here tests the detector only. Shipping replay is measured by the CLI.
function oracle(role:'driver'|'observer'='driver'):QualityEvidence {
 const delay=role==='observer'?9:0;
 return reference.attach({version:QUALITY_VERSION,scenario:contract.id,role,startTick:12,endTick:719,observerDelayTicks:delay,
  lostRecords:0,source:'analytic-perfect-presentation-on-native-course',corrections:[],triggers:[],
  frames:trace.frames.slice(12).map((_,i)=>({tick:i+12,sourceTick:i+12,frozen:false,
    reference:structuredClone(trace.frames[i+12-delay].sample),actual:structuredClone(trace.frames[i+12-delay].sample)}))});
}
const score=(e:QualityEvidence)=>evaluateVehicleQuality(e,contract);
const metric=(e:QualityEvidence,id:string)=>score(e).metrics.find(m=>m.id===id)!;
describe('fast garage heightfield qualification',()=>{
 it('proves the pinned tape covers actual fast uneven terrain, not the spawn drop',()=>{
  const c=reference.coverage!;
  expect(c.peakSpeedMps).toBeGreaterThan(22);expect(c.sustainedFastTicks).toBeGreaterThanOrEqual(180);
  expect(c.veryFastTicks).toBeGreaterThanOrEqual(60);expect(c.washboardTicks).toBeGreaterThanOrEqual(60);
  expect(c.terrainRangeM).toBeGreaterThan(1);expect(c.crestTick).toBe(498);
  expect(c.crestRiseM).toBeGreaterThan(.25);expect(c.crestFallM).toBeGreaterThan(.25);
 });
 it('accepts perfect trajectory and aligns spectator terrain to the delayed truth',()=>{
  expect(score(oracle()).verdict).toBe('pass');expect(score(oracle('observer')).verdict).toBe('pass');
  expect(heightfieldCoverage(oracle('observer')).summary!.crestTick).toBe(507);
  expect(oracle('observer').frames[500].heightfield).toEqual(oracle().frames[491].heightfield);
 });
 it('blocks slow, flat, out-of-lane, missing and truncated evidence',()=>{
  const slow=oracle();slow.frames.forEach(f=>f.heightfield!.speedMps=2);expect(score(slow).verdict).toBe('blocked');
  const flat=oracle();flat.frames.forEach(f=>f.heightfield!.surfaceHeightM=0);expect(score(flat).verdict).toBe('blocked');
  const lane=oracle();lane.frames.forEach(f=>f.reference.position[0]=50);expect(score(lane).verdict).toBe('blocked');
  const missing=oracle();delete missing.frames[20].heightfield;expect(score(missing).verdict).toBe('blocked');
  const short=oracle();short.endTick=550;short.frames=short.frames.filter(f=>f.tick<=550);expect(score(short).verdict).toBe('blocked');
 });
 it('rejects absent or flat geometry and out-of-bounds source instead of inventing a floor',()=>{
  const noWorld=structuredClone(trace);noWorld.world={};expect(()=>garageHeightfieldReference(noWorld,hash)).toThrow('heightfield');
  const flat=structuredClone(trace);(flat.world as any).terrain.tiles[0].heights.fill(0);expect(()=>garageHeightfieldReference(flat,hash)).toThrow('not covered');
  const outside=structuredClone(trace);outside.frames[500].sample.position[0]=1000;expect(()=>garageHeightfieldReference(outside,hash)).toThrow('outside');
 });
 it('detects terrain-only vertical drift hidden by a full-course percentile',()=>{
  const e=oracle();for(const f of e.frames)if(f.tick>=490&&f.tick<500)f.actual!.position[1]-=.2;
  expect(metric(e,'position-p95').value).toBe(0);
  expect(metric(e,'high-speed-crest/vertical-p95').value).toBeGreaterThan(HEIGHTFIELD_LIMITS.verticalP95M);
  expect(metric(e,'high-speed-crest/vertical-error-step-max').value).toBeGreaterThan(HEIGHTFIELD_LIMITS.verticalStepMaxM);
  expect(score(e).verdict).toBe('fail');
 });
 it('detects incorrect pitch even with an exactly matching chassis position',()=>{
  const e=oracle();e.frames.find(f=>f.tick===498)!.actual!.quaternion=[Math.sin(.3),0,0,Math.cos(.3)];
  expect(metric(e,'high-speed-crest/tilt-max').value).toBeGreaterThan(10);
 });
 it('measures reconciliation on the washboard separately from smooth straight driving',()=>{
  const e=oracle();e.corrections=[{tick:360,errorM:1,angleRad:0,hard:true}];
  expect(metric(e,'washboard/correction-max').value).toBe(1);
  expect(metric(e,'high-speed-crest/correction-max').value).toBe(0);
 });
 it('targets burst loss at the fast crest and suspension lane with deterministic schedules',()=>{
  for(const id of ['washboard-burst','fast-crest-burst']){
   const link=reference.links.find(l=>l.id===id)!,[begin,end]=link.blackout!;
   expect(begin).toBeGreaterThan(300);expect(end).toBeLessThan(600);
   expect(packetSchedule(720,link,42)).toEqual(packetSchedule(720,link,42));
   const affected=packetSchedule(720,link,42).filter(p=>p.arrivalTick>=begin&&p.arrivalTick<end);
   expect(affected.length).toBeGreaterThan(0);expect(affected.every(p=>p.dropped)).toBe(true);
  }
 });
 it('requires sustained convergence after recovery rather than one lucky corrected frame',()=>{
  const e=oracle();e.snapshotRecoveries=[{tick:512,sourceTick:506}];
  expect(metric(e,'receive-recovery-0/settle').value).toBe(0);
  for(const f of e.frames)if(f.tick>=512&&f.tick<570&&f.tick!==514)f.actual!.position[1]-=.2;
  expect(metric(e,'receive-recovery-0/settle').value).toBe(58);expect(score(e).verdict).toBe('fail');
 });
 it('fails unbounded recovery and blocks captures ending before the recovery budget',()=>{
  const e=oracle();e.snapshotRecoveries=[{tick:512,sourceTick:506}];
  for(const f of e.frames)if(f.tick>=512)f.actual!.position[1]-=.2;
  expect(metric(e,'receive-recovery-0/unsettled').value).toBe(1);
  const late=oracle();late.snapshotRecoveries=[{tick:710,sourceTick:704}];expect(score(late).verdict).toBe('blocked');
 });
});
