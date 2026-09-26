import { GrassPatchWorker } from './GrassPatchWorker';
import { FOLIAGE_SPECIES } from './foliageProfiles';
import * as THREE from 'three';
import { createGrassMaterial } from './grassMaterial';
import { GrassInteraction } from './GrassInteraction';
import { cityGrassPaint, GRASS_MAX_HEIGHT, type GrassPaint } from './GrassPaint';
import {
  generateGrassPatch, grassDensityAtDistance, grassPatchDistance,
  GRASS_PATCH_SIZE, GRASS_PROFILES, GRASS_WORLD_HALF_EXTENT,
  type GrassExclusion, type GrassQuality, type GrassPatchData,
} from './grassPlacement';

export interface GrassStats {
  patches: number;
  visiblePatches: number;
  blades: number;
  triangles: number;
  instanceBytes: number;
  pendingPatches: number;
}

/** Tapered strip: 7 / 3 / 1 triangles. One tip vertex, no alpha texture or overdraw quad. */
export function createBladeGeometry(segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row < segments; row++) {
    positions.push(-0.5, row / segments, 0, 0.5, row / segments, 0);
    if (row < segments - 1) {
      const i = row * 2;
      indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  positions.push(0, 1, 0);
  indices.push(segments * 2 - 2, segments * 2 - 1, segments * 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
  geometry.setIndex(indices);
  return geometry;
}

// Keep every LOD in one tiny buffer. Switching a patch only changes its draw
// range; no attribute swapping, uploads, orphaned buffers or additional draws.
function createPlantLods(species: number) {
  const positions: number[] = [], indices: number[] = [];
  const ranges: Array<{ start: number; count: number }> = [];
  for (const segments of [4, 2, 1]) {
    const start = indices.length;
    const parts = species >= 3 ? 7 : species > 0 ? 3 : 1;
    for (let partIndex = 0; partIndex < parts; partIndex++) {
      const part = createBladeGeometry(partIndex > 0 && species === 4 ? segments*6 : partIndex > 0 && species <= 2 ? Math.max(2, segments*2) : partIndex > 0 && species >= 3 && segments === 4 ? 6 : segments);
      const offset = positions.length / 3;
      const points = part.getAttribute('position').array;
      for (let i = 0; i < points.length; i+=3) positions.push(points[i] * (species === 4 && partIndex > 0 && (i/6)%2 === 1 ? 0.12 : 1), points[i+1], partIndex);
      indices.push(...Array.from(part.index!.array, i => i + offset));
      part.dispose();
    }
    ranges.push({ start, count: indices.length-start });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
  geometry.setIndex(indices);
  return { geometry, ranges };
}

type Part = { species: number; count: number; mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial> };
type Patch = {
  x: number; z: number; count: number; lod: number; bytes: number; height: number;
  mesh: THREE.Group; parts: Part[];
  bounds: THREE.Box3;
};
const disposePatch = (patch: Patch) => { for (const part of patch.parts) part.mesh.geometry.dispose(); };

/** A bounded, camera-local cache. No per-blade CPU work after a patch is built. */
export class GrassField {
  readonly group = new THREE.Group();
  readonly interaction = new GrassInteraction();
  readonly shading: ReturnType<typeof createGrassMaterial>;
  readonly stats: GrassStats = { patches: 0, visiblePatches: 0, blades: 0, triangles: 0, instanceBytes: 0, pendingPatches: 0 };
  private readonly generator = new GrassPatchWorker();
  private readonly patches = new Map<string, Patch>();
  private readonly templates = FOLIAGE_SPECIES.map((_, i) => createPlantLods(i));
  private readonly frustum = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();
  private readonly eye = new THREE.Vector3();
  private readonly candidateBounds = new THREE.Box3();
  private readonly candidates: Array<{ x: number; z: number; distance: number; visible: boolean }> = [];
  private cellX = Infinity;
  private cellZ = Infinity;
  private lastCandidates = -Infinity;
  private readonly dirtyPatches = new Set<string>();
  private readonly unsubscribePaint: () => void;

  constructor(readonly quality: GrassQuality, readonly exclusions: readonly GrassExclusion[] = [], readonly paint: GrassPaint = cityGrassPaint) {
    this.shading = createGrassMaterial(quality, this.interaction);
    this.group.name = 'City grass (client only)';
    this.group.userData.grassStats = this.stats;
    this.unsubscribePaint = paint.subscribe(bounds => {
      for (const [key, patch] of this.patches) {
        const x = patch.x*GRASS_PATCH_SIZE, z = patch.z*GRASS_PATCH_SIZE;
        if (x <= bounds.maxX+1 && x+GRASS_PATCH_SIZE >= bounds.minX-1 && z <= bounds.maxZ+1 && z+GRASS_PATCH_SIZE >= bounds.minZ-1) this.dirtyPatches.add(key);
      }
      this.lastCandidates = -Infinity;
    });
  }

  setShadows(enabled: boolean): void {
    for (const patch of this.patches.values()) for (const part of patch.parts) part.mesh.receiveShadow = enabled;
  }

  setWind(speed: number, degrees: number): void {
    const angle = degrees * Math.PI / 180;
    this.shading.uniforms.grassWind.value.set(Math.sin(angle), Math.cos(angle))
      .multiplyScalar(Math.max(0, Math.min(40, speed)));
  }

  private setBounds(box: THREE.Box3, x: number, z: number, height = GRASS_MAX_HEIGHT): THREE.Box3 {
    const reach = height * 1.6 + 0.1;
    box.min.set(x * GRASS_PATCH_SIZE - reach, 0, z * GRASS_PATCH_SIZE - reach);
    box.max.set((x + 1) * GRASS_PATCH_SIZE + reach, height + 0.05, (z + 1) * GRASS_PATCH_SIZE + reach);
    return box;
  }

  private build(x: number, z: number, time: number, data: GrassPatchData = generateGrassPatch(x, z, this.quality, this.exclusions, this.paint)): Patch {
    const key = `${x},${z}`, previous = this.patches.get(key);
    if (previous) {
      this.group.remove(previous.mesh); disposePatch(previous);
      this.stats.instanceBytes -= previous.bytes;
      this.dirtyPatches.delete(key);
    }
    const mesh = new THREE.Group();
    mesh.position.set(x * GRASS_PATCH_SIZE, 0, z * GRASS_PATCH_SIZE);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    const parts: Part[] = [];
    let bytes = 0;
    for (let species = 0; species < FOLIAGE_SPECIES.length; species++) {
      const members: number[] = [];
      for (let i = 0; i < data.count; i++) if (data.traits[i*4+3] === species) members.push(i);
      if (!members.length) continue;
      const whole = members.length === data.count;
      const roots = whole ? data.roots : new Float32Array(members.length*4), shapes = whole ? data.shapes : new Uint16Array(members.length*4);
      const colors = whole ? data.colors : new Uint8Array(members.length*3), traits = whole ? data.traits : new Uint8Array(members.length*4);
      for (let j = 0; !whole && j < members.length; j++) {
        const i = members[j];
        roots.set(data.roots.subarray(i*4, i*4+4), j*4);
        shapes.set(data.shapes.subarray(i*4, i*4+4), j*4);
        shapes[j*4+3] = Math.floor(j/members.length*65535);
        colors.set(data.colors.subarray(i*3, i*3+3), j*3);
        traits.set(data.traits.subarray(i*4, i*4+4), j*4);
      }
      const geometry = new THREE.InstancedBufferGeometry(), template = this.templates[species].geometry;
      geometry.setIndex(template.index);
      geometry.setAttribute('position', template.getAttribute('position'));
      geometry.setAttribute('normal', template.getAttribute('normal'));
      geometry.setAttribute('grassRoot', new THREE.InstancedBufferAttribute(roots, 4));
      geometry.setAttribute('grassShape', new THREE.InstancedBufferAttribute(shapes, 4, true));
      geometry.setAttribute('grassTint', new THREE.InstancedBufferAttribute(colors, 3, true));
      geometry.setAttribute('grassTraits', new THREE.InstancedBufferAttribute(traits, 4, true));
      geometry.setAttribute('grassBirth', new THREE.InstancedBufferAttribute(new Float32Array([previous ? time-1 : time]), 1, false, members.length));
      geometry.instanceCount = members.length;
      const plant = new THREE.Mesh(geometry, this.shading.material);
      plant.receiveShadow = true; plant.frustumCulled = false;
      plant.matrixAutoUpdate = false; plant.updateMatrix(); plant.raycast = () => {};
      mesh.add(plant); parts.push({ species, count: members.length, mesh: plant });
      bytes += roots.byteLength+shapes.byteLength+colors.byteLength+traits.byteLength+4;
    }
    const patch: Patch = { x, z, count: data.count, lod: -1, bytes, height: data.maxHeight,
      mesh, parts, bounds: this.setBounds(new THREE.Box3(), x, z, data.maxHeight) };
    this.setLod(patch, 0);
    this.group.add(mesh);
    this.patches.set(key, patch);
    this.stats.instanceBytes += bytes;
    return patch;
  }

  private setLod(patch: Patch, lod: number): void {
    if (lod === patch.lod) return;
    for (const part of patch.parts) {
      const range = this.templates[part.species].ranges[lod];
      part.mesh.geometry.setDrawRange(range.start, range.count);
    }
    patch.lod = lod;
  }

  /** Update once per rendered frame. at most two new patches, with a 2 ms CPU budget. */
  update(camera: THREE.Camera, time: number): void {
    const profile = GRASS_PROFILES[this.quality];
    camera.getWorldPosition(this.eye);
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    this.shading.uniforms.grassTime.value = time;
    this.shading.uniforms.grassContactBlend.value = this.interaction.blendAt(time);
    this.shading.uniforms.grassCanopyCount.value = this.interaction.canopyCount;
    this.shading.uniforms.grassImpulseCount.value = this.interaction.impulseCount;
    const { x, y, z } = this.eye;
    const cx = Math.floor(x / GRASS_PATCH_SIZE), cz = Math.floor(z / GRASS_PATCH_SIZE);
    if (cx !== this.cellX || cz !== this.cellZ || time - this.lastCandidates > 0.25) {
      this.cellX = cx; this.cellZ = cz; this.lastCandidates = time;
      this.candidates.length = 0;
      const radius = Math.ceil(profile.distance / GRASS_PATCH_SIZE);
      const limit = GRASS_WORLD_HALF_EXTENT / GRASS_PATCH_SIZE;
      for (let pz = Math.max(-limit, cz - radius); pz < Math.min(limit, cz + radius + 1); pz++) {
        for (let px = Math.max(-limit, cx - radius); px < Math.min(limit, cx + radius + 1); px++) {
          const distance = grassPatchDistance(x, y, z, px, pz);
          if (distance >= profile.distance || (this.patches.has(`${px},${pz}`) && !this.dirtyPatches.has(`${px},${pz}`))) continue;
          const visible = this.frustum.intersectsBox(this.setBounds(this.candidateBounds, px, pz));
          this.candidates.push({ x: px, z: pz, distance, visible });
        }
      }
      this.candidates.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
      for (const [key, patch] of this.patches) {
        if (grassPatchDistance(x, y, z, patch.x, patch.z) > profile.distance + GRASS_PATCH_SIZE) {
          this.group.remove(patch.mesh);
          disposePatch(patch);
          this.stats.instanceBytes -= patch.bytes;
          this.patches.delete(key);
          this.dirtyPatches.delete(key);
        }
      }
    }
    const result = this.generator.take();
    if (result) {
      if (result.revision === this.paint.revision && grassPatchDistance(x, y, z, result.x, result.z) < profile.distance) {
        this.build(result.x, result.z, time, result.data);
      }
      this.lastCandidates = -Infinity;
    }
    const started = performance.now();
    for (let built = 0; built < 2 && this.candidates.length && performance.now() - started < 2; built++) {
      if (this.generator.available && this.generator.busy) break;
      const next = this.candidates.shift()!;
      if (this.patches.has(`${next.x},${next.z}`) && !this.dirtyPatches.has(`${next.x},${next.z}`)) continue;
      if (this.generator.available) {
        this.generator.request({ ...next, revision: this.paint.revision, quality: this.quality,
          exclusions: this.exclusions.filter(b => b.maxX >= next.x*8 && b.minX <= next.x*8+8 && b.maxZ >= next.z*8 && b.minZ <= next.z*8+8),
          paint: this.paint.patchDocument(next.x, next.z) });
      } else this.build(next.x, next.z, time);
    }
    this.stats.pendingPatches = this.candidates.length + Number(this.generator.busy);
    this.stats.patches = this.patches.size;
    this.stats.visiblePatches = this.stats.blades = this.stats.triangles = 0;
    for (const patch of this.patches.values()) {
      const distance = grassPatchDistance(x, y, z, patch.x, patch.z);
      patch.mesh.visible = patch.count > 0 && distance < profile.distance && this.frustum.intersectsBox(patch.bounds);
      if (!patch.mesh.visible) continue;
      // Hysteresis stops segment topology oscillating at a boundary.
      let lod = distance > profile.middle ? 2 : distance > profile.near ? 1 : 0;
      if (patch.lod === 0 && distance < profile.near + 1) lod = 0;
      if (patch.lod === 1 && distance > profile.near - 1 && distance < profile.middle + 1) lod = 1;
      if (patch.lod === 2 && distance > profile.middle - 1) lod = 2;
      this.setLod(patch, lod);
      for (const part of patch.parts) {
        const density = Math.max(part.species >= 3 ? 0.65 : patch.height > 1.5 ? 0.32 : 0,
          grassDensityAtDistance(distance, this.quality));
        const count = Math.ceil(part.count * density);
        part.mesh.geometry.instanceCount = count;
        this.stats.visiblePatches++;
        this.stats.blades += count;
        this.stats.triangles += count * (this.templates[part.species].ranges[lod].count / 3);
      }
    }
  }

  dispose(): void {
    this.unsubscribePaint();
    this.generator.dispose();
    this.interaction.dispose();
    for (const patch of this.patches.values()) disposePatch(patch);
    this.patches.clear();
    this.group.clear();
    for (const template of this.templates) template.geometry.dispose();
    this.shading.material.dispose();
  }
}
