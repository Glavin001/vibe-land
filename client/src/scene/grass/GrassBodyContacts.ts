import { Quaternion, Vector3 } from 'three';
import type { CityManifest } from '../../city/manifest';
import type { CityTopology, LedgerBody } from '../../city/topology';
import type { GameRuntimeClient } from '../../runtime/gameRuntime';
import { getSharedVehicleDefinition } from '../../wasm/sharedVehicleDefinitions';
import { FLAG_DEAD, FLAG_IN_VEHICLE } from '../../net/protocol';
import { GrassInteraction, type GrassContact } from './GrassInteraction';
import { cityGrassPaint, type GrassPaint } from './GrassPaint';

/** Grounded vehicles push tall canopy across their width; short lawns retain tyre tracks. */
export function grassVehicleCanopyContact(paint: GrassPaint, x: number, z: number,
  radiusX: number, radiusZ: number, yaw: number): GrassContact | null {
  // Include the leading/side edges so the hood does not wait for its centre to
  // enter a tall stand before parting it.
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const height = Math.max(paint.heightAt(x,z), paint.heightAt(x+c*radiusX,z-s*radiusX),
    paint.heightAt(x-c*radiusX,z+s*radiusX), paint.heightAt(x+s*radiusZ,z+c*radiusZ),
    paint.heightAt(x-s*radiusZ,z-c*radiusZ));
  if (height < 1.5) return null;
  return { x, z, radiusX: radiusX+0.2, radiusZ: radiusZ+0.2, yaw, shape: 'box', pressure: 0.95, hold: 6, damage: 0.65 };
}

/** Optional presentation metadata; grass does not depend on the garage protocol. */
type GrassVehicleContactMetadata = {
  customVehicle?: { configuration: { dimensions: { tireRadius: number; track: number; wheelbase: number } } };
  customRig?: { wheels: readonly { grounded: boolean }[] };
};

export type GrassActorSource = Pick<GameRuntimeClient, 'vehicles' | 'dynamicBodies' | 'remotePlayers'
  | 'interpolator' | 'getRenderTimeUs' | 'getDynamicBodyRenderTimeUs' | 'sampleRemoteVehicle' | 'sampleRemoteDynamicBody'>
  & Partial<Pick<GameRuntimeClient, 'getDrivenVehicleId' | 'getVehiclePose' | 'getRenderedDynamicBodyState' | 'usesLocalAuthority'>>;

/** Reads existing presented poses. Never steps physics or drains destruction events. */
export class GrassBodyContacts {
  private readonly falling = new Map<string, { bottom: number; time: number }>();
  private readonly previous = new Map<string, { x: number; z: number; time: number }>();
  private readonly pose = new Float32Array(7);
  private readonly rotation = new Quaternion();
  private readonly point = new Vector3();
  private readonly chunkSizes: Float32Array;
  private bodies: IterableIterator<LedgerBody>;
  private current: LedgerBody | null = null;
  private chunk = 0;

  constructor(private readonly city: { manifest: { manifest: CityManifest }; topology: CityTopology },
    private readonly paint: GrassPaint = cityGrassPaint) {
    this.bodies = city.topology.allBodies();
    this.chunkSizes = Float32Array.from(city.manifest.manifest.structures.flatMap(s => s.chunks.flatMap(c => c.size)));
  }

  private track(field: GrassInteraction, key: string, contact: GrassContact, time: number): void {
    const previous = this.previous.get(key);
    if (previous && time-previous.time < 0.25) { contact.fromX = previous.x; contact.fromZ = previous.z; }
    field.stamp(contact);
    if (previous) { previous.x = contact.x; previous.z = contact.z; previous.time = time; }
    else if (this.previous.size < 512) this.previous.set(key, { x: contact.x, z: contact.z, time });
  }

  update(field: GrassInteraction, time: number, cameraX: number, cameraZ: number,
    source: GrassActorSource | null, localPlayer?: readonly number[] | null): void {
    for (const [key, value] of this.falling) if (time-value.time > 2) this.falling.delete(key);
    if (localPlayer) field.canopy(localPlayer[0], localPlayer[1]+0.2, localPlayer[2], 0.65);
    for (const [key, value] of this.previous) if (time-value.time > 1) this.previous.delete(key);
    if (localPlayer && localPlayer[1] < 2.2 && localPlayer[1] > -1) {
      this.track(field, 'local', { x: localPlayer[0], z: localPlayer[2], radiusX: 0.55, radiusZ: 0.55, pressure: 0.8, hold: 0.25 }, time);
    }
    if (source) {
      const renderTime = source.getRenderTimeUs();
      let actors = 0;
      for (const player of source.remotePlayers.values()) {
        if (++actors > 64) break;
        if (player.flags & (FLAG_DEAD | FLAG_IN_VEHICLE)) continue;
        const p = source.interpolator.sample(player.id, renderTime)?.position ?? player.position;
        if (p[1] > 2.2 || p[1] < -1 || Math.abs(p[0]-cameraX) > 40 || Math.abs(p[2]-cameraZ) > 40) continue;
        field.canopy(p[0], p[1]+0.2, p[2], 0.65);
        this.track(field, `p${player.id}`, { x: p[0], z: p[2], radiusX: 0.55, radiusZ: 0.55, pressure: 0.8, hold: 0.25 }, time);
      }
      actors = 0;
      const drivenId = source.getDrivenVehicleId?.();
      for (const vehicle of source.vehicles.values()) {
        if (++actors > 24) break;
        // The driver's car uses the prediction/short-delay presentation, not
        // the older remote-player timeline (which would leave tracks behind it).
        const driven = drivenId === vehicle.id && !source.usesLocalAuthority ? source.getVehiclePose?.() : null;
        const sample = driven ?? source.sampleRemoteVehicle(vehicle.id, renderTime) ?? vehicle;
        const p = sample.position;
        if (Math.abs(p[0]-cameraX) > 40 || Math.abs(p[2]-cameraZ) > 40) continue;
        this.rotation.fromArray(sample.quaternion);
        const definition = getSharedVehicleDefinition(vehicle.vehicleType);
        const metadata = vehicle as typeof vehicle & GrassVehicleContactMetadata;
        const custom = metadata.customVehicle?.configuration.dimensions;
        const radius = custom?.tireRadius ?? definition.wheelRadiusM;
        const yaw = Math.atan2(2*(this.rotation.w*this.rotation.y+this.rotation.x*this.rotation.z), 1-2*(this.rotation.y**2+this.rotation.z**2));
        let grounded = false;
        for (let wheel = 0; wheel < 4; wheel++) {
          if (metadata.customRig && !metadata.customRig.wheels[wheel]?.grounded) continue;
          if (custom) this.point.set(wheel%2 ? custom.track/2 : -custom.track/2, -0.25, wheel<2 ? custom.wheelbase/2 : -custom.wheelbase/2);
          else { this.point.fromArray(definition.wheelOffsets[wheel]); this.point.y -= definition.suspensionRestLengthM; }
          this.point.applyQuaternion(this.rotation);
          const bottom = p[1]+this.point.y-radius;
          if (bottom > 0.55 || bottom < -1) continue;
          grounded = true;
          this.track(field, `v${vehicle.id}w${wheel}`, { x: p[0]+this.point.x, z: p[2]+this.point.z,
            radiusX: 0.34, radiusZ: Math.max(0.45, radius), yaw, pressure: 1, hold: 1.6, damage: 0.8 }, time);
        }
        if (grounded) {
          field.canopy(p[0],p[1],p[2], custom ? custom.track/2 : definition.chassisHalfExtents.x);
          const canopy = grassVehicleCanopyContact(this.paint, p[0], p[2],
            custom ? custom.track/2 : definition.chassisHalfExtents.x,
            custom ? custom.wheelbase/2+radius : definition.chassisHalfExtents.z, yaw);
          if (canopy) this.track(field, `v${vehicle.id}canopy`, canopy, time);
        }
      }
      actors = 0;
      const bodyTime = source.getDynamicBodyRenderTimeUs();
      for (const body of source.dynamicBodies.values()) {
        if (++actors > 96) break;
        const sample = source.getRenderedDynamicBodyState?.(body.id) ?? source.sampleRemoteDynamicBody(body.id, bodyTime) ?? body;
        this.stampBox(field, sample.position, sample.quaternion, sample.halfExtents, time, `d${body.id}`, 0.8);
      }
    }
    // Resume a bounded scan instead of touching every shard every render frame.
    // Settled bodies are included: stones keep holding grass down after sleeping.
    let bodiesVisited = 0;
    for (let slots = 0; slots < 512 && bodiesVisited < 1024 && field.hasBudget;) {
      if (!this.current || this.chunk >= this.current.chunkSlots.length) {
        const next = this.bodies.next(); bodiesVisited++;
        if (next.done) { this.bodies = this.city.topology.allBodies(); this.current = null; break; }
        this.current = next.value; this.chunk = 0;
        if (this.current.islandSerial === 0 || Math.abs(this.current.position[0]-cameraX) > 64 || Math.abs(this.current.position[2]-cameraZ) > 64) {
          this.current = null; continue;
        }
      }
      const slot = this.current.chunkSlots[this.chunk++]; slots++;
      if (!this.city.topology.body(this.current.key)) { this.current = null; continue; }
      if (!this.city.topology.chunkWorldPoseInto(slot, this.current, this.pose, 0)) continue;
      const at = slot*3;
      this.stampBox(field, this.pose, this.pose.subarray(3),
        [this.chunkSizes[at]*0.5, this.chunkSizes[at+1]*0.5, this.chunkSizes[at+2]*0.5], time, `s${slot}`, 4);
    }
  }

  private stampBox(field: GrassInteraction, p: ArrayLike<number>, q: ArrayLike<number>, half: ArrayLike<number>,
    time: number, key: string | null, hold: number): void {
    // Rotated AABB projected onto the ground is deliberately conservative.
    const [x,y,z,w] = [q[0],q[1],q[2],q[3]];
    const hx = Math.abs(1-2*(y*y+z*z))*half[0]+Math.abs(2*(x*y-z*w))*half[1]+Math.abs(2*(x*z+y*w))*half[2];
    const hy = Math.abs(2*(x*y+z*w))*half[0]+Math.abs(1-2*(x*x+z*z))*half[1]+Math.abs(2*(y*z-x*w))*half[2];
    const hz = Math.abs(2*(x*z-y*w))*half[0]+Math.abs(2*(y*z+x*w))*half[1]+Math.abs(1-2*(x*x+y*y))*half[2];
    const bottom = p[1]-hy;
    field.canopy(p[0], Math.max(0,p[1]), p[2], Math.max(hx,hz));
    if (key) {
      const last = this.falling.get(key);
      if (last && bottom < 0.75 && last.bottom >= 0.75 && time > last.time && time-last.time < 0.5) {
        const speed = (last.bottom-bottom)/(time-last.time);
        if (speed > 2) field.impulse(p[0],p[2],time,Math.min(1,speed/12)*Math.min(1,Math.sqrt(hx*hz)));
      }
      if (last) { last.bottom = bottom; last.time = time; }
      else if (this.falling.size < 512) this.falling.set(key, { bottom, time });
    }
    if (bottom > 0.75 || p[1]+hy < -0.05) return;
    const contact: GrassContact = { x:p[0], z:p[2], radiusX:hx+0.65, radiusZ:hz+0.65, shape:'box',
      pressure: Math.min(1, Math.max(0, (0.85-bottom)/0.7)), hold };
    if (key) this.track(field, key, contact, time); else field.stamp(contact);
  }
}
