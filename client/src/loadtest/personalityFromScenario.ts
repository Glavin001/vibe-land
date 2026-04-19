/**
 * Bridges {@link LoadTestScenario.behavior} (the legacy load-test config
 * shape) into {@link BotPersonality} (the unified bot config). Used by
 * both the load-test page and the benchmark autopilot in `GameWorld.tsx`
 * so they consume the same brain tuning.
 */
import type { BotPersonality } from '../bots/config/botPersonality';
import type { BotSelfState } from '../bots/types';
import {
  FLAG_DEAD,
  FLAG_ON_GROUND,
  type PlayerStateMeters,
} from '../net/protocol';
import type { LoadTestScenario } from './scenario';

export function personalityFromScenario(
  scenario: LoadTestScenario,
): Partial<BotPersonality> {
  const b = scenario.behavior;
  const fromBehavior: Partial<BotPersonality> = {
    behaviorKind: 'harass',
    stopDistanceM: b.stopDistanceM,
    orbitDistanceM: b.orbitDistanceM,
    sprintDistanceM: b.sprintDistanceM,
    recoveryDistanceM: b.recoveryDistanceM,
    targetAcquireDistanceM: b.targetAcquireDistanceM,
    stuckTickThreshold: b.stuckTickThreshold,
    jumpCooldownTicks: b.jumpCooldownTicks,
    fireMode: b.fireMode,
    fireDistanceM: b.fireDistanceM,
    fireCooldownTicks: b.fireCooldownTicks,
  };
  // Explicit personality overrides win over the behavior-derived defaults so
  // scenarios can reach knobs that BehaviorConfig doesn't expose.
  return scenario.personality ? { ...fromBehavior, ...scenario.personality } : fromBehavior;
}

export function playerStateToBotSelf(
  state: PlayerStateMeters | null,
): BotSelfState | null {
  if (!state) return null;
  return {
    position: [state.position[0], state.position[1], state.position[2]],
    velocity: [state.velocity[0], state.velocity[1], state.velocity[2]],
    yaw: state.yaw,
    pitch: state.pitch,
    onGround: (state.flags & FLAG_ON_GROUND) !== 0,
    dead: (state.flags & FLAG_DEAD) !== 0 || state.hp <= 0,
  };
}
