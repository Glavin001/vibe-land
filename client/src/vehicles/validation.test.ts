import { describe, expect, it } from 'vitest';
import { defaultConfiguration } from './configuration.mjs';
import { preparationIssue, validateVehicleAssembly } from './validation.mjs';
import { Matrix4, Vector3, type InstancedMesh } from 'three';
import { VehicleVisual } from './VehicleVisual';

describe('shared garage assembly validation', () => {
  it('checks the Sprint preset through collision, measured-joint and GPU-shape audits', async () => {
    const result = await validateVehicleAssembly(defaultConfiguration('sprint'));
    expect(result.collision.report.components).toBe(1);
    expect(result.collision.report.penetratingPairs).toBe(0);
    expect(result.bonds.length).toBeGreaterThan(result.collision.parts.length);
    // Every visual in a finalized collider group must receive the same rigid
    // translation, including tread/rim instances across different draw batches.
    const centers = new Map<string, number[]>();
    for (const group of result.collision.parts) for (const id of group.visualIds) centers.set(id, group.position);
    const visual = new VehicleVisual(defaultConfiguration('sprint'));
    const translations = () => {
      const positions = new Map<string, Vector3>(), matrix = new Matrix4();
      for (const object of visual.group.children) {
        const mesh = object as InstancedMesh;
        mesh.userData.parts.forEach((part: {id: string}, i: number) => {
          mesh.getMatrixAt(i, matrix);
          positions.set(part.id, new Vector3().setFromMatrixPosition(matrix));
        });
      }
      return positions;
    };
    try {
      const intact = translations();
      expect(centers.size).toBe(intact.size);
      expect(result.collision.parts.some((group: {visualIds: string[]}) => group.visualIds.length === 149)).toBe(true);
      visual.inspect(1, false, undefined, centers);
      for (const [id, position] of translations()) {
        const [x,y,z] = centers.get(id)!;
        const offset = new Vector3(x,y-.65,z);
        if (offset.lengthSq()<.01) offset.set(0,1,0);
        offset.normalize().multiplyScalar(.9);
        expect(position.sub(intact.get(id)!).distanceTo(offset)).toBeLessThan(1e-5);
      }
      visual.inspect(0, false, undefined, centers);
      for (const [id, position] of translations()) expect(position.distanceTo(intact.get(id)!)).toBeLessThan(1e-5);
    } finally {visual.dispose();}
  }, 60000);
  it('rejects invalid dimensions before building geometry with an actionable field error', async () => {
    const config = defaultConfiguration();
    config.dimensions.track = 10;
    await expect(validateVehicleAssembly(config)).rejects.toThrow('Track width must be between');
  });
  it('explains disconnected geometry and offers exact preset recovery', () => {
    const config = defaultConfiguration('sprint');
    config.dimensions.track = 2;
    config.dimensions.cageHeight = 1.9;
    const issue = preparationIssue(new Error('Collider contact graph has 33 disconnected components'), config);
    expect(issue.code).toBe('disconnected');
    expect(issue.message).toContain('33');
    expect(issue.fields).toEqual([
      {key:'track', label:'Track width', value:1.85},
      {key:'cageHeight', label:'Cage height', value:1.65},
    ]);
    expect(preparationIssue(new Error('Collider contact graph has 33 disconnected components'), defaultConfiguration('sprint')).recovery)
      .toContain('model-generation issue');
  });
});
