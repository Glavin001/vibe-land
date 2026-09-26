import type { RecorderEvent } from './recorder';

export const VEHICLE_LAB_PROFILES = ['baseline', 'wifi-good', 'wifi-bad', 'lte', 'poor-mobile', 'blackhole'] as const;
export const VEHICLE_LAB_TARGETS = {
  durationSec: 30, movingSec: 5, correctionP95M: .15, hardSnapsPerMinute: 1,
  inputPresentationP95Ms: 50, frozenPct: 1, observerExtrapolatedPct: 5, frameP95Ms: 33.4,
};
export type VehicleLabRole = 'driver' | 'observer';
export function vehicleLabEnabled(search: string): boolean {
  return new URLSearchParams(search).get('vehicleNetlab') === '1';
}
export function vehicleLabHref(profile: string, search = ''): string {
  const params = new URLSearchParams(search);
  params.set('vehicleNetlab', '1'); params.set('netlab', '1'); params.set('impairSeed', '42');
  if (profile === 'baseline') params.delete('impair'); else params.set('impair', profile);
  return `/garage?${params}`;
}
const percentile = (a: number[]): number | null => {
  if (!a.length) return null;
  const sorted = [...a].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*.95)-1)];
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export interface VehicleLabMetric { label: string; value: number | null; unit: string; target?: number; }
export interface VehicleLabScore {
  role: VehicleLabRole; vehicleId: number; seconds: number; movingSeconds: number;
  verdict: 'insufficient' | 'needs-work' | 'within-targets'; metrics: VehicleLabMetric[];
}
/** Scores one role/entity at a time. Never compare today's driver pose with an old
 * spectator pose as if they represented the same instant. Events are shared with
 * the existing netlab recorder/CLI, not a second telemetry recording system. */
export function scoreVehicleLab(events: readonly RecorderEvent[]): VehicleLabScore[] {
  const keys = new Set(events.filter(e=>e.type==='vehicle_frame').map(e=>`${e.data.role}:${e.data.vehicleId}`));
  return [...keys].map(key=>{
    const [role, id] = key.split(':') as [VehicleLabRole,string]; const vehicleId=Number(id);
    const frames=events.filter(e=>e.type==='vehicle_frame' && e.data.role===role && e.data.vehicleId===vehicleId);
    const corrections=events.filter(e=>e.type==='vehicle_reconcile' && e.data.vehicleId===vehicleId);
    const responses=events.filter(e=>e.type==='vehicle_input_presented' && e.data.vehicleId===vehicleId);
    // Exclude hidden-tab gaps from exposure; report actual frame intervals separately.
    const exposure=(e:RecorderEvent)=>finite(e.data.dtMs)?Math.max(0, Math.min(100,e.data.dtMs))/1000:0;
    const seconds=frames.reduce((s,e)=>s+exposure(e),0);
    const movingSeconds=frames.reduce((s,e)=>s+(Number(e.data.speed)>1?exposure(e):0),0);
    const values=(es:RecorderEvent[],field:string)=>es.map(e=>e.data[field]).filter(finite);
    const percentage=(field:string,movingOnly=false)=>{
      const duration=movingOnly?movingSeconds:seconds;
      return duration?100*frames.reduce((s,e)=>s+(e.data[field]===true && (!movingOnly || Number(e.data.speed)>1)?exposure(e):0),0)/duration:null;
    };
    const metrics:VehicleLabMetric[] = role==='driver' ? [
      {label:'Reconciliation displacement p95',value:percentile(values(corrections,'errorM')),unit:'m',target:VEHICLE_LAB_TARGETS.correctionP95M},
      {label:'Hard corrections / minute',value:seconds?corrections.filter(e=>e.data.hard===true).length*60/seconds:null,unit:'/min',target:VEHICLE_LAB_TARGETS.hardSnapsPerMinute},
      {label:'Input → predicted pose p95',value:percentile(values(responses,'delayMs')),unit:'ms',target:VEHICLE_LAB_TARGETS.inputPresentationP95Ms},
      {label:'Prediction frozen',value:percentage('frozen'),unit:'%',target:VEHICLE_LAB_TARGETS.frozenPct},
    ] : [
      {label:'Buffer underrun',value:percentage('extrapolated',true),unit:'%',target:VEHICLE_LAB_TARGETS.observerExtrapolatedPct},
      {label:'Held while moving',value:percentage('heldWhileMoving',true),unit:'%',target:VEHICLE_LAB_TARGETS.frozenPct},
      {label:'Presentation delay p95',value:percentile(values(frames,'delayMs')),unit:'ms'},
    ];
    metrics.push(
      {label:'Frame time p95',value:percentile(values(frames,'dtMs')),unit:'ms',target:VEHICLE_LAB_TARGETS.frameP95Ms},
      {label:'Motion residual p95',value:percentile(values(frames,'residualM')),unit:'m'},
    );
    const sufficient=seconds>=VEHICLE_LAB_TARGETS.durationSec && movingSeconds>=VEHICLE_LAB_TARGETS.movingSec
      && metrics.filter(m=>m.target!==undefined).every(m=>m.value!==null);
    return {role,vehicleId,seconds,movingSeconds,metrics,verdict:!sufficient?'insufficient':
      metrics.some(m=>m.target!==undefined && m.value!==null && m.value>m.target)?'needs-work':'within-targets'};
  });
}
