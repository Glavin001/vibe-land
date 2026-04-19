import { initSharedPhysics, WasmSimWorld, type WasmSimWorldInstance } from '../wasm/sharedPhysics';

const COSMETIC_STEP_DT = 1 / 60;
const MAX_COSMETIC_CATCHUP_STEPS = 4;

export class CosmeticPhysicsWorld {
  private readonly sim: WasmSimWorldInstance;
  private accumulatorSec = 0;
  private readonly activeRagdollBodyIds = new Set<number>();

  private constructor(sim: WasmSimWorldInstance) {
    this.sim = sim;
  }

  static async create(worldJson?: string): Promise<CosmeticPhysicsWorld> {
    await initSharedPhysics();

    const sim = new WasmSimWorld();
    if (worldJson) {
      sim.loadWorldDocument(worldJson);
    } else {
      sim.seedDemoTerrain();
    }
    sim.rebuildBroadPhase();

    return new CosmeticPhysicsWorld(sim);
  }

  dispose(): void {
    this.accumulatorSec = 0;
    this.activeRagdollBodyIds.clear();
    (this.sim as { free?: () => void }).free?.();
  }

  advance(frameDeltaSec: number): void {
    if (this.activeRagdollBodyIds.size === 0) {
      this.accumulatorSec = 0;
      return;
    }

    this.accumulatorSec += frameDeltaSec;
    let steps = 0;
    while (
      this.accumulatorSec >= COSMETIC_STEP_DT
      && steps < MAX_COSMETIC_CATCHUP_STEPS
    ) {
      this.sim.stepDynamics(COSMETIC_STEP_DT);
      this.accumulatorSec -= COSMETIC_STEP_DT;
      steps += 1;
    }
    if (this.accumulatorSec > COSMETIC_STEP_DT) {
      this.accumulatorSec = COSMETIC_STEP_DT;
    }
  }

  spawnRagdollBody(
    id: number,
    hx: number,
    hy: number,
    hz: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    vx: number,
    vy: number,
    vz: number,
    wx: number,
    wy: number,
    wz: number,
  ): void {
    this.sim.spawnRagdollBody(
      id, hx, hy, hz, px, py, pz, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz,
    );
    this.activeRagdollBodyIds.add(id);
  }

  removeRagdollBody(id: number): void {
    this.sim.removeRagdollBody(id);
    this.activeRagdollBodyIds.delete(id);
  }

  getRagdollBodyState(id: number): Float64Array | null {
    const state = this.sim.getRagdollBodyState(id);
    return state.length === 7 ? state : null;
  }

  setRagdollBodyVelocity(
    id: number,
    vx: number,
    vy: number,
    vz: number,
    wx: number,
    wy: number,
    wz: number,
  ): void {
    this.sim.setRagdollBodyVelocity(id, vx, vy, vz, wx, wy, wz);
  }

  createRagdollSphericalJoint(
    jointId: number,
    b1Id: number,
    b2Id: number,
    a1x: number,
    a1y: number,
    a1z: number,
    a2x: number,
    a2y: number,
    a2z: number,
  ): void {
    this.sim.createRagdollSphericalJoint(jointId, b1Id, b2Id, a1x, a1y, a1z, a2x, a2y, a2z);
  }

  createRagdollRevoluteJoint(
    jointId: number,
    b1Id: number,
    b2Id: number,
    a1x: number,
    a1y: number,
    a1z: number,
    a2x: number,
    a2y: number,
    a2z: number,
    ax: number,
    ay: number,
    az: number,
    limitMin: number,
    limitMax: number,
  ): void {
    this.sim.createRagdollRevoluteJoint(
      jointId, b1Id, b2Id,
      a1x, a1y, a1z, a2x, a2y, a2z,
      ax, ay, az, limitMin, limitMax,
    );
  }

  removeRagdollJoint(jointId: number): void {
    this.sim.removeRagdollJoint(jointId);
  }
}
