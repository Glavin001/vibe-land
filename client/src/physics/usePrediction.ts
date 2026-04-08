import { useEffect, useRef, useCallback, useState } from 'react';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { PredictionManager } from './predictionManager';
import type { BlockEditCmd, DynamicBodyStateMeters, InputCmd, NetPlayerState, ServerWorldPacket } from '../net/protocol';
import type { RenderBlock } from '../world/voxelWorld';

type BlockRayHit = {
  point: [number, number, number];
  normal: [number, number, number];
  removeCell: [number, number, number];
  placeCell: [number, number, number];
};

/**
 * Thin React wrapper around PredictionManager.
 * Handles Rapier WASM init and lifecycle only — all netcode logic lives
 * in PredictionManager which is framework-agnostic and fully testable.
 */
export function usePrediction() {
  const managerRef = useRef<PredictionManager | null>(null);
  const worldRef = useRef<RAPIER.World | null>(null);
  const colliderRef = useRef<RAPIER.Collider | null>(null);
  const initializedRef = useRef(false);
  const pendingWorldPacketsRef = useRef<ServerWorldPacket[]>([]);
  const [ready, setReady] = useState(false);
  const [renderBlocks, setRenderBlocks] = useState<RenderBlock[]>([]);

  useEffect(() => {
    let disposed = false;

    RAPIER.init().then(() => {
      if (disposed) return;

      const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.45, 0.35), body);

      // Initialize Rapier internals before the first prediction tick.
      world.step();

      const manager = new PredictionManager(world, body, collider);
      managerRef.current = manager;
      worldRef.current = world;
      colliderRef.current = collider;

      // Apply any world packets that arrived before Rapier was ready.
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
      worldRef.current = null;
      colliderRef.current = null;
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
    const world = worldRef.current;
    const playerCollider = colliderRef.current;
    if (!m || !world || !playerCollider || !m.isWorldLoaded()) return null;

    const ray = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: direction[0], y: direction[1], z: direction[2] },
    );
    const hit = world.castRayAndGetNormal(ray, maxDistance, true, undefined, undefined, playerCollider);
    if (!hit) return null;

    const point: [number, number, number] = [
      origin[0] + direction[0] * hit.timeOfImpact,
      origin[1] + direction[1] * hit.timeOfImpact,
      origin[2] + direction[2] * hit.timeOfImpact,
    ];
    const normal: [number, number, number] = [hit.normal.x, hit.normal.y, hit.normal.z];
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

  const getBlockMaterial = useCallback((cell: [number, number, number]): number => {
    const m = managerRef.current;
    if (!m || !m.isWorldLoaded()) return 0;
    return m.voxelWorld.getMaterial(cell[0], cell[1], cell[2]);
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
    getBlockMaterial,
    updateDynamicBodies,
    getDebugStats,
  };
}

function pointToCell(point: [number, number, number]): [number, number, number] {
  return [
    Math.floor(point[0]),
    Math.floor(point[1]),
    Math.floor(point[2]),
  ];
}
