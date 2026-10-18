import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initSync } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { coreInputBundler } from '../core/clientCore';
import { FixedInputBundler, provideCoreInputBundler } from './fixedInputBundler';

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

/**
 * The web's axes can be -0 (`Math.round(-0.4)`); the core's are 0. Both encode to the same byte
 * (`setInt8`), and nothing reads the sign of a zero axis, so the comparison treats them alike.
 */
function unsignedZeros(frames: ReturnType<FixedInputBundler['produce']>) {
  return frames.map((f) => ({ ...f, moveX: f.moveX + 0, moveY: f.moveY + 0 }));
}

/** A TypeScript bundler and one delegating to the core, built with the same parameters. */
function pair(fixedDt: number, catchup: number): [FixedInputBundler, FixedInputBundler] {
  provideCoreInputBundler(null);
  const ts = new FixedInputBundler(fixedDt, catchup);
  provideCoreInputBundler(coreInputBundler);
  const core = new FixedInputBundler(fixedDt, catchup);
  provideCoreInputBundler(null);
  return [ts, core];
}

describe('core input bundler (the Unreal client\'s, via WASM)', () => {
  beforeAll(() => {
    const dir = dirname(fileURLToPath(import.meta.url));
    initSync({ module: readFileSync(join(dir, '../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
  });
  afterEach(() => provideCoreInputBundler(null));

  // Axis values where rounding parts: halves of a step, negative halves, beyond the stick's range.
  const AXES = [0, 1, -1, 0.5, -0.5, 63.5 / 127, -63.5 / 127, 0.5 / 127, -0.5 / 127, 1.7, -3];

  it.each([
    ['60 Hz renderer', 1 / 60, 4, () => 1 / 60],
    ['144 Hz renderer', 1 / 60, 4, () => 1 / 144],
    ['jittery 30-240 Hz renderer', 1 / 60, 4, (n: () => number) => 1 / (30 + n() * 210)],
    ['stalls and a catch-up cap of 2', 1 / 60, 2, (n: () => number) => (n() < 0.05 ? n() * 0.5 : 1 / 60)],
  ] as const)('%s: the same frames, sequence and remainder', (_name, fixedDt, catchup, dt) => {
    const next = rng(fixedDt * 1e6 + catchup);
    const [ts, core] = pair(fixedDt, catchup);
    const pick = () => (next() < 0.3 ? AXES[Math.floor(next() * AXES.length)] : next() * 2 - 1);
    for (let i = 0; i < 3000; i += 1) {
      const frameDt = dt(next);
      const state = {
        moveX: pick(),
        moveY: pick(),
        yaw: (next() - 0.5) * 40,
        pitch: (next() - 0.5) * 3,
        buttons: Math.floor(next() * 0x10000),
      };
      expect(core.produce(frameDt, state)).toStrictEqual(unsignedZeros(ts.produce(frameDt, state)));
      expect(core.peekNextSeq()).toBe(ts.peekNextSeq());
      expect(core.remainderSec()).toBe(ts.remainderSec());
      if (i === 1500) {
        ts.reset(65530);
        core.reset(65530); // and the sequence wraps soon after
      }
    }
  });

  it('a bundler built before the core loads takes it at its next reset, never mid-sequence', () => {
    provideCoreInputBundler(null);
    const early = new FixedInputBundler(1 / 60, 4);
    const state = { moveX: 0, moveY: 1, yaw: 0, pitch: 0, buttons: 0 };
    expect(early.produce(2 / 60, state).map((f) => f.seq)).toEqual([1, 2]);
    provideCoreInputBundler(coreInputBundler);
    // Started on its own: the sequence continues on its own.
    expect(early.produce(1 / 60, state).map((f) => f.seq)).toEqual([3]);
    const attached = () => (early as unknown as { core: unknown }).core !== null;
    expect(attached()).toBe(false);
    early.reset(1);
    expect(attached()).toBe(true);
    // Now the core's: same frames, and its remainder is the core's own.
    expect(early.produce(1.5 / 60, state).map((f) => f.seq)).toEqual([1]);
    expect(early.remainderSec()).toBeCloseTo(0.5 / 60, 12);
  });
});
