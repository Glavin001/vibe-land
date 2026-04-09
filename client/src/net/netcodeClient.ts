import { GameSocket } from './gameSocket';
import { PlayerInterpolator, ServerClockEstimator, VehicleInterpolator, type PlayerSample, type VehicleSample } from './interpolation';
import {
  netDynamicBodyStateToMeters,
  netStateToMeters,
  netVehicleStateToMeters,
  type BlockEditCmd,
  type DynamicBodyStateMeters,
  type InputCmd,
  type NetPlayerState,
  type NetVehicleState,
  type ServerPacket,
  type ServerWorldPacket,
  type VehicleStateMeters,
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
  onLocalVehicleSnapshot?: (vehicleState: NetVehicleState, ackInputSeq: number) => void;
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
  readonly vehicleInterpolator: VehicleInterpolator;

  playerId = 0;
  interpolationDelayMs = 100;
  latestServerTick = 0;
  rttMs = 0;
  readonly remotePlayers = new Map<number, RemotePlayer>();
  readonly dynamicBodies = new Map<number, DynamicBodyStateMeters>();
  readonly vehicles = new Map<number, VehicleStateMeters>();

  private socket: GameSocket | null = null;
  private config: NetcodeClientConfig;

  constructor(config: NetcodeClientConfig) {
    this.config = config;
    this.interpolator = new PlayerInterpolator();
    this.serverClock = new ServerClockEstimator();
    this.vehicleInterpolator = new VehicleInterpolator();
  }

  connect(wsUrl: string): void {
    this.socket = new GameSocket({
      onPacket: (packet: ServerPacket) => this.handlePacket(packet),
      onClose: () => { this.config.onDisconnect?.(); },
      onRttUpdated: (rttMs: number) => {
        this.rttMs = rttMs;
        this.serverClock.observeRtt(rttMs);
      },
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

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    this.socket?.sendVehicleEnter(vehicleId, seat);
  }

  sendVehicleExit(vehicleId: number): void {
    this.socket?.sendVehicleExit(vehicleId);
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
        // Tell the clock the server's tick rate so hysteresis thresholds are correct.
        this.serverClock.setSimHz(packet.simHz);
        // Don't seed clock from welcome — it arrives with unpredictable
        // latency (TLS handshake, etc.) and skews the initial offset.
        // The first snapshot will initialize the estimator instead.
        this.config.onWelcome?.(packet.playerId);
        break;
      case 'snapshot': {
        this.latestServerTick = packet.serverTick;
        this.serverClock.observe(packet.serverTimeUs, performance.now() * 1000);
        // Use adaptive interpolation delay from WASM when available (jitter*4 + 5ms).
        const adaptiveDelayMs = this.serverClock.getInterpolationDelayMs();
        if (adaptiveDelayMs > 0) {
          this.interpolationDelayMs = Math.round(adaptiveDelayMs * 100) / 100;
        }

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

        // Handle vehicle states
        const knownVehicleIds = new Set<number>();
        for (const vs of packet.vehicleStates) {
          knownVehicleIds.add(vs.id);
          const m = netVehicleStateToMeters(vs);
          this.vehicles.set(vs.id, m);

          // Route local vehicle snapshot to driver-side prediction
          if (vs.driverId === this.playerId && vs.driverId !== 0) {
            this.config.onLocalVehicleSnapshot?.(vs, packet.ackInputSeq);
          } else {
            // Push to interpolator for remote rendering
            this.vehicleInterpolator.push(vs.id, {
              serverTimeUs: packet.serverTimeUs,
              position: m.position,
              quaternion: m.quaternion,
              linearVelocity: m.linearVelocity,
              angularVelocity: m.angularVelocity,
              wheelData: m.wheelData,
              driverPlayerId: vs.driverId,
              flags: vs.flags,
            });
          }
        }
        // Remove despawned vehicles
        for (const id of this.vehicles.keys()) {
          if (!knownVehicleIds.has(id)) {
            this.vehicles.delete(id);
            this.vehicleInterpolator.remove(id);
          }
        }
        this.vehicleInterpolator.retainOnly(knownVehicleIds);
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

  /** Get the render time for interpolating remote vehicles. */
  sampleRemoteVehicle(id: number, renderTimeUs?: number): VehicleSample | null {
    const t = renderTimeUs ?? this.getRenderTimeUs();
    return this.vehicleInterpolator.sample(id, t);
  }

  /** Reset all state (for reconnection). */
  reset(): void {
    this.playerId = 0;
    this.latestServerTick = 0;
    this.interpolationDelayMs = 100;
    this.remotePlayers.clear();
    this.dynamicBodies.clear();
    this.vehicles.clear();
  }
}
