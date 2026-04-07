import * as RAPIER from '@dimforge/rapier3d-compat';

import {
  BTN_CROUCH,
  BTN_JUMP,
  BTN_SPRINT,
  type InputFrame,
  type NetPlayerState,
  netPlayerStateToMeters,
} from '../net/protocol';

export type Vec3 = { x: number; y: number; z: number };

export type MovementConfig = {
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  groundAccel: number;
  airAccel: number;
  friction: number;
  gravity: number;
  jumpSpeed: number;
  capsuleHalfSegment: number;
  capsuleRadius: number;
  collisionOffset: number;
  maxStepHeight: number;
  minStepWidth: number;
  snapToGround: number;
  maxSlopeRadians: number;
  minSlideRadians: number;
  correctionDistance: number;
};

const DEFAULT_CONFIG: MovementConfig = {
  walkSpeed: 6.0,
  sprintSpeed: 8.5,
  crouchSpeed: 3.5,
  groundAccel: 80.0,
  airAccel: 18.0,
  friction: 10.0,
  gravity: 20.0,
  jumpSpeed: 6.5,
  capsuleHalfSegment: 0.45,
  capsuleRadius: 0.35,
  collisionOffset: 0.01,
  maxStepHeight: 0.55,
  minStepWidth: 0.2,
  snapToGround: 0.2,
  maxSlopeRadians: 45 * Math.PI / 180,
  minSlideRadians: 30 * Math.PI / 180,
  correctionDistance: 0.15,
};

export type PredictedSnapshot = {
  ackInputSeq: number;
  state: NetPlayerState;
};

export class PredictedFpsController {
  readonly config: MovementConfig;
  readonly controller: RAPIER.KinematicCharacterController;

  private pendingInputs: InputFrame[] = [];
  private velocity: Vec3 = { x: 0, y: 0, z: 0 };
  private onGround = false;
  private yaw = 0;
  private pitch = 0;

  constructor(
    world: RAPIER.World,
    private readonly body: RAPIER.RigidBody,
    private readonly collider: RAPIER.Collider,
    config?: Partial<MovementConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.controller = world.createCharacterController(this.config.collisionOffset);
    this.controller.setMaxSlopeClimbAngle(this.config.maxSlopeRadians);
    this.controller.setMinSlopeSlideAngle(this.config.minSlideRadians);
    this.controller.enableAutostep(this.config.maxStepHeight, this.config.minStepWidth, true);
    this.controller.enableSnapToGround(this.config.snapToGround);
  }

  dispose(): void {
    (this.controller as unknown as { free?: () => void }).free?.();
  }

  getPosition(): Vec3 {
    const p = this.body.translation();
    return { x: p.x, y: p.y, z: p.z };
  }

  getVelocity(): Vec3 {
    return { ...this.velocity };
  }

  getAngles(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  isGrounded(): boolean {
    return this.onGround;
  }

  setPosition(position: Vec3): void {
    this.body.setTranslation(position, true);
  }

  /** Remove inputs that the server has acknowledged. */
  clearAckedInputs(ackInputSeq: number): void {
    this.pendingInputs = this.pendingInputs.filter(
      (input) => seqIsNewer(input.seq, ackInputSeq),
    );
  }

  getPendingCount(): number {
    return this.pendingInputs.length;
  }

  predict(input: InputFrame, fixedDt: number): void {
    this.pendingInputs.push(input);
    this.simulateOne(input, fixedDt);
  }

  reconcile(snapshot: PredictedSnapshot, fixedDt: number): { dx: number; dy: number; dz: number } | null {
    const authoritative = netPlayerStateToMeters(snapshot.state);
    this.pendingInputs = this.pendingInputs.filter((input) => seqIsNewer(input.seq, snapshot.ackInputSeq));

    const before = this.body.translation();
    const ex = before.x - authoritative.position[0];
    const ey = before.y - authoritative.position[1];
    const ez = before.z - authoritative.position[2];
    const errorSq = ex * ex + ey * ey + ez * ez;
    if (errorSq <= this.config.correctionDistance * this.config.correctionDistance) {
      return null;
    }

    // Reset to server authoritative state
    this.setFullState(
      { x: authoritative.position[0], y: authoritative.position[1], z: authoritative.position[2] },
      { x: authoritative.velocity[0], y: authoritative.velocity[1], z: authoritative.velocity[2] },
      authoritative.yaw,
      authoritative.pitch,
      (authoritative.flags & 1) !== 0,
    );

    // Replay all unacked inputs
    for (const input of this.pendingInputs) {
      this.simulateOne(input, fixedDt);
    }

    // Return position delta so caller can set visual offset
    const after = this.body.translation();
    return {
      dx: after.x - before.x,
      dy: after.y - before.y,
      dz: after.z - before.z,
    };
  }

  setFullState(position: Vec3, velocity: Vec3, yaw: number, pitch: number, onGround: boolean): void {
    this.body.setTranslation(position, true);
    this.velocity = { ...velocity };
    this.yaw = yaw;
    this.pitch = pitch;
    this.onGround = onGround;
  }

  private simulateOne(input: InputFrame, dt: number): void {
    this.yaw = input.yaw;
    this.pitch = input.pitch;

    applyHorizontalFriction(this.velocity, this.config.friction, dt, this.onGround);

    const move = buildWishDir(input, this.yaw);
    const hasMove = move.x * move.x + move.z * move.z > 1e-5;
    const speed = this.pickMoveSpeed(input.buttons);
    const wishDir = hasMove ? normalizeXZ(move) : { x: 0, y: 0, z: 0 };

    const accel = this.onGround ? this.config.groundAccel : this.config.airAccel;
    accelerate(this.velocity, wishDir, speed, accel, dt);

    if (this.onGround && (input.buttons & BTN_JUMP) !== 0) {
      this.velocity.y = this.config.jumpSpeed;
      this.onGround = false;
    }
    this.velocity.y -= this.config.gravity * dt;

    const desiredTranslation = {
      x: this.velocity.x * dt,
      y: this.velocity.y * dt,
      z: this.velocity.z * dt,
    };

    this.controller.computeColliderMovement(this.collider, desiredTranslation);
    const corrected = this.controller.computedMovement();

    const current = this.body.translation();
    const next = {
      x: current.x + corrected.x,
      y: current.y + corrected.y,
      z: current.z + corrected.z,
    };
    this.body.setTranslation(next, true);

    const wantedDown = desiredTranslation.y <= 0;
    const yClipped = Math.abs(corrected.y - desiredTranslation.y) > 1e-4;
    const yStopped = Math.abs(corrected.y) < 0.001;
    this.onGround = wantedDown && yClipped && yStopped;
    if (this.onGround && this.velocity.y < 0) {
      this.velocity.y = 0;
    }

    this.velocity.x = corrected.x / dt;
    this.velocity.z = corrected.z / dt;
  }

  private pickMoveSpeed(buttons: number): number {
    if ((buttons & BTN_CROUCH) !== 0) return this.config.crouchSpeed;
    if ((buttons & BTN_SPRINT) !== 0) return this.config.sprintSpeed;
    return this.config.walkSpeed;
  }
}

function buildWishDir(input: InputFrame, yaw: number): Vec3 {
  const forward = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  const right = { x: forward.z, y: 0, z: -forward.x };
  const mx = input.moveX / 127;
  const my = input.moveY / 127;
  return {
    x: right.x * mx + forward.x * my,
    y: 0,
    z: right.z * mx + forward.z * my,
  };
}

function normalizeXZ(value: Vec3): Vec3 {
  const length = Math.hypot(value.x, value.z);
  if (length <= 1e-6) {
    return { x: 0, y: 0, z: 0 };
  }
  return { x: value.x / length, y: 0, z: value.z / length };
}

function applyHorizontalFriction(velocity: Vec3, friction: number, dt: number, onGround: boolean): void {
  if (!onGround) return;
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed <= 1e-6) return;
  const drop = speed * friction * dt;
  const newSpeed = Math.max(0, speed - drop);
  const ratio = newSpeed / speed;
  velocity.x *= ratio;
  velocity.z *= ratio;
}

function accelerate(velocity: Vec3, wishDir: Vec3, wishSpeed: number, accel: number, dt: number): void {
  const currentSpeed = velocity.x * wishDir.x + velocity.z * wishDir.z;
  const addSpeed = Math.max(0, wishSpeed - currentSpeed);
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(addSpeed, accel * wishSpeed * dt);
  velocity.x += wishDir.x * accelSpeed;
  velocity.z += wishDir.z * accelSpeed;
}

export function seqIsNewer(a: number, b: number): boolean {
  const diff = (a - b + 0x10000) & 0xffff;
  return diff !== 0 && diff < 0x8000;
}
