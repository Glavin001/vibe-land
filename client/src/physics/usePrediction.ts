import { useEffect, useRef, useCallback, useState } from 'react';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { PredictedFpsController } from './predictedFpsController';
import type { InputCmd, NetPlayerState } from '../net/protocol';
import { netPlayerStateToMeters } from '../net/protocol';
import { buildInputFromButtons } from '../scene/inputBuilder';

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
  accumulator: number;
  prevPosition: [number, number, number];
  currPosition: [number, number, number];
  // Visual offset SET (not accumulated) on each reconciliation, decays toward zero
  correctionOffset: [number, number, number];
  nextSeq: number;
  tickCount: number;
};

export function usePrediction() {
  const stateRef = useRef<PredictionState | null>(null);
  const initializedRef = useRef(false);
  const lastSendCadenceSeqRef = useRef(0);
  const lastSendCadenceAtRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;

    RAPIER.init().then(() => {
      if (disposed) return;

      const world = new RAPIER.World({ x: 0, y: -20, z: 0 });

      // Static ground plane (top surface at y=1.0)
      const groundDesc = RAPIER.ColliderDesc.cuboid(50, 0.5, 50)
        .setTranslation(0, 0.5, 0);
      world.createCollider(groundDesc);

      // Pillar blocks matching GameWorld.tsx hardcoded scene
      const pillarBlocks: [number, number, number][] = [
        [2.5, 1.5, 2.5],
        [2.5, 2.5, 2.5],
        [2.5, 3.5, 2.5],
        [3.5, 1.5, 2.5],
        [3.5, 2.5, 2.5],
      ];
      for (const [x, y, z] of pillarBlocks) {
        const desc = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
          .setTranslation(x, y, z);
        world.createCollider(desc);
      }

      // Player capsule (kinematic)
      const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      const body = world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.capsule(0.45, 0.35);
      const collider = world.createCollider(colliderDesc, body);

      // Initialize broadphase so computeColliderMovement detects collisions
      world.step();

      const controller = new PredictedFpsController(world, body, collider);

      stateRef.current = {
        world, body, collider, controller,
        accumulator: 0,
        prevPosition: [0, 0, 0],
        currPosition: [0, 0, 0],
        correctionOffset: [0, 0, 0],
        nextSeq: 1,
        tickCount: 0,
      };
      setReady(true);
    });

    return () => {
      disposed = true;
      const s = stateRef.current;
      if (s) {
        s.controller.dispose();
        stateRef.current = null;
      }
    };
  }, []);

  /**
   * Called every render frame. Accumulates time and runs 0-N fixed physics ticks.
   * For each tick: builds an input, predicts locally, AND sends to server.
   * Also decays the visual correction offset toward zero.
   */
  const update = useCallback((
    frameDeltaSec: number,
    buttons: number,
    yaw: number,
    pitch: number,
    sendInputs: (cmds: InputCmd[]) => void,
  ): void => {
    const s = stateRef.current;
    if (!s) return;

    s.accumulator += frameDeltaSec;
    const pendingInputs: InputCmd[] = [];

    let steps = 0;
    while (s.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      const seq = (s.nextSeq++ & 0xffff);
      const clientTick = Math.floor(performance.now() / (1000 / 60));
      const input = buildInputFromButtons(seq, clientTick, buttons, yaw, pitch);

      // Predict locally and send to server — same seq, same input
      s.controller.predict(input, FIXED_DT);
      pendingInputs.push(input);

      s.prevPosition = [...s.currPosition] as [number, number, number];
      const p = s.controller.getPosition();
      s.currPosition = [p.x, p.y, p.z];

      // Decay visual correction offset toward zero
      const decay = Math.exp(-VISUAL_SMOOTH_RATE * FIXED_DT);
      s.correctionOffset[0] *= decay;
      s.correctionOffset[1] *= decay;
      s.correctionOffset[2] *= decay;

      s.accumulator -= FIXED_DT;
      steps++;
      s.tickCount++;
    }

    // Clamp accumulator to prevent runaway
    if (s.accumulator > FIXED_DT) {
      s.accumulator = FIXED_DT;
    }

    if (pendingInputs.length > 0) {
      sendInputs(pendingInputs);
      const lastSeq = pendingInputs[pendingInputs.length - 1].seq;
      const now = performance.now();
      if (lastSendCadenceAtRef.current === null) {
        lastSendCadenceAtRef.current = now;
        lastSendCadenceSeqRef.current = lastSeq;
      } else if (lastSeq - lastSendCadenceSeqRef.current >= 60) {
        // #region agent log
        fetch('http://127.0.0.1:7573/ingest/57b4fbd5-6dde-4eb5-b85a-6674ac4543c0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'83ac5f'},body:JSON.stringify({sessionId:'83ac5f',runId:'cadence-pre',hypothesisId:'H26',location:'client/src/physics/usePrediction.ts:149',message:'client send cadence summary',data:{elapsedMs:now-lastSendCadenceAtRef.current,lastSeq,batchSize:pendingInputs.length,steps,frameDeltaSec,buttons,accumulator:s.accumulator},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        lastSendCadenceAtRef.current = now;
        lastSendCadenceSeqRef.current = lastSeq;
      }
    }
  }, []);

  /**
   * Replay-based reconciliation: resets physics to server state, replays unacked
   * inputs, and SETs (not accumulates) the visual offset to the position delta.
   */
  const reconcile = useCallback((ackInputSeq: number, playerState: NetPlayerState) => {
    const s = stateRef.current;
    if (!s) return;

    const m = netPlayerStateToMeters(playerState);

    // First snapshot: teleport physics body to spawn position
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

    // Check for large error → hard teleport (respawn, major desync)
    const curr = s.controller.getPosition();
    const rawError = Math.hypot(
      m.position[0] - curr.x,
      m.position[1] - curr.y,
      m.position[2] - curr.z,
    );

    // Controller handles: reset to server state, replay unacked inputs
    const delta = s.controller.reconcile(
      { ackInputSeq, state: playerState },
      FIXED_DT,
    );

    if (delta) {
      const pending = s.controller.getPendingDebugInfo();
      const deltaMagnitude = Math.hypot(delta.dx, delta.dy, delta.dz);
      if (rawError < 0.5 && deltaMagnitude > 1.0) {
        // #region agent log
        fetch('http://127.0.0.1:7573/ingest/57b4fbd5-6dde-4eb5-b85a-6674ac4543c0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'83ac5f'},body:JSON.stringify({sessionId:'83ac5f',runId:'replay-path-pre',hypothesisId:'H22',location:'client/src/physics/usePrediction.ts:221',message:'small reconcile error but large replay delta',data:{ackInputSeq,rawError,deltaMagnitude,delta,pendingCount:pending.count,firstPendingSeq:pending.firstSeq,lastPendingSeq:pending.lastSeq},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
      if (rawError > HARD_SNAP_DISTANCE) {
        // #region agent log
        fetch('http://127.0.0.1:7573/ingest/57b4fbd5-6dde-4eb5-b85a-6674ac4543c0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'83ac5f'},body:JSON.stringify({sessionId:'83ac5f',runId:'post-fix',hypothesisId:'H24',location:'client/src/physics/usePrediction.ts:214',message:'pre-replay raw error exceeded hard snap threshold',data:{ackInputSeq,rawError,deltaMagnitude,pendingCount:pending.count,firstPendingSeq:pending.firstSeq,lastPendingSeq:pending.lastSeq},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
      if (deltaMagnitude > HARD_SNAP_DISTANCE) {
        // #region agent log
        fetch('http://127.0.0.1:7573/ingest/57b4fbd5-6dde-4eb5-b85a-6674ac4543c0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'83ac5f'},body:JSON.stringify({sessionId:'83ac5f',runId:'post-fix',hypothesisId:'H25',location:'client/src/physics/usePrediction.ts:218',message:'post-replay correction exceeded hard snap threshold',data:{ackInputSeq,rawError,deltaMagnitude,delta},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        s.correctionOffset = [0, 0, 0];
      } else {
        // SET the visual offset (not accumulate) — bounded to single reconciliation delta
        s.correctionOffset = [-delta.dx, -delta.dy, -delta.dz];
      }
      // Update positions to match reconciled physics state
      const p = s.controller.getPosition();
      s.currPosition = [p.x, p.y, p.z];
      s.prevPosition = [...s.currPosition] as [number, number, number];
    }
  }, []);

  /**
   * Returns interpolated physics position + smooth correction offset.
   */
  const getPosition = useCallback((): [number, number, number] | null => {
    const s = stateRef.current;
    if (!s) return null;

    const alpha = s.accumulator / FIXED_DT;
    return [
      s.prevPosition[0] + (s.currPosition[0] - s.prevPosition[0]) * alpha + s.correctionOffset[0],
      s.prevPosition[1] + (s.currPosition[1] - s.prevPosition[1]) * alpha + s.correctionOffset[1],
      s.prevPosition[2] + (s.currPosition[2] - s.prevPosition[2]) * alpha + s.correctionOffset[2],
    ];
  }, []);

  return { ready, update, reconcile, getPosition };
}
