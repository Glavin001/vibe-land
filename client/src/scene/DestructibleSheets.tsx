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
  meshPositions(sheetId: number): Float32Array | number[];
  meshIndices(sheetId: number): Uint32Array | number[];
};

type DestructibleSheetsProps = {
  world: WorldDocument;
  carveEvents: CarveEventPacket[];
};

const MATERIAL_COLORS: Record<SheetMaterialId, number> = {
  drywall: 0xd8d0c0,
  wood: 0x8b5a2b,
  plaster: 0xcfc6b8,
};

function toFloat32(data: Float32Array | number[]): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data);
}

function toUint32(data: Uint32Array | number[]): Uint32Array {
  return data instanceof Uint32Array ? data : new Uint32Array(data);
}

export function DestructibleSheets({ world, carveEvents }: DestructibleSheetsProps) {
  const groupRef = useRef<THREE.Group>(null);
  const registryRef = useRef<WasmSheetRegistry | null>(null);
  const meshesRef = useRef<Map<number, THREE.Mesh>>(new Map());
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
        const positions = toFloat32(registry.meshPositions(id));
        const indices = toUint32(registry.meshIndices(id));
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
          color,
          roughness: matName === 'wood' ? 0.85 : 0.92,
          metalness: 0.02,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.sheetId = id;
        group.add(mesh);
        meshesRef.current.set(id, mesh);
      }
      appliedSeqRef.current = 0;
      setReady(true);
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
      registryRef.current = null;
    };
  }, [world]);

  useEffect(() => {
    if (!ready) return;
    const registry = registryRef.current;
    if (!registry) return;
    if (carveEvents.length <= appliedSeqRef.current) return;

    for (let i = appliedSeqRef.current; i < carveEvents.length; i += 1) {
      const evt = carveEvents[i];
      registry.applyCarve(
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
      const mesh = meshesRef.current.get(evt.sheetId);
      if (!mesh) continue;
      const positions = toFloat32(registry.meshPositions(evt.sheetId));
      const indices = toUint32(registry.meshIndices(evt.sheetId));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.computeVertexNormals();
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      mesh.visible = positions.length > 0;
    }
    appliedSeqRef.current = carveEvents.length;
  }, [carveEvents, ready]);

  return <group ref={groupRef} />;
}

/** Static props that are NOT sheet materials (sheets render via DestructibleSheets). */
export function filterNonSheetStaticProps(world: WorldDocument): WorldDocument {
  return {
    ...world,
    staticProps: world.staticProps.filter((p) => !isSheetMaterial(p.material)),
  };
}
