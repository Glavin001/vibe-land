import { GameSocket } from './gameSocket';
import { LocalPreviewTransport } from './localPreviewTransport';
import { WebTransportGameClient } from './webTransportClient';
import {
  DynamicBodyInterpolator,
  PlayerInterpolator,
  ServerClockEstimator,
  VehicleInterpolator,
  type DynamicBodySample,
  type PlayerSample,
  type VehicleSample,
} from './interpolation';
import {
  encodeDebugStatsPacket,
  netDynamicBodyStateToMeters,
  netStateToMeters,
  netVehicleStateToMeters,
  type BlockEditCmd,
  type DynamicBodyStateMeters,
  type FireCmd,
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
  private static readonly DYNAMIC_BODY_STALE_TICKS = 90;

  readonly interpolator: PlayerInterpolator;
  readonly serverClock: ServerClockEstimator;
  readonly vehicleInterpolator: VehicleInterpolator;
  readonly dynamicBodyInterpolator: DynamicBodyInterpolator;

  playerId = 0;
  interpolationDelayMs = 100;
  latestServerTick = 0;
  rttMs = 0;
  localPlayerHp = 100;
  localPlayerFlags = 0;
  readonly remotePlayers = new Map<number, RemotePlayer>();
  readonly dynamicBodies = new Map<number, DynamicBodyStateMeters>();
  readonly vehicles = new Map<number, VehicleStateMeters>();
  private readonly dynamicBodyLastSeenTick = new Map<number, number>();

  private socket: GameSocket | null = null;
  private wtClient: WebTransportGameClient | null = null;
  private localTransport: LocalPreviewTransport | null = null;
  private config: NetcodeClientConfig;

  // Rolling accumulators for 1Hz debug stats report to server
  private _debugCorrectionSum = 0;
  private _debugPhysicsSum = 0;
  private _debugSampleCount = 0;
  private _debugLastSendMs = 0;

  /** Human-readable active transport. */
  get transport(): string {
    if (this.localTransport) return 'local-preview';
    if (this.wtClient) return 'webtransport';
    if (this.socket) return 'websocket';
    return 'connecting';
  }

  constructor(config: NetcodeClientConfig) {
    this.config = config;
    this.interpolator = new PlayerInterpolator();
    this.serverClock = new ServerClockEstimator();
    this.vehicleInterpolator = new VehicleInterpolator();
    this.dynamicBodyInterpolator = new DynamicBodyInterpolator();
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

  async connectLocalPreview(worldJson?: string): Promise<void> {
    this.localTransport = await LocalPreviewTransport.connect({
      worldJson,
      onPacket: (packet) => this.handlePacket(packet),
      onClose: () => {
        this.localTransport = null;
        this.config.onDisconnect?.();
      },
    });
  }

  /**
   * Try WebTransport first; fall back to WebSocket on failure or if unsupported.
   */
  async connectWithFallback(matchId: string, wsUrl: string, sessionConfigEndpoint?: string): Promise<void> {
    const hasWebTransport = typeof window !== 'undefined' && 'WebTransport' in window;
    console.info('[netcode] connectWithFallback', { matchId, wsUrl, browserSupportsWT: hasWebTransport });

    if (hasWebTransport) {
      console.info('[netcode] attempting WebTransport (QUIC/UDP)...');
      try {
        const wt = await WebTransportGameClient.connect({
          matchId,
          sessionConfigEndpoint,
          onReliablePacket: (packet) => this.handlePacket(packet as ServerPacket),
          onDatagramPacket: (packet) => this.handlePacket(packet as ServerPacket),
          onClose: () => { this.config.onDisconnect?.(); },
        });
        this.wtClient = wt;
        console.info('[netcode] ✓ connected via WebTransport (QUIC/UDP)', wt.sessionConfig.url);
        return;
      } catch (err) {
        console.warn('[netcode] WebTransport failed — falling back to WebSocket', err);
      }
    } else {
      console.info('[netcode] WebTransport not supported in this browser — using WebSocket');
    }

    console.info('[netcode] connecting via WebSocket (TCP):', wsUrl);
    this.connect(wsUrl);
  }

  ping(): void {
    if (this.localTransport) {
      this.localTransport.ping();
      return;
    }
    // WebTransport RTT is measured server-side via server-initiated pings
    if (!this.wtClient) {
      this.socket?.ping();
    }
  }

  disconnect(): void {
    this.localTransport?.close();
    this.localTransport = null;
    this.wtClient?.close();
    this.wtClient = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  sendInputs(cmds: InputCmd[]): void {
    if (this.localTransport) {
      this.localTransport.sendInputs(cmds);
    } else if (this.wtClient) {
      if (cmds.length > 0) this.wtClient.sendInputBundle(cmds);
    } else {
      this.socket?.sendInputs(cmds);
    }
  }

  /**
   * Accumulate per-frame debug stats; sends a 9-byte report to the server once per second.
   * Call each frame with the current correction magnitude and physics step time.
   */
  accumulateDebugStats(correctionM: number, physicsStepMs: number): void {
    this._debugCorrectionSum += correctionM;
    this._debugPhysicsSum += physicsStepMs;
    this._debugSampleCount++;

    const now = performance.now();
    if (now - this._debugLastSendMs >= 1000 && this._debugSampleCount > 0) {
      const avgCorrection = this._debugCorrectionSum / this._debugSampleCount;
      const avgPhysics = this._debugPhysicsSum / this._debugSampleCount;
      const pkt = encodeDebugStatsPacket(avgCorrection, avgPhysics);
      if (this.localTransport) {
        // Local preview has no server stats consumer.
      } else if (this.wtClient) {
        this.wtClient.sendRawDatagram(pkt);
      } else {
        this.socket?.sendRaw(pkt);
      }
      this._debugCorrectionSum = 0;
      this._debugPhysicsSum = 0;
      this._debugSampleCount = 0;
      this._debugLastSendMs = now;
    }
  }

  sendFire(cmd: FireCmd): void {
    if (this.localTransport) {
      this.localTransport.sendFire(cmd);
    } else if (this.wtClient) {
      this.wtClient.sendFire(cmd);
    } else {
      this.socket?.sendFire(cmd);
    }
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    if (this.localTransport) {
      this.localTransport.sendBlockEdit(cmd);
    } else if (this.wtClient) {
      this.wtClient.sendBlockEdit(cmd);
    } else {
      this.socket?.sendBlockEdit(cmd);
    }
  }

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    if (this.localTransport) {
      this.localTransport.sendVehicleEnter(vehicleId, seat);
    } else if (this.wtClient) {
      this.wtClient.sendVehicleEnter(vehicleId, seat);
    } else {
      this.socket?.sendVehicleEnter(vehicleId, seat);
    }
  }

  sendVehicleExit(vehicleId: number): void {
    if (this.localTransport) {
      this.localTransport.sendVehicleExit(vehicleId);
    } else if (this.wtClient) {
      this.wtClient.sendVehicleExit(vehicleId);
    } else {
      this.socket?.sendVehicleExit(vehicleId);
    }
  }

  /**
   * Process a server packet directly (for testing without a real socket).
   * In production, packets arrive via the socket; in tests, call this directly.
   */
  handlePacket(packet: ServerPacket): void {
    switch (packet.type) {
      case 'welcome':
        this.playerId = packet.playerId;
        this.interpolationDelayMs = this.localTransport ? 0 : packet.interpolationDelayMs;
        // Tell the clock the server's tick rate so hysteresis thresholds are correct.
        this.serverClock.setSimHz(packet.simHz);
        // Don't seed clock from welcome — it arrives with unpredictable
        // latency (TLS handshake, etc.) and skews the initial offset.
        // The first snapshot will initialize the estimator instead.
        console.info('[netcode] Welcome — playerId:', packet.playerId, { transport: this.transport, simHz: packet.simHz, interpolationDelayMs: packet.interpolationDelayMs });
        this.config.onWelcome?.(packet.playerId);
        break;
      case 'snapshot': {
        this.latestServerTick = packet.serverTick;
        this.serverClock.observe(packet.serverTimeUs, performance.now() * 1000);
        if (this.localTransport) {
          this.interpolationDelayMs = 0;
        } else {
          // Use adaptive interpolation delay from WASM when available (jitter*4 + 5ms).
          const adaptiveDelayMs = this.serverClock.getInterpolationDelayMs();
          if (adaptiveDelayMs > 0) {
            this.interpolationDelayMs = Math.round(adaptiveDelayMs * 100) / 100;
          }
        }

        // Update dynamic bodies BEFORE reconciliation so that input replay
        // collides with the correct (same-tick) collider positions.
        for (const db of packet.dynamicBodyStates) {
          const meters = netDynamicBodyStateToMeters(db);
          this.dynamicBodies.set(db.id, meters);
          this.dynamicBodyInterpolator.push(db.id, {
            serverTimeUs: packet.serverTimeUs,
            position: meters.position,
            quaternion: meters.quaternion,
            halfExtents: meters.halfExtents,
            velocity: meters.velocity,
            angularVelocity: meters.angularVelocity,
            shapeType: meters.shapeType,
          });
          this.dynamicBodyLastSeenTick.set(db.id, packet.serverTick);
        }
        for (const [id, lastSeenTick] of this.dynamicBodyLastSeenTick) {
          if (packet.serverTick - lastSeenTick > NetcodeClient.DYNAMIC_BODY_STALE_TICKS) {
            this.dynamicBodyLastSeenTick.delete(id);
            this.dynamicBodies.delete(id);
            this.dynamicBodyInterpolator.remove(id);
          }
        }

        const knownIds = new Set<number>();
        for (const ps of packet.playerStates) {
          knownIds.add(ps.id);
          if (ps.id === this.playerId) {
            this.localPlayerHp = ps.hp;
            this.localPlayerFlags = ps.flags;
            this.config.onLocalSnapshot?.(packet.ackInputSeq, ps);
          } else {
            const m = netStateToMeters(ps);
            this.interpolator.push(ps.id, {
              serverTimeUs: packet.serverTimeUs,
              position: m.position,
              velocity: m.velocity,
              yaw: m.yaw,
              pitch: m.pitch,
              hp: m.hp,
              flags: ps.flags,
            });
            this.remotePlayers.set(ps.id, {
              id: ps.id,
              position: m.position,
              yaw: m.yaw,
              pitch: m.pitch,
              hp: m.hp,
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

  sampleRemoteDynamicBody(id: number, renderTimeUs?: number): DynamicBodySample | null {
    const t = renderTimeUs ?? this.getRenderTimeUs();
    return this.dynamicBodyInterpolator.sample(id, t);
  }

  /** Reset all state (for reconnection). */
  reset(): void {
    this.playerId = 0;
    this.latestServerTick = 0;
    this.interpolationDelayMs = 100;
    this.remotePlayers.clear();
    this.dynamicBodies.clear();
    this.dynamicBodyLastSeenTick.clear();
    this.dynamicBodyInterpolator.retainOnly(new Set());
    this.vehicles.clear();
  }
}
