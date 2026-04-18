import type { WasmSimWorldInstance } from '../wasm/sharedPhysics';
import type { BlockEditCmd, DynamicBodyStateMeters, InputCmd, NetPlayerState, ServerWorldPacket } from '../net/protocol';
import { netPlayerStateToMeters } from '../net/protocol';
import type { SemanticInputState } from '../input/types';
import { CLIENT_MAX_CATCHUP_STEPS, CLIENT_PREDICTION_MAX_PENDING_INPUTS, FIXED_DT } from '../runtime/clientSimConstants';
import { buildInputFromButtons, buildInputFromState } from '../scene/inputBuilder';
import { ClientVoxelWorld, type RenderBlock } from '../world/voxelWorld';

export { FIXED_DT, CLIENT_MAX_CATCHUP_STEPS as MAX_CATCHUP_STEPS };
export const HARD_SNAP_DISTANCE = 3.0;
export const VISUAL_SMOOTH_RATE = 8.0;
export const CORRECTION_DISTANCE = 0.15;

/**
 * When pending (unacked) inputs exceed this count, the client pauses tick
 * generation to let the server catch up.
 */
export const MAX_PENDING_INPUTS = CLIENT_PREDICTION_MAX_PENDING_INPUTS;

/**
 * Framework-agnostic prediction manager.
 *
 * Owns the shared WASM sim world, the voxel world, the fixed-timestep
 * accumulator, visual smoothing, and input sequence generation.
 */
export class PredictionManager {
  readonly voxelWorld: ClientVoxelWorld;

  private accumulator = 0;
  private prevPosition: [number, number, number] = [0, 0, 0];
  private currPosition: [number, number, number] = [0, 0, 0];
  private currVelocity: [number, number, number] = [0, 0, 0];
  private correctionOffset: [number, number, number] = [0, 0, 0];
  private nextSeq = 1;
  private tickCount = 0;
  private worldLoaded = false;
  private terrainLoaded = false;
  private initialized = false;
  private _lastPhysicsStepMs = 0;

  constructor(private readonly sim: WasmSimWorldInstance) {
    this.voxelWorld = new ClientVoxelWorld(sim);
  }

  /**
   * Advance the prediction simulation by one render-frame's worth of time.
   * Returns any InputCmds generated (one per fixed-step tick).
   */
  update(frameDeltaSec: number, input: SemanticInputState): InputCmd[];
  update(frameDeltaSec: number, buttons: number, yaw: number, pitch: number): InputCmd[];
  update(
    frameDeltaSec: number,
    inputOrButtons: SemanticInputState | number,
    yaw = 0,
    pitch = 0,
  ): InputCmd[] {
    if (!this.worldLoaded || !this.initialized) {
      return [];
    }
    const semanticInput = normalizeSemanticInput(inputOrButtons, yaw, pitch);

    this.accumulator += frameDeltaSec;
    const pendingInputs: InputCmd[] = [];

    if (this.sim.getPendingCount() >= CLIENT_PREDICTION_MAX_PENDING_INPUTS) {
      if (this.accumulator > FIXED_DT) {
        this.accumulator = FIXED_DT;
      }
      return [];
    }

    let steps = 0;
    let physicsTimeTotal = 0;
    while (this.accumulator >= FIXED_DT && steps < CLIENT_MAX_CATCHUP_STEPS) {
      const seq = this.nextSeq++ & 0xffff;
      const input = buildInputFromState(seq, 0, semanticInput);

      const t0 = performance.now();
      this.sim.tick(input.seq, input.buttons, input.moveX, input.moveY, input.yaw, input.pitch, FIXED_DT);
      physicsTimeTotal += performance.now() - t0;
      pendingInputs.push(input);

      this.prevPosition = [...this.currPosition] as [number, number, number];
      const p = this.sim.getPosition();
      this.currPosition = [p[0], p[1], p[2]];
      this.currVelocity = [
        (this.currPosition[0] - this.prevPosition[0]) / FIXED_DT,
        (this.currPosition[1] - this.prevPosition[1]) / FIXED_DT,
        (this.currPosition[2] - this.prevPosition[2]) / FIXED_DT,
      ];

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

    if (steps > 0) {
      this._lastPhysicsStepMs = physicsTimeTotal / steps;
    }

    return pendingInputs;
  }

  /**
   * Process an authoritative server snapshot for the local player.
   */
  reconcile(ackInputSeq: number, playerState: NetPlayerState): void {
    const m = netPlayerStateToMeters(playerState);
    const onGround = (m.flags & 1) !== 0;

    if (!this.initialized) {
      this.sim.setFullState(
        m.position[0], m.position[1], m.position[2],
        m.velocity[0], m.velocity[1], m.velocity[2],
        m.yaw, m.pitch,
        onGround,
      );
      this.currPosition = [...m.position] as [number, number, number];
      this.prevPosition = [...m.position] as [number, number, number];
      this.currVelocity = [...m.velocity] as [number, number, number];
      this.correctionOffset = [0, 0, 0];
      this.initialized = true;
      return;
    }

    const result = this.sim.reconcile(
      CORRECTION_DISTANCE,
      ackInputSeq,
      m.position[0], m.position[1], m.position[2],
      m.velocity[0], m.velocity[1], m.velocity[2],
      m.yaw, m.pitch,
      onGround,
      FIXED_DT,
    );

    const didCorrect = result[10] !== 0;
    if (!didCorrect) return;

    const dx = result[7];
    const dy = result[8];
    const dz = result[9];
    const replayError = Math.hypot(dx, dy, dz);

    if (replayError > HARD_SNAP_DISTANCE) {
      const p = this.sim.getPosition();
      this.currPosition = [p[0], p[1], p[2]];
      this.prevPosition = [...this.currPosition] as [number, number, number];
      this.currVelocity = [...m.velocity] as [number, number, number];
      this.correctionOffset = [0, 0, 0];
    } else {
      this.correctionOffset = [-dx, -dy, -dz];
      const p = this.sim.getPosition();
      this.currPosition = [p[0], p[1], p[2]];
      this.prevPosition = [...this.currPosition] as [number, number, number];
      this.currVelocity = [...m.velocity] as [number, number, number];
    }
  }

  /**
   * Get the visually-smoothed interpolated position for rendering.
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

  applyOptimisticEdit(cmd: BlockEditCmd): void {
    this.voxelWorld.applyOptimisticEdit(cmd);
  }

  applyWorldPacket(packet: ServerWorldPacket): void {
    if (packet.type === 'chunkFull') {
      this.voxelWorld.applyFullChunk(packet);
    } else {
      this.voxelWorld.applyChunkDiff(packet);
    }
    this.worldLoaded = this.terrainLoaded || this.voxelWorld.hasChunks();
  }

  isWorldLoaded(): boolean {
    return this.worldLoaded;
  }

  enableTerrainWorld(): void {
    this.terrainLoaded = true;
    this.worldLoaded = true;
  }

  hasEditableWorld(): boolean {
    return this.voxelWorld.hasChunks();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getRenderBlocks(): RenderBlock[] {
    return this.voxelWorld.getRenderBlocks();
  }

  getPosition(): [number, number, number] {
    const p = this.sim.getPosition();
    return [p[0], p[1], p[2]];
  }

  getCorrectionOffset(): [number, number, number] {
    return [...this.correctionOffset] as [number, number, number];
  }

  getPendingInputCount(): number {
    return this.sim.getPendingCount();
  }

  getTickCount(): number {
    return this.tickCount;
  }

  getLastPhysicsStepMs(): number {
    return this._lastPhysicsStepMs;
  }

  getVelocity(): [number, number, number] {
    if (!this.initialized) return [0, 0, 0];
    return [...this.currVelocity] as [number, number, number];
  }

  getNextSeq(): number {
    return this.nextSeq;
  }

  setNextSeq(seq: number): void {
    this.nextSeq = seq;
  }

  updateDynamicBodies(bodies: DynamicBodyStateMeters[]): void {
    for (const body of bodies) {
      this.sim.syncDynamicBody(
        body.id,
        body.shapeType,
        body.halfExtents[0], body.halfExtents[1], body.halfExtents[2],
        body.position[0], body.position[1], body.position[2],
        body.quaternion[0], body.quaternion[1], body.quaternion[2], body.quaternion[3],
        body.velocity[0], body.velocity[1], body.velocity[2],
        body.angularVelocity[0], body.angularVelocity[1], body.angularVelocity[2],
      );
    }
    // Remove stale dynamic bodies
    const activeIds = new Uint32Array(bodies.map(b => b.id));
    this.sim.removeStaleeDynamicBodies(activeIds);

    // Rebuild the broad-phase BVH so the KCC sees dynamic bodies at their
    // updated positions during both reconcile replays and prediction ticks.
    this.sim.rebuildBroadPhase();
  }

  dispose(): void {
    this.sim.free();
  }
}

function normalizeSemanticInput(
  inputOrButtons: SemanticInputState | number,
  yaw: number,
  pitch: number,
): SemanticInputState {
  if (typeof inputOrButtons !== 'number') {
    return inputOrButtons;
  }

  const legacyInput = buildInputFromButtons(0, 0, inputOrButtons, yaw, pitch);
  return {
    moveX: legacyInput.moveX / 127,
    moveY: legacyInput.moveY / 127,
    yaw: legacyInput.yaw,
    pitch: legacyInput.pitch,
    buttons: inputOrButtons,
  };
}
