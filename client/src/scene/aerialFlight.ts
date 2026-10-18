import type { ActionSnapshot } from '../input/types';
import { advanceLookAngles } from '../input/resolver';

export type AerialPose = {
  position: [number, number, number];
  yaw: number;
  pitch: number;
};

/** Camera-only motion. Gameplay receives neutral input while this runs. */
export function advanceAerialPose(
  pose: AerialPose,
  action: ActionSnapshot | null,
  speed: number,
  deltaSeconds: number,
): AerialPose {
  const look = advanceLookAngles(pose.yaw, pose.pitch, action);
  const forward = action?.moveY ?? 0;
  const right = action?.moveX ?? 0;
  const vertical = Number(action?.jump ?? false) - Number(action?.crouch ?? false);
  const sin = Math.sin(look.yaw);
  const cos = Math.cos(look.yaw);
  const cosPitch = Math.cos(look.pitch);
  const dx = sin * cosPitch * forward - cos * right;
  const dy = Math.sin(look.pitch) * forward + vertical;
  const dz = cos * cosPitch * forward + sin * right;
  const length = Math.max(1, Math.hypot(dx, dy, dz));
  const distance = Math.max(0, Math.min(deltaSeconds, 0.1))
    * speed * (action?.sprint ? 3 : 1) / length;
  return {
    ...look,
    position: [
      pose.position[0] + dx * distance,
      pose.position[1] + dy * distance,
      pose.position[2] + dz * distance,
    ],
  };
}
