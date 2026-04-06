import * as RAPIER from '@dimforge/rapier3d-compat';

export type DemoBox = {
  key: string;
  center: [number, number, number];
  halfExtents: [number, number, number];
  color: number;
};

export const DEMO_WORLD_BOXES: DemoBox[] = [
  { key: 'floor', center: [0, -0.5, 0], halfExtents: [32, 0.5, 32], color: 0x556655 },
  { key: 'c1', center: [0, 1.0, 0], halfExtents: [0.75, 1.0, 0.75], color: 0x887766 },
  { key: 'c2', center: [4.0, 0.75, 3.5], halfExtents: [0.5, 0.75, 0.5], color: 0x887766 },
  { key: 'c3', center: [-4.0, 1.25, -3.5], halfExtents: [0.5, 1.25, 0.5], color: 0x887766 },
  { key: 'c4', center: [6.5, 1.0, -5.5], halfExtents: [1.0, 1.0, 0.5], color: 0x887766 },
  { key: 'c5', center: [-6.5, 1.0, 5.5], halfExtents: [1.0, 1.0, 0.5], color: 0x887766 },
  { key: 'w1', center: [0.0, 0.75, -8.0], halfExtents: [5.0, 0.75, 0.5], color: 0x665544 },
  { key: 'w2', center: [0.0, 0.75, 8.0], halfExtents: [5.0, 0.75, 0.5], color: 0x665544 },
  { key: 'w3', center: [8.0, 0.75, 0.0], halfExtents: [0.5, 0.75, 5.0], color: 0x665544 },
  { key: 'w4', center: [-8.0, 0.75, 0.0], halfExtents: [0.5, 0.75, 5.0], color: 0x665544 },
];

export function addDemoWorldColliders(world: RAPIER.World): void {
  for (const box of DEMO_WORLD_BOXES) {
    const collider = RAPIER.ColliderDesc.cuboid(box.halfExtents[0], box.halfExtents[1], box.halfExtents[2])
      .setTranslation(box.center[0], box.center[1], box.center[2]);
    world.createCollider(collider);
  }
}
