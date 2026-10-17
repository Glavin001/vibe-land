import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { coreVoicePlan } from './coreVoicePlan';
import type { AcousticMaterial, SoundEvent } from './model';
import { DEFAULT_AUDIO, MIXES, type AudioSettings } from './settings';
import { planEventVoices } from './voicePlan';

const here = dirname(fileURLToPath(import.meta.url));
beforeAll(() => {
  initSync({ module: readFileSync(join(here, '../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
});

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('voice plans from the shared core (?coreAudio=1)', () => {
  it('equal the web recipe for every kind, material, mix and range', () => {
    const r = rng(7);
    const kinds: SoundEvent['kind'][] = ['impact', 'fracture', 'collapse', 'shot', 'flyby'];
    const materials: AcousticMaterial[] = ['concrete', 'stone', 'metal', 'sheet', 'wood', 'glass', 'earth'];
    const settings: AudioSettings[] = [];
    for (const mix of Object.values(MIXES)) for (const dynamicRange of ['balanced', 'night', 'cinematic'] as const) settings.push({ ...DEFAULT_AUDIO, ...mix, dynamicRange });
    let compared = 0;
    for (let n = 0; n < 2000; n++) {
      const e = { id: `e${n}`, kind: kinds[n % kinds.length], material: materials[Math.floor(r() * materials.length)],
        position: [0, 0, 0], intensity: r() * 1.2, size: r() < .2 ? r() * .3 : r() * 12, seed: Math.floor(r() * 2 ** 31),
        atMs: 0, protected: r() < .2 } as SoundEvent;
      const s = settings[n % settings.length];
      const web = planEventVoices(e, s), core = coreVoicePlan(e, s);
      expect(core.map(v => [v.clip, v.role, v.protected])).toEqual(web.map(v => [v.clip, v.role, v.protected]));
      core.forEach((v, i) => {
        expect(Math.abs(v.level - web[i].level)).toBeLessThan(1e-5 * Math.max(1, web[i].level));
        expect(Math.abs(v.rate - web[i].rate)).toBeLessThan(1e-5);
        expect(Math.abs(v.delay - web[i].delay)).toBeLessThan(1e-6);
      });
      compared += web.length;
    }
    expect(compared).toBeGreaterThan(3000);
  });
});
