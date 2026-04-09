import { useEffect, useRef, useCallback, useState } from 'react';
import { initSharedPhysics, WasmSimWorld } from '../wasm/sharedPhysics';
import { PredictionManager } from './predictionManager';
import { VehiclePredictionManager } from './vehiclePredictionManager';
import type { BlockEditCmd, DynamicBodyStateMeters, InputCmd, NetPlayerState, NetVehicleState, ServerWorldPacket } from '../net/protocol';
import type { RenderBlock } from '../world/voxelWorld';

type BlockRayHit = {
  point: [number, number, number];
  normal: [number, number, number];
  removeCell: [number, number, number];
  placeCell: [number, number, number];
};

/**
 * Thin React wrapper around PredictionManager.
 * Handles shared WASM init and lifecycle only.
 */
export function usePrediction() {
  const managerRef = useRef<PredictionManager | null>(null);
  const vehicleManagerRef = useRef<VehiclePredictionManager | null>(null);
  const simRef = useRef<WasmSimWorld | null>(null);
  const initializedRef = useRef(false);
  const pendingWorldPacketsRef = useRef<ServerWorldPacket[]>([]);
  const [ready, setReady] = useState(false);
  const [renderBlocks, setRenderBlocks] = useState<RenderBlock[]>([]);

  useEffect(() => {
    let disposed = false;

    initSharedPhysics().then(() => {
      if (disposed) return;

      const sim = new WasmSimWorld();
      // Spawn player at origin — will be repositioned on first server snapshot
      sim.spawnPlayer(0, 2, 0);
      sim.rebuildBroadPhase();

      const manager = new PredictionManager(sim);
      managerRef.current = manager;
      vehicleManagerRef.current = new VehiclePredictionManager(sim);
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
      initializedRef.current = false;
      setReady(false);
      setRenderBlocks([]);
      const m = managerRef.current;
      if (m) {
        m.dispose();
        managerRef.current = null;
      }
      vehicleManagerRef.current?.dispose();
      vehicleManagerRef.current = null;
      simRef.current = null;
    };
  }, []);

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
    buttons: number,
    yaw: number,
    pitch: number,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void => {
    const m = managerRef.current;
    if (!m) return;

    const cmds = m.update(frameDeltaSec, buttons, yaw, pitch);
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
    if (!m || !sim || !m.isWorldLoaded()) return null;

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

  const buildBlockEdit = useCallback((
    cell: [number, number, number],
    op: number,
    material: number,
  ): BlockEditCmd | null => {
    const m = managerRef.current;
    if (!m || !m.isWorldLoaded()) return null;
    return m.voxelWorld.buildEditRequest(cell[0], cell[1], cell[2], op, material);
  }, []);

  const applyOptimisticEdit = useCallback((cmd: BlockEditCmd): void => {
    const m = managerRef.current;
    if (!m || !m.isWorldLoaded()) return;
    m.applyOptimisticEdit(cmd);
    setRenderBlocks(m.getRenderBlocks());
  }, []);

  const getBlockMaterial = useCallback((cell: [number, number, number]): number => {
    const m = managerRef.current;
    if (!m || !m.isWorldLoaded()) return 0;
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

  const enterVehicle = useCallback((vehicleId: number, initState: NetVehicleState): void => {
    vehicleManagerRef.current?.enterVehicle(vehicleId, initState);
  }, []);

  const exitVehicle = useCallback((): void => {
    vehicleManagerRef.current?.exitVehicle();
  }, []);

  const updateVehicle = useCallback((
    frameDeltaSec: number,
    buttons: number,
    yaw: number,
    pitch: number,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void => {
    const vm = vehicleManagerRef.current;
    if (!vm) return;
    const cmds = vm.update(frameDeltaSec, buttons, yaw, pitch);
    if (cmds.length > 0) sendInputs(cmds);
  }, []);

  const reconcileVehicle = useCallback((vehicleState: NetVehicleState, ackInputSeq: number): void => {
    vehicleManagerRef.current?.reconcile(vehicleState, ackInputSeq);
  }, []);

  const getVehiclePose = useCallback(() => {
    return vehicleManagerRef.current?.getInterpolatedChassisPose() ?? null;
  }, []);

  const isInVehicle = useCallback((): boolean => {
    return vehicleManagerRef.current?.isActive() ?? false;
  }, []);

  const updateDynamicBodies = useCallback((bodies: DynamicBodyStateMeters[]) => {
    const m = managerRef.current;
    if (!m) return;
    m.updateDynamicBodies(bodies);
  }, []);

  const getDebugStats = useCallback(() => {
    const m = managerRef.current;
    if (!m) return { pendingInputs: 0, predictionTicks: 0, correctionMagnitude: 0, physicsStepMs: 0 };
    const offset = m.getCorrectionOffset();
    return {
      pendingInputs: m.getPendingInputCount(),
      predictionTicks: m.getTickCount(),
      correctionMagnitude: Math.hypot(offset[0], offset[1], offset[2]),
      physicsStepMs: m.getLastPhysicsStepMs(),
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
    getDebugStats,
    spawnVehicle,
    removeVehicle,
    enterVehicle,
    exitVehicle,
    updateVehicle,
    reconcileVehicle,
    getVehiclePose,
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
