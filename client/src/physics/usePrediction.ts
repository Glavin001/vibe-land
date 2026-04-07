import { useEffect, useRef, useCallback, useState } from 'react';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { PredictionManager } from './predictionManager';
import type { InputCmd, NetPlayerState, ServerWorldPacket } from '../net/protocol';
import type { RenderBlock } from '../world/voxelWorld';

/**
 * Thin React wrapper around PredictionManager.
 * Handles Rapier WASM init and lifecycle only — all netcode logic lives
 * in PredictionManager which is framework-agnostic and fully testable.
 */
export function usePrediction() {
  const managerRef = useRef<PredictionManager | null>(null);
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

  return { ready, renderBlocks, update, reconcile, getPosition, applyWorldPacket };
}
