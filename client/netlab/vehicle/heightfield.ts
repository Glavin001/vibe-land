import {type QualityEvidence, type QualityFrame, type QualityMetric} from './contracts';

/** Pin separately from the general course: deliberately stronger vertical budgets.
 * These are provisional experience targets, not runtime or physics tolerances. */
export const HEIGHTFIELD_LIMITS = {
  fastMps:15, veryFastMps:20, sustainedFastTicks:180, veryFastTicks:60, washboardTicks:60,
  terrainRangeM:1, crestProminenceM:.25,
  verticalP95M:.1, verticalMaxM:.3, verticalStepMaxM:.15, tiltMaxDeg:10,
  positionP95M:.15, positionMaxM:.5, correctionMaxM:.35,
  recoverySettleTicks:30, recoveryHoldTicks:30,
} as const;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const speed=(f:QualityFrame)=>f.heightfield!.speedMps;
const height=(f:QualityFrame)=>f.heightfield!.surfaceHeightM;
const range=(values:number[])=>values.length?Math.max(...values)-Math.min(...values):0;
const longest=(frames:QualityFrame[],predicate:(f:QualityFrame)=>boolean)=>{
  let n=0,best=0;for(const f of frames){n=predicate(f)?n+1:0;best=Math.max(best,n);}return best;
};
export function heightfieldCoverage(e:QualityEvidence) {
  const problems:string[]=[];
  if(e.heightfieldSource?.worldName!=='Garage proving ground'||!/^[a-f0-9]{64}$/.test(e.heightfieldSource?.terrainSha256??''))problems.push('Missing garage terrain identity/hash');
  if(!e.frames.length||e.frames.some(f=>!finite(f.heightfield?.speedMps)||f.heightfield!.speedMps<0||!finite(f.heightfield?.surfaceHeightM)))problems.push('Missing finite authority speed/terrain samples');
  if(problems.length)return {problems,summary:null,segments:[]};
  const fast=e.frames.filter(f=>speed(f)>=HEIGHTFIELD_LIMITS.fastMps);
  const veryFast=fast.filter(f=>speed(f)>=HEIGHTFIELD_LIMITS.veryFastMps);
  const washboard=fast.filter(f=>Math.abs(f.reference.position[0])<=10&&f.reference.position[2]>=32&&f.reference.position[2]<=64);
  // Select the hill crest entirely from pinned truth, independently of candidate errors.
  const crest=veryFast.reduce<QualityFrame|undefined>((a,b)=>!a||height(b)>height(a)?b:a,undefined);
  const crestBefore=crest?fast.filter(f=>f.tick<crest.tick):[];
  const crestAfter=crest?fast.filter(f=>f.tick>crest.tick):[];
  const prominence=(side:QualityFrame[])=>crest&&side.length?height(crest)-Math.min(...side.map(height)):0;
  const summary={peakSpeedMps:Math.max(...e.frames.map(speed)),fastTicks:fast.length,
    sustainedFastTicks:longest(e.frames,f=>speed(f)>=HEIGHTFIELD_LIMITS.fastMps),veryFastTicks:veryFast.length,
    sustainedVeryFastTicks:longest(e.frames,f=>speed(f)>=HEIGHTFIELD_LIMITS.veryFastMps),
    washboardTicks:washboard.length,terrainRangeM:range(fast.map(height)),
    crestTick:crest?.tick??null,crestRiseM:prominence(crestBefore),crestFallM:prominence(crestAfter)};
  if(summary.sustainedFastTicks<HEIGHTFIELD_LIMITS.sustainedFastTicks)problems.push('Need 3 continuous seconds at >=15 m/s (54 km/h)');
  if(summary.sustainedVeryFastTicks<HEIGHTFIELD_LIMITS.veryFastTicks)problems.push('Need 60 consecutive ticks at >=20 m/s (72 km/h)');
  if(summary.washboardTicks<HEIGHTFIELD_LIMITS.washboardTicks)problems.push('Need 60 fast ticks inside the garage suspension lane');
  if(summary.terrainRangeM<HEIGHTFIELD_LIMITS.terrainRangeM)problems.push('Fast path must cross at least 1 m of heightfield elevation change');
  if(summary.crestRiseM<HEIGHTFIELD_LIMITS.crestProminenceM||summary.crestFallM<HEIGHTFIELD_LIMITS.crestProminenceM)problems.push('Need fast uphill/downhill travel around a crest reached at >=20 m/s');
  const segments=[{id:'fast-terrain',frames:fast},{id:'washboard',frames:washboard},
    {id:'high-speed-crest',frames:crest?e.frames.filter(f=>Math.abs(f.tick-crest.tick)<=30):[]},
    {id:'descent-reconcile',frames:crest?e.frames.filter(f=>f.tick>crest.tick&&f.tick<=crest.tick+120):[]}];
  // Always retain a complete post-crest recovery interval: truncated recordings cannot pass.
  if(segments[3].frames.length!==120)problems.push('Need two full seconds after the high-speed crest');
  return {problems,summary,segments};
}
const up=([x,y,z,w]:number[])=>[2*(x*y-z*w),1-2*(x*x+z*z),2*(y*z+x*w)];
const tilt=(a:number[],b:number[])=>{
  const aa=up(a),bb=up(b);return Math.acos(Math.max(-1,Math.min(1,aa.reduce((s,v,i)=>s+v*bb[i],0))))*180/Math.PI;
};
/** Appends focused metrics after envelope/pose validation by the shared evaluator.
 * Missing rendering still fails via the shared evaluator; it is never replaced by truth. */
export function measureHeightfield(e:QualityEvidence,metrics:QualityMetric[],problems:string[]) {
  const coverage=heightfieldCoverage(e);problems.push(...coverage.problems);
  if(coverage.problems.length)return;
  const add=(id:string,values:{tick:number;value:number}[],limit:number,unit:string,p95=false)=>{
    if(!values.length)return;
    const sorted=[...values].sort((a,b)=>a.value-b.value||a.tick-b.tick);
    const v=sorted[p95?Math.ceil(sorted.length*.95)-1:sorted.length-1];
    metrics.push({id,value:v.value,witnessTick:v.tick,limit,unit});
  };
  for(const segment of coverage.segments) {
    const present=segment.frames.filter(f=>f.actual!==null),prefix=segment.id;
    const vertical=present.map(f=>({tick:f.tick,value:Math.abs(f.actual!.position[1]-f.reference.position[1])}));
    const position=present.map(f=>({tick:f.tick,value:Math.hypot(...f.actual!.position.map((v,i)=>v-f.reference.position[i]))}));
    add(`${prefix}/vertical-p95`,vertical,HEIGHTFIELD_LIMITS.verticalP95M,'m',true);
    add(`${prefix}/vertical-max`,vertical,HEIGHTFIELD_LIMITS.verticalMaxM,'m');
    add(`${prefix}/position-p95`,position,HEIGHTFIELD_LIMITS.positionP95M,'m',true);
    add(`${prefix}/position-max`,position,HEIGHTFIELD_LIMITS.positionMaxM,'m');
    add(`${prefix}/tilt-max`,present.map(f=>({tick:f.tick,value:tilt(f.actual!.quaternion,f.reference.quaternion)})),HEIGHTFIELD_LIMITS.tiltMaxDeg,'deg');
    const steps=present.flatMap(f=>{
      const p=e.frames[f.tick-e.startTick-1];if(!p?.actual)return [];
      return [{tick:f.tick,value:Math.abs((f.actual!.position[1]-p.actual.position[1])-(f.reference.position[1]-p.reference.position[1]))}];
    });
    add(`${prefix}/vertical-error-step-max`,steps,HEIGHTFIELD_LIMITS.verticalStepMaxM,'m/tick');
    const ticks=new Set(segment.frames.map(f=>f.tick));
    // Zero is explicit so changing packet patterns cannot silently omit this metric.
    add(`${prefix}/correction-max`,[{tick:segment.frames[0].tick,value:0},...e.corrections.filter(c=>ticks.has(c.tick)).map(c=>({tick:c.tick,value:c.errorM}))],HEIGHTFIELD_LIMITS.correctionMaxM,'m');
  }
  if(e.snapshotRecoveries!==undefined&&!Array.isArray(e.snapshotRecoveries)) {problems.push('Invalid receive-recovery evidence');return;}
  for(const [index,recovery] of (e.snapshotRecoveries??[]).entries()) {
    if(!recovery||!Number.isInteger(recovery.tick)||!Number.isInteger(recovery.sourceTick)||recovery.tick<e.startTick
      ||recovery.sourceTick<0||recovery.sourceTick>recovery.tick||recovery.tick+HEIGHTFIELD_LIMITS.recoverySettleTicks+HEIGHTFIELD_LIMITS.recoveryHoldTicks-1>e.endTick) {
      problems.push('Incomplete or invalid receive-recovery observation window');continue;
    }
    let run=0,settled:number|null=null;
    for(const f of e.frames.filter(f=>f.tick>=recovery.tick)) {
      const error=f.actual?Math.hypot(...f.actual.position.map((v,i)=>v-f.reference.position[i])):Infinity;
      const ok=error<=HEIGHTFIELD_LIMITS.positionP95M&&!!f.actual
        &&Math.abs(f.actual.position[1]-f.reference.position[1])<=HEIGHTFIELD_LIMITS.verticalP95M
        &&tilt(f.actual.quaternion,f.reference.quaternion)<=HEIGHTFIELD_LIMITS.tiltMaxDeg
        &&f.sourceTick>=recovery.sourceTick&&!f.frozen;
      run=ok?run+1:0;
      if(run===HEIGHTFIELD_LIMITS.recoveryHoldTicks){settled=f.tick-run+1-recovery.tick;break;}
    }
    metrics.push({id:`receive-recovery-${index}/settle`,value:settled??e.endTick-recovery.tick+1,
      limit:HEIGHTFIELD_LIMITS.recoverySettleTicks,unit:'ticks',witnessTick:recovery.tick});
    metrics.push({id:`receive-recovery-${index}/unsettled`,value:settled===null?1:0,limit:0,unit:'events',witnessTick:recovery.tick});
  }
}
