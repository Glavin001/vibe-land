import {describe,expect,it} from 'vitest';
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

describe('detached vehicle parts', () => {
  it('decodes the optional detached-part tail of a rig packet', async () => {
    const { PKT_VEHICLE_RIG } = await import('../net/sharedConstants');
    const { decodeVehicleRig } = await import('./vehicleStream');
    const bytes = new Uint8Array(58 + 1 + 30), view = new DataView(bytes.buffer);
    bytes[0] = PKT_VEHICLE_RIG; view.setUint32(1, 77, true); bytes[5] = 3; bytes[58] = 1;
    view.setUint16(59, 12, true);
    [1, 2, 3, 0, 0, 0, 1].forEach((v, i) => view.setFloat32(61 + i * 4, v, true));
    const packet = decodeVehicleRig(bytes);
    expect(packet.detached).toEqual([{ part: 12, position: [1, 2, 3], rotation: [0, 0, 0, 1] }]);
    expect(decodeVehicleRig(bytes.subarray(0, 58)).detached).toEqual([]);
    expect(() => decodeVehicleRig(bytes.subarray(0, 70))).toThrow();
  });
  it('draws a detached part at its world pose independent of the chassis', async () => {
    const THREE = await import('three');
    const { VehicleVisual } = await import('./VehicleVisual');
    const { defaultConfiguration } = await import('./configuration.mjs');
    const visual = new VehicleVisual(defaultConfiguration('buggy'), true);
    const chassis = new THREE.Group(); chassis.add(visual.group);
    chassis.position.set(5, 1, -2); chassis.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    const part = visual.parts[3] as unknown as { id: string; matrix: THREE.Matrix4 };
    visual.setFractureGroups([[], [], [], [part.id]]);
    const world = new THREE.Matrix4().compose(new THREE.Vector3(10, 0.5, 4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1), new THREE.Vector3(1, 1, 1));
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); world.decompose(p, q, s);
    visual.setDetached([{ part: 3, position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] }]);
    // Find the part's instance and compare its world matrix with W * actor * part.matrix.
    chassis.updateMatrixWorld(true);
    let drawn: THREE.Matrix4 | null = null;
    visual.group.traverse(o => { const mesh = o as THREE.InstancedMesh; const parts = mesh.userData?.parts as { id: string }[] | undefined;
      const index = parts?.findIndex(x => x.id === part.id) ?? -1; if (index >= 0) { const m = new THREE.Matrix4(); mesh.getMatrixAt(index, m); drawn = mesh.matrixWorld.clone().multiply(m); } });
    expect(drawn).not.toBeNull();
    const expected = world.clone().multiply(visual.group.matrix).multiply(part.matrix);
    drawn!.elements.forEach((v, i) => expect(v).toBeCloseTo(expected.elements[i], 5));
  });
});
