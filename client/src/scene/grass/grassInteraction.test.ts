import { describe, expect, it } from 'vitest';
import type { CityManifest } from '../../city/manifest';
import { bodyKey, CityTopology } from '../../city/topology';
import { GrassBodyContacts, type GrassActorSource } from './GrassBodyContacts';
import { GrassInteraction } from './GrassInteraction';
import { GrassPaint, GRASS_BRUSHES } from './GrassPaint';

describe('grass contact field', () => {
  it('interpolates committed contacts without reintroducing stale history after scrolling or clearing', () => {
    const field = new GrassInteraction(); field.begin(0,0,0);
    field.stamp({ x: 0.25, z: 0.25, radiusX: 1, radiusZ: 1 }); field.commit();
    expect(field.blendAt(0.025)).toBeCloseTo(0.5);
    expect(field.blendAt(0.1)).toBe(1);
    field.begin(0.2,80,80); field.commit();
    expect(field.previousTexture.image.data).toEqual(field.texture.image.data);
    field.clear(); expect(field.previousTexture.image.data).toEqual(field.texture.image.data);
    field.begin(0.3,80,80); field.commit();
    expect(field.blendAt(0.3)).toBe(1);
    field.dispose();
  });

  it('bounds canopy contacts and expires impact gusts', () => {
    const field = new GrassInteraction(); field.begin(0,0,0);
    field.canopy(8,2,0,1); field.canopy(12,2,0,1); field.canopy(1,2,0,1);
    expect(field.canopyCount).toBe(2);
    expect([field.canopies[0],field.canopies[4]].sort((a,b)=>a-b)).toEqual([1,8]);
    for (let i=0;i<100;i++) field.impulse(0,0,i*0.001,0.8);
    expect(field.impulseCount).toBe(2);
    field.begin(2,0,0);
    expect(field.impulseCount).toBe(0); expect(field.canopyCount).toBe(0);
    field.dispose();
  });

  it('combs moving contacts along travel and retains a bounded, slowly recovering crease', () => {
    const field = new GrassInteraction();
    field.begin(0, 0, 0);
    field.stamp({ x: 2.25, z: 0.25, fromX: -2.25, fromZ: 0.25,
      radiusX: 1, radiusZ: 1, damage: 0.8 });
    field.commit();
    const index = (64*128+64)*4;
    expect(field.data[index+1]).toBeGreaterThan(220); // +X, including both sides of the track.
    expect(field.data[index+3]).toBeGreaterThan(150);
    field.begin(30, 0, 0); field.commit();
    expect(field.sample(0.25, 0.25)).toBe(0); // Elastic pressure has recovered.
    expect(field.data[index+3]).toBeGreaterThan(100); // Crease remains.
    field.begin(31, 100, 100);
    expect(field.historyBytes).toBeGreaterThan(0);
    field.begin(32, 0, 0); field.commit();
    expect(field.data[index+3]).toBeGreaterThan(100);
    const untouched = (70*128+70)*4;
    expect(field.data[untouched+1]).toBe(128);
    expect(field.data[untouched+2]).toBe(128);
    field.begin(2000,0,0); field.commit();
    expect(field.data[index+1]).toBe(128); expect(field.data[index+2]).toBe(128);
    for (let i = 0; i < 280; i++) {
      field.begin(2001+i, i*64, 0);
      field.stamp({ x: i*64+0.25, z: 0.25, radiusX: 1, radiusZ: 1, damage: 1 });
    }
    expect(field.historyBytes).toBeLessThanOrEqual(256*1024);
    field.clear(); field.begin(2500, 0, 0); field.commit();
    expect(field.data[index+3]).toBe(0);
    field.dispose();
  });

  it('covers the corners of a rotated box without exceeding the work budget', () => {
    const field = new GrassInteraction();
    field.begin(0, 0, 0);
    field.stamp({ x: 0, z: 0, radiusX: 4, radiusZ: 4, yaw: Math.PI/4, shape: 'box' });
    expect(field.sample(0.25, 4.75)).toBeGreaterThan(0.5);
    field.dispose();
  });

  it('sweeps tyre tracks, holds them briefly, and recovers after departure', () => {
    const field = new GrassInteraction();
    field.begin(0, 0, 0);
    field.stamp({ x: 5, z: 0.25, fromX: -5, fromZ: 0.25, radiusX: 0.7, radiusZ: 0.7, hold: 1 });
    field.commit();
    for (let x = -5; x <= 5; x += 0.5) expect(field.sample(x, 0.25)).toBeGreaterThan(0.65);
    const initial = field.sample(0, 0.25);
    field.begin(0.5, 0, 0);
    expect(field.sample(0, 0.25)).toBe(initial);
    field.begin(4, 0, 0);
    expect(field.sample(0, 0.25)).toBeLessThan(initial * 0.25);
    field.begin(20, 0, 0); field.commit();
    expect(field.activeCells).toBe(0);
    field.dispose();
  });

  it('retains world positions while scrolling in either direction, and clears after a teleport', () => {
    const field = new GrassInteraction();
    field.begin(0, 0, 0);
    field.stamp({ x: 2.25, z: -3.75, radiusX: 1, radiusZ: 1, hold: 8 });
    const initial = field.sample(2.25, -3.75);
    field.begin(0.1, 8, -8);
    expect(field.sample(2.25, -3.75)).toBe(initial);
    expect(field.sample(10.25, -11.75)).toBe(0);
    field.begin(0.2, -8, 8);
    expect(field.sample(2.25, -3.75)).toBe(initial);
    field.begin(0.3, 100, 100); field.commit();
    expect(field.activeCells).toBe(0);
    field.dispose();
  });

  it('does not stamp teleport paths or let offscreen and invalid contacts exhaust the budget', () => {
    const field = new GrassInteraction();
    field.begin(0, 0, 0);
    for (let i = 0; i < 500; i++) {
      expect(field.stamp({ x: 200, z: 200, radiusX: 1, radiusZ: 1 })).toBe(false);
      expect(field.stamp({ x: 0, z: 0, radiusX: 1, radiusZ: 1, yaw: NaN })).toBe(false);
    }
    expect(field.hasBudget).toBe(true);
    field.stamp({ x: 15.25, z: 0.25, fromX: -15, fromZ: 0.25, radiusX: 1, radiusZ: 1 });
    expect(field.sample(0, 0.25)).toBe(0);
    expect(field.sample(15.25, 0.25)).toBe(1);
    for (let i = 0; i < 500; i++) field.stamp({ x: 0, z: 0, radiusX: 8, radiusZ: 8 });
    expect(field.hasBudget).toBe(false);
    field.begin(0.06, 0, 0);
    expect(field.hasBudget).toBe(true);
    field.dispose();
  });

  it('refreshes resting pressure instead of recovering underneath a stationary object', () => {
    const field = new GrassInteraction();
    for (let time = 0; time < 12; time += 0.1) {
      field.begin(time, 0, 0);
      field.stamp({ x: 0.25, z: 0.25, radiusX: 2, radiusZ: 1, hold: 0.2 });
    }
    expect(field.sample(0.25, 0.25)).toBe(1);
    field.begin(20, 0, 0);
    expect(field.sample(0.25, 0.25)).toBeLessThan(0.02);
    field.clear();
    expect(field.activeCells).toBe(0);
    field.dispose();
  });
});

describe('city destruction contacts', () => {
  it('sweeps a broad lane through tall grass, keeps it held under parked cars, and recovers', () => {
    const manifest: CityManifest = { version: 1, structures: [] };
    const paint = new GrassPaint();
    paint.paint(0, 0, 18, GRASS_BRUSHES.vehicle);
    const contacts = new GrassBodyContacts({ manifest: { manifest }, topology: new CityTopology(manifest) }, paint);
    const field = new GrassInteraction();
    let x = -2, y = 0.65;
    const source = {
      remotePlayers: new Map(), dynamicBodies: new Map(),
      vehicles: new Map([[2, { id: 2, vehicleType: 0 }]]),
      sampleRemoteVehicle: () => ({ position: [x, y, 0.25], quaternion: [0, 0, 0, 1] }),
      getRenderTimeUs: () => 0, getDynamicBodyRenderTimeUs: () => 0,
    } as unknown as GrassActorSource;
    const update = (t: number) => { field.begin(t, 0, 0); contacts.update(field, t, 0, 0, source); };
    update(0); x = 2; update(0.1);
    expect(field.sample(0.25, 0.25)).toBeGreaterThan(0.9); // Between tyres and between frames.
    for (let t = 1; t <= 12; t++) update(t);
    expect(field.sample(2.25, 0.25)).toBeGreaterThan(0.9);
    const vehicle = source.vehicles.get(2)!;
    source.vehicles.clear(); field.begin(17, 0, 0);
    expect(field.sample(2.25, 0.25)).toBeGreaterThan(0.9);
    field.begin(30, 0, 0);
    expect(field.sample(2.25, 0.25)).toBeLessThan(0.01);
    field.clear(); source.vehicles.set(2, vehicle); y = 5;
    update(31);
    expect(field.sample(2.25, 0.25)).toBe(0);
    field.dispose(); paint.dispose();
  });

  it('follows presented player, wheel and object positions while rejecting airborne contacts', () => {
    const manifest: CityManifest = { version: 1, structures: [] };
    const contacts = new GrassBodyContacts({ manifest: { manifest }, topology: new CityTopology(manifest) });
    const field = new GrassInteraction();
    // Network snapshots deliberately differ from the rendered/interpolated poses.
    const source = {
      remotePlayers: new Map([[1, { id: 1, flags: 0, position: [100, 100, 100] }]]),
      interpolator: { sample: () => ({ position: [-5.75, 1, 0.25] }) },
      vehicles: new Map([[2, { id: 2, vehicleType: 0, position: [100, 100, 100] }]]),
      sampleRemoteVehicle: () => ({ position: [8.15, 0.65, 1.15], quaternion: [0, 0, 0, 1] }),
      dynamicBodies: new Map([[3, { id: 3 }]]),
      sampleRemoteDynamicBody: () => ({ position: [0.25, 0.5, 6.25], quaternion: [0, 0, 0, 1], halfExtents: [1, 0.5, 1] }),
      getRenderTimeUs: () => 1000, getDynamicBodyRenderTimeUs: () => 1000,
    } as unknown as GrassActorSource;
    field.begin(0, 0, 0);
    contacts.update(field, 0, 0, 0, source, [0.25, 1, 0.25]);
    expect(field.sample(0.25, 0.25)).toBeCloseTo(0.8);
    expect(field.sample(-5.75, 0.25)).toBeCloseTo(0.8);
    expect(field.sample(7.25, 2.25)).toBeGreaterThan(0.9);
    expect(field.sample(8.15, 1.15)).toBe(0); // Two tyre tracks, not a solid car-sized stamp.
    expect(field.sample(0.25, 6.25)).toBe(1);
    field.clear();
    source.getDrivenVehicleId = () => 2;
    source.getVehiclePose = () => ({ position: [12.15, 0.65, 1.15], quaternion: [0, 0, 0, 1] });
    field.begin(0.06, 0, 0); contacts.update(field, 0.06, 0, 0, source);
    expect(field.sample(13.05, 2.25)).toBeGreaterThan(0.5);
    field.clear(); source.getDrivenVehicleId = () => null;
    source.sampleRemoteVehicle = () => ({ position: [8.15, 5, 1.15], quaternion: [0, 0, 0, 1] }) as ReturnType<GrassActorSource['sampleRemoteVehicle']>;
    source.remotePlayers.clear(); source.dynamicBodies.clear();
    field.begin(0.1, 0, 0); contacts.update(field, 0.1, 0, 0, source, [0.25, 5, 0.25]); field.commit();
    expect(field.activeCells).toBe(0);
    field.dispose();
  });

  it('uses promoted chunk poses, ignores airborne chunks, and includes sleeping rubble', () => {
    const manifest: CityManifest = { version: 1, structures: [{
      structureId: 0, worldPosition: [0, 0, 0], worldRotation: [0, 0, 0, 1],
      chunks: [{ nodeIndex: 0, centroid: [0, 5, 0], size: [4, 1, 2], radius: 3,
        mass: 10, volume: 8, support: false, geometry: { kind: 'cuboid', halfExtents: [2, 0.5, 1] } }],
    }] };
    const topology = new CityTopology(manifest);
    const contacts = new GrassBodyContacts({ manifest: { manifest }, topology });
    const field = new GrassInteraction();
    const update = (time: number) => { field.begin(time, 0, 0); contacts.update(field, time, 0, 0, null); field.commit(); };
    update(0);
    expect(field.activeCells).toBe(0);
    topology.apply({ topoSeq: 1, simTick: 1, batches: [{ structureId: 0, brokenBondIndices: [],
      promotions: [{ structureId: 0, islandId: 1, nodes: [0], position: [0, 5, 0], rotation: [0, 0, 0, 1], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] }],
      retiredIslandIds: [], migrations: [] }], settled: [], wakes: [] });
    update(0.1);
    expect(field.activeCells).toBe(0);
    const key = bodyKey(0, 1);
    topology.updateBodyPose(key, [4, 0.5, 2], [0, 0, 0, 1]);
    topology.body(key)!.settled = true;
    for (let t = 0.2; t < 10; t += 0.1) update(t);
    expect(field.sample(4, 2)).toBeGreaterThan(0.95);
    expect(field.sample(5.75, 2.75)).toBeGreaterThan(0.95); // Slab corners are covered too.
    expect(field.sample(0, 0)).toBe(0);
    topology.updateBodyPose(key, [4, 10, 2], [0, 0, 0, 1]);
    for (let t = 10; t < 25; t += 0.1) update(t);
    expect(field.sample(4, 2)).toBe(0);
    field.dispose();
  });
});
