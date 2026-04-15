/**
 * High-level wrapper around a navcat crowd. One {@link BotCrowd} owns a
 * single shared navmesh and a navcat {@link crowd.Crowd}; each connected bot
 * is one agent inside it.
 *
 * The wrapper exists so callers never have to reach into `navcat`'s imperative
 * crowd API directly — they get `addBot`, `removeBot`, `requestMoveTo`, etc.,
 * and all the navmesh housekeeping (nearest-poly lookups, position syncing,
 * bounds clamping) is centralized here.
 */

import { crowd } from 'navcat/blocks';

type AgentParams = crowd.AgentParams;
type Crowd = crowd.Crowd;
import {
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  findRandomPoint,
  type NavMesh,
  type NodeRef,
  type Vec3,
} from 'navcat';

import type { WorldDocument } from '../../world/worldDocument';
import type { Vec3Tuple } from '../types';
import {
  buildBotNavMesh,
  type BotNavMesh,
  type BuildBotNavMeshOptions,
} from '../world/buildNavMesh';

export interface BotCrowdOptions extends BuildBotNavMeshOptions {
  /**
   * The largest agent radius that will be added to this crowd. navcat uses
   * this to size internal placement half-extents and neighbor grids; pick a
   * value at least as large as your biggest agent.
   * @default 0.6
   */
  maxAgentRadius?: number;
  /**
   * Half-extents used when snapping positions to the nearest walkable polygon.
   * Larger values tolerate bigger mismatches between the server's character
   * position and the navmesh surface (useful for terrain heightfields where
   * the KCC stands slightly above the triangle mesh).
   * @default [2, 4, 2]
   */
  snapHalfExtents?: Vec3Tuple;
}

export interface BotHandle {
  /** String id used by navcat for this agent. */
  readonly id: string;
  /** Currently applied target position, if any. */
  targetPosition: Vec3Tuple | null;
}

const DEFAULT_SNAP_HALF_EXTENTS: Vec3Tuple = [2, 4, 2];

const DEFAULT_AGENT_PARAMS: Omit<AgentParams, 'queryFilter'> = {
  radius: 0.45,
  height: 1.7,
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

/**
 * Wrapper around a navcat crowd. Thread-hostile — create one per Node worker
 * or per browser tab and reuse it for the lifetime of the bot swarm.
 */
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

  /** The underlying navcat NavMesh (for raw queries). */
  get navMesh(): NavMesh {
    return this.nav.navMesh;
  }

  /**
   * Adds a new bot to the crowd and returns its handle.
   *
   * The supplied `initialPosition` is snapped to the nearest walkable
   * polygon; if no polygon is reachable the agent is still created at the
   * raw position and will be in the INVALID state until moved onto the mesh.
   */
  addBot(initialPosition: Vec3Tuple, params?: Partial<AgentParams>): BotHandle {
    const snap = this.findNearestWalkable(initialPosition);
    const position: Vec3 = snap ? snap.position : ([...initialPosition] as Vec3);
    const agentParams: AgentParams = {
      ...DEFAULT_AGENT_PARAMS,
      ...params,
      queryFilter: params?.queryFilter ?? DEFAULT_QUERY_FILTER,
    };
    const id = crowd.addAgent(this.crowd, this.nav.navMesh, position, agentParams);
    const handle: BotHandle = { id, targetPosition: null };
    this.handles.set(id, handle);
    return handle;
  }

  /** Removes a bot by handle or id. */
  removeBot(botOrId: BotHandle | string): boolean {
    const id = typeof botOrId === 'string' ? botOrId : botOrId.id;
    const removed = crowd.removeAgent(this.crowd, id);
    if (removed) this.handles.delete(id);
    return removed;
  }

  /**
   * Adds a **static pseudo-agent** to the crowd for use as a dynamic
   * obstacle (e.g. a vehicle that can roll into the bots' pathing space).
   * The returned string id is a raw navcat agent id — pass it back to
   * {@link setObstacleAgentPose} / {@link removeObstacleAgent}.
   *
   * The pseudo-agent has `maxSpeed = 0` and `updateFlags = 0`, so navcat
   * won't try to move it; it exists solely so real bot agents' separation
   * + obstacle-avoidance logic routes around it.
   */
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

  /**
   * Updates a pseudo-agent's world position (and optional velocity for
   * anticipatory avoidance). Safe to call every tick. Returns false if
   * the id is unknown.
   */
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

  /** Removes a previously added obstacle pseudo-agent. */
  removeObstacleAgent(agentId: string): boolean {
    return crowd.removeAgent(this.crowd, agentId);
  }

  /** Look up a previously added handle by id. */
  getHandle(id: string): BotHandle | undefined {
    return this.handles.get(id);
  }

  /** Read the navcat agent object for direct inspection (position, etc.). */
  getAgent(id: string) {
    return this.crowd.agents[id];
  }

  /**
   * Snaps a world-space target to the nearest walkable polygon and requests
   * that the agent plan a path to it. Returns true on success.
   */
  requestMoveTo(botOrId: BotHandle | string, target: Vec3Tuple): boolean {
    const handle = typeof botOrId === 'string' ? this.handles.get(botOrId) : botOrId;
    if (!handle) return false;
    const nearest = this.findNearestWalkable(target);
    if (!nearest) return false;
    handle.targetPosition = [nearest.position[0], nearest.position[1], nearest.position[2]];
    return crowd.requestMoveTarget(
      this.crowd,
      handle.id,
      nearest.nodeRef,
      nearest.position,
    );
  }

  /** Clears the agent's current move target (agent will stop). */
  stop(botOrId: BotHandle | string): boolean {
    const handle = typeof botOrId === 'string' ? this.handles.get(botOrId) : botOrId;
    if (!handle) return false;
    handle.targetPosition = null;
    return crowd.resetMoveTarget(this.crowd, handle.id);
  }

  /**
   * Updates the agent's internal position so subsequent planning uses the
   * server-authoritative location. Without this the crowd happily predicts
   * but drifts off the network truth.
   */
  syncBotPosition(botOrId: BotHandle | string, serverPosition: Vec3Tuple): void {
    const handle = typeof botOrId === 'string' ? this.handles.get(botOrId) : botOrId;
    if (!handle) return;
    const agent = this.crowd.agents[handle.id];
    if (!agent) return;
    // Snap to mesh so the corridor/poly refs stay consistent.
    const nearest = this.findNearestWalkable(serverPosition);
    const target: Vec3 = nearest ? nearest.position : ([...serverPosition] as Vec3);
    agent.position[0] = target[0];
    agent.position[1] = target[1];
    agent.position[2] = target[2];
  }

  /**
   * Advances the crowd simulation by `dt` seconds. Call this once per tick,
   * not once per bot.
   */
  step(dt: number): void {
    crowd.update(this.crowd, this.nav.navMesh, dt);
  }

  /** Returns true if the bot is within `threshold` meters of its target. */
  isAtTarget(botOrId: BotHandle | string, threshold: number): boolean {
    const id = typeof botOrId === 'string' ? botOrId : botOrId.id;
    return crowd.isAgentAtTarget(this.crowd, id, threshold);
  }

  /**
   * Finds the nearest walkable polygon to a world-space position. Returns
   * `null` if nothing is reachable within {@link snapHalfExtents}.
   */
  findNearestWalkable(position: Vec3Tuple): { nodeRef: NodeRef; position: Vec3 } | null {
    const center: Vec3 = [position[0], position[1], position[2]];
    findNearestPoly(
      this.tmpNearest,
      this.nav.navMesh,
      center,
      this.snapHalfExtents as Vec3,
      DEFAULT_QUERY_FILTER,
    );
    if (!this.tmpNearest.success) return null;
    // Copy so callers can't mutate our scratch buffer.
    return {
      nodeRef: this.tmpNearest.nodeRef,
      position: [
        this.tmpNearest.position[0],
        this.tmpNearest.position[1],
        this.tmpNearest.position[2],
      ] as Vec3,
    };
  }

  /**
   * Returns a random walkable point anywhere on the navmesh, or `null` if the
   * mesh is empty.
   */
  findRandomWalkable(rand: () => number = Math.random): Vec3Tuple | null {
    const result = findRandomPoint(this.nav.navMesh, DEFAULT_QUERY_FILTER, rand);
    if (!result.success) return null;
    return [result.position[0], result.position[1], result.position[2]];
  }
}

/**
 * Convenience constructor: builds the navmesh and a ready-to-use BotCrowd in
 * one call.
 */
export function createBotCrowd(world: WorldDocument, options: BotCrowdOptions = {}): BotCrowd {
  const nav = buildBotNavMesh(world, options);
  // Default `maxAgentRadius` is sized for vehicle-scale obstacles (the
  // biggest thing we register via `addObstacleAgent`). Bots themselves are
  // smaller (≈0.45), but navcat uses this value to pre-size its neighbor
  // lookup so the largest possible agent still fits.
  const maxAgentRadius = options.maxAgentRadius ?? 2.5;
  const crowdInstance = crowd.create(maxAgentRadius);
  const snap = options.snapHalfExtents ?? DEFAULT_SNAP_HALF_EXTENTS;
  return new BotCrowd(nav, crowdInstance, snap);
}
