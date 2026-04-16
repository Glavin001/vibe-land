import { beforeAll, describe, expect, it } from 'vitest';
import { initWasmForTests, WasmSimWorld } from './testInit';
import {
  DEFAULT_WORLD_DOCUMENT,
  cloneWorldDocument,
  serializeWorldDocument,
} from '../world/worldDocument';

beforeAll(() => {
  initWasmForTests();
});

describe('snap-machine wasm bindings bridge', () => {
  it('surfaces authored keyboard controls instead of only fallback defaults', () => {
    const car = DEFAULT_WORLD_DOCUMENT.dynamicEntities.find(
      (entity) => entity.kind === 'snapMachine'
        && entity.envelope
        && typeof entity.envelope === 'object'
        && 'metadata' in entity.envelope
        && (entity.envelope as { metadata?: { presetName?: string } }).metadata?.presetName === '4-Wheel Car',
    );
    expect(car, 'default world should ship a 4-Wheel Car snap-machine').toBeDefined();

    const envelope = structuredClone(car!.envelope) as {
      controls?: unknown;
      plan: { joints: Array<{ id: string }> };
    };
    envelope.controls = {
      defaultProfileId: 'custom',
      profiles: [
        {
          id: 'custom',
          kind: 'keyboard',
          bindings: [
            {
              target: { kind: 'joint', id: envelope.plan.joints[0]?.id ?? 'joint:fl-wheel' },
              positive: { code: 'KeyI' },
              negative: { code: 'KeyK' },
              enabled: true,
              scale: 0.5,
            },
          ],
        },
      ],
    };

    const staticWorld = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    staticWorld.dynamicEntities = [];

    const sim = new WasmSimWorld();
    sim.loadWorldDocument(serializeWorldDocument(staticWorld));
    sim.rebuildBroadPhase();
    sim.spawnSnapMachine(
      car!.id,
      JSON.stringify(envelope),
      car!.position[0], car!.position[1], car!.position[2],
      car!.rotation[0], car!.rotation[1], car!.rotation[2], car!.rotation[3],
    );

    const bindings = sim.getSnapMachineBindings(car!.id);
    expect(bindings).toContain('motorSpin\tKeyI\tKeyK\t0.5');
    expect(bindings).not.toContain('motorSpin\tKeyE\tKeyQ\t1');
  });
});
