import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { CoreDestructionActivity } from './coreActivity';
import { DestructionActivity } from './destructionActivity';
import type { AcousticMaterial, SoundEvent, Vec3 } from './model';

const here = dirname(fileURLToPath(import.meta.url));
beforeAll(() => {
  initSync({ module: readFileSync(join(here, '../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
});

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('debris beds from the shared core (?coreAudio=1)', () => {
  it('equal destructionActivity.ts over random collapses', () => {
    const r = rng(11);
    const web = new DestructionActivity(), core = new CoreDestructionActivity();
    const materials: AcousticMaterial[] = ['concrete', 'stone', 'metal', 'wood', 'glass'];
    const kinds: SoundEvent['kind'][] = ['impact', 'fracture', 'collapse', 'shot'];
    let now = 1000, compared = 0;
    const listener: Vec3 = [0, 1.6, 0];
    for (let step = 0; step < 400; step++) {
      now += 16 + r() * 30;
      const events = Math.floor(r() * 6);
      for (let k = 0; k < events; k++) {
        const e = { id: `e${Math.floor(r() * 300)}`, kind: kinds[Math.floor(r() * kinds.length)], material: materials[Math.floor(r() * materials.length)],
          position: [(r() - .5) * 160, r() * 30, (r() - .5) * 160], intensity: r() * 1.1, size: r() * 10, seed: 1,
          atMs: now + (r() - .4) * 600, occlusion: r() < .3 ? .7 : 0 } as SoundEvent;
        web.add(e, listener, now);
        core.add(e, listener, now);
      }
      const a = web.sample(now, listener), b = core.sample(now, listener);
      expect(b.map(x => x.id)).toEqual(a.map(x => x.id));
      b.forEach((x, i) => {
        expect(Math.abs(x.intensity - a[i].intensity)).toBeLessThan(1e-4);
        expect(Math.abs(x.occlusion - a[i].occlusion)).toBeLessThan(1e-4);
        for (let k = 0; k < 3; k++) expect(Math.abs(x.position[k] - a[i].position[k])).toBeLessThan(1e-3);
        expect(x.material).toBe(a[i].material);
      });
      compared += a.length;
    }
    expect(compared).toBeGreaterThan(200);
  });
});
