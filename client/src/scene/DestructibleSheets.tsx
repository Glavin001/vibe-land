import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CarveEventPacket } from '../net/protocol';
import { initSharedPhysics } from '../wasm/sharedPhysics';
import { isSheetMaterial, type SheetMaterialId } from '../world/destructibleDemoHuts';
import { serializeWorldDocument, type WorldDocument } from '../world/worldDocument';

type WasmSheetRegistry = {
  sheetIds(): Uint32Array | number[];
  materialName(sheetId: number): string | undefined;
  applyCarve(
    sheetId: number,
    seq: number,
    uvU: number,
    uvV: number,
    dirU: number,
    dirV: number,
    normalSpeedCms: number,
    massOrEnergyGrams: number,
    footprintRadiusMm: number,
    seed: number,
  ): number;
  takeLastDebrisSpawns?(): Float32Array | number[];
  meshPositions(sheetId: number): Float32Array | number[];
  meshColors(sheetId: number): Float32Array | number[];
  meshIndices(sheetId: number): Uint32Array | number[];
  carvedCellCount(sheetId: number): number;
};

type DestructibleSheetsProps = {
  world: WorldDocument;
  carveEvents: CarveEventPacket[];
  /** Multiplayer-only: spawn pure-visual falling cutouts (practice uses physics debris). */
  spawnVisualDebris?: boolean;
};

type VisualDebris = {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  age: number;
};

const MATERIAL_COLORS: Record<SheetMaterialId, number> = {
  drywall: 0xd8d0c0,
  wood: 0x8b5a2b,
  plaster: 0xcfc6b8,
};

const VISUAL_STRIDE = 13;
const VISUAL_TTL_SEC = 3.5;
const GRAVITY = -9.5;

function toFloat32(data: Float32Array | number[]): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data);
}

function toUint32(data: Uint32Array | number[]): Uint32Array {
  return data instanceof Uint32Array ? data : new Uint32Array(data);
}

function uploadSheetGeometry(mesh: THREE.Mesh, registry: WasmSheetRegistry, sheetId: number) {
  const positions = toFloat32(registry.meshPositions(sheetId));
  const colors = toFloat32(registry.meshColors(sheetId));
  const indices = toUint32(registry.meshIndices(sheetId));

  const geometry = mesh.geometry as THREE.BufferGeometry;
  geometry.dispose();
  const next = new THREE.BufferGeometry();
  next.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors.length === positions.length) {
    next.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  next.setIndex(new THREE.BufferAttribute(indices, 1));
  // Flat shading from non-indexed unique verts — skip expensive smooth normals.
  next.computeVertexNormals();
  mesh.geometry = next;
  mesh.visible = positions.length > 0;
}

function spawnVisualFromPacked(group: THREE.Group, packed: Float32Array, into: VisualDebris[]) {
  for (let i = 0; i + VISUAL_STRIDE <= packed.length; i += VISUAL_STRIDE) {
    const hx = packed[i];
    const hy = packed[i + 1];
    const hz = packed[i + 2];
    const geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    const material = new THREE.MeshLambertMaterial({
      color: new THREE.Color(packed[i + 10], packed[i + 11], packed[i + 12]),
      flatShading: true,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(packed[i + 3], packed[i + 4], packed[i + 5]);
    mesh.quaternion.set(packed[i + 6], packed[i + 7], packed[i + 8], packed[i + 9]);
    mesh.castShadow = true;
    group.add(mesh);
    into.push({
      mesh,
      vx: (Math.random() - 0.5) * 0.8,
      vy: 0.35 + Math.random() * 0.5,
      vz: (Math.random() - 0.5) * 0.8,
      wx: (Math.random() - 0.5) * 3,
      wy: (Math.random() - 0.5) * 2,
      wz: (Math.random() - 0.5) * 3,
      age: 0,
    });
  }
}

export function DestructibleSheets({
  world,
  carveEvents,
  spawnVisualDebris = false,
}: DestructibleSheetsProps) {
  const groupRef = useRef<THREE.Group>(null);
  const debrisGroupRef = useRef<THREE.Group>(null);
  const registryRef = useRef<WasmSheetRegistry | null>(null);
  const meshesRef = useRef<Map<number, THREE.Mesh>>(new Map());
  const visualDebrisRef = useRef<VisualDebris[]>([]);
  const appliedSeqRef = useRef(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const worldJson = serializeWorldDocument(world);
    (async () => {
      await initSharedPhysics();
      const mod = await import('../wasm/pkg/vibe_land_shared.js');
      if (cancelled) return;
      const Registry = (mod as { WasmSheetRegistry: new (json: string) => WasmSheetRegistry })
        .WasmSheetRegistry;
      const registry = new Registry(worldJson);
      registryRef.current = registry;

      const group = groupRef.current;
      if (!group) return;
      for (const mesh of meshesRef.current.values()) {
        group.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      meshesRef.current.clear();

      const ids = Array.from(registry.sheetIds());
      for (const id of ids) {
        const matName = registry.materialName(id) ?? 'drywall';
        const color = isSheetMaterial(matName) ? MATERIAL_COLORS[matName] : 0xaaaaaa;
        const geometry = new THREE.BufferGeometry();
        // Lambert (not Standard): specular on jagged sleeve tris looked like a
        // fuzzy/animated material. DoubleSide kept for tunnel visibility;
        // z-fight is avoided in remesh (single sleeve pass + inset caps).
        const material = new THREE.MeshLambertMaterial({
          color,
          side: THREE.DoubleSide,
          vertexColors: true,
          flatShading: true,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        const mesh = new THREE.Mesh(geometry, material);
        // Shadows on high-damage sheets dominate GPU time; keep receive only.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        mesh.userData.sheetId = id;
        group.add(mesh);
        meshesRef.current.set(id, mesh);
        uploadSheetGeometry(mesh, registry, id);
      }
      appliedSeqRef.current = 0;
      setReady(true);
      const qa = (window as Window & { __VIBE_SHEET_QA__?: Record<string, unknown> }).__VIBE_SHEET_QA__;
      if (qa) {
        qa.getSheetMeshStats = () => {
          const reg = registryRef.current;
          if (!reg) return [];
          return Array.from(reg.sheetIds()).map((sheetId) => ({
            sheetId,
            indexCount: toUint32(reg.meshIndices(sheetId)).length,
            carvedCells: reg.carvedCellCount(sheetId),
          }));
        };
      }
    })().catch((err) => {
      console.error('DestructibleSheets init failed', err);
    });

    return () => {
      cancelled = true;
      const group = groupRef.current;
      for (const mesh of meshesRef.current.values()) {
        group?.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      meshesRef.current.clear();
      const debrisGroup = debrisGroupRef.current;
      for (const d of visualDebrisRef.current) {
        debrisGroup?.remove(d.mesh);
        d.mesh.geometry.dispose();
        (d.mesh.material as THREE.Material).dispose();
      }
      visualDebrisRef.current = [];
      registryRef.current = null;
    };
  }, [world]);

  useEffect(() => {
    if (!ready) return;
    const registry = registryRef.current;
    if (!registry) return;
    if (carveEvents.length <= appliedSeqRef.current) return;

    // Apply all new events first, then remesh each dirty sheet once.
    const dirty = new Set<number>();
    const debrisGroup = debrisGroupRef.current;
    for (let i = appliedSeqRef.current; i < carveEvents.length; i += 1) {
      const evt = carveEvents[i];
      const carved = registry.applyCarve(
        evt.sheetId,
        evt.seq,
        evt.uvU,
        evt.uvV,
        evt.dirU,
        evt.dirV,
        evt.normalSpeedCms,
        evt.massOrEnergyGrams,
        evt.footprintRadiusMm,
        evt.seed,
      );
      if (carved > 0) {
        dirty.add(evt.sheetId);
        if (spawnVisualDebris && debrisGroup && registry.takeLastDebrisSpawns) {
          const packed = toFloat32(registry.takeLastDebrisSpawns());
          if (packed.length > 0) {
            spawnVisualFromPacked(debrisGroup, packed, visualDebrisRef.current);
          }
        } else if (registry.takeLastDebrisSpawns) {
          // Drain so practice doesn't accumulate stale packs.
          registry.takeLastDebrisSpawns();
        }
      }
    }
    for (const sheetId of dirty) {
      const mesh = meshesRef.current.get(sheetId);
      if (mesh) {
        uploadSheetGeometry(mesh, registry, sheetId);
      }
    }
    appliedSeqRef.current = carveEvents.length;
  }, [carveEvents, ready, spawnVisualDebris]);

  useFrame((_, dt) => {
    if (!spawnVisualDebris) return;
    const group = debrisGroupRef.current;
    if (!group) return;
    const next: VisualDebris[] = [];
    for (const d of visualDebrisRef.current) {
      d.age += dt;
      if (d.age >= VISUAL_TTL_SEC) {
        group.remove(d.mesh);
        d.mesh.geometry.dispose();
        (d.mesh.material as THREE.Material).dispose();
        continue;
      }
      d.vy += GRAVITY * dt;
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.mesh.rotation.x += d.wx * dt;
      d.mesh.rotation.y += d.wy * dt;
      d.mesh.rotation.z += d.wz * dt;
      const fade = Math.max(0, 1 - (d.age - (VISUAL_TTL_SEC - 0.5)) / 0.5);
      const mat = d.mesh.material as THREE.MeshLambertMaterial;
      mat.opacity = fade;
      mat.transparent = fade < 1;
      next.push(d);
    }
    visualDebrisRef.current = next;
  });

  return (
    <>
      <group ref={groupRef} />
      <group ref={debrisGroupRef} />
    </>
  );
}

/** Static props that are NOT sheet materials (sheets render via DestructibleSheets). */
export function filterNonSheetStaticProps(world: WorldDocument): WorldDocument {
  return {
    ...world,
    staticProps: world.staticProps.filter((p) => !isSheetMaterial(p.material)),
  };
}
