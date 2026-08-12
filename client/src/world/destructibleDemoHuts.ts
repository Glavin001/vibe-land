import type { StaticProp, WorldDocument } from './worldDocument';

/** Mirror of shared `append_destructible_demo_huts` — keep in sync with Rust. */
export function appendDestructibleDemoHuts(world: WorldDocument): WorldDocument {
  let nextId =
    Math.max(0, ...world.staticProps.map((p) => p.id), 1999) + 1;
  const alloc = () => {
    const id = nextId;
    nextId += 1;
    return id;
  };
  const props = [...world.staticProps];
  pushHut(props, alloc, [4.0, 0.0, -12.0], 'drywall');
  pushHut(props, alloc, [14.0, 0.0, -12.0], 'wood');
  pushHut(props, alloc, [9.0, 0.0, -20.0], 'plaster');
  return { ...world, staticProps: props };
}

function pushHut(
  props: StaticProp[],
  alloc: () => number,
  origin: [number, number, number],
  wallMaterial: string,
): void {
  const wallHalfH = 1.4;
  const thick = 0.06;
  const halfW = 2.0;
  const halfD = 1.6;
  const floorY = origin[1] + wallHalfH;
  const cx = origin[0];
  const cz = origin[2];
  const identity: [number, number, number, number] = [0, 0, 0, 1];

  props.push(
    {
      id: alloc(),
      kind: 'cuboid',
      position: [cx, floorY, cz - halfD],
      rotation: identity,
      halfExtents: [halfW, wallHalfH, thick],
      material: wallMaterial,
    },
    {
      id: alloc(),
      kind: 'cuboid',
      position: [cx, floorY, cz + halfD],
      rotation: identity,
      halfExtents: [halfW, wallHalfH, thick],
      material: wallMaterial,
    },
    {
      id: alloc(),
      kind: 'cuboid',
      position: [cx - halfW, floorY, cz],
      rotation: identity,
      halfExtents: [thick, wallHalfH, halfD],
      material: wallMaterial,
    },
    {
      id: alloc(),
      kind: 'cuboid',
      position: [cx + halfW, floorY, cz],
      rotation: identity,
      halfExtents: [thick, wallHalfH, halfD],
      material: wallMaterial,
    },
    {
      id: alloc(),
      kind: 'cuboid',
      position: [cx, origin[1] + wallHalfH * 2 + 0.1, cz],
      rotation: identity,
      halfExtents: [halfW + 0.15, 0.1, halfD + 0.15],
      material: 'hut-roof',
    },
  );
}

export const SHEET_MATERIAL_IDS = ['drywall', 'wood', 'plaster'] as const;
export type SheetMaterialId = (typeof SHEET_MATERIAL_IDS)[number];

export function isSheetMaterial(material: string | undefined): material is SheetMaterialId {
  return material === 'drywall' || material === 'wood' || material === 'plaster';
}
