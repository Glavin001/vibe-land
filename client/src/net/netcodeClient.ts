import { GameSocket } from './gameSocket';
import { PlayerInterpolator, ServerClockEstimator, type PlayerSample } from './interpolation';
import {
  netDynamicBodyStateToMeters,
  netStateToMeters,
  type BlockEditCmd,
  type DynamicBodyStateMeters,
  type InputCmd,
  type NetPlayerState,
  type ServerPacket,
  type ServerWorldPacket,
} from './protocol';

export type RemotePlayer = {
  id: number;
  position: [number, number, number];
  yaw: number;
  pitch: number;
  hp: number;
};

export type NetcodeClientConfig = {
  onWelcome?: (playerId: number) => void;
  onDisconnect?: () => void;
  onLocalSnapshot?: (ackInputSeq: number, state: NetPlayerState) => void;
  onWorldPacket?: (packet: ServerWorldPacket) => void;
  onShotResult?: (packet: ServerPacket) => void;
  onPacket?: (packet: ServerPacket) => void;
};

/**
 * Framework-agnostic netcode client.
 *
 * Owns the network socket, server clock estimation, remote player
 * interpolation, and snapshot routing.  Does NOT depend on React or
 * any rendering framework.
 *
 * Usage:
 *   const client = new NetcodeClient({ onWelcome: ..., onLocalSnapshot: ... });
 *   client.connect(wsUrl);
 *   // each frame: sample remote players
 *   const sample = client.sampleRemotePlayer(id);
 *   // send inputs
 *   client.sendInputs(cmds);
 */
export class NetcodeClient {
  readonly interpolator: PlayerInterpolator;
  readonly serverClock: ServerClockEstimator;

  playerId = 0;
  interpolationDelayMs = 100;
  latestServerTick = 0;
  rttMs = 0;
  readonly remotePlayers = new Map<number, RemotePlayer>();
  readonly dynamicBodies = new Map<number, DynamicBodyStateMeters>();

  private socket: GameSocket | null = null;
  private config: NetcodeClientConfig;

  constructor(config: NetcodeClientConfig) {
    this.config = config;
    this.interpolator = new PlayerInterpolator();
    this.serverClock = new ServerClockEstimator();
  }

  connect(wsUrl: string): void {
    this.socket = new GameSocket({
      onPacket: (packet: ServerPacket) => this.handlePacket(packet),
      onClose: () => { this.config.onDisconnect?.(); },
      onRttUpdated: (rttMs: number) => { this.rttMs = rttMs; },
    });
    this.socket.connect(wsUrl);
  }

  ping(): void {
    this.socket?.ping();
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  sendInputs(cmds: InputCmd[]): void {
    this.socket?.sendInputs(cmds);
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    this.socket?.sendBlockEdit(cmd);
  }

  /**
   * Process a server packet directly (for testing without a real socket).
   * In production, packets arrive via the socket; in tests, call this directly.
   */
  handlePacket(packet: ServerPacket): void {
    switch (packet.type) {
      case 'welcome':
        this.playerId = packet.playerId;
        this.interpolationDelayMs = packet.interpolationDelayMs;
        // Don't seed clock from welcome — it arrives with unpredictable
        // latency (TLS handshake, etc.) and skews the initial offset.
        // The first snapshot will initialize the estimator instead.
        this.config.onWelcome?.(packet.playerId);
        break;
      case 'snapshot': {
        this.latestServerTick = packet.serverTick;
        this.serverClock.observe(packet.serverTimeUs, performance.now() * 1000);

        // Update dynamic bodies BEFORE reconciliation so that input replay
        // collides with the correct (same-tick) collider positions.
        this.dynamicBodies.clear();
        for (const db of packet.dynamicBodyStates) {
          this.dynamicBodies.set(db.id, netDynamicBodyStateToMeters(db));
        }

        const knownIds = new Set<number>();
        for (const ps of packet.playerStates) {
          knownIds.add(ps.id);
          if (ps.id === this.playerId) {
            this.config.onLocalSnapshot?.(packet.ackInputSeq, ps);
          } else {
            const m = netStateToMeters(ps);
            this.interpolator.push(ps.id, {
              serverTimeUs: packet.serverTimeUs,
              position: m.position,
              velocity: m.velocity,
              yaw: m.yaw,
              pitch: m.pitch,
              flags: ps.flags,
            });
            this.remotePlayers.set(ps.id, {
              id: ps.id,
              position: m.position,
              yaw: m.yaw,
              pitch: m.pitch,
              hp: 100,
            });
          }
        }
        // Remove disconnected players
        for (const id of this.remotePlayers.keys()) {
          if (!knownIds.has(id)) {
            this.remotePlayers.delete(id);
            this.interpolator.remove(id);
          }
        }
        this.interpolator.retainOnly(knownIds);
        break;
      }
      case 'chunkFull':
      case 'chunkDiff':
        this.config.onWorldPacket?.(packet);
        break;
      case 'shotResult':
        this.config.onShotResult?.(packet);
        break;
      default:
        break;
    }
    this.config.onPacket?.(packet);
  }

  /** Get the render time for interpolating remote players. */
  getRenderTimeUs(localTimeUs?: number): number {
    return this.serverClock.renderTimeUs(
      this.interpolationDelayMs * 1000,
      localTimeUs,
    );
  }

  /** Sample a remote player's interpolated state at the current render time. */
  sampleRemotePlayer(id: number, renderTimeUs?: number): PlayerSample | null {
    const t = renderTimeUs ?? this.getRenderTimeUs();
    return this.interpolator.sample(id, t);
  }

  /** Reset all state (for reconnection). */
  reset(): void {
    this.playerId = 0;
    this.latestServerTick = 0;
    this.interpolationDelayMs = 100;
    this.remotePlayers.clear();
    this.dynamicBodies.clear();
  }
}
