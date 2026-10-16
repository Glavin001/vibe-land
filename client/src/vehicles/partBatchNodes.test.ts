import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

// three/webgpu reads `self` at import (a browser global).
(globalThis as { self?: unknown }).self ??= globalThis;
const { createPartBatch } = await import('./partBatchNodes');

// The WebGPU part batch draws a loose part (a body of its own) from its world
// matrix: the instance's `partLoose` flag tells the shader to undo the car's
// transform for it (vehicles/looseParts.ts).
describe('part batch loose instances', () => {
  it('flags world-pose instances, and clears the flag when a part is back on the car', () => {
    const batch = createPartBatch(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 3) as THREE.Mesh & {
      setMatrixAt(i: number, m: THREE.Matrix4): void; setWorldMatrixAt(i: number, m: THREE.Matrix4): void; getMatrixAt(i: number, m: THREE.Matrix4): void;
    };
    const flags = (batch.geometry.getAttribute('partLoose') as THREE.InstancedBufferAttribute);
    const world = new THREE.Matrix4().makeTranslation(4, 5, 6);
    const version = flags.version;
    batch.setWorldMatrixAt(1, world);
    expect(Array.from(flags.array)).toEqual([0, 1, 0]);
    expect(flags.version).toBeGreaterThan(version);
    const read = new THREE.Matrix4(); batch.getMatrixAt(1, read);
    expect(read.equals(world)).toBe(true);
    // Writing the same kind again does not re-upload the flags.
    const after = flags.version;
    batch.setWorldMatrixAt(1, world);
    expect(flags.version).toBe(after);
    batch.setMatrixAt(1, new THREE.Matrix4());
    expect(Array.from(flags.array)).toEqual([0, 0, 0]);
  });
});
