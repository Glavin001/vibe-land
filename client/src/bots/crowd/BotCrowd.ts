/**
 * High-level wrapper around a navcat crowd.
 */

import { crowd, pathCorridor } from 'navcat/blocks';
import {
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  findRandomPoint,
  INVALID_NODE_REF,
  type NavMesh,
  type NodeRef,
  type Vec3,
} from 'navcat';

import type { WorldDocument } from '../../world/worldDocument';
import type { Vec3Tuple } from '../types';
import {
  buildBotNavMesh,
  buildBotNavMeshFromSharedProfile,
  type BotNavMesh,
  type BuildBotNavMeshOptions,
  type BuildBotNavMeshFromSharedProfileOptions,
} from '../world/buildNavMesh';

type AgentParams = crowd.AgentParams;
type Crowd = crowd.Crowd;

export interface BotCrowdOptions extends BuildBotNavMeshOptions {
  maxAgentRadius?: number;
  snapHalfExtents?: Vec3Tuple;
}

export interface BotCrowdFromSharedProfileOptions extends BuildBotNavMeshFromSharedProfileOptions {
  maxAgentRadius?: number;
  snapHalfExtents?: Vec3Tuple;
}

export interface BotHandle {
  readonly id: string;
  targetPosition: Vec3Tuple | null;
}

const DEFAULT_SNAP_HALF_EXTENTS: Vec3Tuple = [2, 4, 2];
const CORRIDOR_RESET_DISTANCE_M = 1.5;

function defaultAgentParams(nav: BotNavMesh): Omit<AgentParams, 'queryFilter'> {
  return {
    radius: nav.navigationProfile.walkableRadius,
    height: nav.navigationProfile.walkableHeight,
    maxAcceleration: 25.0,
    maxSpeed: 7.0,
    collisionQueryRange: 4,
    separationWeight: 1.0,
    updateFlags:
      crowd.CrowdUpdateFlags.ANTICIPATE_TURNS
      | crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE
      | crowd.CrowdUpdateFlags.SEPARATION
      | crowd.CrowdUpdateFlags.OPTIMIZE_VIS
      | crowd.CrowdUpdateFlags.OPTIMIZE_TOPO,
    obstacleAvoidance: crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
    autoTraverseOffMeshConnections: true,
  };
}

export class BotCrowd {
  readonly nav: BotNavMesh;
  readonly crowd: Crowd;
  private readonly handles = new Map<string, BotHandle>();
  private readonly snapHalfExtents: Vec3Tuple;
  private readonly tmpNearest = createFindNearestPolyResult();

  constructor(nav: BotNavMesh, crowdInstance: Crowd, snapHalfExtents: Vec3Tuple) {
    this.nav = nav;
    this.crowd = crowdInstance;
    this.snapHalfExtents = snapHalfExtents;
  }

  get navMesh(): NavMesh {
    return this.nav.navMesh;
  }

  get debugSnapHalfExtents(): Vec3Tuple {
    return [this.snapHalfExtents[0], this.snapHalfExtents[1], this.snapHalfExtents[2]];
  }

  addBot(initialPosition: Vec3Tuple, params?: Partial<AgentParams>): BotHandle {
    const snap = this.findNearestWalkable(initialPosition);
    const position: Vec3 = snap ? snap.position : ([...initialPosition] as Vec3);
    const agentParams: AgentParams = {
      ...defaultAgentParams(this.nav),
      ...params,
      queryFilter: params?.queryFilter ?? DEFAULT_QUERY_FILTER,
    };
    const id = crowd.addAgent(this.crowd, this.nav.navMesh, position, agentParams);
    const handle: BotHandle = { id, targetPosition: null };
    this.handles.set(id, handle);
    return handle;
  }

  removeBot(botOrId: BotHandle | string): boolean {
    const id = typeof botOrId === 'string' ? botOrId : botOrId.id;
    const removed = crowd.removeAgent(this.crowd, id);
    if (removed) this.handles.delete(id);
    return removed;
  }

  addObstacleAgent(position: Vec3Tuple, radius: number, height: number): string {
    const snap = this.findNearestWalkable(position);
    const initial: Vec3 = snap
      ? ([snap.position[0], snap.position[1], snap.position[2]] as Vec3)
      : ([position[0], position[1], position[2]] as Vec3);
    const params: AgentParams = {
      radius,
      height,
      maxAcceleration: 0,
      maxSpeed: 0,
      collisionQueryRange: 0,
      separationWeight: 0,
      updateFlags: 0,
      queryFilter: DEFAULT_QUERY_FILTER,
      obstacleAvoidance: crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
      autoTraverseOffMeshConnections: false,
    };
    return crowd.addAgent(this.crowd, this.nav.navMesh, initial, params);
  }

  setObstacleAgentPose(
    agentId: string,
    position: Vec3Tuple,
    velocity?: Vec3Tuple,
  ): boolean {
    const agent = this.crowd.agents[agentId];
    if (!agent) return false;
    agent.position[0] = position[0];
    agent.position[1] = position[1];
    agent.position[2] = position[2];
    if (velocity) {
      agent.velocity[0] = velocity[0];
      agent.velocity[1] = velocity[1];
      agent.velocity[2] = velocity[2];
    }
    return true;
  }

  removeObstacleAgent(agentId: string): boolean {
    return crowd.removeAgent(this.crowd, agentId);
  }

  getHandle(id: string): BotHandle | undefined {
    return this.handles.get(id);
  }

  getAgent(id: string) {
    return this.crowd.agents[id];
  }

  requestMoveTo(botOrId: BotHandle | string, target: Vec3Tuple): boolean {
    const handle = typeof botOrId === 'string' ? this.handles.get(botOrId) : botOrId;
    if (!handle) return false;
    const nearest = this.findNearestWalkableForActorCenter(target);
    if (!nearest) {
      handle.targetPosition = null;
      return false;
    }
    handle.targetPosition = [nearest.position[0], nearest.position[1], nearest.position[2]];
    return crowd.requestMoveTarget(
      this.crowd,
      handle.id,
      nearest.nodeRef,
      nearest.position,
    );
  }

  stop(botOrId: BotHandle | string): boolean {
    const handle = typeof botOrId === 'string' ? this.handles.get(botOrId) : botOrId;
    if (!handle) return false;
    handle.targetPosition = null;
    return crowd.resetMoveTarget(this.crowd, handle.id);
  }

  syncBotPosition(botOrId: BotHandle | string, serverPosition: Vec3Tuple): void {
    const handle = typeof botOrId === 'string' ? this.handles.get(botOrId) : botOrId;
    if (!handle) return;
    const agent = this.crowd.agents[handle.id];
    if (!agent) return;
    const nearest = this.findNearestWalkableForActorCenter(serverPosition);
    const target: Vec3 = nearest ? nearest.position : ([...serverPosition] as Vec3);
    if (nearest) {
      const dx = target[0] - agent.corridor.position[0];
      const dy = target[1] - agent.corridor.position[1];
      const dz = target[2] - agent.corridor.position[2];
      const correctionDistSq = dx * dx + dy * dy + dz * dz;
      if (
        agent.corridor.path.length === 0
        || correctionDistSq >= CORRIDOR_RESET_DISTANCE_M * CORRIDOR_RESET_DISTANCE_M
      ) {
        // Spawn/respawn corrections are effectively teleports, so preserving the
        // previous corridor would steer from the wrong polygon.
        pathCorridor.reset(agent.corridor, nearest.nodeRef, target);
      } else {
        const moved = pathCorridor.movePosition(
          agent.corridor,
          target,
          this.nav.navMesh,
          agent.queryFilter,
        );
        if (!moved || agent.corridor.path[0] !== nearest.nodeRef) {
          const fixed = pathCorridor.fixPathStart(agent.corridor, nearest.nodeRef, target);
          if (!fixed) {
            pathCorridor.reset(agent.corridor, nearest.nodeRef, target);
          }
        }
      }
    } else {
      pathCorridor.reset(agent.corridor, INVALID_NODE_REF, target);
    }
    agent.position[0] = target[0];
    agent.position[1] = target[1];
    agent.position[2] = target[2];
  }

  step(dt: number): void {
    crowd.update(this.crowd, this.nav.navMesh, dt);
  }

  isAtTarget(botOrId: BotHandle | string, threshold: number): boolean {
    const id = typeof botOrId === 'string' ? botOrId : botOrId.id;
    return crowd.isAgentAtTarget(this.crowd, id, threshold);
  }

  findNearestWalkable(position: Vec3Tuple): { nodeRef: NodeRef; position: Vec3 } | null {
    return this.findNearestWalkableFromQueryCenter(position);
  }

  private findNearestWalkableForActorCenter(
    position: Vec3Tuple,
  ): { nodeRef: NodeRef; position: Vec3 } | null {
    // Player snapshot positions are capsule centers; query from the feet so
    // ledges near the actor do not snap onto a higher unclimbable surface.
    const feetYOffset = this.nav.navigationProfile.walkableHeight * 0.5;
    return this.findNearestWalkableFromQueryCenter([
      position[0],
      position[1] - feetYOffset,
      position[2],
    ]);
  }

  private findNearestWalkableFromQueryCenter(
    position: Vec3Tuple,
  ): { nodeRef: NodeRef; position: Vec3 } | null {
    const center: Vec3 = [position[0], position[1], position[2]];
    findNearestPoly(
      this.tmpNearest,
      this.nav.navMesh,
      center,
      this.snapHalfExtents as Vec3,
      DEFAULT_QUERY_FILTER,
    );
    if (!this.tmpNearest.success) return null;
    return {
      nodeRef: this.tmpNearest.nodeRef,
      position: [
        this.tmpNearest.position[0],
        this.tmpNearest.position[1],
        this.tmpNearest.position[2],
      ] as Vec3,
    };
  }

  findRandomWalkable(rand: () => number = Math.random): Vec3Tuple | null {
    const result = findRandomPoint(this.nav.navMesh, DEFAULT_QUERY_FILTER, rand);
    if (!result.success) return null;
    return [result.position[0], result.position[1], result.position[2]];
  }
}

export function createBotCrowd(world: WorldDocument, options: BotCrowdOptions): BotCrowd {
  const nav = buildBotNavMesh(world, options);
  const maxAgentRadius = options.maxAgentRadius ?? 2.5;
  const crowdInstance = crowd.create(maxAgentRadius);
  const snap = options.snapHalfExtents ?? DEFAULT_SNAP_HALF_EXTENTS;
  return new BotCrowd(nav, crowdInstance, snap);
}

export async function createBotCrowdFromSharedProfile(
  world: WorldDocument,
  options: BotCrowdFromSharedProfileOptions = {},
): Promise<BotCrowd> {
  const nav = await buildBotNavMeshFromSharedProfile(world, options);
  const maxAgentRadius = options.maxAgentRadius ?? 2.5;
  const crowdInstance = crowd.create(maxAgentRadius);
  const snap = options.snapHalfExtents ?? DEFAULT_SNAP_HALF_EXTENTS;
  return new BotCrowd(nav, crowdInstance, snap);
}
