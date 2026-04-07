import * as RAPIER from '@dimforge/rapier3d-compat';
import { PredictedFpsController, type MovementConfig } from './predictedFpsController';
import type { InputCmd, NetPlayerState, ServerWorldPacket } from '../net/protocol';
import { netPlayerStateToMeters } from '../net/protocol';
import { buildInputFromButtons } from '../scene/inputBuilder';
import { ClientVoxelWorld, type RenderBlock } from '../world/voxelWorld';

export const FIXED_DT = 1 / 60;
export const MAX_CATCHUP_STEPS = 4;
export const HARD_SNAP_DISTANCE = 3.0;
export const VISUAL_SMOOTH_RATE = 8.0;

export type PredictionManagerConfig = {
  movementConfig?: Partial<MovementConfig>;
};

/**
 * Framework-agnostic prediction manager.
 *
 * Owns the Rapier world, the PredictedFpsController, the voxel world,
 * the fixed-timestep accumulator, visual smoothing, and input sequence
 * generation.  Does NOT depend on React or any rendering framework.
 *
 * Usage:
 *   const mgr = new PredictionManager(world, body, collider);
 *   // each render frame:
 *   const cmds = mgr.update(frameDelta, buttons, yaw, pitch);
 *   // send cmds over the network
 *   // on snapshot receipt:
 *   mgr.reconcile(ackInputSeq, playerState);
 *   // for rendering:
 *   const pos = mgr.getInterpolatedPosition();
 */
export class PredictionManager {
  readonly controller: PredictedFpsController;
  readonly voxelWorld: ClientVoxelWorld;

  private accumulator = 0;
  private prevPosition: [number, number, number] = [0, 0, 0];
  private currPosition: [number, number, number] = [0, 0, 0];
  private correctionOffset: [number, number, number] = [0, 0, 0];
  private nextSeq = 1;
  private tickCount = 0;
  private worldLoaded = false;
  private initialized = false;

  constructor(
    private readonly world: RAPIER.World,
    body: RAPIER.RigidBody,
    collider: RAPIER.Collider,
    config?: PredictionManagerConfig,
  ) {
    this.controller = new PredictedFpsController(world, body, collider, config?.movementConfig);
    this.voxelWorld = new ClientVoxelWorld(world);
  }

  /**
   * Advance the prediction simulation by one render-frame's worth of time.
   * Returns any InputCmds generated (one per fixed-step tick).
   */
  update(frameDeltaSec: number, buttons: number, yaw: number, pitch: number): InputCmd[] {
    if (!this.worldLoaded || !this.initialized) {
      return [];
    }

    this.accumulator += frameDeltaSec;
    const pendingInputs: InputCmd[] = [];

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      const seq = this.nextSeq++ & 0xffff;
      const input = buildInputFromButtons(seq, 0, buttons, yaw, pitch);

      this.controller.predict(input, FIXED_DT);
      pendingInputs.push(input);

      this.prevPosition = [...this.currPosition] as [number, number, number];
      const p = this.controller.getPosition();
      this.currPosition = [p.x, p.y, p.z];

      const decay = Math.exp(-VISUAL_SMOOTH_RATE * FIXED_DT);
      this.correctionOffset[0] *= decay;
      this.correctionOffset[1] *= decay;
      this.correctionOffset[2] *= decay;

      this.accumulator -= FIXED_DT;
      steps++;
      this.tickCount++;
    }

    if (this.accumulator > FIXED_DT) {
      this.accumulator = FIXED_DT;
    }

    return pendingInputs;
  }

  /**
   * Process an authoritative server snapshot for the local player.
   * Handles initial sync, hard-snap, and smooth reconciliation with input replay.
   */
  reconcile(ackInputSeq: number, playerState: NetPlayerState): void {
    const m = netPlayerStateToMeters(playerState);

    if (!this.initialized) {
      this.controller.setFullState(
        { x: m.position[0], y: m.position[1], z: m.position[2] },
        { x: m.velocity[0], y: m.velocity[1], z: m.velocity[2] },
        m.yaw,
        m.pitch,
        (m.flags & 1) !== 0,
      );
      this.currPosition = [...m.position] as [number, number, number];
      this.prevPosition = [...m.position] as [number, number, number];
      this.correctionOffset = [0, 0, 0];
      this.initialized = true;
      return;
    }

    const curr = this.controller.getPosition();
    const rawError = Math.hypot(
      m.position[0] - curr.x,
      m.position[1] - curr.y,
      m.position[2] - curr.z,
    );

    if (rawError > HARD_SNAP_DISTANCE) {
      this.controller.setFullState(
        { x: m.position[0], y: m.position[1], z: m.position[2] },
        { x: m.velocity[0], y: m.velocity[1], z: m.velocity[2] },
        m.yaw,
        m.pitch,
        (m.flags & 1) !== 0,
      );
      const p = this.controller.getPosition();
      this.currPosition = [p.x, p.y, p.z];
      this.prevPosition = [...this.currPosition] as [number, number, number];
      this.correctionOffset = [0, 0, 0];
      return;
    }

    const delta = this.controller.reconcile(
      { ackInputSeq, state: playerState },
      FIXED_DT,
    );

    if (delta) {
      this.correctionOffset = [-delta.dx, -delta.dy, -delta.dz];
      const p = this.controller.getPosition();
      this.currPosition = [p.x, p.y, p.z];
      this.prevPosition = [...this.currPosition] as [number, number, number];
    }
  }

  /**
   * Get the visually-smoothed interpolated position for rendering.
   * Interpolates between previous and current tick positions using the
   * sub-tick accumulator alpha, and applies the decaying correction offset.
   */
  getInterpolatedPosition(): [number, number, number] | null {
    if (!this.initialized) return null;

    const alpha = this.accumulator / FIXED_DT;
    return [
      this.prevPosition[0] + (this.currPosition[0] - this.prevPosition[0]) * alpha + this.correctionOffset[0],
      this.prevPosition[1] + (this.currPosition[1] - this.prevPosition[1]) * alpha + this.correctionOffset[1],
      this.prevPosition[2] + (this.currPosition[2] - this.prevPosition[2]) * alpha + this.correctionOffset[2],
    ];
  }

  /** Apply an incoming world chunk (full or diff) to the local voxel world. */
  applyWorldPacket(packet: ServerWorldPacket): void {
    if (packet.type === 'chunkFull') {
      this.voxelWorld.applyFullChunk(packet);
    } else {
      this.voxelWorld.applyChunkDiff(packet);
    }
    this.worldLoaded = this.voxelWorld.hasChunks();
  }

  isWorldLoaded(): boolean {
    return this.worldLoaded;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getRenderBlocks(): RenderBlock[] {
    return this.voxelWorld.getRenderBlocks();
  }

  /** Get the raw current position (not interpolated). */
  getPosition(): [number, number, number] {
    const p = this.controller.getPosition();
    return [p.x, p.y, p.z];
  }

  getCorrectionOffset(): [number, number, number] {
    return [...this.correctionOffset] as [number, number, number];
  }

  getPendingInputCount(): number {
    return this.controller.getPendingCount();
  }

  getTickCount(): number {
    return this.tickCount;
  }

  getNextSeq(): number {
    return this.nextSeq;
  }

  /** For testing only: advance the sequence counter to a specific value. */
  setNextSeq(seq: number): void {
    this.nextSeq = seq;
  }

  dispose(): void {
    this.controller.dispose();
  }
}
