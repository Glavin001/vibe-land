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
  it('decodes one page of detached parts grouped by shared body pose', async () => {
    const { PKT_VEHICLE_RIG } = await import('../net/sharedConstants');
    const { decodeVehicleRig } = await import('./vehicleStream');
    // Two parts on one body: one pose, two part indices.
    const bytes = new Uint8Array(58 + 3 + 29 + 4), view = new DataView(bytes.buffer);
    bytes[0] = PKT_VEHICLE_RIG; view.setUint32(1, 77, true); bytes[5] = 3;
    bytes[58] = 1; bytes[59] = 2; bytes[60] = 1;
    [1, 2, 3, 0, 0, 0, 1].forEach((v, i) => view.setFloat32(61 + i * 4, v, true));
    bytes[89] = 2; view.setUint16(90, 12, true); view.setUint16(92, 40, true);
    const packet = decodeVehicleRig(bytes);
    expect(packet.page).toBe(1); expect(packet.pages).toBe(2);
    expect(packet.detached).toEqual([
      { part: 12, position: [1, 2, 3], rotation: [0, 0, 0, 1] },
      { part: 40, position: [1, 2, 3], rotation: [0, 0, 0, 1] },
    ]);
    expect(decodeVehicleRig(bytes.subarray(0, 58)).detached).toEqual([]);
    expect(() => decodeVehicleRig(bytes.subarray(0, 92))).toThrow();
  });
  // Broken-off parts are their own physics bodies: drawn at their world
  // pose, written only when a new rig changes that body, never re-derived from
  // the car's pose except where the batch draws in the car's frame (WebGL,
  // and then only when the car moved). They keep their instance in the car's
  // batch: no extra draw calls, never drawn twice.
  async function setup() {
    const THREE = await import('three');
    const { VehicleVisual } = await import('./VehicleVisual');
    const { defaultConfiguration } = await import('./configuration.mjs');
    const visual = new VehicleVisual(defaultConfiguration('buggy'), true);
    const world = new THREE.Group();
    const chassis = new THREE.Group(); chassis.add(visual.group);
    world.add(chassis);
    chassis.position.set(5, 1, -2); chassis.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    const parts = visual.parts as unknown as { id: string; matrix: THREE.Matrix4; motion: { role: string } | null }[];
    const plain = parts.find(p => !p.motion)!;
    const wheel = parts.find(p => p.motion?.role === 'wheel')!;
    visual.setFractureGroups([[], [], [], [plain.id], [wheel.id]]);
    const pose = (x: number, angle = 1.1) => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0.5, 4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle), new THREE.Vector3(1, 1, 1));
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m.decompose(p, q, s);
      return { matrix: m, position: [p.x, p.y, p.z] as [number, number, number], rotation: [q.x, q.y, q.z, q.w] as [number, number, number, number] };
    };
    const wheels = (spin: number) => [0, 1, 2, 3].map(() => ({ travelM: 0.05, steeringRad: 0.1, rotationRad: spin, grounded: true }));
    /** Where `id` is drawn in the world (the InstancedMesh path: its instance in the car's frame). */
    const drawnOf = (id: string) => {
      world.updateMatrixWorld(true);
      let drawn: THREE.Matrix4 | null = null;
      visual.group.traverse(o => {
        const mesh = o as THREE.InstancedMesh; const list = mesh.userData?.parts as { id: string }[] | undefined;
        const index = list?.findIndex(x => x.id === id) ?? -1;
        if (index < 0) return;
        const m = new THREE.Matrix4(); mesh.getMatrixAt(index, m);
        drawn = mesh.matrixWorld.clone().multiply(m);
      });
      return drawn as THREE.Matrix4 | null;
    };
    const versions = () => { const out: number[] = []; visual.group.traverse(o => { const m = o as THREE.InstancedMesh; if (m.instanceMatrix) out.push(m.instanceMatrix.version); }); return out; };
    const frame = () => { world.updateMatrixWorld(true); visual.syncLoose(); };
    return { THREE, visual, chassis, plain, wheel, pose, wheels, drawnOf, versions, frame };
  }
  const close = (a: { elements: number[] } | null, b: { elements: number[] }) => {
    expect(a).not.toBeNull(); a!.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], 5));
  };

  it('draws a broken-off part at its body pose, wherever the car goes, without new batches', async () => {
    const { THREE, visual, chassis, plain, pose, wheels, drawnOf, frame } = await setup();
    const batches = visual.group.children.length;
    const body = pose(10);
    visual.applyRig({ wheels: wheels(0), detached: [{ part: 3, position: body.position, rotation: body.rotation }] });
    frame();
    const expected = body.matrix.clone().multiply(visual.group.matrix).multiply(plain.matrix);
    close(drawnOf(plain.id), expected);
    expect(visual.group.children.length).toBe(batches);
    // The car drives off: the piece stays where its body is.
    chassis.position.set(40, 1, 30); chassis.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.4);
    frame();
    close(drawnOf(plain.id), expected);
    // The QA traces read the same pose (vehicleQaCore drawnFlicker).
    const traced = visual.drawnLooseParts(1)[0].position;
    const at = new THREE.Vector3().setFromMatrixPosition(expected);
    expect(traced[0]).toBeCloseTo(at.x, 5); expect(traced[1]).toBeCloseTo(at.y, 5); expect(traced[2]).toBeCloseTo(at.z, 5);
  });

  it('does no work for a rig it has applied, or for bodies and wheels that did not move', async () => {
    const { visual, pose, wheels, versions, frame } = await setup();
    const body = pose(10);
    const rig = { wheels: wheels(0), detached: [{ part: 3, position: body.position, rotation: body.rotation }] };
    visual.applyRig(rig); frame();
    const before = versions();
    visual.applyRig(rig); frame();
    visual.applyRig({ wheels: wheels(0), detached: [{ part: 3, position: [...body.position], rotation: [...body.rotation] }] }); frame();
    frame();
    expect(versions()).toEqual(before);
    // One body moves: its part is rewritten.
    const moved = pose(11);
    visual.applyRig({ wheels: wheels(0), detached: [{ part: 3, position: moved.position, rotation: moved.rotation }] }); frame();
    expect(versions()).not.toEqual(before);
  });

  it('keeps a broken-off wheel off the car when the suspension moves', async () => {
    const { visual, wheel, pose, wheels, drawnOf, frame } = await setup();
    const body = pose(3, 0.2);
    visual.applyRig({ wheels: wheels(0), detached: [{ part: 4, position: body.position, rotation: body.rotation }] }); frame();
    visual.applyRig({ wheels: wheels(1.5), detached: [{ part: 4, position: body.position, rotation: body.rotation }] }); frame();
    close(drawnOf(wheel.id), body.matrix.clone().multiply(visual.group.matrix).multiply(wheel.matrix));
  });

  it('puts every part back on the car when it respawns', async () => {
    const { visual, plain, pose, wheels, drawnOf, frame } = await setup();
    const body = pose(10);
    visual.applyRig({ wheels: wheels(0), detached: [{ part: 3, position: body.position, rotation: body.rotation }] }); frame();
    visual.applyRig({ wheels: wheels(0), detached: [] }); frame();
    expect(visual.drawnLooseParts(10)).toEqual([]);
    close(drawnOf(plain.id), visual.group.matrixWorld.clone().multiply(plain.matrix));
  });

  it('applies a rig that arrived before the fracture groups once they are known', async () => {
    const { VehicleVisual } = await import('./VehicleVisual');
    const { defaultConfiguration } = await import('./configuration.mjs');
    const visual = new VehicleVisual(defaultConfiguration('buggy'), true);
    const part = (visual.parts as unknown as { id: string; motion: unknown }[]).find(p => !p.motion)!;
    const rig = { wheels: [0, 1, 2, 3].map(() => ({ travelM: 0, steeringRad: 0, rotationRad: 0, grounded: true })), detached: [{ part: 0, position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] }] };
    visual.applyRig(rig);
    visual.setFractureGroups([[part.id]]);
    visual.applyRig(rig);
    expect(visual.drawnLooseParts(10).map(p => p.id)).toEqual([part.id]);
  });
});
