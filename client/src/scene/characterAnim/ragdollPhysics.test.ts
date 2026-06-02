// End-to-end (real WASM Rapier) integration test for the ragdoll.
//
// This drives the *entire* real pipeline — Ragdoll.activate spawns bodies + joints
// into a live WasmSimWorld using the actual calibration, we step Rapier, and
// Ragdoll.update() writes the bones back. It asserts the body collapses as one
// coherent, settling pile (no NaN, bounded spread, falls to the ground, no
// residual jitter). A gross spawn/joint/marshaling regression would blow the
// spread up or produce NaN here.
//
// (The pixel-precise calibration round-trip and the joint wiring/anchor convention
// are pinned down deterministically without WASM in Ragdoll.test.ts.)
//
// Requires the WASM package to be built (npm run build:wasm), like the other
// WASM-backed tests in this repo.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { initWasmForTests, WasmSimWorld } from '../../wasm/testInit';
import { Ragdoll } from './Ragdoll';
import { RAGDOLL_PARTS, PART_INDEX } from './ragdollBones';
import type { CharacterModel } from './CharacterModel';
import type { GameRuntimeClient } from '../../runtime/gameRuntime';
import { buildSyntheticSkeleton } from './ragdollTestSkeleton';

beforeAll(() => {
  initWasmForTests();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeSim(): any {
  const sim: any = new WasmSimWorld();
  sim.seedDemoTerrain();
  sim.rebuildBroadPhase();
  return sim;
}

/** Adapt the raw WasmSimWorld to the GameRuntimeClient surface Ragdoll calls. */
function adaptRuntime(sim: any): GameRuntimeClient {
  return {
    spawnRagdollBody: (...a: number[]) => sim.spawnRagdollBody(...a),
    removeRagdollBody: (id: number) => sim.removeRagdollBody(id),
    getRagdollBodyState: (id: number) => {
      const s = sim.getRagdollBodyState(id) as Float64Array;
      return s && s.length === 7 ? s : null;
    },
    setRagdollBodyVelocity: (...a: number[]) => sim.setRagdollBodyVelocity(...a),
    createRagdollSphericalJoint: (...a: number[]) => sim.createRagdollSphericalJoint(...a),
    createRagdollRevoluteJoint: (...a: number[]) => sim.createRagdollRevoluteJoint(...a),
    removeRagdollJoint: (id: number) => sim.removeRagdollJoint(id),
  } as unknown as GameRuntimeClient;
}

function bodyId(playerId: number, partIndex: number): number {
  return (0xc000_0000 | ((playerId & 0xff) << 4) | (partIndex & 0xf)) >>> 0;
}

describe('Ragdoll physics integration (WASM)', () => {
  it('round-trips a body transform through getRagdollBodyState', () => {
    const sim = makeSim();
    sim.spawnRagdollBody(1, 0.2, 0.2, 0.2, 1, 5, -2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
    const s = sim.getRagdollBodyState(1) as Float64Array;
    expect(s.length).toBe(7);
    expect(s[0]).toBeCloseTo(1, 4);
    expect(s[1]).toBeCloseTo(5, 4);
    expect(s[2]).toBeCloseTo(-2, 4);
    expect(s[6]).toBeCloseTo(1, 4); // identity quaternion w
  });

  it('pulls a jointed pair to satisfy the shared anchor constraint', () => {
    const sim = makeSim();
    // Spawn high (no ground/tumble interference in the window we measure) with the
    // joint anchors violated by ~0.56m: anchor1 = body1+0.22, anchor2 = body2-0.22.
    sim.spawnRagdollBody(1, 0.2, 0.2, 0.2, 0, 20.0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
    sim.spawnRagdollBody(2, 0.2, 0.2, 0.2, 0, 21.0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
    sim.createRagdollSphericalJoint(10, 1, 2, 0, 0.22, 0, 0, -0.22, 0);

    const anchorGap = () => {
      const a = sim.getRagdollBodyState(1) as Float64Array;
      const b = sim.getRagdollBodyState(2) as Float64Array;
      // |(p1 + (0,0.22,0)) - (p2 + (0,-0.22,0))| with identity rotations.
      return Math.hypot(a[0] - b[0], a[1] + 0.22 - (b[1] - 0.22), a[2] - b[2]);
    };

    const initialGap = anchorGap();
    expect(initialGap).toBeGreaterThan(0.4);
    // Free fall is equal for both bodies, so relative motion is purely the joint
    // closing its constraint violation. Stay well above the ground.
    for (let i = 0; i < 30; i++) sim.stepDynamics(1 / 60);

    const gap = anchorGap();
    expect(Number.isFinite(gap)).toBe(true);
    expect(gap).toBeLessThan(0.1);
  });

  it('collapses a full ragdoll into a coherent, settling pile', () => {
    const sim = makeSim();
    const runtime = adaptRuntime(sim);
    // Use a realistic non-unit rig scale + posed bones so the real calibration and
    // scale-measurement paths are exercised end-to-end.
    const { root } = buildSyntheticSkeleton({ scale: 0.85, pose: true, rootY: 0 });
    const model = { root } as unknown as CharacterModel;

    const ragdoll = new Ragdoll(model, 1, runtime);
    ragdoll.activate(new THREE.Vector3(0, 0, 0));

    const ids = RAGDOLL_PARTS.map((p) => bodyId(1, PART_INDEX[p]));

    const states = () => ids.map((id) => sim.getRagdollBodyState(id) as Float64Array);
    const spreadFromPelvis = (ss: Float64Array[]) => {
      const pelvis = ss[0];
      let max = 0;
      for (const s of ss) {
        expect(
          Number.isFinite(s[0]) && Number.isFinite(s[1]) && Number.isFinite(s[2]),
          'body state must stay finite',
        ).toBe(true);
        max = Math.max(max, Math.hypot(s[0] - pelvis[0], s[1] - pelvis[1], s[2] - pelvis[2]));
      }
      return max;
    };

    let prev = states().map((s) => [s[0], s[1], s[2]] as [number, number, number]);
    let maxLateJitter = 0;

    for (let i = 0; i < 240; i++) {
      sim.stepDynamics(1 / 60);
      ragdoll.update();
      const ss = states();
      // A human ragdoll is <1.8m tall; the parts must never spread past ~1.6m of
      // the pelvis. A flung limb or solver blow-up would exceed this.
      expect(spreadFromPelvis(ss), `spread at step ${i}`).toBeLessThan(1.6);
      if (i > 200) {
        for (let k = 0; k < ids.length; k++) {
          const s = ss[k];
          const p = prev[k];
          maxLateJitter = Math.max(
            maxLateJitter,
            Math.hypot(s[0] - p[0], s[1] - p[1], s[2] - p[2]),
          );
        }
      }
      prev = ss.map((s) => [s[0], s[1], s[2]] as [number, number, number]);
    }

    // Settled: per-step motion is tiny (no buzzing/jitter).
    expect(maxLateJitter, 'late per-step jitter').toBeLessThan(0.02);

    // Fell toward the ground rather than launching upward.
    const pelvis = states()[0];
    expect(pelvis[1]).toBeLessThan(1.5);
    expect(pelvis[1]).toBeGreaterThan(-5);
  });
});
