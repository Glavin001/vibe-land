import { normalizeConfiguration, type VehicleConfiguration } from './configuration.mjs';
import { PKT_VEHICLE_ASSET, PKT_VEHICLE_RIG } from '../net/sharedConstants';

export type VehicleAsset = { configuration:VehicleConfiguration; assetHash:string; geometryHash:string };
export type WheelPose = {travelM:number; steeringRad:number; rotationRad:number; grounded:boolean};
export type VehicleAssetPacket = {type:'vehicleAsset'; handle:number; vehicle:VehicleAsset};
export type VehicleRigPacket = {type:'vehicleRig'; handle:number; serverTick:number; wheels:WheelPose[]};

export function decodeVehicleAsset(bytes:Uint8Array):VehicleAssetPacket {
  if(bytes.length<2 || bytes.length>8192 || bytes[0]!==PKT_VEHICLE_ASSET)throw Error('Invalid vehicle asset packet');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(1)));
  if(!Number.isInteger(value.handle)||value.handle<1||value.handle>255)throw Error('Invalid vehicle handle');
  const vehicle=value.vehicle;
  if(!vehicle||!(/^[a-f0-9]{64}$/.test(vehicle.assetHash))||!(/^[a-f0-9]{64}$/.test(vehicle.geometryHash)))throw Error('Invalid vehicle asset identity');
  return {type:'vehicleAsset',handle:value.handle,vehicle:{configuration:normalizeConfiguration(vehicle.configuration),assetHash:vehicle.assetHash,geometryHash:vehicle.geometryHash}};
}
export function decodeVehicleRig(bytes:Uint8Array):VehicleRigPacket {
  if(bytes.length!==58||bytes[0]!==PKT_VEHICLE_RIG||bytes[5]===0)throw Error('Invalid vehicle rig packet');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),wheels:WheelPose[]=[];
  for(let i=0;i<4;i++) {
    const offset=6+i*13,travelM=view.getFloat32(offset,true),steeringRad=view.getFloat32(offset+4,true),rotationRad=view.getFloat32(offset+8,true),grounded=bytes[offset+12];
    if(![travelM,steeringRad,rotationRad].every(Number.isFinite)||grounded>1)throw Error('Invalid wheel pose');
    wheels.push({travelM,steeringRad,rotationRad,grounded:grounded===1});
  }
  return {type:'vehicleRig',handle:bytes[5],serverTick:view.getUint32(1,true),wheels};
}
