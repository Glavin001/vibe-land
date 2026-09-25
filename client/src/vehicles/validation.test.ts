import { describe, expect, it } from 'vitest';
import { defaultConfiguration } from './configuration.mjs';
import { preparationIssue, validateVehicleAssembly } from './validation.mjs';

describe('shared garage assembly validation', () => {
  it('checks the Sprint preset through collision, measured-joint and GPU-shape audits', async () => {
    const result = await validateVehicleAssembly(defaultConfiguration('sprint'));
    expect(result.collision.report.components).toBe(1);
    expect(result.collision.report.penetratingPairs).toBe(0);
    expect(result.bonds.length).toBeGreaterThan(result.collision.parts.length);
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
