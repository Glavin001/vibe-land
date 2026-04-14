/**
 * @module bots
 *
 * First-class bot automation framework built on top of
 * [navcat](https://github.com/isaac-mason/navcat).
 *
 * Basic usage:
 *
 * ```ts
 * import { createBotCrowd, BotBrain, behaviors } from '@/bots';
 *
 * const crowd = createBotCrowd(world);
 * const handle = crowd.addBot(spawnPoint);
 * const brain = new BotBrain(crowd, handle, behaviors.harassNearest());
 *
 * // per tick:
 * crowd.step(dt);
 * const intent = brain.think(selfState, remotePlayers);
 * transport.sendInput(buildInputFromButtons(seq, 0, intent.buttons, intent.yaw, intent.pitch));
 * ```
 */

export { buildWorldGeometry, type BotWorldGeometry } from './world/worldGeometry';
export {
  buildBotNavMesh,
  type BotNavMesh,
  type BuildBotNavMeshOptions,
  type NavMeshMode,
} from './world/buildNavMesh';
export {
  BotCrowd,
  createBotCrowd,
  type BotCrowdOptions,
  type BotHandle,
} from './crowd/BotCrowd';
export { BotBrain, type BotBrainOptions } from './agent/BotBrain';
export {
  agentStateToIntent,
  createSteeringState,
  type SteeringOptions,
  type SteeringState,
} from './agent/steering';
export * as behaviors from './agent/behaviors';
export type {
  Behavior,
  BehaviorDecision,
  BotBehaviorContext,
  HarassNearestOptions,
  WanderOptions,
} from './agent/behaviors';
export type {
  BotIntent,
  BotMode,
  BotSelfState,
  ObservedPlayer,
  Vec3Tuple,
} from './types';
