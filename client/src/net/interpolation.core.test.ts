import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initSync } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { corePlayerInterpolator } from '../core/clientCore';
import { PlayerInterpolator, provideCorePlayerInterpolator, type PlayerSample } from './interpolation';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A TypeScript interpolator and one delegating to the core. */
function pair(): [PlayerInterpolator, PlayerInterpolator] {
  provideCorePlayerInterpolator(null);
  const ts = new PlayerInterpolator();
  provideCorePlayerInterpolator(corePlayerInterpolator);
  const core = new PlayerInterpolator();
  provideCorePlayerInterpolator(null);
  return [ts, core];
}

/**
 * Within 1e-9 (the Rust port computes a hypot as a square root of a sum, where V8's Math.hypot
 * scales: a last-bit difference at most), and the hold mark exactly.
 */
function expectSame(core: PlayerSample | null, ts: PlayerSample | null) {
  if (!ts) return expect(core).toBeNull();
  expect(core).not.toBeNull();
  expect(!!core!.held).toBe(!!ts.held);
  expect([core!.hp, core!.flags]).toEqual([ts.hp, ts.flags]);
  const n = (s: PlayerSample) => [s.serverTimeUs, ...s.position, ...s.velocity, s.yaw, s.pitch];
  n(core!).forEach((v, i) => expect(Math.abs(v - n(ts)[i])).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(n(ts)[i]))));
}

describe('core player interpolation (the Unreal client\'s, via WASM)', () => {
  beforeAll(() => {
    const dir = dirname(fileURLToPath(import.meta.url));
    initSync({ module: readFileSync(join(dir, '../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
  });
  afterEach(() => provideCorePlayerInterpolator(null));

  it('samples, latest and ids equal the web\'s over seeded histories with gaps, late snapshots and rest', () => {
    const TICK_US = 16_666;
    const next = rng(3);
    const [ts, core] = pair();
    expect(core.usesCore()).toBe(true);
    expect(ts.usesCore()).toBe(false);
    const ticks = new Map<number, { tick: number; pos: [number, number, number]; resting: boolean }>();
    let samples = 0;
    for (let step = 0; step < 6000; step += 1) {
      const id = 1 + Math.floor(next() * 5);
      const r = next();
      if (r < 0.55) {
        const st = ticks.get(id) ?? { tick: 50, pos: [0, 0, 0] as [number, number, number], resting: false };
        const g = next();
        const tick = g < 0.7 ? st.tick + 1 : g < 0.85 ? st.tick + 5 + Math.floor(next() * 30) : st.tick - Math.floor(next() * 4);
        if (next() < 0.1) st.resting = !st.resting;
        const v: [number, number, number] = st.resting ? [next() < 0.5 ? 0 : 0.03, 0, 0] : [(next() - 0.5) * 12, (next() - 0.5) * 4, (next() - 0.5) * 12];
        st.pos = st.resting ? (next() < 0.2 ? [st.pos[0] + 0.02, st.pos[1], st.pos[2]] : st.pos) : [st.pos[0] + v[0] / 60, st.pos[1] + v[1] / 60, st.pos[2] + v[2] / 60];
        const sample: PlayerSample = {
          serverTimeUs: tick * TICK_US, position: [...st.pos], velocity: v,
          yaw: (next() - 0.5) * 20, pitch: (next() - 0.5) * 3, hp: Math.floor(next() * 101), flags: Math.floor(next() * 32),
        };
        const interval = next() < 0.8 ? TICK_US : 0;
        ts.push(id, sample, interval);
        core.push(id, sample, interval);
        st.tick = Math.max(st.tick, tick);
        ticks.set(id, st);
      } else if (r < 0.93) {
        const target = ((ticks.get(id)?.tick ?? 50) + (next() - 0.7) * 20) * TICK_US;
        expectSame(core.sample(id, target), ts.sample(id, target));
        samples += 1;
      } else if (r < 0.97) {
        expectSame(core.latest(id), ts.latest(id));
      } else if (r < 0.99) {
        ts.remove(id);
        core.remove(id);
        ticks.delete(id);
      } else {
        const keep = new Set([1, 2, 3].filter(() => next() < 0.7));
        ts.retainOnly(keep);
        core.retainOnly(keep);
        for (const k of [...ticks.keys()]) if (!keep.has(k)) ticks.delete(k);
      }
      expect(core.ids().sort()).toEqual(ts.ids().sort());
    }
    expect(samples).toBeGreaterThan(2000);
  });
});
