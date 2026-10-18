import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initSync } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { corePredictor } from '../core/clientCore';
import { BTN_JUMP, BTN_SPRINT } from '../net/protocol';
import { provideCorePredictor, ThinAuthoritativePredictor } from './thinAuthoritativePredictor';

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

/** A TypeScript predictor and one delegating to the core, pinned to the TypeScript's speeds. */
function pair(): [ThinAuthoritativePredictor, ThinAuthoritativePredictor] {
  provideCorePredictor(null);
  const ts = new ThinAuthoritativePredictor();
  provideCorePredictor(() => {
    const p = corePredictor();
    p.set_speeds(6, 9);
    return p;
  });
  const core = new ThinAuthoritativePredictor();
  provideCorePredictor(null);
  return [ts, core];
}

describe("core predictor (the Unreal client's, via WASM)", () => {
  beforeAll(() => {
    const dir = dirname(fileURLToPath(import.meta.url));
    initSync({ module: readFileSync(join(dir, '../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
  });
  afterEach(() => provideCorePredictor(null));

  it('presents the same position every frame, within the offset caps', () => {
    const next = rng(45);
    const [ts, core] = pair();
    let pos: [number, number, number] = [10, 2, -5];
    let grounded = true;
    let inVehicle = false;
    let worst = 0;
    for (let i = 0; i < 20000; i += 1) {
      // Frame times from 240 Hz to stalls past the 50 ms prediction horizon.
      const dt = next() < 0.03 ? 0.05 + next() * 0.2 : 1 / (30 + next() * 210);
      if (next() < 0.01) grounded = !grounded;
      if (next() < 0.002) inVehicle = !inVehicle;
      if (next() < 0.001) {
        ts.reset();
        core.reset();
      }
      const vel: [number, number, number] = [next() * 12 - 6, next() * 6 - 3, next() * 12 - 6];
      const support: [number, number, number] | undefined = next() < 0.2 ? [next() * 4 - 2, 0, next() * 4 - 2] : undefined;
      const state = { position: pos, velocity: vel, grounded, inVehicle, supportVelocity: support };
      ts.observeAuthoritative(state, dt);
      core.observeAuthoritative(state, dt);
      pos = [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt, pos[2] + vel[2] * dt];
      const input = {
        moveX: next() < 0.3 ? 0 : next() * 2.4 - 1.2,
        moveY: next() < 0.3 ? 0 : next() * 2.4 - 1.2,
        yaw: next() * 20 - 10,
        pitch: 0,
        buttons: (next() < 0.4 ? BTN_SPRINT : 0) | (next() < 0.1 ? BTN_JUMP : 0),
      };
      const a = ts.update(pos, dt, input);
      const b = core.update(pos, dt, input);
      for (let k = 0; k < 3; k += 1) {
        // f32 in the core against f64 here, on coordinates of ~10 m.
        worst = Math.max(worst, Math.abs(a[k] - b[k]));
      }
      const off = [b[0] - pos[0], b[1] - pos[1], b[2] - pos[2]];
      expect(Math.hypot(off[0], off[2])).toBeLessThanOrEqual(0.35 + 1e-5);
      expect(Math.abs(off[1])).toBeLessThanOrEqual(0.22 + 1e-5);
      expect(Math.abs(ts.correctionMagnitude() - core.correctionMagnitude())).toBeLessThan(1e-5);
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it("leads sprint at the server's 8.5 m/s by default", () => {
    provideCorePredictor(corePredictor);
    const core = new ThinAuthoritativePredictor();
    provideCorePredictor(null);
    core.observeAuthoritative({ position: [0, 0, 0], velocity: [0, 0, 8.5], grounded: true }, 1 / 60);
    const p = core.update([0, 0, 0], 1 / 60, { moveX: 0, moveY: 1, yaw: 0, pitch: 0, buttons: BTN_SPRINT });
    expect(Math.abs(p[2])).toBeLessThan(1e-6); // the server already moves at the pushed speed
  });
});
