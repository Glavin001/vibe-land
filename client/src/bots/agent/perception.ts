/**
 * Per-bot perception: filters the raw {@link ObservedPlayer} list by
 * field-of-view and line-of-sight, and maintains a per-player "last-known"
 * memory so behaviors can chase where they last saw someone without having
 * omniscient knowledge of the world.
 *
 * Also tracks HP changes to detect damage: when the bot takes a hit with no
 * active target, it enters a "curious" window during which the harass
 * behavior pivots 180° then slow-sweeps to look for the attacker.
 */

import { PLAYER_EYE_HEIGHT_M } from '../../net/sharedConstants';
import type { BotSelfState, ObservedPlayer, Vec3Tuple } from '../types';

export interface LastKnown {
  readonly playerId: number;
  readonly position: Vec3Tuple;
  readonly velocity: Vec3Tuple | null;
  readonly seenAtTick: number;
  readonly isInVehicle: boolean;
}

export interface PerceptionConfig {
  perceptionRangeM: number;
  fovHalfAngleRad: number;
  memoryDurationTicks: number;
  curiousDurationTicks: number;
  perceptionRaycastCadenceTicks: number;
}

export const DEFAULT_PERCEPTION_CONFIG: PerceptionConfig = Object.freeze({
  perceptionRangeM: 60,
  fovHalfAngleRad: Math.PI / 2,
  memoryDurationTicks: 300,
  curiousDurationTicks: 120,
  perceptionRaycastCadenceTicks: 1,
}) as PerceptionConfig;

export type RaycastFn = (
  origin: [number, number, number],
  direction: [number, number, number],
  maxDistance?: number,
) => { toi: number } | null;

interface LastLosEntry {
  tick: number;
  visible: boolean;
}

export class BotPerception {
  private readonly memory = new Map<number, LastKnown>();
  private readonly lastLos = new Map<number, LastLosEntry>();
  private lastHp: number | null = null;
  private damageTick = -Infinity;
  private curiousUntilTick = -Infinity;
  private damageYawAtHit = 0;

  /**
   * Filter raw observations by FOV + LOS and update last-known memory.
   * Returns the currently-visible subset (the behavior treats this as its
   * normal ObservedPlayer[] input).
   */
  observe(
    self: BotSelfState,
    raw: readonly ObservedPlayer[],
    raycast: RaycastFn | null,
    tick: number,
    cfg: PerceptionConfig,
  ): ObservedPlayer[] {
    const visible: ObservedPlayer[] = [];
    const fovHalf = cfg.fovHalfAngleRad;
    const rangeSq = cfg.perceptionRangeM * cfg.perceptionRangeM;
    const eye: [number, number, number] = [
      self.position[0],
      self.position[1] + PLAYER_EYE_HEIGHT_M,
      self.position[2],
    ];

    for (const player of raw) {
      if (player.isDead) continue;

      const dx = player.position[0] - self.position[0];
      const dz = player.position[2] - self.position[2];
      const planarSq = dx * dx + dz * dz;
      if (planarSq > rangeSq) continue;

      // FOV gate (planar — ignore pitch).
      const dirYaw = Math.atan2(dx, dz);
      const yawDelta = wrapAnglePi(dirYaw - self.yaw);
      if (Math.abs(yawDelta) > fovHalf) continue;

      // LOS gate (skip if no raycaster available; FOV-only is still a big win).
      let losBlocked = false;
      if (raycast) {
        const cadence = Math.max(1, cfg.perceptionRaycastCadenceTicks | 0);
        const prev = this.lastLos.get(player.id);
        const needsCast = !prev || tick - prev.tick >= cadence;
        if (needsCast) {
          const targetX = player.position[0];
          const targetY = player.position[1] + PLAYER_EYE_HEIGHT_M;
          const targetZ = player.position[2];
          const deltaX = targetX - eye[0];
          const deltaY = targetY - eye[1];
          const deltaZ = targetZ - eye[2];
          const dist = Math.hypot(deltaX, deltaY, deltaZ);
          if (dist > 0.0001) {
            const inv = 1 / dist;
            const hit = raycast(
              eye,
              [deltaX * inv, deltaY * inv, deltaZ * inv],
              dist + 0.5,
            );
            losBlocked = !!hit && hit.toi < dist - 0.25;
          }
          this.lastLos.set(player.id, { tick, visible: !losBlocked });
        } else {
          losBlocked = !prev.visible;
        }
      }
      if (losBlocked) continue;

      this.memory.set(player.id, {
        playerId: player.id,
        position: [player.position[0], player.position[1], player.position[2]],
        velocity: player.velocity
          ? [player.velocity[0], player.velocity[1], player.velocity[2]]
          : null,
        seenAtTick: tick,
        isInVehicle: !!player.isInVehicle,
      });
      visible.push(player);
    }

    // Prune stale memory.
    const cutoff = tick - cfg.memoryDurationTicks;
    for (const [id, entry] of this.memory) {
      if (entry.seenAtTick < cutoff) this.memory.delete(id);
    }
    // Prune stale LOS cache entries at 2× memory window.
    const losCutoff = tick - cfg.memoryDurationTicks * 2;
    for (const [id, entry] of this.lastLos) {
      if (entry.tick < losCutoff) this.lastLos.delete(id);
    }

    return visible;
  }

  /**
   * Record the bot's current HP. If it dropped since last tick and the bot
   * has no acquired target, enter the "curious" scan window.
   */
  noteHp(currentHp: number, tick: number, hasTarget: boolean, yaw: number, cfg: PerceptionConfig): void {
    if (this.lastHp !== null && currentHp < this.lastHp && !hasTarget) {
      this.damageTick = tick;
      this.curiousUntilTick = tick + Math.max(1, cfg.curiousDurationTicks | 0);
      this.damageYawAtHit = yaw;
    }
    this.lastHp = currentHp;
  }

  /** True while the curious window is active. */
  isCurious(tick: number): boolean {
    return tick < this.curiousUntilTick;
  }

  /**
   * Suggested yaw (radians, atan2(x,z) convention) the steering layer should
   * face when the bot is curious and has no other aim. The first few ticks
   * snap directly behind; after that it slow-sweeps ±60° around that axis.
   * Returns null when not curious.
   */
  getCuriousLookYaw(tick: number): number | null {
    if (tick >= this.curiousUntilTick) return null;
    const elapsed = tick - this.damageTick;
    const behind = this.damageYawAtHit + Math.PI;
    const SNAP_TICKS = 6;
    if (elapsed < SNAP_TICKS) return wrapAnglePi(behind);
    const total = Math.max(SNAP_TICKS + 1, this.curiousUntilTick - this.damageTick);
    const sweepTicks = Math.max(1, total - SNAP_TICKS);
    const phase = (elapsed - SNAP_TICKS) / sweepTicks;
    // Triangle wave in [-1, 1] so we sweep left-right-left.
    const tri = 1 - Math.abs(((phase * 2) % 2) - 1) * 2;
    const sweepAmp = (60 * Math.PI) / 180;
    return wrapAnglePi(behind + tri * sweepAmp);
  }

  /** Cancel the curious window (e.g. when the behavior acquires a new target). */
  clearCurious(): void {
    this.curiousUntilTick = -Infinity;
  }

  getMemory(): ReadonlyMap<number, LastKnown> {
    return this.memory;
  }

  getLastKnown(playerId: number): LastKnown | null {
    return this.memory.get(playerId) ?? null;
  }

  getDebugState(tick: number): {
    memorySize: number;
    curious: boolean;
    ticksSinceDamage: number;
  } {
    return {
      memorySize: this.memory.size,
      curious: this.isCurious(tick),
      ticksSinceDamage: Number.isFinite(this.damageTick)
        ? tick - this.damageTick
        : -1,
    };
  }
}

/** Wrap an angle (radians) to [-π, π]. */
function wrapAnglePi(a: number): number {
  const twoPi = Math.PI * 2;
  let x = a % twoPi;
  if (x > Math.PI) x -= twoPi;
  else if (x < -Math.PI) x += twoPi;
  return x;
}
