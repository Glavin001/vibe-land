import type { WasmSimWorldInstance } from '../wasm/sharedPhysics';
import type { InputCmd, NetVehicleState } from '../net/protocol';
import { buildInputFromButtons } from '../scene/inputBuilder';

export const FIXED_DT = 1 / 60;
export const MAX_CATCHUP_STEPS = 4;
export const VEHICLE_HARD_SNAP_DISTANCE = 5.0;
export const VEHICLE_CORRECTION_DISTANCE = 0.05;    // 5cm position threshold
export const VEHICLE_ROT_THRESHOLD = 0.0175;         // ~1 degree
export const VEHICLE_LINVEL_THRESHOLD = 0.1;         // 10 cm/s
export const VEHICLE_ANGVEL_THRESHOLD = 0.035;       // ~2 degrees/s
export const VEHICLE_VISUAL_SMOOTH_RATE = 15.0;  // fast decay → correction applied in ~4 ticks
export const VEHICLE_INPUT_REDUNDANCY = 4;

// ── Quaternion math helpers ──────────────────────────────────────────────────

function quatMultiply(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatInvert(q: [number, number, number, number]): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]]; // conjugate (unit quaternion)
}

function quatNormalize(q: [number, number, number, number]): [number, number, number, number] {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function quatSlerp(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bFlipped: [number, number, number, number] = [...b] as [number, number, number, number];
  if (dot < 0) {
    bFlipped = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    const r: [number, number, number, number] = [
      a[0] + t * (bFlipped[0] - a[0]),
      a[1] + t * (bFlipped[1] - a[1]),
      a[2] + t * (bFlipped[2] - a[2]),
      a[3] + t * (bFlipped[3] - a[3]),
    ];
    return quatNormalize(r);
  }
  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - dot * sinTheta / sinTheta0;
  const s1 = sinTheta / sinTheta0;
  return [
    s0 * a[0] + s1 * bFlipped[0],
    s0 * a[1] + s1 * bFlipped[1],
    s0 * a[2] + s1 * bFlipped[2],
    s0 * a[3] + s1 * bFlipped[3],
  ];
}

const IDENTITY_QUAT: [number, number, number, number] = [0, 0, 0, 1];

/**
 * Driver-side client-side prediction for a vehicle.
 *
 * Mirrors the PredictionManager pattern: fixed-timestep accumulator,
 * server reconciliation via input replay, and visual smoothing.
 */
export class VehiclePredictionManager {
  private vehicleId: number | null = null;
  private accumulator = 0;
  private nextSeq = 1;

  // Current chassis pose (from physics)
  private currPosition: [number, number, number] = [0, 0, 0];
  private prevPosition: [number, number, number] = [0, 0, 0];
  private currQuaternion: [number, number, number, number] = [0, 0, 0, 1];

  // Visual smoothing correction offsets (applied to rendered pose)
  private correctionOffset: [number, number, number] = [0, 0, 0];
  private correctionQuatOffset: [number, number, number, number] = [0, 0, 0, 1]; // identity

  constructor(private readonly sim: WasmSimWorldInstance) {}

  isActive(): boolean {
    return this.vehicleId !== null;
  }

  getVehicleId(): number | null {
    return this.vehicleId;
  }

  /**
   * Enter a vehicle — activate prediction for `vehicleId`.
   * `initState` is the authoritative server state at enter time.
   */
  enterVehicle(vehicleId: number, initState: NetVehicleState): void {
    this.vehicleId = vehicleId;
    this.accumulator = 0;
    this.correctionOffset = [0, 0, 0];
    this.correctionQuatOffset = [...IDENTITY_QUAT] as [number, number, number, number];

    // Sync WASM chassis to authoritative server state BEFORE activating prediction
    // so the first tick starts from the correct position, not a stale spawn position.
    const px = initState.pxMm / 1000;
    const py = initState.pyMm / 1000;
    const pz = initState.pzMm / 1000;
    const qx = initState.qxSnorm / 32767;
    const qy = initState.qySnorm / 32767;
    const qz = initState.qzSnorm / 32767;
    const qw = initState.qwSnorm / 32767;
    const vx = initState.vxCms / 100;
    const vy = initState.vyCms / 100;
    const vz = initState.vzCms / 100;
    this.sim.syncRemoteVehicle(vehicleId, px, py, pz, qx, qy, qz, qw, vx, vy, vz);

    this.sim.setLocalVehicle(vehicleId);

    const pos: [number, number, number] = [px, py, pz];
    this.currPosition = [...pos];
    this.prevPosition = [...pos];
    this.currQuaternion = [qx, qy, qz, qw];
  }

  /** Exit vehicle — deactivate prediction. */
  exitVehicle(): void {
    if (this.vehicleId !== null) {
      this.sim.clearLocalVehicle();
    }
    this.vehicleId = null;
    this.accumulator = 0;
    this.correctionOffset = [0, 0, 0];
    this.correctionQuatOffset = [...IDENTITY_QUAT] as [number, number, number, number];
  }

  /**
   * Advance vehicle prediction for one render frame.
   * Returns InputCmds generated (one per fixed-step tick), with redundancy
   * (last VEHICLE_INPUT_REDUNDANCY inputs) for packet loss resilience.
   */
  update(frameDeltaSec: number, buttons: number, yaw: number, pitch: number): InputCmd[] {
    if (this.vehicleId === null) return [];

    this.accumulator += frameDeltaSec;
    const pendingInputs: InputCmd[] = [];

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
      const seq = this.nextSeq++ & 0xffff;
      const input = buildInputFromButtons(seq, 0, buttons, yaw, pitch);

      const result = this.sim.tickVehicle(
        input.seq, input.buttons, input.moveX, input.moveY, input.yaw, input.pitch, FIXED_DT,
      );
      pendingInputs.push(input);

      this.prevPosition = [...this.currPosition] as [number, number, number];
      this.currPosition = [result[0], result[1], result[2]];
      this.currQuaternion = [result[3], result[4], result[5], result[6]];

      // Decay correction offsets
      const decay = Math.exp(-VEHICLE_VISUAL_SMOOTH_RATE * FIXED_DT);
      this.correctionOffset[0] *= decay;
      this.correctionOffset[1] *= decay;
      this.correctionOffset[2] *= decay;
      this.correctionQuatOffset = quatSlerp(this.correctionQuatOffset, IDENTITY_QUAT, 1.0 - decay);

      this.accumulator -= FIXED_DT;
      steps++;
    }

    if (this.accumulator > FIXED_DT) {
      this.accumulator = FIXED_DT;
    }

    // Return last N inputs for redundancy (server will dedup by seq)
    if (pendingInputs.length === 0) return [];
    return pendingInputs.slice(-VEHICLE_INPUT_REDUNDANCY);
  }

  /**
   * Reconcile with an authoritative server vehicle snapshot.
   * `ackInputSeq` must be the `ackInputSeq` from the same snapshot packet so
   * that processed vehicle inputs are pruned from the replay buffer.
   */
  reconcile(vehicleState: NetVehicleState, ackInputSeq: number): void {
    if (this.vehicleId === null) return;

    const serverPos: [number, number, number] = [
      vehicleState.pxMm / 1000,
      vehicleState.pyMm / 1000,
      vehicleState.pzMm / 1000,
    ];
    const serverQuat: [number, number, number, number] = [
      vehicleState.qxSnorm / 32767,
      vehicleState.qySnorm / 32767,
      vehicleState.qzSnorm / 32767,
      vehicleState.qwSnorm / 32767,
    ];
    const serverVel: [number, number, number] = [
      vehicleState.vxCms / 100,
      vehicleState.vyCms / 100,
      vehicleState.vzCms / 100,
    ];
    const serverAngVel: [number, number, number] = [
      vehicleState.wxMrads / 1000,
      vehicleState.wyMrads / 1000,
      vehicleState.wzMrads / 1000,
    ];

    const result = this.sim.reconcileVehicle(
      VEHICLE_CORRECTION_DISTANCE,
      VEHICLE_ROT_THRESHOLD,
      VEHICLE_LINVEL_THRESHOLD,
      VEHICLE_ANGVEL_THRESHOLD,
      ackInputSeq,
      serverPos[0], serverPos[1], serverPos[2],
      serverQuat[0], serverQuat[1], serverQuat[2], serverQuat[3],
      serverVel[0], serverVel[1], serverVel[2],
      serverAngVel[0], serverAngVel[1], serverAngVel[2],
      FIXED_DT,
    );

    const didCorrect = result[13] !== 0;
    if (!didCorrect) return;

    const oldQuat = this.currQuaternion;

    const dx = result[10] as number;
    const dy = result[11] as number;
    const dz = result[12] as number;
    const replayError = Math.hypot(dx, dy, dz);

    const newQuat: [number, number, number, number] = [
      result[3] as number,
      result[4] as number,
      result[5] as number,
      result[6] as number,
    ];

    if (replayError > VEHICLE_HARD_SNAP_DISTANCE) {
      this.currPosition = [result[0], result[1], result[2]];
      this.prevPosition = [...this.currPosition];
      this.correctionOffset = [0, 0, 0];
      this.currQuaternion = newQuat;
      this.correctionQuatOffset = [...IDENTITY_QUAT] as [number, number, number, number];
    } else {
      this.correctionOffset = [-dx, -dy, -dz];
      this.currPosition = [result[0], result[1], result[2]];
      this.prevPosition = [...this.currPosition];
      this.currQuaternion = newQuat;
      // Correction quat offset = oldQuat * inverse(newQuat) — the delta to decay away
      this.correctionQuatOffset = quatNormalize(quatMultiply(oldQuat, quatInvert(newQuat)));
    }
  }

  /**
   * Get the visually-smoothed chassis position for rendering.
   */
  getInterpolatedChassisPose(): {
    position: [number, number, number];
    quaternion: [number, number, number, number];
  } | null {
    if (this.vehicleId === null) return null;

    const alpha = this.accumulator / FIXED_DT;
    const position: [number, number, number] = [
      this.prevPosition[0] + (this.currPosition[0] - this.prevPosition[0]) * alpha + this.correctionOffset[0],
      this.prevPosition[1] + (this.currPosition[1] - this.prevPosition[1]) * alpha + this.correctionOffset[1],
      this.prevPosition[2] + (this.currPosition[2] - this.prevPosition[2]) * alpha + this.correctionOffset[2],
    ];
    // Apply orientation correction: render_quat = correctionQuatOffset * simulation_quat
    const renderQuat = quatNormalize(quatMultiply(this.correctionQuatOffset, this.currQuaternion));
    return { position, quaternion: renderQuat };
  }

  dispose(): void {
    this.exitVehicle();
  }
}
