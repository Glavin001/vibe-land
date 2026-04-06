import * as RAPIER from '@dimforge/rapier3d-compat';

import {
  BTN_BACK,
  BTN_CROUCH,
  BTN_FORWARD,
  BTN_JUMP,
  BTN_LEFT,
  BTN_RELOAD,
  BTN_RIGHT,
  BTN_SECONDARY_FIRE,
  BTN_SPRINT,
  InputCmd,
  netStateToMeters,
  type NetPlayerState,
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
  correctionDistance: 0.05,
};

export type PredictedSnapshot = {
  ackInputSeq: number;
  state: NetPlayerState;
};

export class PredictedFpsController {
  readonly config: MovementConfig;
  readonly controller: RAPIER.KinematicCharacterController;

  private pendingInputs: InputCmd[] = [];
  private velocity: Vec3 = { x: 0, y: 0, z: 0 };
  private onGround = false;
  private yaw = 0;
  private pitch = 0;

  constructor(
    private readonly world: RAPIER.World,
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

    const start = this.body.translation();
    this.body.setTranslation(start, true);
  }

  dispose(): void {
    (this.controller as any).free?.();
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

  predict(input: InputCmd, fixedDt: number): void {
    this.pendingInputs.push(input);
    this.simulateOne(input, fixedDt);
  }

  reconcile(snapshot: PredictedSnapshot, fixedDt: number): void {
    const authoritative = netStateToMeters(snapshot.state);
    this.pendingInputs = this.pendingInputs.filter((cmd) => cmd.seq > snapshot.ackInputSeq);

    const current = this.body.translation();
    const dx = current.x - authoritative.position[0];
    const dy = current.y - authoritative.position[1];
    const dz = current.z - authoritative.position[2];
    const errorSq = dx * dx + dy * dy + dz * dz;
    if (errorSq <= this.config.correctionDistance * this.config.correctionDistance) {
      return;
    }

    this.body.setTranslation(
      { x: authoritative.position[0], y: authoritative.position[1], z: authoritative.position[2] },
      true,
    );
    this.velocity = {
      x: authoritative.velocity[0],
      y: authoritative.velocity[1],
      z: authoritative.velocity[2],
    };
    this.yaw = authoritative.yaw;
    this.pitch = authoritative.pitch;
    this.onGround = (authoritative.flags & 1) !== 0;

    for (const cmd of this.pendingInputs) {
      this.simulateOne(cmd, fixedDt);
    }
  }

  simulateOne(input: InputCmd, dt: number): void {
    this.yaw = input.yaw;
    this.pitch = input.pitch;

    applyHorizontalFriction(this.velocity, this.config.friction, dt, this.onGround);

    const move = buildWishDir(input, this.yaw);
    const hasMove = move.x * move.x + move.z * move.z > 1e-5;
    const speed = this.pickMoveSpeed(input.buttons);
    const wishDir = hasMove ? normalizeXZ(move) : { x: 0, y: 0, z: 0 };

    const accel = this.onGround ? this.config.groundAccel : this.config.airAccel;
    accelerate(this.velocity, wishDir, speed, accel, dt);

    this.velocity.y -= this.config.gravity * dt;
    if (this.onGround && (input.buttons & BTN_JUMP) !== 0) {
      this.velocity.y = this.config.jumpSpeed;
      this.onGround = false;
    }

    const desiredTranslation = {
      x: this.velocity.x * dt,
      y: this.velocity.y * dt,
      z: this.velocity.z * dt,
    };

    this.controller.computeColliderMovement(this.collider, desiredTranslation);
    const corrected = this.controller.computedMovement();

    const position = this.body.translation();
    const next = {
      x: position.x + corrected.x,
      y: position.y + corrected.y,
      z: position.z + corrected.z,
    };

    // For a local predicted controller against a static mirrored world, immediate translation
    // keeps the feel responsive without requiring a full local world.step(). If you later add
    // local dynamic props, switch this to setNextKinematicTranslation and step a parallel world.
    this.body.setTranslation(next, true);

    const wantedDown = desiredTranslation.y <= 0;
    const yClipped = Math.abs(corrected.y - desiredTranslation.y) > 1e-4;
    this.onGround = wantedDown && (yClipped || this.isNearGround());
    if (this.onGround && this.velocity.y < 0) {
      this.velocity.y = 0;
    }

    this.velocity.x = corrected.x / dt;
    this.velocity.z = corrected.z / dt;
  }

  private isNearGround(): boolean {
    const p = this.body.translation();
    const origin = { x: p.x, y: p.y, z: p.z };
    const ray = new RAPIER.Ray(origin, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, this.config.snapToGround + 0.05, true);
    return !!hit;
  }

  private pickMoveSpeed(buttons: number): number {
    if ((buttons & BTN_CROUCH) !== 0) return this.config.crouchSpeed;
    if ((buttons & BTN_SPRINT) !== 0) return this.config.sprintSpeed;
    return this.config.walkSpeed;
  }
}

export function buildInputFromButtons(
  seq: number,
  clientTick: number,
  buttons: number,
  yaw: number,
  pitch: number,
): InputCmd {
  const moveX = ((buttons & BTN_RIGHT) !== 0 ? 127 : 0) + ((buttons & BTN_LEFT) !== 0 ? -127 : 0);
  const moveY = ((buttons & BTN_FORWARD) !== 0 ? 127 : 0) + ((buttons & BTN_BACK) !== 0 ? -127 : 0);

  return {
    seq,
    clientTick,
    buttons: buttons & ~(BTN_SECONDARY_FIRE | BTN_RELOAD),
    moveX,
    moveY,
    yaw,
    pitch,
  };
}

function buildWishDir(input: InputCmd, yaw: number): Vec3 {
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

function normalizeXZ(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.z);
  if (len <= 1e-6) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: 0, z: v.z / len };
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
