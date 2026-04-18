import { resolveMultiplayerBackend } from '../app/runtimeConfig';
import { initSharedPhysics, WasmSimWorld, type WasmDebugRenderBuffers, type WasmSimWorldInstance } from '../wasm/sharedPhysics';
import { LocalPracticeClient, type PracticeBotHost } from '../net/localPracticeClient';
import { NetDebugTelemetry } from '../net/debugTelemetry';
import { NetcodeClient, type RemotePlayer } from '../net/netcodeClient';
import {
  PlayerInterpolator,
  ServerClockEstimator,
  type DynamicBodySample,
  type VehicleSample,
} from '../net/interpolation';
import {
  type BatteryStateMeters,
  DYNAMIC_BODY_IMPULSE,
  type BlockEditCmd,
  type DynamicBodyStateMeters,
  type FireCmd,
  type InputCmd,
  type NetPlayerState,
  type NetVehicleState,
  type ServerPacket,
  type ServerWorldPacket,
  type VehicleStateMeters,
} from '../net/protocol';
import { netPlayerStateToMeters } from '../net/protocol';
import type { SemanticInputState } from '../input/types';
import { PredictionManager } from '../physics/predictionManager';
import { VehiclePredictionManager } from '../physics/vehiclePredictionManager';
import { DynamicBodyPredictionManager } from '../physics/dynamicBodyPredictionManager';
import type { RenderBlock } from '../world/voxelWorld';
import { decodeVehicleDebugSnapshot, type VehicleDebugSnapshot } from './vehicleDebug';
import { FixedInputBundler } from './fixedInputBundler';
import { getOrCreatePlayerIdentity } from './playerIdentity';

type MultiplayerBackend = ReturnType<typeof resolveMultiplayerBackend>;

export type RuntimeDebugStats = {
  pendingInputs: number;
  predictionTicks: number;
  playerCorrectionMagnitude: number;
  vehicleCorrectionMagnitude: number;
  dynamicGlobalMaxCorrectionMagnitude: number;
  dynamicNearPlayerMaxCorrectionMagnitude: number;
  dynamicInteractiveMaxCorrectionMagnitude: number;
  dynamicOverThresholdCount: number;
  dynamicTrackedBodies: number;
  dynamicInteractiveBodies: number;
  lastDynamicShotBodyId: number;
  lastDynamicShotAgeMs: number;
  vehiclePendingInputs: number;
  vehicleAckSeq: number;
  vehicleLatestLocalSeq: number;
  vehiclePendingInputsAgeMs: number;
  vehicleAckBacklogMs: number;
  vehicleResendWindow: number;
  vehicleReplayErrorM: number;
  vehiclePosErrorM: number;
  vehicleVelErrorMs: number;
  vehicleRotErrorRad: number;
  vehicleCorrectionAgeMs: number;
  physicsStepMs: number;
  velocity: [number, number, number];
};

export type DynamicBodyShotDiagnostic = {
  proxyHitBodyId: number | null;
  proxyHitToi: number | null;
  blockerDistance: number | null;
  blockedByBlocker: boolean;
  localPredictedDeltaM: number | null;
};

export type RuntimeConnectionState = {
  socket: unknown;
  playerId: number;
  remoteInterpolator: PlayerInterpolator;
  serverClock: ServerClockEstimator;
  interpolationDelayMs: number;
  dynamicBodyInterpolationDelayMs: number;
  latestServerTick: number;
  remotePlayers: Map<number, RemotePlayer>;
  dynamicBodies: Map<number, DynamicBodyStateMeters>;
  localPosition: [number, number, number];
};

export type GameRuntimeCallbacks = {
  onWelcome: (playerId: number) => void;
  onDisconnect: (reason?: string) => void;
  onSnapshot?: () => void;
  onRenderBlocksChanged?: (blocks: RenderBlock[]) => void;
};

export interface GameRuntimeClient {
  readonly usesLocalAuthority: boolean;
  readonly transport: string;
  readonly interpolator: PlayerInterpolator;
  readonly serverClock: ServerClockEstimator;
  readonly remotePlayers: Map<number, RemotePlayer>;
  readonly dynamicBodies: Map<number, DynamicBodyStateMeters>;
  readonly vehicles: Map<number, VehicleStateMeters>;
  readonly batteries: Map<number, BatteryStateMeters>;
  readonly state: RuntimeConnectionState;
  readonly playerId: number;
  readonly latestServerTick: number;
  readonly interpolationDelayMs: number;
  readonly dynamicBodyInterpolationDelayMs: number;
  readonly localPlayerHp: number;
  readonly localPlayerEnergy: number;
  readonly localPlayerFlags: number;
  readonly rttMs: number;
  readonly renderBlocks: RenderBlock[];

  connect(): Promise<void>;
  disconnect(): void;
  resetInputState(): void;
  submitInput(frameDeltaSec: number, input: SemanticInputState): void;
  peekNextInputSeq(): number;
  supportsBlockEditing(): boolean;
  supportsRemotePlayerHitscan(): boolean;
  syncVehicleAuthority(): void;
  sendInputs(cmds: InputCmd[]): void;
  sendFire(cmd: FireCmd): void;
  sendBlockEdit(cmd: BlockEditCmd): void;
  sendVehicleEnter(vehicleId: number, seat?: number): void;
  sendVehicleExit(vehicleId: number): void;
  sampleRemoteVehicle(id: number, renderTimeUs?: number): VehicleSample | null;
  getVehicleObservedAgeMs(id: number, localTimeUs?: number): number | null;
  sampleRemoteDynamicBody(id: number, renderTimeUs?: number): DynamicBodySample | null;
  getDynamicBodyRenderTimeUs(localTimeUs?: number): number;
  getDynamicBodyObservedAgeMs(id: number, localTimeUs?: number): number | null;
  recordFrameDebugMetrics(
    playerCorrectionMagnitude: number,
    vehicleCorrectionMagnitude: number,
    dynamicCorrectionMagnitude: number,
    pendingInputCount: number,
  ): void;
  accumulateDebugStats(correctionM: number, physicsStepMs: number): void;
  recordLocalShotFired(
    shotId: number,
    shot: Parameters<NetcodeClient['recordLocalShotFired']>[1],
  ): void;
  getDebugTelemetrySnapshot(): ReturnType<NetcodeClient['getDebugTelemetrySnapshot']>;

  applyWorldPacket(packet: ServerWorldPacket): void;
  update(
    frameDeltaSec: number,
    input: SemanticInputState,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void;
  reconcile(ackInputSeq: number, playerState: NetPlayerState): void;
  getPosition(): [number, number, number] | null;
  raycastBlocks(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance?: number,
  ): {
    point: [number, number, number];
    normal: [number, number, number];
    removeCell: [number, number, number];
    placeCell: [number, number, number];
  } | null;
  raycastScene(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance?: number,
  ): { toi: number } | null;
  classifyHitscanPlayer(
    origin: [number, number, number],
    direction: [number, number, number],
    bodyCenter: [number, number, number],
    blockerDistance: number | null,
  ): { distance: number; kind: number } | null;
  buildBlockEdit(cell: [number, number, number], op: number, material: number): BlockEditCmd | null;
  applyOptimisticEdit(cmd: BlockEditCmd): void;
  getBlockMaterial(cell: [number, number, number]): number;
  updateDynamicBodies(bodies: DynamicBodyStateMeters[]): void;
  advanceDynamicBodies(frameDeltaSec: number, allowProxyStep: boolean): void;
  getDynamicBodyRenderState(id: number): DynamicBodyStateMeters | null;
  getDynamicBodyPhysicsState(id: number): DynamicBodyStateMeters | null;
  predictDynamicBodyShot(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance?: number,
    blockerDistance?: number | null,
  ): { bodyId: number | null; diagnostic: DynamicBodyShotDiagnostic };
  hasRecentDynamicBodyInteraction(id: number): boolean;
  getRenderedDynamicBodyState(id: number): DynamicBodyStateMeters | null;
  listDynamicBodyProxyStates(): Array<{
    id: number;
    position: [number, number, number];
    halfExtents: [number, number, number];
  }>;
  getNextSeq(): number;
  getDebugRenderBuffers(modeBits: number): WasmDebugRenderBuffers | null;
  getDebugStats(): RuntimeDebugStats;
  spawnVehicle(
    id: number,
    vehicleType: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void;
  removeVehicle(id: number): void;
  syncRemoteVehicle(
    id: number,
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
  ): void;
  syncBroadPhase(): void;
  enterVehicle(vehicleId: number, initState: NetVehicleState): void;
  exitVehicle(): void;
  updateVehicle(
    frameDeltaSec: number,
    input: SemanticInputState,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void;
  reconcileVehicle(vehicleState: NetVehicleState, ackInputSeq: number): void;
  getVehiclePose(): { position: [number, number, number]; quaternion: [number, number, number, number] } | null;
  getDrivenVehicleId(): number | null;
  getLocalVehicleDebug(vehicleId: number): VehicleDebugSnapshot | null;
  isInVehicle(): boolean;
  getPracticeBotHost(): PracticeBotHost | null;
}

function createDefaultConnectionState(): RuntimeConnectionState {
  return {
    socket: null,
    playerId: 0,
    remoteInterpolator: new PlayerInterpolator(),
    serverClock: new ServerClockEstimator(),
    interpolationDelayMs: 100,
    dynamicBodyInterpolationDelayMs: 16,
    latestServerTick: 0,
    remotePlayers: new Map(),
    dynamicBodies: new Map(),
    localPosition: [0, 2, 0],
  };
}

function defaultDebugStats(): RuntimeDebugStats {
  return {
    pendingInputs: 0,
    predictionTicks: 0,
    playerCorrectionMagnitude: 0,
    vehicleCorrectionMagnitude: 0,
    dynamicGlobalMaxCorrectionMagnitude: 0,
    dynamicNearPlayerMaxCorrectionMagnitude: 0,
    dynamicInteractiveMaxCorrectionMagnitude: 0,
    dynamicOverThresholdCount: 0,
    dynamicTrackedBodies: 0,
    dynamicInteractiveBodies: 0,
    lastDynamicShotBodyId: 0,
    lastDynamicShotAgeMs: -1,
    vehiclePendingInputs: 0,
    vehicleAckSeq: 0,
    vehicleLatestLocalSeq: 0,
    vehiclePendingInputsAgeMs: 0,
    vehicleAckBacklogMs: 0,
    vehicleResendWindow: 0,
    vehicleReplayErrorM: 0,
    vehiclePosErrorM: 0,
    vehicleVelErrorMs: 0,
    vehicleRotErrorRad: 0,
    vehicleCorrectionAgeMs: -1,
    physicsStepMs: 0,
    velocity: [0, 0, 0],
  };
}

const EMPTY_DEBUG_TELEMETRY_SNAPSHOT = new NetDebugTelemetry().snapshot();
const EMPTY_BATTERIES = new Map<number, BatteryStateMeters>();

function pointToCell(point: [number, number, number]): [number, number, number] {
  return [Math.floor(point[0]), Math.floor(point[1]), Math.floor(point[2])];
}

abstract class BaseGameRuntime implements GameRuntimeClient {
  readonly state = createDefaultConnectionState();

  protected _renderBlocks: RenderBlock[] = [];

  constructor(protected readonly callbacks: GameRuntimeCallbacks) {}

  abstract get usesLocalAuthority(): boolean;
  abstract get transport(): string;
  abstract get interpolator(): PlayerInterpolator;
  abstract get serverClock(): ServerClockEstimator;
  abstract get remotePlayers(): Map<number, RemotePlayer>;
  abstract get dynamicBodies(): Map<number, DynamicBodyStateMeters>;
  abstract get vehicles(): Map<number, VehicleStateMeters>;
  abstract get batteries(): Map<number, BatteryStateMeters>;
  abstract get playerId(): number;
  abstract get latestServerTick(): number;
  abstract get interpolationDelayMs(): number;
  abstract get dynamicBodyInterpolationDelayMs(): number;
  abstract get localPlayerHp(): number;
  abstract get localPlayerEnergy(): number;
  abstract get localPlayerFlags(): number;
  abstract get rttMs(): number;

  get renderBlocks(): RenderBlock[] {
    return this._renderBlocks;
  }

  protected syncState(): void {
    this.state.playerId = this.playerId;
    this.state.remoteInterpolator = this.interpolator;
    this.state.serverClock = this.serverClock;
    this.state.interpolationDelayMs = this.interpolationDelayMs;
    this.state.dynamicBodyInterpolationDelayMs = this.dynamicBodyInterpolationDelayMs;
    this.state.latestServerTick = this.latestServerTick;
    this.state.remotePlayers = this.remotePlayers;
    this.state.dynamicBodies = this.dynamicBodies;
  }

  protected setLocalPosition(position: [number, number, number]): void {
    this.state.localPosition = position;
  }

  protected setRenderBlocks(blocks: RenderBlock[]): void {
    this._renderBlocks = blocks;
    this.callbacks.onRenderBlocksChanged?.(blocks);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract resetInputState(): void;
  abstract submitInput(frameDeltaSec: number, input: SemanticInputState): void;
  abstract peekNextInputSeq(): number;
  abstract supportsBlockEditing(): boolean;
  abstract supportsRemotePlayerHitscan(): boolean;
  abstract syncVehicleAuthority(): void;
  abstract sendInputs(cmds: InputCmd[]): void;
  abstract sendFire(cmd: FireCmd): void;
  abstract sendBlockEdit(cmd: BlockEditCmd): void;
  abstract sendVehicleEnter(vehicleId: number, seat?: number): void;
  abstract sendVehicleExit(vehicleId: number): void;
  abstract sampleRemoteVehicle(id: number, renderTimeUs?: number): VehicleSample | null;
  abstract getVehicleObservedAgeMs(id: number, localTimeUs?: number): number | null;
  abstract sampleRemoteDynamicBody(id: number, renderTimeUs?: number): DynamicBodySample | null;
  abstract getDynamicBodyRenderTimeUs(localTimeUs?: number): number;
  abstract getDynamicBodyObservedAgeMs(id: number, localTimeUs?: number): number | null;
  abstract recordFrameDebugMetrics(
    playerCorrectionMagnitude: number,
    vehicleCorrectionMagnitude: number,
    dynamicCorrectionMagnitude: number,
    pendingInputCount: number,
  ): void;
  abstract accumulateDebugStats(correctionM: number, physicsStepMs: number): void;
  abstract recordLocalShotFired(
    shotId: number,
    shot: Parameters<NetcodeClient['recordLocalShotFired']>[1],
  ): void;
  abstract getDebugTelemetrySnapshot(): ReturnType<NetcodeClient['getDebugTelemetrySnapshot']>;
  abstract applyWorldPacket(packet: ServerWorldPacket): void;
  abstract update(
    frameDeltaSec: number,
    input: SemanticInputState,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void;
  abstract reconcile(ackInputSeq: number, playerState: NetPlayerState): void;
  abstract getPosition(): [number, number, number] | null;
  abstract raycastBlocks(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance?: number,
  ): {
    point: [number, number, number];
    normal: [number, number, number];
    removeCell: [number, number, number];
    placeCell: [number, number, number];
  } | null;
  abstract raycastScene(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance?: number,
  ): { toi: number } | null;
  abstract classifyHitscanPlayer(
    origin: [number, number, number],
    direction: [number, number, number],
    bodyCenter: [number, number, number],
    blockerDistance: number | null,
  ): { distance: number; kind: number } | null;
  abstract buildBlockEdit(cell: [number, number, number], op: number, material: number): BlockEditCmd | null;
  abstract applyOptimisticEdit(cmd: BlockEditCmd): void;
  abstract getBlockMaterial(cell: [number, number, number]): number;
  abstract updateDynamicBodies(bodies: DynamicBodyStateMeters[]): void;
  abstract advanceDynamicBodies(frameDeltaSec: number, allowProxyStep: boolean): void;
  abstract getDynamicBodyRenderState(id: number): DynamicBodyStateMeters | null;
  abstract getDynamicBodyPhysicsState(id: number): DynamicBodyStateMeters | null;
  abstract predictDynamicBodyShot(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance?: number,
    blockerDistance?: number | null,
  ): { bodyId: number | null; diagnostic: DynamicBodyShotDiagnostic };
  abstract hasRecentDynamicBodyInteraction(id: number): boolean;
  abstract getRenderedDynamicBodyState(id: number): DynamicBodyStateMeters | null;
  abstract listDynamicBodyProxyStates(): Array<{
    id: number;
    position: [number, number, number];
    halfExtents: [number, number, number];
  }>;
  abstract getNextSeq(): number;
  abstract getDebugRenderBuffers(modeBits: number): WasmDebugRenderBuffers | null;
  abstract getDebugStats(): RuntimeDebugStats;
  abstract spawnVehicle(
    id: number,
    vehicleType: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void;
  abstract removeVehicle(id: number): void;
  abstract syncRemoteVehicle(
    id: number,
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
  ): void;
  abstract syncBroadPhase(): void;
  abstract enterVehicle(vehicleId: number, initState: NetVehicleState): void;
  abstract exitVehicle(): void;
  abstract updateVehicle(
    frameDeltaSec: number,
    input: SemanticInputState,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void;
  abstract reconcileVehicle(vehicleState: NetVehicleState, ackInputSeq: number): void;
  abstract getVehiclePose(): { position: [number, number, number]; quaternion: [number, number, number, number] } | null;
  abstract getDrivenVehicleId(): number | null;
  abstract getLocalVehicleDebug(vehicleId: number): VehicleDebugSnapshot | null;
  abstract isInVehicle(): boolean;
  abstract getPracticeBotHost(): PracticeBotHost | null;
}

export class LocalGameRuntime extends BaseGameRuntime {
  private client: LocalPracticeClient | null = null;
  private readonly inputBundler = new FixedInputBundler(1 / 60, 4);

  constructor(
    callbacks: GameRuntimeCallbacks,
    private readonly worldJson?: string,
  ) {
    super(callbacks);
  }

  get usesLocalAuthority(): boolean {
    return true;
  }

  get transport(): string {
    return this.client?.transport ?? 'connecting';
  }

  get interpolator(): PlayerInterpolator {
    return this.client?.interpolator ?? this.state.remoteInterpolator;
  }

  get serverClock(): ServerClockEstimator {
    return this.client?.serverClock ?? this.state.serverClock;
  }

  get remotePlayers(): Map<number, RemotePlayer> {
    return this.client?.remotePlayers ?? this.state.remotePlayers;
  }

  get dynamicBodies(): Map<number, DynamicBodyStateMeters> {
    return this.client?.dynamicBodies ?? this.state.dynamicBodies;
  }

  get vehicles(): Map<number, VehicleStateMeters> {
    return this.client?.vehicles ?? new Map<number, VehicleStateMeters>();
  }

  get batteries(): Map<number, BatteryStateMeters> {
    return this.client?.batteries ?? EMPTY_BATTERIES;
  }

  get playerId(): number {
    return this.client?.playerId ?? 0;
  }

  get latestServerTick(): number {
    return this.client?.latestServerTick ?? 0;
  }

  get interpolationDelayMs(): number {
    return this.client?.interpolationDelayMs ?? 0;
  }

  get dynamicBodyInterpolationDelayMs(): number {
    return this.client?.dynamicBodyInterpolationDelayMs ?? 0;
  }

  get localPlayerHp(): number {
    return this.client?.localPlayerHp ?? 100;
  }

  get localPlayerEnergy(): number {
    return this.client?.localPlayerEnergy ?? 0;
  }

  get localPlayerFlags(): number {
    return this.client?.localPlayerFlags ?? 0;
  }

  get rttMs(): number {
    return this.client?.rttMs ?? 0;
  }

  async connect(): Promise<void> {
    const client = await LocalPracticeClient.connect({
      worldJson: this.worldJson,
      onDisconnect: (reason) => {
        this.callbacks.onDisconnect(reason);
      },
      onLocalSnapshot: (ackInputSeq, state) => {
        const meters = netPlayerStateToMeters(state);
        this.setLocalPosition(meters.position);
        this.syncState();
        this.callbacks.onSnapshot?.();
        void ackInputSeq;
      },
    });
    this.client = client;
    this.state.remoteInterpolator = client.interpolator;
    this.state.serverClock = client.serverClock;
    this.state.remotePlayers = client.remotePlayers;
    this.state.dynamicBodies = client.dynamicBodies;
    this.setLocalPosition(
      client.currentLocalPlayerState ? netPlayerStateToMeters(client.currentLocalPlayerState).position : [0, 2, 0],
    );
    this.syncState();
    this.callbacks.onWelcome(client.playerId);
    client.emitCurrentState();
  }

  disconnect(): void {
    this.client?.disconnect();
    this.client = null;
    this.inputBundler.reset(1);
  }

  resetInputState(): void {
    this.inputBundler.reset(1);
  }

  submitInput(frameDeltaSec: number, input: SemanticInputState): void {
    const cmds = this.inputBundler.produce(frameDeltaSec, input);
    if (cmds.length > 0) {
      this.sendInputs(cmds);
    }
  }

  peekNextInputSeq(): number {
    return this.inputBundler.peekNextSeq();
  }

  supportsBlockEditing(): boolean {
    return false;
  }

  supportsRemotePlayerHitscan(): boolean {
    return false;
  }

  syncVehicleAuthority(): void {
  }

  sendInputs(cmds: InputCmd[]): void {
    this.client?.sendInputs(cmds);
  }

  sendFire(cmd: FireCmd): void {
    this.client?.sendFire(cmd);
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    this.client?.sendBlockEdit(cmd);
  }

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    this.client?.sendVehicleEnter(vehicleId, seat);
  }

  sendVehicleExit(vehicleId: number): void {
    this.client?.sendVehicleExit(vehicleId);
  }

  sampleRemoteVehicle(id: number, renderTimeUs?: number): VehicleSample | null {
    return this.client?.sampleRemoteVehicle(id, renderTimeUs) ?? null;
  }

  getVehicleObservedAgeMs(id: number, localTimeUs?: number): number | null {
    return this.client?.getVehicleObservedAgeMs(id, localTimeUs) ?? null;
  }

  sampleRemoteDynamicBody(id: number, renderTimeUs?: number): DynamicBodySample | null {
    return this.client?.sampleRemoteDynamicBody(id, renderTimeUs) ?? null;
  }

  getDynamicBodyRenderTimeUs(localTimeUs?: number): number {
    return this.client?.getDynamicBodyRenderTimeUs(localTimeUs) ?? 0;
  }

  getDynamicBodyObservedAgeMs(id: number, localTimeUs?: number): number | null {
    return this.client?.getDynamicBodyObservedAgeMs(id, localTimeUs) ?? null;
  }

  recordFrameDebugMetrics(
    playerCorrectionMagnitude: number,
    vehicleCorrectionMagnitude: number,
    dynamicCorrectionMagnitude: number,
    pendingInputCount: number,
  ): void {
    this.client?.recordFrameDebugMetrics(
      playerCorrectionMagnitude,
      vehicleCorrectionMagnitude,
      dynamicCorrectionMagnitude,
      pendingInputCount,
    );
  }

  accumulateDebugStats(correctionM: number, physicsStepMs: number): void {
    this.client?.accumulateDebugStats(correctionM, physicsStepMs);
  }

  recordLocalShotFired(
    shotId: number,
    shot: Parameters<NetcodeClient['recordLocalShotFired']>[1],
  ): void {
    this.client?.recordLocalShotFired(shotId, shot);
  }

  getDebugTelemetrySnapshot() {
    return this.client?.getDebugTelemetrySnapshot() ?? EMPTY_DEBUG_TELEMETRY_SNAPSHOT;
  }

  applyWorldPacket(_packet: ServerWorldPacket): void {}

  update(
    _frameDeltaSec: number,
    _input: SemanticInputState,
    _sendInputs: (cmds: InputCmd[]) => void,
  ): void {}

  reconcile(_ackInputSeq: number, _playerState: NetPlayerState): void {}

  getPosition(): [number, number, number] | null {
    return this.client?.currentLocalPlayerState
      ? netPlayerStateToMeters(this.client.currentLocalPlayerState).position
      : this.state.localPosition;
  }

  raycastBlocks(): null {
    return null;
  }

  raycastScene(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance = 1000,
  ): { toi: number } | null {
    return this.client?.castSceneRay(origin, direction, maxDistance) ?? null;
  }

  classifyHitscanPlayer(): { distance: number; kind: number } | null {
    return null;
  }

  buildBlockEdit(): BlockEditCmd | null {
    return null;
  }

  applyOptimisticEdit(_cmd: BlockEditCmd): void {}

  getBlockMaterial(): number {
    return 0;
  }

  updateDynamicBodies(_bodies: DynamicBodyStateMeters[]): void {}

  advanceDynamicBodies(_frameDeltaSec: number, _allowProxyStep: boolean): void {}

  getDynamicBodyRenderState(id: number): DynamicBodyStateMeters | null {
    return this.dynamicBodies.get(id) ?? null;
  }

  getDynamicBodyPhysicsState(id: number): DynamicBodyStateMeters | null {
    return this.dynamicBodies.get(id) ?? null;
  }

  predictDynamicBodyShot(
    _origin: [number, number, number],
    _direction: [number, number, number],
    _maxDistance = 1000,
    blockerDistance: number | null = null,
  ): { bodyId: number | null; diagnostic: DynamicBodyShotDiagnostic } {
    return {
      bodyId: null,
      diagnostic: {
        proxyHitBodyId: null,
        proxyHitToi: null,
        blockerDistance,
        blockedByBlocker: false,
        localPredictedDeltaM: null,
      },
    };
  }

  hasRecentDynamicBodyInteraction(_id: number): boolean {
    return false;
  }

  getRenderedDynamicBodyState(id: number): DynamicBodyStateMeters | null {
    return this.dynamicBodies.get(id) ?? null;
  }

  listDynamicBodyProxyStates(): Array<{
    id: number;
    position: [number, number, number];
    halfExtents: [number, number, number];
  }> {
    return [];
  }

  getNextSeq(): number {
    return 0;
  }

  getDebugRenderBuffers(_modeBits: number): WasmDebugRenderBuffers | null {
    return null;
  }

  getDebugStats(): RuntimeDebugStats {
    return {
      ...defaultDebugStats(),
      vehicleAckSeq: this.client?.currentAckInputSeq ?? 0,
      vehicleLatestLocalSeq: this.inputBundler.peekNextSeq(),
      velocity: this.client?.currentLocalPlayerState
        ? netPlayerStateToMeters(this.client.currentLocalPlayerState).velocity
        : [0, 0, 0],
    };
  }

  spawnVehicle(): void {}

  removeVehicle(): void {}

  syncRemoteVehicle(): void {}

  syncBroadPhase(): void {}

  enterVehicle(_vehicleId: number, _initState: NetVehicleState): void {}

  exitVehicle(): void {}

  updateVehicle(
    _frameDeltaSec: number,
    _input: SemanticInputState,
    _sendInputs: (cmds: InputCmd[]) => void,
  ): void {}

  reconcileVehicle(_vehicleState: NetVehicleState, _ackInputSeq: number): void {}

  getVehiclePose(): { position: [number, number, number]; quaternion: [number, number, number, number] } | null {
    const state = this.client?.currentLocalVehicleState;
    if (!state) {
      return null;
    }
    const meters = this.vehicles.get(state.id);
    if (!meters) {
      return null;
    }
    return {
      position: meters.position,
      quaternion: meters.quaternion,
    };
  }

  getDrivenVehicleId(): number | null {
    return this.client?.currentLocalVehicleState?.id ?? null;
  }

  getLocalVehicleDebug(vehicleId: number): VehicleDebugSnapshot | null {
    return this.client?.getVehicleDebug(vehicleId) ?? null;
  }

  isInVehicle(): boolean {
    return this.getDrivenVehicleId() != null;
  }

  getPracticeBotHost(): PracticeBotHost | null {
    return this.client;
  }
}

export class MultiplayerGameRuntime extends BaseGameRuntime {
  private client: NetcodeClient | null = null;
  private sim: WasmSimWorldInstance | null = null;
  private prediction: PredictionManager | null = null;
  private vehiclePrediction: VehiclePredictionManager | null = null;
  private dynamicBodiesPrediction: DynamicBodyPredictionManager | null = null;
  private pendingWorldPackets: ServerWorldPacket[] = [];
  private lastPredictedDynamicShot: { bodyId: number; atMs: number } | null = null;
  private readonly knownVehicleIds = new Set<number>();

  constructor(
    callbacks: GameRuntimeCallbacks,
    private readonly backend: MultiplayerBackend,
    private readonly matchId: string,
    private readonly worldJson: string | undefined,
    private readonly localRenderSmoothingEnabled: boolean,
  ) {
    super(callbacks);
  }

  get usesLocalAuthority(): boolean {
    return false;
  }

  get transport(): string {
    return this.client?.transport ?? 'connecting';
  }

  get interpolator(): PlayerInterpolator {
    return this.client?.interpolator ?? this.state.remoteInterpolator;
  }

  get serverClock(): ServerClockEstimator {
    return this.client?.serverClock ?? this.state.serverClock;
  }

  get remotePlayers(): Map<number, RemotePlayer> {
    return this.client?.remotePlayers ?? this.state.remotePlayers;
  }

  get dynamicBodies(): Map<number, DynamicBodyStateMeters> {
    return this.client?.dynamicBodies ?? this.state.dynamicBodies;
  }

  get vehicles(): Map<number, VehicleStateMeters> {
    return this.client?.vehicles ?? new Map<number, VehicleStateMeters>();
  }

  get batteries(): Map<number, BatteryStateMeters> {
    return this.client?.batteries ?? EMPTY_BATTERIES;
  }

  get playerId(): number {
    return this.client?.playerId ?? 0;
  }

  get latestServerTick(): number {
    return this.client?.latestServerTick ?? 0;
  }

  get interpolationDelayMs(): number {
    return this.client?.interpolationDelayMs ?? 100;
  }

  get dynamicBodyInterpolationDelayMs(): number {
    return this.client?.dynamicBodyInterpolationDelayMs ?? NetcodeClient.MAX_DYNAMIC_BODY_INTERPOLATION_DELAY_MS;
  }

  get localPlayerHp(): number {
    return this.client?.localPlayerHp ?? 100;
  }

  get localPlayerEnergy(): number {
    return this.client?.localPlayerEnergy ?? 0;
  }

  get localPlayerFlags(): number {
    return this.client?.localPlayerFlags ?? 0;
  }

  get rttMs(): number {
    return this.client?.rttMs ?? 0;
  }

  async connect(): Promise<void> {
    await initSharedPhysics();

    const sim = new WasmSimWorld();
    if (this.worldJson) {
      sim.loadWorldDocument(this.worldJson);
    } else {
      sim.seedDemoTerrain();
    }
    sim.spawnPlayer(0, 2, 0);
    sim.rebuildBroadPhase();
    this.sim = sim;
    this.prediction = new PredictionManager(sim);
    this.prediction.enableTerrainWorld();
    this.vehiclePrediction = new VehiclePredictionManager(sim);
    this.dynamicBodiesPrediction = new DynamicBodyPredictionManager(sim);
    this.setRenderBlocks(this.prediction.getRenderBlocks());

    const client = new NetcodeClient({
      onWelcome: (playerId) => {
        this.syncState();
        this.callbacks.onWelcome(playerId);
      },
      onDisconnect: (reason) => {
        this.callbacks.onDisconnect(reason);
      },
      onLocalSnapshot: (ackInputSeq, state) => {
        const meters = netPlayerStateToMeters(state);
        this.setLocalPosition(meters.position);
        this.syncState();
        const bodies = Array.from(this.dynamicBodies.values());
        this.dynamicBodiesPrediction?.syncAuthoritativeBodies(bodies);
        if (!this.isInVehicle()) {
          this.reconcile(ackInputSeq, state);
        }
      },
      onLocalVehicleSnapshot: (vehicleState, ackInputSeq) => {
        this.reconcileVehicle(vehicleState, ackInputSeq);
      },
      onWorldPacket: (packet) => {
        this.applyWorldPacket(packet);
      },
      onPacket: (packet) => {
        this.syncState();
        if (packet.type === 'snapshot') {
          this.callbacks.onSnapshot?.();
        }
      },
    });

    this.client = client;
    this.state.remoteInterpolator = client.interpolator;
    this.state.serverClock = client.serverClock;
    this.state.remotePlayers = client.remotePlayers;
    this.state.dynamicBodies = client.dynamicBodies;
    this.syncState();

    const pendingPackets = this.pendingWorldPackets.splice(0);
    for (const packet of pendingPackets) {
      this.applyWorldPacket(packet);
    }

    const identity = getOrCreatePlayerIdentity();
    const token = 'mvp-token';
    const wsUrl = this.backend.createMatchWebSocketUrl(this.matchId, identity, token);
    await client.connectWithFallback(this.matchId, wsUrl, this.backend.sessionConfigEndpoint);
  }

  disconnect(): void {
    this.client?.disconnect();
    this.client = null;
    this.prediction?.dispose();
    this.prediction = null;
    this.vehiclePrediction?.dispose();
    this.vehiclePrediction = null;
    this.dynamicBodiesPrediction?.clear();
    this.dynamicBodiesPrediction = null;
    this.sim = null;
    this.knownVehicleIds.clear();
  }

  resetInputState(): void {
    this.knownVehicleIds.clear();
  }

  submitInput(frameDeltaSec: number, input: SemanticInputState): void {
    if (this.isInVehicle()) {
      this.updateVehicle(frameDeltaSec, input, (cmds) => this.sendInputs(cmds));
      return;
    }
    this.update(frameDeltaSec, input, (cmds) => this.sendInputs(cmds));
  }

  peekNextInputSeq(): number {
    return this.prediction?.getNextSeq() ?? 0;
  }

  supportsBlockEditing(): boolean {
    return true;
  }

  supportsRemotePlayerHitscan(): boolean {
    return true;
  }

  syncVehicleAuthority(): void {
    const client = this.client;
    if (!client) {
      return;
    }
    const serverVehicles = client.vehicles;
    for (const [id, vs] of serverVehicles) {
      if (!this.knownVehicleIds.has(id)) {
        this.knownVehicleIds.add(id);
        this.spawnVehicle(
          id,
          vs.vehicleType ?? 0,
          vs.position[0],
          vs.position[1],
          vs.position[2],
          vs.quaternion[0],
          vs.quaternion[1],
          vs.quaternion[2],
          vs.quaternion[3],
        );
      }
    }
    for (const id of this.knownVehicleIds) {
      if (!serverVehicles.has(id)) {
        this.knownVehicleIds.delete(id);
        this.removeVehicle(id);
      }
    }

    const remoteVehicleRenderTimeUs = this.state.serverClock.renderTimeUs(this.state.interpolationDelayMs * 1000);
    let syncedRemoteVehicles = false;
    for (const [id, vs] of serverVehicles) {
      if (this.isInVehicle() && this.getDrivenVehicleId() === id) {
        continue;
      }
      const sample = client.sampleRemoteVehicle(id, remoteVehicleRenderTimeUs);
      const position = sample?.position ?? vs.position;
      const quaternion = sample?.quaternion ?? vs.quaternion;
      const linearVelocity = sample?.linearVelocity ?? vs.linearVelocity;
      this.syncRemoteVehicle(
        id,
        position[0],
        position[1],
        position[2],
        quaternion[0],
        quaternion[1],
        quaternion[2],
        quaternion[3],
        linearVelocity[0],
        linearVelocity[1],
        linearVelocity[2],
      );
      syncedRemoteVehicles = true;
    }
    if (syncedRemoteVehicles) {
      this.syncBroadPhase();
    }
  }

  sendInputs(cmds: InputCmd[]): void {
    this.client?.sendInputs(cmds);
  }

  sendFire(cmd: FireCmd): void {
    this.client?.sendFire(cmd);
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    this.client?.sendBlockEdit(cmd);
  }

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    this.client?.sendVehicleEnter(vehicleId, seat);
  }

  sendVehicleExit(vehicleId: number): void {
    this.client?.sendVehicleExit(vehicleId);
  }

  sampleRemoteVehicle(id: number, renderTimeUs?: number): VehicleSample | null {
    return this.client?.sampleRemoteVehicle(id, renderTimeUs) ?? null;
  }

  getVehicleObservedAgeMs(id: number, localTimeUs?: number): number | null {
    return this.client?.getVehicleObservedAgeMs(id, localTimeUs) ?? null;
  }

  sampleRemoteDynamicBody(id: number, renderTimeUs?: number): DynamicBodySample | null {
    return this.client?.sampleRemoteDynamicBody(id, renderTimeUs) ?? null;
  }

  getDynamicBodyRenderTimeUs(localTimeUs?: number): number {
    return this.client?.getDynamicBodyRenderTimeUs(localTimeUs) ?? 0;
  }

  getDynamicBodyObservedAgeMs(id: number, localTimeUs?: number): number | null {
    return this.client?.getDynamicBodyObservedAgeMs(id, localTimeUs) ?? null;
  }

  recordFrameDebugMetrics(
    playerCorrectionMagnitude: number,
    vehicleCorrectionMagnitude: number,
    dynamicCorrectionMagnitude: number,
    pendingInputCount: number,
  ): void {
    this.client?.recordFrameDebugMetrics(
      playerCorrectionMagnitude,
      vehicleCorrectionMagnitude,
      dynamicCorrectionMagnitude,
      pendingInputCount,
    );
  }

  accumulateDebugStats(correctionM: number, physicsStepMs: number): void {
    this.client?.accumulateDebugStats(correctionM, physicsStepMs);
  }

  recordLocalShotFired(
    shotId: number,
    shot: Parameters<NetcodeClient['recordLocalShotFired']>[1],
  ): void {
    this.client?.recordLocalShotFired(shotId, shot);
  }

  getDebugTelemetrySnapshot() {
    return this.client?.getDebugTelemetrySnapshot() ?? EMPTY_DEBUG_TELEMETRY_SNAPSHOT;
  }

  applyWorldPacket(packet: ServerWorldPacket): void {
    const prediction = this.prediction;
    if (!prediction) {
      this.pendingWorldPackets.push(packet);
      return;
    }
    prediction.applyWorldPacket(packet);
    this.setRenderBlocks(prediction.getRenderBlocks());
  }

  update(
    frameDeltaSec: number,
    input: SemanticInputState,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void {
    const prediction = this.prediction;
    if (!prediction) {
      return;
    }
    const cmds = prediction.update(frameDeltaSec, input);
    if (cmds.length > 0) {
      sendInputs(cmds);
    }
  }

  reconcile(ackInputSeq: number, playerState: NetPlayerState): void {
    this.prediction?.reconcile(ackInputSeq, playerState);
  }

  getPosition(): [number, number, number] | null {
    const prediction = this.prediction;
    if (!prediction) {
      return null;
    }
    return this.localRenderSmoothingEnabled ? prediction.getInterpolatedPosition() : prediction.getPosition();
  }

  raycastBlocks(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance = 6,
  ) {
    const prediction = this.prediction;
    const sim = this.sim;
    if (!prediction || !sim || !prediction.hasEditableWorld()) {
      return null;
    }
    const result = sim.castRayAndGetNormal(
      origin[0], origin[1], origin[2],
      direction[0], direction[1], direction[2],
      maxDistance,
    );
    if (result.length === 0) {
      return null;
    }
    const toi = result[0];
    const normal: [number, number, number] = [result[1], result[2], result[3]];
    const point: [number, number, number] = [
      origin[0] + direction[0] * toi,
      origin[1] + direction[1] * toi,
      origin[2] + direction[2] * toi,
    ];
    const epsilon = 0.01;
    return {
      point,
      normal,
      removeCell: pointToCell([
        point[0] - normal[0] * epsilon,
        point[1] - normal[1] * epsilon,
        point[2] - normal[2] * epsilon,
      ]),
      placeCell: pointToCell([
        point[0] + normal[0] * epsilon,
        point[1] + normal[1] * epsilon,
        point[2] + normal[2] * epsilon,
      ]),
    };
  }

  raycastScene(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance = 1000,
  ): { toi: number } | null {
    const sim = this.sim;
    const prediction = this.prediction;
    if (!sim || !prediction || !prediction.isWorldLoaded()) {
      return null;
    }
    const result = sim.castRayAndGetNormal(
      origin[0], origin[1], origin[2],
      direction[0], direction[1], direction[2],
      maxDistance,
    );
    if (result.length === 0) {
      return null;
    }
    return { toi: result[0] };
  }

  classifyHitscanPlayer(
    origin: [number, number, number],
    direction: [number, number, number],
    bodyCenter: [number, number, number],
    blockerDistance: number | null,
  ): { distance: number; kind: number } | null {
    const sim = this.sim;
    const prediction = this.prediction;
    if (!sim || !prediction || !prediction.isWorldLoaded()) {
      return null;
    }
    const result = sim.classifyHitscanPlayer(
      origin[0], origin[1], origin[2],
      direction[0], direction[1], direction[2],
      bodyCenter[0], bodyCenter[1], bodyCenter[2],
      blockerDistance ?? Number.POSITIVE_INFINITY,
    );
    if (result.length === 0) {
      return null;
    }
    return { distance: result[0], kind: result[1] };
  }

  buildBlockEdit(cell: [number, number, number], op: number, material: number): BlockEditCmd | null {
    const prediction = this.prediction;
    if (!prediction || !prediction.hasEditableWorld()) {
      return null;
    }
    return prediction.voxelWorld.buildEditRequest(cell[0], cell[1], cell[2], op, material);
  }

  applyOptimisticEdit(cmd: BlockEditCmd): void {
    const prediction = this.prediction;
    if (!prediction || !prediction.hasEditableWorld()) {
      return;
    }
    prediction.applyOptimisticEdit(cmd);
    this.setRenderBlocks(prediction.getRenderBlocks());
  }

  getBlockMaterial(cell: [number, number, number]): number {
    const prediction = this.prediction;
    if (!prediction || !prediction.hasEditableWorld()) {
      return 0;
    }
    return prediction.voxelWorld.getMaterial(cell[0], cell[1], cell[2]);
  }

  updateDynamicBodies(bodies: DynamicBodyStateMeters[]): void {
    this.dynamicBodiesPrediction?.syncAuthoritativeBodies(bodies);
  }

  advanceDynamicBodies(frameDeltaSec: number, allowProxyStep: boolean): void {
    this.dynamicBodiesPrediction?.advance(frameDeltaSec, allowProxyStep);
  }

  getDynamicBodyRenderState(id: number): DynamicBodyStateMeters | null {
    return this.dynamicBodiesPrediction?.getRenderedBodyState(id) ?? null;
  }

  getDynamicBodyPhysicsState(id: number): DynamicBodyStateMeters | null {
    return this.dynamicBodiesPrediction?.getPhysicsBodyState(id) ?? null;
  }

  predictDynamicBodyShot(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance = 1000,
    blockerDistance: number | null = null,
  ): { bodyId: number | null; diagnostic: DynamicBodyShotDiagnostic } {
    const sim = this.sim;
    if (!sim) {
      return {
        bodyId: null,
        diagnostic: {
          proxyHitBodyId: null,
          proxyHitToi: null,
          blockerDistance,
          blockedByBlocker: false,
          localPredictedDeltaM: null,
        },
      };
    }
    const hit = sim.castDynamicBodyRay(
      origin[0], origin[1], origin[2],
      direction[0], direction[1], direction[2],
      maxDistance,
    );
    if (hit.length < 5) {
      return {
        bodyId: null,
        diagnostic: {
          proxyHitBodyId: null,
          proxyHitToi: null,
          blockerDistance,
          blockedByBlocker: false,
          localPredictedDeltaM: null,
        },
      };
    }
    const bodyId = hit[0];
    const toi = hit[1];
    if (blockerDistance != null && blockerDistance < toi) {
      return {
        bodyId: null,
        diagnostic: {
          proxyHitBodyId: bodyId,
          proxyHitToi: toi,
          blockerDistance,
          blockedByBlocker: true,
          localPredictedDeltaM: null,
        },
      };
    }
    const beforeState = this.dynamicBodiesPrediction?.getPhysicsBodyState(bodyId);
    const impactPoint: [number, number, number] = [
      origin[0] + direction[0] * toi,
      origin[1] + direction[1] * toi,
      origin[2] + direction[2] * toi,
    ];
    const impulse: [number, number, number] = [
      direction[0] * DYNAMIC_BODY_IMPULSE + hit[2] * 0.5,
      direction[1] * DYNAMIC_BODY_IMPULSE + hit[3] * 0.5,
      direction[2] * DYNAMIC_BODY_IMPULSE + hit[4] * 0.5,
    ];
    const applied = sim.applyDynamicBodyImpulse(
      bodyId,
      impulse[0], impulse[1], impulse[2],
      impactPoint[0], impactPoint[1], impactPoint[2],
    );
    if (applied) {
      this.dynamicBodiesPrediction?.markRecentInteraction(bodyId);
      this.lastPredictedDynamicShot = { bodyId, atMs: performance.now() };
      sim.stepDynamics(1 / 240);
    }
    const afterState = applied ? this.dynamicBodiesPrediction?.getPhysicsBodyState(bodyId) : null;
    const localPredictedDeltaM = beforeState && afterState
      ? Math.hypot(
          afterState.position[0] - beforeState.position[0],
          afterState.position[1] - beforeState.position[1],
          afterState.position[2] - beforeState.position[2],
        )
      : null;
    return {
      bodyId: applied ? bodyId : null,
      diagnostic: {
        proxyHitBodyId: bodyId,
        proxyHitToi: toi,
        blockerDistance,
        blockedByBlocker: false,
        localPredictedDeltaM,
      },
    };
  }

  hasRecentDynamicBodyInteraction(id: number): boolean {
    return this.dynamicBodiesPrediction?.hasRecentInteraction(id) ?? false;
  }

  getRenderedDynamicBodyState(id: number): DynamicBodyStateMeters | null {
    const proxyBody = this.getDynamicBodyRenderState(id);
    if (proxyBody && this.hasRecentDynamicBodyInteraction(id)) {
      return proxyBody;
    }
    const remoteSample = this.sampleRemoteDynamicBody(id, this.getDynamicBodyRenderTimeUs());
    if (remoteSample) {
      return {
        id,
        shapeType: remoteSample.shapeType,
        position: remoteSample.position,
        quaternion: remoteSample.quaternion,
        halfExtents: remoteSample.halfExtents,
        velocity: remoteSample.velocity,
        angularVelocity: remoteSample.angularVelocity,
      };
    }
    return this.dynamicBodies.get(id) ?? null;
  }

  listDynamicBodyProxyStates(): Array<{
    id: number;
    position: [number, number, number];
    halfExtents: [number, number, number];
  }> {
    return Array.from(this.dynamicBodies.keys())
      .map((id) => {
        const proxyBody = this.getDynamicBodyPhysicsState(id);
        if (!proxyBody) return null;
        return {
          id,
          position: proxyBody.position,
          halfExtents: proxyBody.halfExtents,
        };
      })
      .filter((body): body is {
        id: number;
        position: [number, number, number];
        halfExtents: [number, number, number];
      } => body != null);
  }

  getNextSeq(): number {
    return this.prediction?.getNextSeq() ?? 0;
  }

  getDebugRenderBuffers(modeBits: number): WasmDebugRenderBuffers | null {
    if (!this.sim || modeBits === 0) {
      return null;
    }
    return this.sim.debugRender(modeBits);
  }

  getDebugStats(): RuntimeDebugStats {
    const prediction = this.prediction;
    if (!prediction) {
      return defaultDebugStats();
    }
    const offset = prediction.getCorrectionOffset();
    const playerPosition = prediction.getPosition();
    const dynamicStats = this.dynamicBodiesPrediction?.getDebugCorrectionStats(playerPosition, 16) ?? {
      globalMax: 0,
      nearPlayerMax: 0,
      interactiveMax: 0,
      overThresholdCount: 0,
    };
    const vehicleDebugState = this.vehiclePrediction?.getDebugState();
    return {
      pendingInputs: prediction.getPendingInputCount(),
      predictionTicks: prediction.getTickCount(),
      playerCorrectionMagnitude: Math.hypot(offset[0], offset[1], offset[2]),
      vehicleCorrectionMagnitude: this.vehiclePrediction?.getCorrectionMagnitude() ?? 0,
      dynamicGlobalMaxCorrectionMagnitude: dynamicStats.globalMax,
      dynamicNearPlayerMaxCorrectionMagnitude: dynamicStats.nearPlayerMax,
      dynamicInteractiveMaxCorrectionMagnitude: dynamicStats.interactiveMax,
      dynamicOverThresholdCount: dynamicStats.overThresholdCount,
      dynamicTrackedBodies: this.dynamicBodiesPrediction?.getTrackedBodyCount() ?? 0,
      dynamicInteractiveBodies: this.dynamicBodiesPrediction?.getRecentInteractionCount() ?? 0,
      lastDynamicShotBodyId: this.lastPredictedDynamicShot?.bodyId ?? 0,
      lastDynamicShotAgeMs: this.lastPredictedDynamicShot
        ? Math.max(0, performance.now() - this.lastPredictedDynamicShot.atMs)
        : -1,
      vehiclePendingInputs: vehicleDebugState?.pendingInputs ?? 0,
      vehicleAckSeq: vehicleDebugState?.ackSeq ?? 0,
      vehicleLatestLocalSeq: vehicleDebugState?.latestLocalSeq ?? 0,
      vehiclePendingInputsAgeMs: vehicleDebugState?.pendingInputsAgeMs ?? 0,
      vehicleAckBacklogMs: vehicleDebugState?.ackBacklogMs ?? 0,
      vehicleResendWindow: vehicleDebugState?.resendWindow ?? 0,
      vehicleReplayErrorM: vehicleDebugState?.lastReplayErrorM ?? 0,
      vehiclePosErrorM: vehicleDebugState?.lastPosErrorM ?? 0,
      vehicleVelErrorMs: vehicleDebugState?.lastVelErrorMs ?? 0,
      vehicleRotErrorRad: vehicleDebugState?.lastRotErrorRad ?? 0,
      vehicleCorrectionAgeMs: vehicleDebugState?.lastCorrectionAgeMs ?? -1,
      physicsStepMs: prediction.getLastPhysicsStepMs(),
      velocity: prediction.getVelocity(),
    };
  }

  spawnVehicle(
    id: number,
    vehicleType: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void {
    this.sim?.spawnVehicle(id, vehicleType, px, py, pz, qx, qy, qz, qw);
  }

  removeVehicle(id: number): void {
    this.sim?.removeVehicle(id);
  }

  syncRemoteVehicle(
    id: number,
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
  ): void {
    this.sim?.syncRemoteVehicle(id, px, py, pz, qx, qy, qz, qw, vx, vy, vz);
  }

  syncBroadPhase(): void {
    this.sim?.syncBroadPhase();
  }

  enterVehicle(vehicleId: number, initState: NetVehicleState): void {
    const vehiclePrediction = this.vehiclePrediction;
    if (!vehiclePrediction) {
      return;
    }
    vehiclePrediction.setNextSeq(this.prediction?.getNextSeq() ?? vehiclePrediction.getNextSeq());
    vehiclePrediction.enterVehicle(vehicleId, initState);
  }

  exitVehicle(): void {
    const vehiclePrediction = this.vehiclePrediction;
    if (!vehiclePrediction) {
      return;
    }
    this.prediction?.setNextSeq(vehiclePrediction.getNextSeq());
    vehiclePrediction.exitVehicle();
  }

  updateVehicle(
    frameDeltaSec: number,
    input: SemanticInputState,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void {
    const vehiclePrediction = this.vehiclePrediction;
    if (!vehiclePrediction) {
      return;
    }
    const cmds = vehiclePrediction.update(frameDeltaSec, input);
    this.prediction?.setNextSeq(vehiclePrediction.getNextSeq());
    if (cmds.length > 0) {
      sendInputs(cmds);
    }
  }

  reconcileVehicle(vehicleState: NetVehicleState, ackInputSeq: number): void {
    this.vehiclePrediction?.reconcile(vehicleState, ackInputSeq);
  }

  getVehiclePose(): { position: [number, number, number]; quaternion: [number, number, number, number] } | null {
    return this.vehiclePrediction?.getInterpolatedChassisPose() ?? null;
  }

  getDrivenVehicleId(): number | null {
    return this.vehiclePrediction?.getVehicleId() ?? null;
  }

  getLocalVehicleDebug(vehicleId: number): VehicleDebugSnapshot | null {
    return decodeVehicleDebugSnapshot(this.sim?.getVehicleDebug(vehicleId));
  }

  isInVehicle(): boolean {
    return this.vehiclePrediction?.isActive() ?? false;
  }

  getPracticeBotHost(): PracticeBotHost | null {
    return null;
  }
}
