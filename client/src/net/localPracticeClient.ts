import { PlayerInterpolator, ServerClockEstimator, type DynamicBodySample, type VehicleSample } from './interpolation';
import { NetDebugTelemetry, type LocalShotTelemetry } from './debugTelemetry';
import {
  type BatteryStateMeters,
  SIM_HZ,
  encodeInputBundle,
  netPlayerStateToMeters,
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
  decodeLocalSessionBatteries,
  decodeLocalSessionDynamicBodies,
  decodeLocalSessionPlayers,
  decodeLocalSessionPlayerState,
  decodeLocalSessionSnapshotMeta,
  decodeLocalSessionVehicleState,
  VEHICLE_STATE_STRIDE,
} from '../runtime/localSessionDecode';
import { decodeVehicleDebugSnapshot, type VehicleDebugSnapshot } from '../runtime/vehicleDebug';
import {
  initSharedPhysics,
  WasmLocalSession,
  type WasmDebugRenderBuffers,
  type WasmLocalSessionInstance,
} from '../wasm/sharedPhysics';
import type { RemotePlayer } from './netcodeClient';
import type { DestructibleTuning } from '../physics/destructibleTuning';
import { vehicleTuningFromArray, type VehicleTuning } from '../physics/vehicleTuning';

export type LocalPracticeClientConfig = {
  onDisconnect?: (reason?: string) => void;
  onLocalSnapshot?: (ackInputSeq: number, state: NetPlayerState) => void;
  onLocalVehicleSnapshot?: (vehicleState: NetVehicleState, ackInputSeq: number) => void;
  worldJson?: string;
  destructibleTuning?: DestructibleTuning;
};

export interface PracticeBotHost {
  readonly remotePlayers: Map<number, RemotePlayer>;
  readonly vehicles: Map<number, VehicleStateMeters>;
  readonly playerId: number;
  readonly localPlayerHp: number;
  readonly localPlayerFlags: number;

  connectBot(botId: number): boolean;
  disconnectBot(botId: number): boolean;
  setBotMaxSpeed(botId: number, maxSpeedMps: number | null): boolean;
  sendBotInputs(botId: number, cmds: InputCmd[]): void;
}

export class LocalPracticeClient implements PracticeBotHost {
  readonly interpolator = new PlayerInterpolator();
  readonly serverClock = new ServerClockEstimator();
  readonly remotePlayers = new Map<number, RemotePlayer>();
  readonly dynamicBodies = new Map<number, DynamicBodyStateMeters>();
  readonly vehicles = new Map<number, VehicleStateMeters>();
  readonly batteries = new Map<number, BatteryStateMeters>();

  playerId = 0;
  latestServerTick = 0;
  interpolationDelayMs = 0;
  dynamicBodyInterpolationDelayMs = 0;
  localPlayerHp = 100;
  localPlayerEnergy = 0;
  localPlayerFlags = 0;
  rttMs = 0;
  currentAckInputSeq = 0;
  currentLocalPlayerState: NetPlayerState | null = null;
  currentLocalVehicleState: NetVehicleState | null = null;

  private readonly dynamicBodyServerTimeUs = new Map<number, number>();
  private readonly vehicleServerTimeUs = new Map<number, number>();
  private readonly debugTelemetry = new NetDebugTelemetry();
  private session: WasmLocalSessionInstance | null = null;
  private frameHandle: number | null = null;
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
    client.session = new WasmLocalSession(
      config.worldJson,
      config.destructibleTuning?.wallMaterialScale,
      config.destructibleTuning?.towerMaterialScale,
    );
    client.session.connect();
    client.syncFromSession(false);
    client.startTickLoop();
    return client;
  }

  ping(): void {}

  setDestructiblesLogging(enabled: boolean): void {
    const session = this.session as (WasmLocalSessionInstance & {
      setDestructiblesLogging?: (enabled: boolean) => void;
    }) | null;
    session?.setDestructiblesLogging?.(enabled);
  }

  getVehicleTuning(): VehicleTuning | null {
    const session = this.session as (WasmLocalSessionInstance & {
      getVehicleTuning?: () => Float32Array | number[];
    }) | null;
    if (!session?.getVehicleTuning) return null;
    return vehicleTuningFromArray(session.getVehicleTuning());
  }

  setVehicleTuning(tuning: VehicleTuning): void {
    const session = this.session as (WasmLocalSessionInstance & {
      setVehicleTuning?: (
        maxSteerRad: number,
        engineForce: number,
        brakeForce: number,
        chassisMassKg: number,
        suspensionStiffness: number,
        suspensionDamping: number,
        suspensionMaxForce: number,
        suspensionRestLength: number,
        suspensionTravel: number,
        wheelRadius: number,
        frictionSlip: number,
      ) => void;
    }) | null;
    session?.setVehicleTuning?.(
      tuning.maxSteerRad,
      tuning.engineForce,
      tuning.brakeForce,
      tuning.chassisMassKg,
      tuning.suspensionStiffness,
      tuning.suspensionDamping,
      tuning.suspensionMaxForce,
      tuning.suspensionRestLength,
      tuning.suspensionTravel,
      tuning.wheelRadius,
      tuning.frictionSlip,
    );
  }

  disconnect(): void {
    this.closedByClient = true;
    if (this.frameHandle != null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
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

  connectBot(botId: number): boolean {
    const added = this.session?.connectBot(botId >>> 0) ?? false;
    if (added) {
      this.syncFromSession(true);
    }
    return added;
  }

  disconnectBot(botId: number): boolean {
    const removed = this.session?.disconnectBot(botId >>> 0) ?? false;
    if (removed) {
      this.syncFromSession(true);
    }
    return removed;
  }

  setBotMaxSpeed(botId: number, maxSpeedMps: number | null): boolean {
    const session = this.session;
    if (!session) return false;
    const value = maxSpeedMps == null ? -1 : maxSpeedMps;
    return session.setBotMaxSpeed(botId >>> 0, value);
  }

  sendBotInputs(botId: number, cmds: InputCmd[]): void {
    const session = this.session;
    if (!session || cmds.length === 0) return;
    try {
      session.handleBotPacket(botId >>> 0, encodeInputBundle(cmds));
    } catch (error) {
      console.warn('[local-practice] bot input rejected', error);
    }
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

  getDebugRenderBuffers(modeBits: number): WasmDebugRenderBuffers | null {
    const session = this.session;
    if (!session || modeBits === 0) return null;
    return session.debugRender(modeBits);
  }

  getDestructibleChunkTransforms(): Float32Array {
    return this.session?.getDestructibleChunkTransforms() ?? new Float32Array(0);
  }

  getDestructibleDebugState(): number[] {
    return this.session ? Array.from(this.session.getDestructibleDebugState()) : [];
  }

  getDestructibleDebugConfig(): number[] {
    return this.session ? Array.from(this.session.getDestructibleDebugConfig()) : [];
  }

  drainDestructibleFractureEvents(): Uint32Array {
    return this.session?.drainDestructibleFractureEvents() ?? new Uint32Array(0);
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
    const step = (nowMs: number) => {
      if (!this.session || this.closedByClient) {
        return;
      }
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
      this.frameHandle = requestAnimationFrame(step);
    };
    this.frameHandle = requestAnimationFrame(step);
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
      this.localPlayerEnergy = playerState.energyCenti / 100;
      this.localPlayerFlags = playerState.flags;
      if (emitCallbacks) {
        this.config.onLocalSnapshot?.(ackInputSeq, playerState);
      }
    }

    this.syncRemotePlayers(serverTimeUs, session.getRemotePlayerStates());
    this.syncDynamicBodies(serverTimeUs, session.getDynamicBodyStates());
    const localVehicleState = this.syncVehicles(serverTimeUs, session.getVehicleStates());
    this.syncBatteries(session.getBatteryStates());
    this.currentLocalVehicleState = localVehicleState;
    if (localVehicleState && emitCallbacks) {
      this.config.onLocalVehicleSnapshot?.(localVehicleState, ackInputSeq);
    }

    this.debugTelemetry.observeAcceptedSnapshot(
      'direct',
      this.latestServerTick,
      (playerState ? 1 : 0) + this.remotePlayers.size,
      this.dynamicBodies.size,
    );
  }

  private syncRemotePlayers(serverTimeUs: number, raw: ArrayLike<number>): void {
    const activeIds = new Set<number>();
    for (const state of decodeLocalSessionPlayers(raw)) {
      activeIds.add(state.id);
      const meters = netPlayerStateToMeters(state);
      this.interpolator.push(state.id, {
        serverTimeUs,
        position: meters.position,
        velocity: meters.velocity,
        yaw: meters.yaw,
        pitch: meters.pitch,
        hp: meters.hp,
        flags: state.flags,
      });
      this.remotePlayers.set(state.id, {
        id: state.id,
        position: meters.position,
        yaw: meters.yaw,
        pitch: meters.pitch,
        hp: meters.hp,
      });
    }

    for (const id of [...this.remotePlayers.keys()]) {
      if (!activeIds.has(id)) {
        this.remotePlayers.delete(id);
        this.interpolator.remove(id);
      }
    }
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

  private syncBatteries(raw: ArrayLike<number>): void {
    const activeIds = new Set<number>();
    for (const battery of decodeLocalSessionBatteries(raw)) {
      activeIds.add(battery.id);
      this.batteries.set(battery.id, battery);
    }

    for (const id of [...this.batteries.keys()]) {
      if (!activeIds.has(id)) {
        this.batteries.delete(id);
      }
    }
  }
}
