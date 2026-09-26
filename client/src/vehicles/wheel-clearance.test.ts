import { describe, expect, it } from 'vitest';
import { defaultConfiguration, modelParameters } from './configuration.mjs';
import { validateVehicleAssembly } from './validation.mjs';
// @ts-expect-error Shared geometry authoring module.
import { ColliderPrimitives } from './dune/collider-primitives.mjs';
// @ts-expect-error Shared geometry authoring module.
import { simpleRecipe } from './dune/simple-colliders.mjs';
// @ts-expect-error Shared convex math module.
import { dot } from './dune/convex.mjs';

describe('simple wheel clearance', () => {
  const models = ['buggy', 'trophy', 'rally', 'monster', 'derby', 'sprint', 'semi'];
  it.each(models)('keeps %s suspension space out of the tire proxy', model => {
    const recipe = simpleRecipe(modelParameters(defaultConfiguration(model)));
    const wheels = recipe.parts.filter((p: any) => p.name.endsWith('wheel assembly') && p.motion?.role === 'wheel');
    expect(wheels).toHaveLength(4);
    for (const wheel of wheels) {
      const corner = wheel.motion.corner;
      const upright = recipe.parts.find((p: any) => p.motion?.corner === corner && p.motion.role === 'upright');
      const caliper = recipe.parts.find((p: any) => p.motion?.corner === corner && p.motion.role === 'knuckle');
      for (const part of [upright, caliper]) {
        expect(part).toBeDefined();
        const points = part.pieces.flatMap((p: any) => p.vertices);
        const center = [0,1,2].map(k => points.reduce((n: number,p: number[]) => n+p[k],0)/points.length);
        for (const point of [center,...points]) {
          expect(wheel.pieces.some((piece: any) => piece.planes.every((plane: any) => dot(plane.n,point) < plane.d-1e-7)),
            `${part.name} must not be swallowed by ${wheel.name}`).toBe(false);
        }
      }
      // One fracture group, a small bounded compound, no tread-level shapes.
      expect(wheel.pieces.length).toBeLessThanOrEqual(10);
      expect(wheel.pieces.every((piece: any) => piece.vertices.length <= 64)).toBe(true);
    }
  });
  it.each(models)('retains %s wheel and carrier ownership after collision cooking', async model => {
    const config = defaultConfiguration(model);
    const result = await validateVehicleAssembly(config);
    const raw = new ColliderPrimitives().build(modelParameters(config));
    const visuals = new Map<string, any>(raw.parts.map((p: any) => [p.id,p]));
    const owners = new Map<string, any>();
    for (const group of result.collision.parts) for (const id of group.visualIds) {
      expect(owners.has(id)).toBe(false);
      owners.set(id,group);
    }
    expect(owners.size).toBe(raw.parts.length);
    const wheels = result.collision.parts.filter((p: any) => p.motion?.role === 'wheel');
    expect(wheels).toHaveLength(4);
    for (const wheel of wheels) {
      for (const id of wheel.visualIds) {
        expect(visuals.get(id).motion?.role, visuals.get(id).name).toBe('wheel');
        expect(visuals.get(id).motion.corner).toBe(wheel.motion.corner);
      }
      for (const role of ['upright','knuckle']) {
        const part = raw.parts.find((p: any) => p.motion?.corner === wheel.motion.corner && p.motion.role === role);
        expect(part).toBeDefined();
        expect(owners.get(part.id).id, part.name).not.toBe(wheel.id);
        expect(owners.get(part.id).motion?.role, part.name).toBe(role);
      }
    }
    expect(result.collision.report.penetratingPairs).toBe(0);
    expect(result.collision.report.components).toBe(1);
  },60000);
});
