import { BTN_JUMP, BTN_SPRINT } from '../net/protocol';
import type { SemanticInputState } from '../input/types';

export type AuthoritativePresentationState = {
  position: [number, number, number];
  velocity: [number, number, number];
  grounded: boolean;
  supportVelocity?: [number, number, number];
};

const MAX_PREDICTION_HORIZON_SEC = 0.05;
const MAX_HORIZONTAL_OFFSET_M = 0.35;
const MAX_VERTICAL_OFFSET_M = 0.22;
const WALK_SPEED_MPS = 6;
const SPRINT_SPEED_MPS = 9;
const JUMP_PRESENTATION_SPEED_MPS = 4;
const CORRECTION_HALF_LIFE_SEC = 0.045;

/**
 * A bounded local presentation aid for server-authoritative PhysX sessions.
 *
 * This class never performs collision queries or advances world objects. It
 * only masks a small amount of input latency on the locally rendered player.
 * The authoritative interpolated pose remains the base of every frame.
 */
export class ThinAuthoritativePredictor {
  private offset: [number, number, number] = [0, 0, 0];
  private predictedVelocity: [number, number, number] = [0, 0, 0];
  private grounded = false;
  private jumpConsumed = false;

  reset(): void {
    this.offset = [0, 0, 0];
    this.predictedVelocity = [0, 0, 0];
    this.grounded = false;
    this.jumpConsumed = false;
  }

  observeAuthoritative(state: AuthoritativePresentationState, dtSec: number): void {
    this.grounded = state.grounded;
    if (state.grounded) {
      this.jumpConsumed = false;
    }

    const support = state.supportVelocity ?? [0, 0, 0];
    this.predictedVelocity = [
      state.velocity[0] + support[0],
      state.velocity[1] + support[1],
      state.velocity[2] + support[2],
    ];

    const decay = Math.pow(0.5, Math.max(dtSec, 0) / CORRECTION_HALF_LIFE_SEC);
    this.offset = [
      this.offset[0] * decay,
      this.offset[1] * decay,
      this.offset[2] * decay,
    ];
  }

  update(
    authoritativePosition: [number, number, number],
    frameDeltaSec: number,
    input: SemanticInputState,
  ): [number, number, number] {
    const dt = Math.min(Math.max(frameDeltaSec, 0), MAX_PREDICTION_HORIZON_SEC);
    const moveLength = Math.hypot(input.moveX, input.moveY);
    const normalizedX = moveLength > 1 ? input.moveX / moveLength : input.moveX;
    const normalizedY = moveLength > 1 ? input.moveY / moveLength : input.moveY;
    const speed = (input.buttons & BTN_SPRINT) !== 0 ? SPRINT_SPEED_MPS : WALK_SPEED_MPS;
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    // Match shared::movement::build_wish_dir and Three.js camera space:
    // forward = (+sin(yaw), +cos(yaw)), screen-right = (-cos(yaw), +sin(yaw)).
    const desiredX = (-normalizedX * cos + normalizedY * sin) * speed;
    const desiredZ = (normalizedX * sin + normalizedY * cos) * speed;

    this.offset[0] += (desiredX - this.predictedVelocity[0]) * dt;
    this.offset[2] += (desiredZ - this.predictedVelocity[2]) * dt;

    const jumpPressed = (input.buttons & BTN_JUMP) !== 0;
    if (jumpPressed && this.grounded && !this.jumpConsumed) {
      this.offset[1] += JUMP_PRESENTATION_SPEED_MPS * dt;
      this.jumpConsumed = true;
    }

    const horizontalLength = Math.hypot(this.offset[0], this.offset[2]);
    if (horizontalLength > MAX_HORIZONTAL_OFFSET_M) {
      const scale = MAX_HORIZONTAL_OFFSET_M / horizontalLength;
      this.offset[0] *= scale;
      this.offset[2] *= scale;
    }
    this.offset[1] = Math.max(-MAX_VERTICAL_OFFSET_M, Math.min(MAX_VERTICAL_OFFSET_M, this.offset[1]));

    return [
      authoritativePosition[0] + this.offset[0],
      authoritativePosition[1] + this.offset[1],
      authoritativePosition[2] + this.offset[2],
    ];
  }

  correctionMagnitude(): number {
    return Math.hypot(this.offset[0], this.offset[1], this.offset[2]);
  }
}
