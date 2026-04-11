import type { DynamicBodyStateMeters } from '../net/protocol';
import type { WasmSimWorldInstance } from '../wasm/sharedPhysics';

const DYNAMIC_BODY_POS_THRESHOLD_M = 0.1;
const DYNAMIC_BODY_ROT_THRESHOLD_RAD = 0.08;
const DYNAMIC_BODY_HARD_SNAP_DISTANCE_M = 3.0;
const DYNAMIC_BODY_HARD_SNAP_ROT_RAD = Math.PI / 4;
const DYNAMIC_BODY_CORRECTION_TIME_S = 0.12;
const DYNAMIC_BODY_DEBUG_THRESHOLD_M = 0.25;
const DYNAMIC_BODY_INTERACTION_WINDOW_MS = 500;
const DYNAMIC_BODY_PROXY_STEP_DT = 1 / 60;
const MAX_PROXY_CATCHUP_STEPS = 4;

export class DynamicBodyPredictionManager {
  private readonly latestMeta = new Map<number, Pick<DynamicBodyStateMeters, 'shapeType' | 'halfExtents'>>();
  private readonly recentInteractionUntilMs = new Map<number, number>();
  private readonly lastCorrectionMagnitude = new Map<number, number>();
  private accumulator = 0;

  constructor(private readonly sim: WasmSimWorldInstance) {}

  advance(frameDeltaSec: number, allowProxyStep: boolean): void {
    const now = performance.now();
    for (const [id, untilMs] of this.recentInteractionUntilMs) {
      if (untilMs <= now) {
        this.recentInteractionUntilMs.delete(id);
      }
    }

    if (!allowProxyStep || this.recentInteractionUntilMs.size === 0) {
      this.accumulator = 0;
      return;
    }

    this.accumulator += frameDeltaSec;
    let steps = 0;
    while (this.accumulator >= DYNAMIC_BODY_PROXY_STEP_DT && steps < MAX_PROXY_CATCHUP_STEPS) {
      this.sim.stepDynamics(DYNAMIC_BODY_PROXY_STEP_DT);
      this.accumulator -= DYNAMIC_BODY_PROXY_STEP_DT;
      steps++;
    }
    if (this.accumulator > DYNAMIC_BODY_PROXY_STEP_DT) {
      this.accumulator = DYNAMIC_BODY_PROXY_STEP_DT;
    }
  }

  syncAuthoritativeBodies(bodies: DynamicBodyStateMeters[]): void {
    const activeIds = new Set<number>();
    const nowMs = performance.now();
    for (const body of bodies) {
      activeIds.add(body.id);
      const currentState = this.readPhysicsState(body.id);
      const shouldProxyReconcile = this.hasRecentInteraction(body.id, nowMs);
      if (!currentState) {
        this.lastCorrectionMagnitude.set(body.id, 0);
        this.sim.syncDynamicBody(
          body.id,
          body.shapeType,
          body.halfExtents[0],
          body.halfExtents[1],
          body.halfExtents[2],
          body.position[0],
          body.position[1],
          body.position[2],
          body.quaternion[0],
          body.quaternion[1],
          body.quaternion[2],
          body.quaternion[3],
          body.velocity[0],
          body.velocity[1],
          body.velocity[2],
          body.angularVelocity[0],
          body.angularVelocity[1],
          body.angularVelocity[2],
        );
      } else if (shouldProxyReconcile) {
        const correctionMagnitude = Math.hypot(
          body.position[0] - currentState.position[0],
          body.position[1] - currentState.position[1],
          body.position[2] - currentState.position[2],
        );
        this.lastCorrectionMagnitude.set(body.id, correctionMagnitude);
        this.sim.reconcileDynamicBody(
          body.id,
          body.shapeType,
          body.halfExtents[0],
          body.halfExtents[1],
          body.halfExtents[2],
          body.position[0],
          body.position[1],
          body.position[2],
          body.quaternion[0],
          body.quaternion[1],
          body.quaternion[2],
          body.quaternion[3],
          body.velocity[0],
          body.velocity[1],
          body.velocity[2],
          body.angularVelocity[0],
          body.angularVelocity[1],
          body.angularVelocity[2],
          DYNAMIC_BODY_POS_THRESHOLD_M,
          DYNAMIC_BODY_ROT_THRESHOLD_RAD,
          DYNAMIC_BODY_HARD_SNAP_DISTANCE_M,
          DYNAMIC_BODY_HARD_SNAP_ROT_RAD,
          DYNAMIC_BODY_CORRECTION_TIME_S,
        );
      } else {
        // For non-interacted bodies, keep the local collider world aligned to
        // the latest authoritative snapshot instead of leaving a lagging proxy
        // trail behind the buffered render pose.
        this.lastCorrectionMagnitude.set(body.id, 0);
        this.sim.syncDynamicBody(
          body.id,
          body.shapeType,
          body.halfExtents[0],
          body.halfExtents[1],
          body.halfExtents[2],
          body.position[0],
          body.position[1],
          body.position[2],
          body.quaternion[0],
          body.quaternion[1],
          body.quaternion[2],
          body.quaternion[3],
          body.velocity[0],
          body.velocity[1],
          body.velocity[2],
          body.angularVelocity[0],
          body.angularVelocity[1],
          body.angularVelocity[2],
        );
      }
      this.latestMeta.set(body.id, { shapeType: body.shapeType, halfExtents: body.halfExtents });
    }

    this.sim.removeStaleeDynamicBodies(Uint32Array.from(activeIds));
    for (const id of this.latestMeta.keys()) {
      if (!activeIds.has(id)) {
        this.latestMeta.delete(id);
        this.recentInteractionUntilMs.delete(id);
        this.lastCorrectionMagnitude.delete(id);
      }
    }
    this.sim.rebuildBroadPhase();
  }

  markRecentInteraction(id: number, nowMs = performance.now()): void {
    this.recentInteractionUntilMs.set(id, nowMs + DYNAMIC_BODY_INTERACTION_WINDOW_MS);
  }

  hasRecentInteraction(id: number, nowMs = performance.now()): boolean {
    return (this.recentInteractionUntilMs.get(id) ?? 0) > nowMs;
  }

  getRecentInteractionCount(nowMs = performance.now()): number {
    let count = 0;
    for (const untilMs of this.recentInteractionUntilMs.values()) {
      if (untilMs > nowMs) count++;
    }
    return count;
  }

  getTrackedBodyCount(): number {
    return this.latestMeta.size;
  }

  getMaxCorrectionMagnitude(
    center?: [number, number, number],
    radiusM?: number,
  ): number {
    let maxCorrection = 0;
    const radiusSq = radiusM != null ? radiusM * radiusM : 0;
    for (const [id, correction] of this.lastCorrectionMagnitude) {
      if (!Number.isFinite(correction)) continue;
      if (center && radiusM != null) {
        const state = this.readPhysicsState(id);
        if (!state) continue;
        const dx = state.position[0] - center[0];
        const dy = state.position[1] - center[1];
        const dz = state.position[2] - center[2];
        if (dx * dx + dy * dy + dz * dz > radiusSq) {
          continue;
        }
      }
      if (correction > maxCorrection) {
        maxCorrection = correction;
      }
    }
    return maxCorrection;
  }

  getDebugCorrectionStats(
    center?: [number, number, number],
    radiusM?: number,
    thresholdM = DYNAMIC_BODY_DEBUG_THRESHOLD_M,
    nowMs = performance.now(),
  ): {
    globalMax: number;
    nearPlayerMax: number;
    interactiveMax: number;
    overThresholdCount: number;
  } {
    let globalMax = 0;
    let nearPlayerMax = 0;
    let interactiveMax = 0;
    let overThresholdCount = 0;
    const radiusSq = center && radiusM != null ? radiusM * radiusM : null;

    for (const [id, correction] of this.lastCorrectionMagnitude) {
      if (!Number.isFinite(correction)) continue;
      const state = this.readPhysicsState(id);
      if (!state) continue;

      if (correction > globalMax) {
        globalMax = correction;
      }
      if (correction >= thresholdM) {
        overThresholdCount++;
      }

      if (center && radiusSq != null) {
        const dx = state.position[0] - center[0];
        const dy = state.position[1] - center[1];
        const dz = state.position[2] - center[2];
        if (dx * dx + dy * dy + dz * dz <= radiusSq && correction > nearPlayerMax) {
          nearPlayerMax = correction;
        }
      }

      if ((this.recentInteractionUntilMs.get(id) ?? 0) > nowMs && correction > interactiveMax) {
        interactiveMax = correction;
      }
    }

    return {
      globalMax,
      nearPlayerMax,
      interactiveMax,
      overThresholdCount,
    };
  }

  getRenderedBodyState(id: number): DynamicBodyStateMeters | null {
    const physicsState = this.readPhysicsState(id);
    const meta = this.latestMeta.get(id);
    if (!physicsState || !meta) return null;
    return {
      ...physicsState,
      shapeType: meta.shapeType,
      halfExtents: meta.halfExtents,
    };
  }

  clear(): void {
    this.latestMeta.clear();
    this.recentInteractionUntilMs.clear();
    this.lastCorrectionMagnitude.clear();
    this.accumulator = 0;
  }

  private readPhysicsState(id: number): DynamicBodyStateMeters | null {
    const state = this.sim.getDynamicBodyState(id);
    if (state.length < 13) return null;
    return {
      id,
      shapeType: 0,
      position: [state[0], state[1], state[2]],
      quaternion: [state[3], state[4], state[5], state[6]],
      velocity: [state[7], state[8], state[9]],
      angularVelocity: [state[10], state[11], state[12]],
      halfExtents: [0, 0, 0],
    };
  }
}
