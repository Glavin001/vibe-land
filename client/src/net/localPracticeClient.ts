import { PlayerInterpolator, ServerClockEstimator, type DynamicBodySample, type VehicleSample } from './interpolation';
import { NetDebugTelemetry, type LocalShotTelemetry } from './debugTelemetry';
import {
  SIM_HZ,
  netVehicleStateToMeters,
  type BlockEditCmd,
  type DynamicBodyStateMeters,
  type FireCmd,
  type InputCmd,
  type NetPlayerState,
  type NetVehicleState,
  type VehicleStateMeters,
} from './protocol';
import { FIXED_DT, CLIENT_MAX_CATCHUP_STEPS } from '../runtime/clientSimConstants';
import {
  decodeLocalSessionDynamicBodies,
  decodeLocalSessionPlayerState,
  decodeLocalSessionSnapshotMeta,
  decodeLocalSessionVehicleState,
  VEHICLE_STATE_STRIDE,
} from '../runtime/localSessionDecode';
import { decodeVehicleDebugSnapshot, type VehicleDebugSnapshot } from '../runtime/vehicleDebug';
import { initSharedPhysics, WasmLocalSession, type WasmLocalSessionInstance } from '../wasm/sharedPhysics';
import type { RemotePlayer } from './netcodeClient';

export type LocalPracticeClientConfig = {
  onDisconnect?: (reason?: string) => void;
  onLocalSnapshot?: (ackInputSeq: number, state: NetPlayerState) => void;
  onLocalVehicleSnapshot?: (vehicleState: NetVehicleState, ackInputSeq: number) => void;
  worldJson?: string;
};

export class LocalPracticeClient {
  readonly interpolator = new PlayerInterpolator();
  readonly serverClock = new ServerClockEstimator();
  readonly remotePlayers = new Map<number, RemotePlayer>();
  readonly dynamicBodies = new Map<number, DynamicBodyStateMeters>();
  readonly vehicles = new Map<number, VehicleStateMeters>();

  playerId = 0;
  latestServerTick = 0;
  interpolationDelayMs = 0;
  dynamicBodyInterpolationDelayMs = 0;
  localPlayerHp = 100;
  localPlayerFlags = 0;
  rttMs = 0;
  currentAckInputSeq = 0;
  currentLocalPlayerState: NetPlayerState | null = null;
  currentLocalVehicleState: NetVehicleState | null = null;

  private readonly dynamicBodyServerTimeUs = new Map<number, number>();
  private readonly vehicleServerTimeUs = new Map<number, number>();
  private readonly debugTelemetry = new NetDebugTelemetry();
  private session: WasmLocalSessionInstance | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private tickAccumulatorSec = 0;
  private lastTickTimeMs = 0;
  private closedByClient = false;

  get transport(): string {
    return 'local';
  }

  private constructor(private readonly config: LocalPracticeClientConfig = {}) {
    this.serverClock.setSimHz(SIM_HZ);
  }

  static async connect(config: LocalPracticeClientConfig = {}): Promise<LocalPracticeClient> {
    await initSharedPhysics();
    const client = new LocalPracticeClient(config);
    client.session = new WasmLocalSession(config.worldJson);
    client.session.connect();
    client.syncFromSession(false);
    client.startTickLoop();
    return client;
  }

  ping(): void {}

  disconnect(): void {
    this.closedByClient = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.tickAccumulatorSec = 0;
    this.lastTickTimeMs = 0;
    this.session?.disconnect();
    this.session?.free();
    this.session = null;
  }

  sendInputs(cmds: InputCmd[]): void {
    const session = this.session;
    if (!session) return;
    for (const cmd of cmds) {
      session.enqueueInput(
        cmd.seq & 0xffff,
        cmd.buttons & 0xffff,
        cmd.moveX,
        cmd.moveY,
        cmd.yaw,
        cmd.pitch,
      );
    }
  }

  sendFire(cmd: FireCmd): void {
    this.session?.queueFire(
      cmd.seq & 0xffff,
      cmd.shotId >>> 0,
      cmd.weapon & 0xff,
      cmd.clientFireTimeUs,
      cmd.clientInterpMs & 0xffff,
      cmd.clientDynamicInterpMs & 0xffff,
      cmd.dir[0],
      cmd.dir[1],
      cmd.dir[2],
    );
  }

  sendBlockEdit(_cmd: BlockEditCmd): void {
    // Practice mode does not currently expose direct block-edit authority.
  }

  sendVehicleEnter(vehicleId: number, _seat = 0): void {
    this.session?.enterVehicle(vehicleId >>> 0);
    this.syncFromSession(true);
  }

  sendVehicleExit(vehicleId: number): void {
    this.session?.exitVehicle(vehicleId >>> 0);
    this.syncFromSession(true);
  }

  castSceneRay(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance = 1000,
  ): { toi: number } | null {
    const result = this.session?.castSceneRay(
      origin[0], origin[1], origin[2],
      direction[0], direction[1], direction[2],
      maxDistance,
    );
    if (!result || result.length === 0) return null;
    return { toi: result[0] };
  }

  getVehicleDebug(vehicleId: number): VehicleDebugSnapshot | null {
    return decodeVehicleDebugSnapshot(this.session?.getVehicleDebug(vehicleId >>> 0));
  }

  sampleRemoteVehicle(id: number, _renderTimeUs?: number): VehicleSample | null {
    const vehicle = this.vehicles.get(id);
    if (!vehicle) return null;
    return {
      serverTimeUs: this.vehicleServerTimeUs.get(id) ?? this.serverClock.serverNowUs(),
      position: vehicle.position,
      quaternion: vehicle.quaternion,
      linearVelocity: vehicle.linearVelocity,
      angularVelocity: vehicle.angularVelocity,
      wheelData: vehicle.wheelData,
      driverPlayerId: vehicle.driverId,
      flags: vehicle.flags ?? 0,
    };
  }

  getVehicleObservedAgeMs(id: number, localTimeUs = performance.now() * 1000): number | null {
    const sampleServerTimeUs = this.vehicleServerTimeUs.get(id);
    if (sampleServerTimeUs == null) return null;
    return Math.max(0, (this.serverClock.serverNowUs(localTimeUs) - sampleServerTimeUs) / 1000);
  }

  sampleRemoteDynamicBody(id: number, _renderTimeUs?: number): DynamicBodySample | null {
    const body = this.dynamicBodies.get(id);
    if (!body) return null;
    return {
      serverTimeUs: this.dynamicBodyServerTimeUs.get(id) ?? this.serverClock.serverNowUs(),
      position: body.position,
      quaternion: body.quaternion,
      halfExtents: body.halfExtents,
      velocity: body.velocity,
      angularVelocity: body.angularVelocity,
      shapeType: body.shapeType,
    };
  }

  getDynamicBodyRenderTimeUs(localTimeUs = performance.now() * 1000): number {
    return this.serverClock.renderTimeUs(0, localTimeUs);
  }

  getDynamicBodyObservedAgeMs(id: number, localTimeUs = performance.now() * 1000): number | null {
    const sampleServerTimeUs = this.dynamicBodyServerTimeUs.get(id);
    if (sampleServerTimeUs == null) return null;
    return Math.max(0, (this.serverClock.serverNowUs(localTimeUs) - sampleServerTimeUs) / 1000);
  }

  recordFrameDebugMetrics(
    playerCorrectionMagnitude: number,
    vehicleCorrectionMagnitude: number,
    dynamicCorrectionMagnitude: number,
    pendingInputCount: number,
  ): void {
    this.debugTelemetry.observeFrameMetrics(
      playerCorrectionMagnitude,
      vehicleCorrectionMagnitude,
      dynamicCorrectionMagnitude,
      pendingInputCount,
    );
  }

  accumulateDebugStats(_correctionM: number, _physicsStepMs: number): void {}

  recordLocalShotFired(
    shotId: number,
    shot: Omit<LocalShotTelemetry, 'baselineBodyPosition'>,
  ): void {
    this.debugTelemetry.observeLocalShotFired(shotId, {
      ...shot,
      baselineBodyPosition: shot.predictedDynamicBodyId != null
        ? this.dynamicBodies.get(shot.predictedDynamicBodyId)?.position ?? null
        : null,
    });
  }

  getDebugTelemetrySnapshot() {
    return this.debugTelemetry.snapshot();
  }

  emitCurrentState(): void {
    if (this.currentLocalPlayerState) {
      this.config.onLocalSnapshot?.(this.currentAckInputSeq, this.currentLocalPlayerState);
    }
    if (this.currentLocalVehicleState) {
      this.config.onLocalVehicleSnapshot?.(this.currentLocalVehicleState, this.currentAckInputSeq);
    }
  }

  private startTickLoop(): void {
    this.lastTickTimeMs = performance.now();
    this.tickHandle = setInterval(() => {
      if (!this.session || this.closedByClient) {
        return;
      }
      const nowMs = performance.now();
      const elapsedSec = Math.min(Math.max((nowMs - this.lastTickTimeMs) / 1000, 0), 0.1);
      this.lastTickTimeMs = nowMs;
      this.tickAccumulatorSec += elapsedSec;
      let ticks = 0;
      while (this.tickAccumulatorSec >= FIXED_DT && ticks < CLIENT_MAX_CATCHUP_STEPS) {
        this.session.tick(FIXED_DT);
        this.tickAccumulatorSec -= FIXED_DT;
        ticks += 1;
      }
      if (this.tickAccumulatorSec > FIXED_DT) {
        this.tickAccumulatorSec = FIXED_DT;
      }
      if (ticks > 0) {
        this.syncFromSession(true);
      }
    }, 1000 / SIM_HZ);
  }

  private syncFromSession(emitCallbacks: boolean): void {
    const session = this.session;
    if (!session) return;

    const meta = decodeLocalSessionSnapshotMeta(session.getSnapshotMeta());
    if (!meta) {
      return;
    }

    const serverTimeUs = meta.serverTimeUs;
    this.latestServerTick = meta.serverTick;
    const ackInputSeq = meta.ackInputSeq;
    this.playerId = meta.playerId;
    this.currentAckInputSeq = ackInputSeq;
    this.serverClock.observe(serverTimeUs, performance.now() * 1000);

    const playerState = decodeLocalSessionPlayerState(session.getLocalPlayerState());
    this.currentLocalPlayerState = playerState;
    if (playerState) {
      this.localPlayerHp = playerState.hp;
      this.localPlayerFlags = playerState.flags;
      if (emitCallbacks) {
        this.config.onLocalSnapshot?.(ackInputSeq, playerState);
      }
    }

    this.syncDynamicBodies(serverTimeUs, session.getDynamicBodyStates());
    const localVehicleState = this.syncVehicles(serverTimeUs, session.getVehicleStates());
    this.currentLocalVehicleState = localVehicleState;
    if (localVehicleState && emitCallbacks) {
      this.config.onLocalVehicleSnapshot?.(localVehicleState, ackInputSeq);
    }

    this.debugTelemetry.observeAcceptedSnapshot(
      'direct',
      this.latestServerTick,
      playerState ? 1 : 0,
      this.dynamicBodies.size,
    );
  }

  private syncDynamicBodies(serverTimeUs: number, raw: ArrayLike<number>): void {
    const activeIds = new Set<number>();
    for (const state of decodeLocalSessionDynamicBodies(raw)) {
      activeIds.add(state.id);
      this.dynamicBodies.set(state.id, state);
      this.dynamicBodyServerTimeUs.set(state.id, serverTimeUs);
    }

    for (const id of [...this.dynamicBodies.keys()]) {
      if (!activeIds.has(id)) {
        this.dynamicBodies.delete(id);
        this.dynamicBodyServerTimeUs.delete(id);
      }
    }
  }

  private syncVehicles(serverTimeUs: number, raw: ArrayLike<number>): NetVehicleState | null {
    const activeIds = new Set<number>();
    let localVehicleState: NetVehicleState | null = null;

    for (let offset = 0; offset + VEHICLE_STATE_STRIDE <= raw.length; offset += VEHICLE_STATE_STRIDE) {
      const state = decodeLocalSessionVehicleState(raw, offset);
      activeIds.add(state.id);
      this.vehicles.set(state.id, netVehicleStateToMeters(state));
      this.vehicleServerTimeUs.set(state.id, serverTimeUs);
      if (state.driverId === this.playerId && this.playerId !== 0) {
        localVehicleState = state;
      }
    }

    for (const id of [...this.vehicles.keys()]) {
      if (!activeIds.has(id)) {
        this.vehicles.delete(id);
        this.vehicleServerTimeUs.delete(id);
      }
    }

    return localVehicleState;
  }
}
