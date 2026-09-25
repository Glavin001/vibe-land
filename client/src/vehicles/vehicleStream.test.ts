import {expect,it} from 'vitest';
import {defaultConfiguration} from './configuration.mjs';
import {decodeVehicleAsset,decodeVehicleRig} from './vehicleStream';
import {decodeInboundGamePacket} from '../net/inbound';
import {PKT_VEHICLE_ASSET,PKT_VEHICLE_RIG} from '../net/sharedConstants';
import {NetcodeClient} from '../net/netcodeClient';

function assetBytes() {
 const json=JSON.stringify({handle:7,vehicle:{configuration:defaultConfiguration(),assetHash:'a'.repeat(64),geometryHash:'b'.repeat(64)}});
 return new Uint8Array([PKT_VEHICLE_ASSET,...new TextEncoder().encode(json)]);
}
function rigBytes(tick=400) {
 const bytes=new Uint8Array(58),view=new DataView(bytes.buffer);
 bytes[0]=PKT_VEHICLE_RIG;view.setUint32(1,tick,true);bytes[5]=7;
 for(let wheel=0;wheel<4;wheel++) {
  const offset=6+wheel*13;
  view.setFloat32(offset,.08,true);view.setFloat32(offset+4,.3,true);view.setFloat32(offset+8,-2,true);bytes[offset+12]=1;
 }
 return bytes;
}
it('routes authoritative rig poses through live and replay transport decoders',()=>{
 for(const channel of ['wt-datagram','wt-reliable','websocket'] as const) {
  const packet=decodeInboundGamePacket(rigBytes(),channel);
  expect(packet.type).toBe('vehicleRig');
  if(packet.type!=='vehicleRig')throw Error('Wrong packet');
  expect(packet.handle).toBe(7);expect(packet.serverTick).toBe(400);
  expect(packet.wheels[0].travelM).toBeCloseTo(.08);expect(packet.wheels[0].rotationRad).toBe(-2);
 }
 expect(decodeInboundGamePacket(assetBytes(),'wt-reliable')).toEqual(decodeVehicleAsset(assetBytes()));
});
it('rejects truncated, nonfinite and malformed poses and configurations',()=>{
 expect(()=>decodeVehicleRig(rigBytes().subarray(0,57))).toThrow();
 const invalid=rigBytes();new DataView(invalid.buffer).setFloat32(6,NaN,true);
 expect(()=>decodeVehicleRig(invalid)).toThrow();
 invalid.set(rigBytes());invalid[18]=3;expect(()=>decodeVehicleRig(invalid)).toThrow();
 expect(()=>decodeVehicleAsset(new Uint8Array([140,123]))).toThrow();
});
it('keeps asset metadata and latest rig pose when datagrams arrive out of order',()=>{
 const client=new NetcodeClient({});
 client.vehicles.set(7,{id:7,vehicleType:0,driverId:0,flags:0,position:[0,0,0],quaternion:[0,0,0,1],linearVelocity:[0,0,0],angularVelocity:[0,0,0],wheelData:[0,0,0,0]});
 client.handlePacket(decodeVehicleRig(rigBytes(400)));
 client.handlePacket(decodeVehicleAsset(assetBytes()));
 client.handlePacket(decodeVehicleRig(rigBytes(399)));
 expect(client.vehicles.get(7)?.customRig?.serverTick).toBe(400);
 expect(client.vehicles.get(7)?.customVehicle?.configuration.model).toBe('buggy');
 client.reset();expect(client.vehicles.size).toBe(0);
});
