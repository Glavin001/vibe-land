/**
 * @module bots
 *
 * First-class bot automation framework built on top of navcat.
 */

export { buildWorldGeometry, type BotWorldGeometry } from './world/worldGeometry';
export {
  buildBotNavMesh,
  buildBotNavMeshFromSharedProfile,
  type BotNavMesh,
  type BuildBotNavMeshOptions,
  type BuildBotNavMeshFromSharedProfileOptions,
  type NavMeshMode,
} from './world/buildNavMesh';
export {
  BotCrowd,
  createBotCrowd,
  createBotCrowdFromSharedProfile,
  type BotCrowdOptions,
  type BotCrowdFromSharedProfileOptions,
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
export {
  PracticeBotRuntime,
  PRACTICE_BOT_ID_BASE,
  type BotDebugInfo,
  type BotObstacleDebugInfo,
  type LocalSelfAccessor,
  type LocalSelfSnapshot,
  type PracticeBotBehaviorKind,
  type PracticeBotRuntimeOptions,
  type PracticeBotRuntimeSyncOptions,
  type PracticeBotStats,
} from './practice/PracticeBotRuntime';
