import { isRecording, recordEvent } from './recorder';
import type { VehicleLabRole } from './vehicleLab';

// Only retained during capture. Exact rendered transforms, not camera/player poses.
const previous = new Map<number, {t:number; position:readonly number[]; velocity:number[]; role:VehicleLabRole;assetHash?:string}>();
export function resetVehicleTelemetry(): void { previous.clear(); }
export function recordVehicleFrame(sample: {
  vehicleId:number; role:VehicleLabRole; now:number; dtMs:number;
  position:readonly number[]; quaternion:readonly number[]; speed:number;
  delayMs:number; extrapolated:boolean; frozen:boolean; assetHash?:string; configuration?:unknown;
}): void {
  if(!isRecording()) return;
  const last=previous.get(sample.vehicleId), dt=last?(sample.now-last.t)/1000:0;
  if(!last || last.assetHash!==sample.assetHash)recordEvent('note',{vehicleId:sample.vehicleId,assetHash:sample.assetHash,configuration:sample.configuration});
  const continuous=last?.role===sample.role && dt>0 && dt<.25;
  const velocity=continuous?sample.position.map((p,i)=>(p-last!.position[i])/dt):[0,0,0];
  const residualM=continuous?Math.hypot(...sample.position.map((p,i)=>p-last!.position[i]-last!.velocity[i]*dt)):null;
  previous.set(sample.vehicleId,{t:sample.now,position:[...sample.position],velocity,role:sample.role,assetHash:sample.assetHash});
  if(previous.size>256) for(const [id,value] of previous) if(sample.now-value.t>1000) previous.delete(id);
  const {configuration:_,...frame}=sample;
  recordEvent('vehicle_frame',{...frame,residualM,heldWhileMoving:continuous && sample.speed>1 && Math.hypot(...velocity)<.001});
}
