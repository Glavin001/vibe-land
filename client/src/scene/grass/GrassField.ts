import * as THREE from 'three';
import { createGrassMaterial } from './grassMaterial';
import { GrassInteraction } from './GrassInteraction';
import { cityGrassPaint, GRASS_MAX_HEIGHT, type GrassPaint } from './GrassPaint';
import {
  generateGrassPatch, grassDensityAtDistance, grassPatchDistance,
  GRASS_PATCH_SIZE, GRASS_PROFILES, GRASS_WORLD_HALF_EXTENT,
  type GrassExclusion, type GrassQuality,
} from './grassPlacement';

export interface GrassStats {
  patches: number;
  visiblePatches: number;
  blades: number;
  triangles: number;
  instanceBytes: number;
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
const LOD_RANGES = [{ start: 0, count: 21 }, { start: 21, count: 9 }, { start: 30, count: 3 }];
function createBladeLods(): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = [];
  for (const segments of [4, 2, 1]) {
    const part = createBladeGeometry(segments);
    const offset = positions.length / 3;
    positions.push(...part.getAttribute('position').array);
    indices.push(...Array.from(part.index!.array, i => i + offset));
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
  geometry.setIndex(indices);
  return geometry;
}

type Patch = {
  x: number; z: number; count: number; lod: number; bytes: number;
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  bounds: THREE.Box3;
};

/** A bounded, camera-local cache. No per-blade CPU work after a patch is built. */
export class GrassField {
  readonly group = new THREE.Group();
  readonly interaction = new GrassInteraction();
  readonly shading: ReturnType<typeof createGrassMaterial>;
  readonly stats: GrassStats = { patches: 0, visiblePatches: 0, blades: 0, triangles: 0, instanceBytes: 0 };
  private readonly patches = new Map<string, Patch>();
  private readonly template = createBladeLods();
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

  setWind(speed: number, degrees: number): void {
    const angle = degrees * Math.PI / 180;
    this.shading.uniforms.grassWind.value.set(Math.sin(angle), Math.cos(angle))
      .multiplyScalar(Math.max(0, Math.min(40, speed)));
  }

  private setBounds(box: THREE.Box3, x: number, z: number, height = GRASS_MAX_HEIGHT): THREE.Box3 {
    const reach = height * 3.5 + 0.1;
    box.min.set(x * GRASS_PATCH_SIZE - reach, 0, z * GRASS_PATCH_SIZE - reach);
    box.max.set((x + 1) * GRASS_PATCH_SIZE + reach, height + 0.05, (z + 1) * GRASS_PATCH_SIZE + reach);
    return box;
  }

  private build(x: number, z: number, time: number): Patch {
    const data = generateGrassPatch(x, z, this.quality, this.exclusions, this.paint);
    const key = `${x},${z}`, previous = this.patches.get(key);
    if (previous) {
      this.group.remove(previous.mesh); previous.mesh.geometry.dispose();
      this.stats.instanceBytes -= previous.bytes;
      this.dirtyPatches.delete(key);
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(this.template.index);
    geometry.setAttribute('position', this.template.getAttribute('position'));
    geometry.setAttribute('normal', this.template.getAttribute('normal'));
    geometry.setAttribute('grassRoot', new THREE.InstancedBufferAttribute(data.roots, 4));
    geometry.setAttribute('grassShape', new THREE.InstancedBufferAttribute(data.shapes, 4, true));
    geometry.setAttribute('grassTint', new THREE.InstancedBufferAttribute(data.colors, 3, true));
    geometry.setAttribute('grassBirth', new THREE.InstancedBufferAttribute(new Float32Array([previous ? time-1 : time]), 1, false, Math.max(1, data.count)));
    geometry.instanceCount = data.count;
    const mesh = new THREE.Mesh(geometry, this.shading.material);
    mesh.position.set(x * GRASS_PATCH_SIZE, 0, z * GRASS_PATCH_SIZE);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    // The field performs one conservative frustum check with wind-expanded world bounds.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.raycast = () => {}; // Decorative grass must not intercept aiming/selection.
    const bytes = data.roots.byteLength + data.shapes.byteLength + data.colors.byteLength + 4;
    const patch: Patch = { x, z, count: data.count, lod: -1, bytes, mesh, bounds: this.setBounds(new THREE.Box3(), x, z, data.maxHeight) };
    this.setLod(patch, 0);
    this.group.add(mesh);
    this.patches.set(key, patch);
    this.stats.instanceBytes += bytes;
    return patch;
  }

  private setLod(patch: Patch, lod: number): void {
    if (lod === patch.lod) return;
    const range = LOD_RANGES[lod];
    patch.mesh.geometry.setDrawRange(range.start, range.count);
    patch.lod = lod;
  }

  /** Update once per rendered frame. at most two new patches, with a 2 ms CPU budget. */
  update(camera: THREE.Camera, time: number): void {
    const profile = GRASS_PROFILES[this.quality];
    camera.getWorldPosition(this.eye);
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    this.shading.uniforms.grassTime.value = time;
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
          patch.mesh.geometry.dispose();
          this.stats.instanceBytes -= patch.bytes;
          this.patches.delete(key);
          this.dirtyPatches.delete(key);
        }
      }
    }
    const started = performance.now();
    for (let built = 0; built < 2 && this.candidates.length && performance.now() - started < 2; built++) {
      const next = this.candidates.shift()!;
      this.build(next.x, next.z, time);
    }
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
      const count = Math.ceil(patch.count * grassDensityAtDistance(distance, this.quality));
      patch.mesh.geometry.instanceCount = count;
      this.stats.visiblePatches++;
      this.stats.blades += count;
      this.stats.triangles += count * (LOD_RANGES[lod].count / 3);
    }
  }

  dispose(): void {
    this.unsubscribePaint();
    this.interaction.dispose();
    for (const patch of this.patches.values()) patch.mesh.geometry.dispose();
    this.patches.clear();
    this.group.clear();
    this.template.dispose();
    this.shading.material.dispose();
  }
}
