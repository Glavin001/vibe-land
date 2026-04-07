import { useEffect, useRef, useCallback, useState } from 'react';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { PredictedFpsController } from './predictedFpsController';
import type { InputCmd, NetPlayerState, ServerWorldPacket } from '../net/protocol';
import { netPlayerStateToMeters } from '../net/protocol';
import { buildInputFromButtons } from '../scene/inputBuilder';
import { ClientVoxelWorld, type RenderBlock } from '../world/voxelWorld';

const FIXED_DT = 1 / 60;
const MAX_CATCHUP_STEPS = 4;

// Only hard-snap (teleport) if error exceeds this distance.
const HARD_SNAP_DISTANCE = 3.0;
// How fast the visual offset decays toward zero (per second).
const VISUAL_SMOOTH_RATE = 8.0;

type PredictionState = {
  world: RAPIER.World;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: PredictedFpsController;
  voxelWorld: ClientVoxelWorld;
  accumulator: number;
  prevPosition: [number, number, number];
  currPosition: [number, number, number];
  correctionOffset: [number, number, number];
  nextSeq: number;
  tickCount: number;
  worldLoaded: boolean;
};

function applyWorldPacketToState(state: PredictionState, packet: ServerWorldPacket): void {
  if (packet.type === 'chunkFull') {
    state.voxelWorld.applyFullChunk(packet);
  } else {
    state.voxelWorld.applyChunkDiff(packet);
  }
  state.worldLoaded = state.voxelWorld.hasChunks();
}

export function usePrediction() {
  const stateRef = useRef<PredictionState | null>(null);
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
      const voxelWorld = new ClientVoxelWorld(world);

      // Initialize Rapier internals before the first prediction tick.
      world.step();

      const controller = new PredictedFpsController(world, body, collider);
      const state: PredictionState = {
        world,
        body,
        collider,
        controller,
        voxelWorld,
        accumulator: 0,
        prevPosition: [0, 0, 0],
        currPosition: [0, 0, 0],
        correctionOffset: [0, 0, 0],
        nextSeq: 1,
        tickCount: 0,
        worldLoaded: false,
      };

      stateRef.current = state;

      const pendingPackets = pendingWorldPacketsRef.current.splice(0);
      for (const packet of pendingPackets) {
        try {
          applyWorldPacketToState(state, packet);
        } catch (error) {
          console.warn('Failed to apply queued world packet on client', error);
        }
      }

      setRenderBlocks(state.voxelWorld.getRenderBlocks());
      setReady(true);
    });

    return () => {
      disposed = true;
      initializedRef.current = false;
      setReady(false);
      setRenderBlocks([]);
      const s = stateRef.current;
      if (s) {
        s.controller.dispose();
        stateRef.current = null;
      }
    };
  }, []);

  const applyWorldPacket = useCallback((packet: ServerWorldPacket) => {
    const s = stateRef.current;
    if (!s) {
      pendingWorldPacketsRef.current.push(packet);
      return;
    }

    try {
      applyWorldPacketToState(s, packet);
      setRenderBlocks(s.voxelWorld.getRenderBlocks());
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
    const s = stateRef.current;
    if (!s || !s.worldLoaded || !initializedRef.current) {
      return;
    }

    s.accumulator += frameDeltaSec;
    const pendingInputs: InputCmd[] = [];

    let steps = 0;
    while (s.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      const seq = s.nextSeq++ & 0xffff;
      const clientTick = Math.floor(performance.now() / (1000 / 60));
      const input = buildInputFromButtons(seq, clientTick, buttons, yaw, pitch);

      s.controller.predict(input, FIXED_DT);
      pendingInputs.push(input);

      s.prevPosition = [...s.currPosition] as [number, number, number];
      const p = s.controller.getPosition();
      s.currPosition = [p.x, p.y, p.z];

      const decay = Math.exp(-VISUAL_SMOOTH_RATE * FIXED_DT);
      s.correctionOffset[0] *= decay;
      s.correctionOffset[1] *= decay;
      s.correctionOffset[2] *= decay;

      s.accumulator -= FIXED_DT;
      steps++;
      s.tickCount++;
    }

    if (s.accumulator > FIXED_DT) {
      s.accumulator = FIXED_DT;
    }

    if (pendingInputs.length > 0) {
      sendInputs(pendingInputs);
    }
  }, []);

  const reconcile = useCallback((ackInputSeq: number, playerState: NetPlayerState) => {
    const s = stateRef.current;
    if (!s) return;

    const m = netPlayerStateToMeters(playerState);

    if (!initializedRef.current) {
      s.controller.setFullState(
        { x: m.position[0], y: m.position[1], z: m.position[2] },
        { x: m.velocity[0], y: m.velocity[1], z: m.velocity[2] },
        m.yaw,
        m.pitch,
        (m.flags & 1) !== 0,
      );
      s.currPosition = [...m.position] as [number, number, number];
      s.prevPosition = [...m.position] as [number, number, number];
      s.correctionOffset = [0, 0, 0];
      initializedRef.current = true;
      return;
    }

    const curr = s.controller.getPosition();
    const rawError = Math.hypot(
      m.position[0] - curr.x,
      m.position[1] - curr.y,
      m.position[2] - curr.z,
    );

    if (rawError > HARD_SNAP_DISTANCE) {
      s.controller.setFullState(
        { x: m.position[0], y: m.position[1], z: m.position[2] },
        { x: m.velocity[0], y: m.velocity[1], z: m.velocity[2] },
        m.yaw,
        m.pitch,
        (m.flags & 1) !== 0,
      );
      const p = s.controller.getPosition();
      s.currPosition = [p.x, p.y, p.z];
      s.prevPosition = [...s.currPosition] as [number, number, number];
      s.correctionOffset = [0, 0, 0];
      return;
    }

    const delta = s.controller.reconcile(
      { ackInputSeq, state: playerState },
      FIXED_DT,
    );

    if (delta) {
      s.correctionOffset = [-delta.dx, -delta.dy, -delta.dz];
      const p = s.controller.getPosition();
      s.currPosition = [p.x, p.y, p.z];
      s.prevPosition = [...s.currPosition] as [number, number, number];
    }
  }, []);

  const getPosition = useCallback((): [number, number, number] | null => {
    const s = stateRef.current;
    if (!s || !initializedRef.current) return null;

    const alpha = s.accumulator / FIXED_DT;
    return [
      s.prevPosition[0] + (s.currPosition[0] - s.prevPosition[0]) * alpha + s.correctionOffset[0],
      s.prevPosition[1] + (s.currPosition[1] - s.prevPosition[1]) * alpha + s.correctionOffset[1],
      s.prevPosition[2] + (s.currPosition[2] - s.prevPosition[2]) * alpha + s.correctionOffset[2],
    ];
  }, []);

  return { ready, renderBlocks, update, reconcile, getPosition, applyWorldPacket };
}
