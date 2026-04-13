import { useEffect, useRef, useCallback, useState } from 'react';
import type { GameMode } from '../app/gameMode';
import { isPracticeMode } from '../app/gameMode';
import { initSharedPhysics, WasmSimWorld } from '../wasm/sharedPhysics';
import type { WasmDebugRenderBuffers, WasmSimWorldInstance } from '../wasm/sharedPhysics';
import { PredictionManager } from './predictionManager';
import { VehiclePredictionManager } from './vehiclePredictionManager';
import { DynamicBodyPredictionManager } from './dynamicBodyPredictionManager';
import type { BlockEditCmd, DynamicBodyStateMeters, InputCmd, NetPlayerState, NetVehicleState, ServerWorldPacket } from '../net/protocol';
import type { SemanticInputState } from '../input/types';
import type { RenderBlock } from '../world/voxelWorld';

const PREDICTED_DYNAMIC_BODY_IMPULSE = 6.0;
const FIXED_DT = 1 / 60;
const SHOT_PREVIEW_STEP_DT = 1 / 240;

type BlockRayHit = {
  point: [number, number, number];
  normal: [number, number, number];
  removeCell: [number, number, number];
  placeCell: [number, number, number];
};

type SceneRayHit = {
  toi: number;
};

type PlayerAimHit = {
  distance: number;
  kind: number;
};

export type DynamicBodyShotDiagnostic = {
  proxyHitBodyId: number | null;
  proxyHitToi: number | null;
  blockerDistance: number | null;
  blockedByBlocker: boolean;
  localPredictedDeltaM: number | null;
};

/**
 * Thin React wrapper around PredictionManager.
 * Handles shared WASM init and lifecycle only.
 */
export function usePrediction(mode: GameMode) {
  return usePredictionWithWorld(mode);
}

export function usePredictionWithWorld(mode: GameMode, worldJson?: string) {
  const practiceMode = isPracticeMode(mode);
  const managerRef = useRef<PredictionManager | null>(null);
  const vehicleManagerRef = useRef<VehiclePredictionManager | null>(null);
  const dynamicBodyManagerRef = useRef<DynamicBodyPredictionManager | null>(null);
  const simRef = useRef<WasmSimWorldInstance | null>(null);
  const lastPredictedDynamicShotRef = useRef<{ bodyId: number; atMs: number } | null>(null);
  const pendingWorldPacketsRef = useRef<ServerWorldPacket[]>([]);
  const [ready, setReady] = useState(false);
  const [renderBlocks, setRenderBlocks] = useState<RenderBlock[]>([]);

  useEffect(() => {
    let disposed = false;

    initSharedPhysics().then(() => {
      if (disposed) return;

      const sim = new WasmSimWorld();
      if (worldJson) {
        sim.loadWorldDocument(worldJson);
      } else if (!practiceMode) {
        sim.seedDemoTerrain();
      }
      // Spawn player at origin — will be repositioned on first server snapshot
      sim.spawnPlayer(0, 2, 0);
      sim.rebuildBroadPhase();

      const manager = new PredictionManager(sim, practiceMode);
      manager.enableTerrainWorld();
      managerRef.current = manager;
      vehicleManagerRef.current = new VehiclePredictionManager(sim, practiceMode);
      dynamicBodyManagerRef.current = new DynamicBodyPredictionManager(sim);
      simRef.current = sim;

      // Apply any world packets that arrived before WASM was ready.
      const pendingPackets = pendingWorldPacketsRef.current.splice(0);
      for (const packet of pendingPackets) {
        try {
          manager.applyWorldPacket(packet);
        } catch (error) {
          console.warn('Failed to apply queued world packet on client', error);
        }
      }

      setRenderBlocks(manager.getRenderBlocks());
      setReady(true);
    });

    return () => {
      disposed = true;
      setReady(false);
      setRenderBlocks([]);
      const m = managerRef.current;
      if (m) {
        m.dispose();
        managerRef.current = null;
      }
      vehicleManagerRef.current?.dispose();
      vehicleManagerRef.current = null;
      dynamicBodyManagerRef.current?.clear();
      dynamicBodyManagerRef.current = null;
      simRef.current = null;
    };
  }, [practiceMode, worldJson]);

  const applyWorldPacket = useCallback((packet: ServerWorldPacket) => {
    const m = managerRef.current;
    if (!m) {
      pendingWorldPacketsRef.current.push(packet);
      return;
    }

    try {
      m.applyWorldPacket(packet);
      setRenderBlocks(m.getRenderBlocks());
    } catch (error) {
      console.warn('Chunk world update rejected on client', error);
    }
  }, []);

  const update = useCallback((
    frameDeltaSec: number,
    input: SemanticInputState,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void => {
    const m = managerRef.current;
    if (!m) return;

    const cmds = m.update(frameDeltaSec, input);
    if (cmds.length > 0) {
      sendInputs(cmds);
    }
  }, []);

  const reconcile = useCallback((ackInputSeq: number, playerState: NetPlayerState) => {
    const m = managerRef.current;
    if (!m) return;
    m.reconcile(ackInputSeq, playerState);
  }, []);

  const getPosition = useCallback((): [number, number, number] | null => {
    const m = managerRef.current;
    if (!m) return null;
    return m.getInterpolatedPosition();
  }, []);

  const raycastBlocks = useCallback((
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance = 6,
  ): BlockRayHit | null => {
    const m = managerRef.current;
    const sim = simRef.current;
    if (!m || !sim || !m.hasEditableWorld()) return null;

    const result = sim.castRayAndGetNormal(
      origin[0], origin[1], origin[2],
      direction[0], direction[1], direction[2],
      maxDistance,
    );
    if (result.length === 0) return null;

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
  }, []);

  const raycastScene = useCallback((
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance = 1000,
  ): SceneRayHit | null => {
    const sim = simRef.current;
    const m = managerRef.current;
    if (!sim || !m || !m.isWorldLoaded()) return null;

    const result = sim.castRayAndGetNormal(
      origin[0], origin[1], origin[2],
      direction[0], direction[1], direction[2],
      maxDistance,
    );
    if (result.length === 0) return null;
    return {
      toi: result[0],
    };
  }, []);

  const classifyHitscanPlayer = useCallback((
    origin: [number, number, number],
    direction: [number, number, number],
    bodyCenter: [number, number, number],
    blockerDistance: number | null,
  ): PlayerAimHit | null => {
    const sim = simRef.current;
    const m = managerRef.current;
    if (!sim || !m || !m.isWorldLoaded()) return null;

    const result = sim.classifyHitscanPlayer(
      origin[0], origin[1], origin[2],
      direction[0], direction[1], direction[2],
      bodyCenter[0], bodyCenter[1], bodyCenter[2],
      blockerDistance ?? Number.POSITIVE_INFINITY,
    );
    if (result.length === 0) return null;
    return {
      distance: result[0],
      kind: result[1],
    };
  }, []);

  const buildBlockEdit = useCallback((
    cell: [number, number, number],
    op: number,
    material: number,
  ): BlockEditCmd | null => {
    const m = managerRef.current;
    if (!m || !m.hasEditableWorld()) return null;
    return m.voxelWorld.buildEditRequest(cell[0], cell[1], cell[2], op, material);
  }, []);

  const applyOptimisticEdit = useCallback((cmd: BlockEditCmd): void => {
    const m = managerRef.current;
    if (!m || !m.hasEditableWorld()) return;
    m.applyOptimisticEdit(cmd);
    setRenderBlocks(m.getRenderBlocks());
  }, []);

  const getBlockMaterial = useCallback((cell: [number, number, number]): number => {
    const m = managerRef.current;
    if (!m || !m.hasEditableWorld()) return 0;
    return m.voxelWorld.getMaterial(cell[0], cell[1], cell[2]);
  }, []);

  const spawnVehicle = useCallback((
    id: number, vehicleType: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
  ): void => {
    simRef.current?.spawnVehicle(id, vehicleType, px, py, pz, qx, qy, qz, qw);
  }, []);

  const removeVehicle = useCallback((id: number): void => {
    simRef.current?.removeVehicle(id);
  }, []);

  const syncRemoteVehicle = useCallback((
    id: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    vx: number, vy: number, vz: number,
  ): void => {
    if (practiceMode) return;
    simRef.current?.syncRemoteVehicle(id, px, py, pz, qx, qy, qz, qw, vx, vy, vz);
  }, [practiceMode]);

  const syncBroadPhase = useCallback((): void => {
    if (practiceMode) return;
    simRef.current?.syncBroadPhase();
  }, [practiceMode]);

  const enterVehicle = useCallback((vehicleId: number, initState: NetVehicleState): void => {
    const vm = vehicleManagerRef.current;
    if (!vm) return;
    vm.setNextSeq(managerRef.current?.getNextSeq() ?? vm.getNextSeq());
    vm.enterVehicle(vehicleId, initState);
  }, []);

  const exitVehicle = useCallback((): void => {
    const vm = vehicleManagerRef.current;
    if (!vm) return;
    managerRef.current?.setNextSeq(vm.getNextSeq());
    vm.exitVehicle();
  }, []);

  const updateVehicle = useCallback((
    frameDeltaSec: number,
    input: SemanticInputState,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void => {
    const vm = vehicleManagerRef.current;
    if (!vm) return;
    const cmds = vm.update(frameDeltaSec, input);
    managerRef.current?.setNextSeq(vm.getNextSeq());
    if (cmds.length > 0) sendInputs(cmds);
  }, []);

  const reconcileVehicle = useCallback((vehicleState: NetVehicleState, ackInputSeq: number): void => {
    vehicleManagerRef.current?.reconcile(vehicleState, ackInputSeq);
  }, []);

  const getVehiclePose = useCallback(() => {
    return vehicleManagerRef.current?.getInterpolatedChassisPose() ?? null;
  }, []);

  const getDrivenVehicleId = useCallback((): number | null => {
    return vehicleManagerRef.current?.getVehicleId() ?? null;
  }, []);

  const getLocalVehicleDebug = useCallback((vehicleId: number): {
    speedMs: number;
    groundedWheels: number;
    steering: number;
    engineForce: number;
    brake: number;
  } | null => {
    const sim = simRef.current;
    if (!sim) return null;
    const raw = sim.getVehicleDebug(vehicleId);
    if (raw.length < 5) return null;
    return {
      speedMs: raw[0],
      groundedWheels: raw[1],
      steering: raw[2],
      engineForce: raw[3],
      brake: raw[4],
    };
  }, []);

  const isInVehicle = useCallback((): boolean => {
    return vehicleManagerRef.current?.isActive() ?? false;
  }, []);

  const updateDynamicBodies = useCallback((bodies: DynamicBodyStateMeters[]) => {
    const dynamicManager = dynamicBodyManagerRef.current;
    if (!dynamicManager) return;
    dynamicManager.syncAuthoritativeBodies(bodies);
  }, []);

  const advanceDynamicBodies = useCallback((frameDeltaSec: number, allowProxyStep: boolean): void => {
    dynamicBodyManagerRef.current?.advance(frameDeltaSec, allowProxyStep);
  }, []);

  const getDynamicBodyRenderState = useCallback((id: number): DynamicBodyStateMeters | null => {
    return dynamicBodyManagerRef.current?.getRenderedBodyState(id) ?? null;
  }, []);

  const predictDynamicBodyShot = useCallback((
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance = 1000,
    blockerDistance: number | null = null,
  ): { bodyId: number | null; diagnostic: DynamicBodyShotDiagnostic } => {
    if (practiceMode) {
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
    const sim = simRef.current;
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
    const beforeState = dynamicBodyManagerRef.current?.getPhysicsBodyState(bodyId);
    const impactPoint: [number, number, number] = [
      origin[0] + direction[0] * toi,
      origin[1] + direction[1] * toi,
      origin[2] + direction[2] * toi,
    ];
    const impulse: [number, number, number] = [
      direction[0] * PREDICTED_DYNAMIC_BODY_IMPULSE + hit[2] * 0.5,
      direction[1] * PREDICTED_DYNAMIC_BODY_IMPULSE + hit[3] * 0.5,
      direction[2] * PREDICTED_DYNAMIC_BODY_IMPULSE + hit[4] * 0.5,
    ];
    const applied = sim.applyDynamicBodyImpulse(
      bodyId,
      impulse[0], impulse[1], impulse[2],
      impactPoint[0], impactPoint[1], impactPoint[2],
    );
    if (applied) {
      dynamicBodyManagerRef.current?.markRecentInteraction(bodyId);
      lastPredictedDynamicShotRef.current = { bodyId, atMs: performance.now() };
      // Use a short preview step so shots feel immediate without overshooting
      // far ahead of the authoritative server result.
      sim.stepDynamics(SHOT_PREVIEW_STEP_DT);
    }
    const afterState = applied ? dynamicBodyManagerRef.current?.getPhysicsBodyState(bodyId) : null;
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
  }, [practiceMode]);

  const hasRecentDynamicBodyInteraction = useCallback((id: number): boolean => {
    return dynamicBodyManagerRef.current?.hasRecentInteraction(id) ?? false;
  }, []);

  const getDynamicBodyPhysicsState = useCallback((id: number): DynamicBodyStateMeters | null => {
    return dynamicBodyManagerRef.current?.getPhysicsBodyState(id) ?? null;
  }, []);

  const getNextSeq = useCallback((): number => {
    return managerRef.current?.getNextSeq() ?? 0;
  }, []);

  const getDebugRenderBuffers = useCallback((modeBits: number): WasmDebugRenderBuffers | null => {
    const sim = simRef.current;
    if (!sim || modeBits === 0) return null;
    return sim.debugRender(modeBits);
  }, []);

  const getDebugStats = useCallback(() => {
    const m = managerRef.current;
    const vm = vehicleManagerRef.current;
    const dm = dynamicBodyManagerRef.current;
    if (!m) {
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
        vehicleReplayErrorM: 0,
        vehiclePosErrorM: 0,
        vehicleVelErrorMs: 0,
        vehicleRotErrorRad: 0,
        vehicleCorrectionAgeMs: -1,
        physicsStepMs: 0,
        velocity: [0, 0, 0] as [number, number, number],
      };
    }
    const offset = m.getCorrectionOffset();
    const playerPosition = m.getPosition();
    const dynamicStats = dm?.getDebugCorrectionStats(playerPosition, 16) ?? {
      globalMax: 0,
      nearPlayerMax: 0,
      interactiveMax: 0,
      overThresholdCount: 0,
    };
    const vehicleDebugState = vm?.getDebugState();
    return {
      pendingInputs: m.getPendingInputCount(),
      predictionTicks: m.getTickCount(),
      playerCorrectionMagnitude: Math.hypot(offset[0], offset[1], offset[2]),
      vehicleCorrectionMagnitude: vm?.getCorrectionMagnitude() ?? 0,
      dynamicGlobalMaxCorrectionMagnitude: dynamicStats.globalMax,
      dynamicNearPlayerMaxCorrectionMagnitude: dynamicStats.nearPlayerMax,
      dynamicInteractiveMaxCorrectionMagnitude: dynamicStats.interactiveMax,
      dynamicOverThresholdCount: dynamicStats.overThresholdCount,
      dynamicTrackedBodies: dm?.getTrackedBodyCount() ?? 0,
      dynamicInteractiveBodies: dm?.getRecentInteractionCount() ?? 0,
      lastDynamicShotBodyId: lastPredictedDynamicShotRef.current?.bodyId ?? 0,
      lastDynamicShotAgeMs: lastPredictedDynamicShotRef.current
        ? Math.max(0, performance.now() - lastPredictedDynamicShotRef.current.atMs)
        : -1,
      vehiclePendingInputs: vehicleDebugState?.pendingInputs ?? 0,
      vehicleAckSeq: vehicleDebugState?.ackSeq ?? 0,
      vehicleReplayErrorM: vehicleDebugState?.lastReplayErrorM ?? 0,
      vehiclePosErrorM: vehicleDebugState?.lastPosErrorM ?? 0,
      vehicleVelErrorMs: vehicleDebugState?.lastVelErrorMs ?? 0,
      vehicleRotErrorRad: vehicleDebugState?.lastRotErrorRad ?? 0,
      vehicleCorrectionAgeMs: vehicleDebugState?.lastCorrectionAgeMs ?? -1,
      physicsStepMs: m.getLastPhysicsStepMs(),
      velocity: m.getVelocity(),
    };
  }, []);

  return {
    ready,
    renderBlocks,
    update,
    reconcile,
    getPosition,
    applyWorldPacket,
    raycastBlocks,
    buildBlockEdit,
    applyOptimisticEdit,
    getBlockMaterial,
    updateDynamicBodies,
    advanceDynamicBodies,
    getDynamicBodyRenderState,
    getDynamicBodyPhysicsState,
    predictDynamicBodyShot,
    hasRecentDynamicBodyInteraction,
    raycastScene,
    classifyHitscanPlayer,
    getNextSeq,
    getDebugRenderBuffers,
    getDebugStats,
    spawnVehicle,
    removeVehicle,
    syncRemoteVehicle,
    syncBroadPhase,
    enterVehicle,
    exitVehicle,
    updateVehicle,
    reconcileVehicle,
    getVehiclePose,
    getDrivenVehicleId,
    getLocalVehicleDebug,
    isInVehicle,
  };
}

function pointToCell(point: [number, number, number]): [number, number, number] {
  return [
    Math.floor(point[0]),
    Math.floor(point[1]),
    Math.floor(point[2]),
  ];
}
