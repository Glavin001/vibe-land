import { GameSocket } from './gameSocket';
import { NetDebugTelemetry, type LocalShotTelemetry } from './debugTelemetry';
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
  type BatteryStateMeters,
  type BatterySyncPacket,
  type DamageEventPacket,
  encodeDebugStatsPacket,
  netDynamicBodyStateToMeters,
  netStateToMeters,
  netVehicleStateToMeters,
  q2_5mmToMeters,
  type BlockEditCmd,
  type DynamicBodyMetaPacket,
  type DynamicBodyStateMeters,
  type FireCmd,
  type InputCmd,
  type LocalPlayerEnergyPacket,
  type MeleeCmd,
  type NetBatteryState,
  type NetPlayerState,
  type NetVehicleState,
  type PlayerRosterPacket,
  type SnapshotV2Packet,
  type ServerPacket,
  type ServerWorldPacket,
  type ShotFiredPacket,
  type VehicleStateMeters,
  FLAG_IN_VEHICLE,
} from './protocol';

export type RemotePlayer = {
  id: number;
  position: [number, number, number];
  yaw: number;
  pitch: number;
  hp: number;
  /** Latest player state flags (FLAG_DEAD, FLAG_IN_VEHICLE, ...). */
  flags: number;
};

export type NetcodeClientConfig = {
  onWelcome?: (playerId: number) => void;
  onDisconnect?: (reason?: string) => void;
  onLocalSnapshot?: (ackInputSeq: number, state: NetPlayerState) => void;
  onLocalVehicleSnapshot?: (vehicleState: NetVehicleState, ackInputSeq: number) => void;
  onWorldPacket?: (packet: ServerWorldPacket) => void;
  onShotResult?: (packet: ServerPacket) => void;
  onDamageEvent?: (packet: DamageEventPacket) => void;
  onShotFired?: (packet: ShotFiredPacket) => void;
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
  private static readonly DYNAMIC_BODY_STALE_TICKS = 240;
  private static readonly VEHICLE_STALE_TICKS = 180;
  static readonly MAX_DYNAMIC_BODY_INTERPOLATION_DELAY_MS = 16;
  static readonly REMOTE_PLAYER_BUFFER_RATIO = 0.5;

  readonly interpolator: PlayerInterpolator;
  readonly serverClock: ServerClockEstimator;
  readonly vehicleInterpolator: VehicleInterpolator;
  readonly dynamicBodyInterpolator: DynamicBodyInterpolator;

  playerId = 0;
  interpolationDelayMs = 100;
  dynamicBodyInterpolationDelayMs = NetcodeClient.MAX_DYNAMIC_BODY_INTERPOLATION_DELAY_MS;
  private baselineInterpolationDelayMs = 100;
  private minRemoteInterpolationDelayMs = 0;
  latestServerTick = 0;
  rttMs = 0;
  localPlayerHp = 100;
  localPlayerEnergy = 0;
  localPlayerFlags = 0;

  private pushVehicleSample(
    vehicleId: number,
    serverTimeUs: number,
    meters: VehicleStateMeters,
  ): void {
    this.vehicleInterpolator.push(vehicleId, {
      serverTimeUs,
      position: meters.position,
      quaternion: meters.quaternion,
      linearVelocity: meters.linearVelocity,
      angularVelocity: meters.angularVelocity,
      wheelData: meters.wheelData,
      driverPlayerId: meters.driverId,
      flags: meters.flags ?? 0,
    });
  }

  readonly remotePlayers = new Map<number, RemotePlayer>();
  readonly dynamicBodies = new Map<number, DynamicBodyStateMeters>();
  readonly vehicles = new Map<number, VehicleStateMeters>();
  readonly batteries = new Map<number, BatteryStateMeters>();
  private readonly dynamicBodyLastSeenTick = new Map<number, number>();
  private readonly vehicleLastSeenTick = new Map<number, number>();
  private readonly dynamicBodyServerTimeUs = new Map<number, number>();
  private readonly vehicleServerTimeUs = new Map<number, number>();
  private readonly playerIdByHandle = new Map<number, number>();
  private localDrivenVehicleId: number | null = null;
  private readonly dynamicBodyMetaByHandle = new Map<number, { bodyId: number; shapeType: number; halfExtents: [number, number, number] }>();
  private readonly debugTelemetry = new NetDebugTelemetry();

  private socket: GameSocket | null = null;
  private wtClient: WebTransportGameClient | null = null;
  private config: NetcodeClientConfig;
  private closedByClient = false;

  // Rolling accumulators for 1Hz debug stats report to server
  private _debugCorrectionSum = 0;
  private _debugPhysicsSum = 0;
  private _debugSampleCount = 0;
  private _debugLastSendMs = 0;

  /** Human-readable active transport. */
  get transport(): string {
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
    this.closedByClient = false;
    this.socket = new GameSocket({
      onPacket: (packet: ServerPacket) => this.handlePacket(packet, 'websocket'),
      onClose: (event) => {
        this.notifyDisconnect(
          `websocket closed (code=${event.code}${event.reason ? `, reason=${event.reason}` : ''})`,
        );
      },
      onRttUpdated: (rttMs: number) => {
        this.rttMs = rttMs;
        this.serverClock.observeRtt(rttMs);
      },
    });
    this.socket.connect(wsUrl);
  }

  /**
   * Try WebTransport first; fall back to WebSocket on failure or if unsupported.
   */
  async connectWithFallback(matchId: string, wsUrl: string, sessionConfigEndpoint?: string): Promise<void> {
    this.closedByClient = false;
    const hasWebTransport = typeof window !== 'undefined' && 'WebTransport' in window;
    console.info('[netcode] connectWithFallback', { matchId, wsUrl, browserSupportsWT: hasWebTransport });

    if (hasWebTransport) {
      console.info('[netcode] attempting WebTransport (QUIC/UDP)...');
      try {
        const wt = await WebTransportGameClient.connect({
          matchId,
          sessionConfigEndpoint,
          onReliablePacket: (packet) => this.handlePacket(packet as ServerPacket, 'wt-reliable'),
          onDatagramPacket: (packet) => this.handlePacket(packet as ServerPacket, 'wt-datagram'),
          onClose: (reason) => { this.notifyDisconnect(describeDisconnectReason('webtransport', reason)); },
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
    // WebTransport RTT is measured server-side via server-initiated pings
    if (!this.wtClient) {
      this.socket?.ping();
    }
  }

  disconnect(): void {
    this.closedByClient = true;
    this.wtClient?.close();
    this.wtClient = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  private notifyDisconnect(reason?: string): void {
    if (this.closedByClient) {
      return;
    }
    this.config.onDisconnect?.(reason);
  }

  sendInputs(cmds: InputCmd[]): void {
    if (this.wtClient) {
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
      if (this.wtClient) {
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
    if (this.wtClient) {
      this.wtClient.sendFire(cmd);
    } else {
      this.socket?.sendFire(cmd);
    }
  }

  sendMelee(cmd: MeleeCmd): void {
    if (this.wtClient) {
      this.wtClient.sendMelee(cmd);
    } else {
      this.socket?.sendMelee(cmd);
    }
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    if (this.wtClient) {
      this.wtClient.sendBlockEdit(cmd);
    } else {
      this.socket?.sendBlockEdit(cmd);
    }
  }

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    if (this.wtClient) {
      this.wtClient.sendVehicleEnter(vehicleId, seat);
    } else {
      this.socket?.sendVehicleEnter(vehicleId, seat);
    }
  }

  sendVehicleExit(vehicleId: number): void {
    if (this.wtClient) {
      this.wtClient.sendVehicleExit(vehicleId);
    } else {
      this.socket?.sendVehicleExit(vehicleId);
    }
  }

  private applyPlayerRoster(packet: PlayerRosterPacket): void {
    const nextByHandle = new Map<number, number>();
    const activePlayerIds = new Set<number>();
    for (const entry of packet.entries) {
      nextByHandle.set(entry.handle, entry.playerId);
      activePlayerIds.add(entry.playerId);
    }
    this.playerIdByHandle.clear();
    for (const [handle, playerId] of nextByHandle) {
      this.playerIdByHandle.set(handle, playerId);
    }

    for (const id of [...this.remotePlayers.keys()]) {
      if (!activePlayerIds.has(id)) {
        this.remotePlayers.delete(id);
        this.interpolator.remove(id);
      }
    }
  }

  private applyDynamicBodyMeta(packet: DynamicBodyMetaPacket): void {
    this.dynamicBodyMetaByHandle.clear();
    for (const entry of packet.entries) {
      this.dynamicBodyMetaByHandle.set(entry.handle, {
        bodyId: entry.bodyId,
        shapeType: entry.shapeType,
        halfExtents: entry.halfExtents,
      });
    }
  }

  private applyLocalPlayerEnergy(packet: LocalPlayerEnergyPacket): void {
    this.localPlayerEnergy = packet.energyCenti / 100;
  }

  private applyBatterySync(packet: BatterySyncPacket): void {
    if (packet.fullResync) {
      this.batteries.clear();
    }
    for (const id of packet.removedIds) {
      this.batteries.delete(id);
    }
    for (const battery of packet.batteryStates) {
      this.batteries.set(battery.id, batteryStateToMeters(battery));
    }
  }

  private applySnapshotV2(
    packet: SnapshotV2Packet,
    source: 'wt-datagram' | 'wt-reliable' | 'websocket' | 'local' | 'direct',
  ): void {
    this.latestServerTick = packet.serverTick;
    this.serverClock.observe(packet.serverTimeUs, performance.now() * 1000);
    const adaptiveDelayMs = this.serverClock.getInterpolationDelayMs();
    if (adaptiveDelayMs > 0) {
      this.interpolationDelayMs = Math.round(
        Math.max(adaptiveDelayMs, this.minRemoteInterpolationDelayMs) * 100,
      ) / 100;
      this.dynamicBodyInterpolationDelayMs = Math.round(
        Math.min(adaptiveDelayMs, NetcodeClient.MAX_DYNAMIC_BODY_INTERPOLATION_DELAY_MS) * 100,
      ) / 100;
    }
    this.debugTelemetry.observeAcceptedSnapshot(
      source,
      packet.serverTick,
      1 + packet.remotePlayers.length,
      packet.sphereStates.length + packet.boxStates.length,
    );

    const anchorPos: [number, number, number] = [
      packet.anchorPxMm / 1000,
      packet.anchorPyMm / 1000,
      packet.anchorPzMm / 1000,
    ];
    const localState: NetPlayerState = {
      id: this.playerId,
      pxMm: packet.anchorPxMm,
      pyMm: packet.anchorPyMm,
      pzMm: packet.anchorPzMm,
      vxCms: packet.selfState.vxCms,
      vyCms: packet.selfState.vyCms,
      vzCms: packet.selfState.vzCms,
      yawI16: packet.selfState.yawI16,
      pitchI16: packet.selfState.pitchI16,
      hp: packet.selfState.hp,
      flags: packet.selfState.flags,
      energyCenti: 0,
    };
    this.localPlayerHp = localState.hp;
    this.localPlayerFlags = localState.flags;
    const localPlayerInVehicle = (localState.flags & FLAG_IN_VEHICLE) !== 0;
    if (!localPlayerInVehicle) {
      this.localDrivenVehicleId = null;
    }

    for (const player of packet.remotePlayers) {
      const remotePlayerId = this.playerIdByHandle.get(player.handle);
      if (remotePlayerId == null || remotePlayerId === this.playerId) {
        continue;
      }
      const position: [number, number, number] = [
        anchorPos[0] + q2_5mmToMeters(player.dxQ2_5mm),
        anchorPos[1] + q2_5mmToMeters(player.dyQ2_5mm),
        anchorPos[2] + q2_5mmToMeters(player.dzQ2_5mm),
      ];
      const velocity: [number, number, number] = [
        player.vxCms / 100,
        player.vyCms / 100,
        player.vzCms / 100,
      ];
      const yaw = (player.yawI16 & 0xffff) / 65535 * Math.PI * 2;
      const pitch = (player.pitchI16 & 0xffff) / 65535 * Math.PI * 2;
      this.interpolator.push(remotePlayerId, {
        serverTimeUs: packet.serverTimeUs,
        position,
        velocity,
        yaw,
        pitch,
        hp: player.hp,
        flags: player.flags,
      });
      this.remotePlayers.set(remotePlayerId, {
        id: remotePlayerId,
        position,
        yaw,
        pitch,
        hp: player.hp,
        flags: player.flags,
      });
    }

    const seenDynamicIds = new Set<number>();
    for (const sphere of packet.sphereStates) {
      const meta = this.dynamicBodyMetaByHandle.get(sphere.handle);
      if (!meta) continue;
      const bodyId = meta.bodyId;
      seenDynamicIds.add(bodyId);
      const position: [number, number, number] = [
        anchorPos[0] + q2_5mmToMeters(sphere.dxQ2_5mm),
        anchorPos[1] + q2_5mmToMeters(sphere.dyQ2_5mm),
        anchorPos[2] + q2_5mmToMeters(sphere.dzQ2_5mm),
      ];
      const velocity: [number, number, number] = [
        sphere.vxCms / 100,
        sphere.vyCms / 100,
        sphere.vzCms / 100,
      ];
      const angularVelocity: [number, number, number] = [
        sphere.wxMrads / 1000,
        sphere.wyMrads / 1000,
        sphere.wzMrads / 1000,
      ];
      const quaternion = this.predictSphereQuaternion(bodyId, packet.serverTimeUs, angularVelocity);
      const meters: DynamicBodyStateMeters = {
        id: bodyId,
        shapeType: meta.shapeType,
        position,
        quaternion,
        halfExtents: meta.halfExtents,
        velocity,
        angularVelocity,
      };
      this.dynamicBodies.set(bodyId, meters);
      this.dynamicBodyServerTimeUs.set(bodyId, packet.serverTimeUs);
      this.dynamicBodyInterpolator.push(bodyId, {
        serverTimeUs: packet.serverTimeUs,
        position,
        quaternion,
        halfExtents: meta.halfExtents,
        velocity,
        angularVelocity,
        shapeType: meta.shapeType,
      });
      this.dynamicBodyLastSeenTick.set(bodyId, packet.serverTick);
    }
    for (const box of packet.boxStates) {
      const meta = this.dynamicBodyMetaByHandle.get(box.handle);
      if (!meta) continue;
      const bodyId = meta.bodyId;
      seenDynamicIds.add(bodyId);
      const meters: DynamicBodyStateMeters = {
        id: bodyId,
        shapeType: meta.shapeType,
        position: [
          anchorPos[0] + q2_5mmToMeters(box.dxQ2_5mm),
          anchorPos[1] + q2_5mmToMeters(box.dyQ2_5mm),
          anchorPos[2] + q2_5mmToMeters(box.dzQ2_5mm),
        ],
        quaternion: [
          box.qxSnorm / 32767,
          box.qySnorm / 32767,
          box.qzSnorm / 32767,
          box.qwSnorm / 32767,
        ],
        halfExtents: meta.halfExtents,
        velocity: [box.vxCms / 100, box.vyCms / 100, box.vzCms / 100],
        angularVelocity: [box.wxMrads / 1000, box.wyMrads / 1000, box.wzMrads / 1000],
      };
      this.dynamicBodies.set(bodyId, meters);
      this.dynamicBodyServerTimeUs.set(bodyId, packet.serverTimeUs);
      this.dynamicBodyInterpolator.push(bodyId, {
        serverTimeUs: packet.serverTimeUs,
        position: meters.position,
        quaternion: meters.quaternion,
        halfExtents: meters.halfExtents,
        velocity: meters.velocity,
        angularVelocity: meters.angularVelocity,
        shapeType: meters.shapeType,
      });
      this.dynamicBodyLastSeenTick.set(bodyId, packet.serverTick);
    }
    for (const [id, lastSeenTick] of this.dynamicBodyLastSeenTick) {
      if (packet.serverTick - lastSeenTick > NetcodeClient.DYNAMIC_BODY_STALE_TICKS) {
        this.dynamicBodyLastSeenTick.delete(id);
        this.dynamicBodies.delete(id);
        this.dynamicBodyServerTimeUs.delete(id);
        this.dynamicBodyInterpolator.remove(id);
      }
    }
    this.debugTelemetry.observeAuthoritativeDynamicBodies(this.dynamicBodies);
    // Fire the local snapshot callback only after authoritative dynamic-body
    // state has been applied. Multiplayer vehicle reconcile depends on the
    // callback syncing same-tick collider state before replaying pending inputs.
    this.config.onLocalSnapshot?.(packet.ackInputSeq, localState);

    let inferredLocalDrivenVehicle = false;
    for (const vehicle of packet.vehicleStates) {
      const vehicleId = vehicle.handle;
      const resolvedDriverPlayerId = vehicle.driverHandle === 0
        ? 0
        : (this.playerIdByHandle.get(vehicle.driverHandle) ?? 0);
      const isRememberedLocalVehicle = vehicle.driverHandle !== 0 && this.localDrivenVehicleId === vehicleId;
      const shouldInferLocalDrivenVehicle: boolean = vehicle.driverHandle !== 0
        && resolvedDriverPlayerId === 0
        && localPlayerInVehicle
        && !inferredLocalDrivenVehicle
        && (this.localDrivenVehicleId === null || this.localDrivenVehicleId === vehicleId);
      const driverPlayerId = resolvedDriverPlayerId !== 0
        ? resolvedDriverPlayerId
        : (isRememberedLocalVehicle || shouldInferLocalDrivenVehicle)
          ? this.playerId
          : 0;
      if (vehicle.driverHandle === 0 && this.localDrivenVehicleId === vehicleId) {
        this.localDrivenVehicleId = null;
      }
      const meters: VehicleStateMeters = {
        id: vehicleId,
        vehicleType: vehicle.vehicleType,
        flags: vehicle.flags,
        driverId: driverPlayerId,
        position: [
          anchorPos[0] + q2_5mmToMeters(vehicle.dxQ2_5mm),
          anchorPos[1] + q2_5mmToMeters(vehicle.dyQ2_5mm),
          anchorPos[2] + q2_5mmToMeters(vehicle.dzQ2_5mm),
        ],
        quaternion: [
          vehicle.qxSnorm / 32767,
          vehicle.qySnorm / 32767,
          vehicle.qzSnorm / 32767,
          vehicle.qwSnorm / 32767,
        ],
        linearVelocity: [vehicle.vxCms / 100, vehicle.vyCms / 100, vehicle.vzCms / 100],
        angularVelocity: [vehicle.wxMrads / 1000, vehicle.wyMrads / 1000, vehicle.wzMrads / 1000],
        wheelData: [0, 0, 0, 0],
      };
      this.vehicles.set(vehicleId, meters);
      this.vehicleLastSeenTick.set(vehicleId, packet.serverTick);
      this.vehicleServerTimeUs.set(vehicleId, packet.serverTimeUs);
      if (driverPlayerId === this.playerId && driverPlayerId !== 0) {
        this.localDrivenVehicleId = vehicleId;
        inferredLocalDrivenVehicle = inferredLocalDrivenVehicle || shouldInferLocalDrivenVehicle;
        const localVehicleState: NetVehicleState = {
          id: vehicleId,
          vehicleType: vehicle.vehicleType,
          flags: vehicle.flags,
          driverId: driverPlayerId,
          pxMm: Math.round(meters.position[0] * 1000),
          pyMm: Math.round(meters.position[1] * 1000),
          pzMm: Math.round(meters.position[2] * 1000),
          qxSnorm: vehicle.qxSnorm,
          qySnorm: vehicle.qySnorm,
          qzSnorm: vehicle.qzSnorm,
          qwSnorm: vehicle.qwSnorm,
          vxCms: vehicle.vxCms,
          vyCms: vehicle.vyCms,
          vzCms: vehicle.vzCms,
          wxMrads: vehicle.wxMrads,
          wyMrads: vehicle.wyMrads,
          wzMrads: vehicle.wzMrads,
          wheelData: [0, 0, 0, 0],
        };
        this.config.onLocalVehicleSnapshot?.(localVehicleState, packet.ackInputSeq);
      }
      this.pushVehicleSample(vehicleId, packet.serverTimeUs, meters);
    }
    for (const [id, lastSeenTick] of this.vehicleLastSeenTick) {
      if (packet.serverTick - lastSeenTick > NetcodeClient.VEHICLE_STALE_TICKS) {
        this.vehicleLastSeenTick.delete(id);
        this.vehicles.delete(id);
        this.vehicleServerTimeUs.delete(id);
        this.vehicleInterpolator.remove(id);
      }
    }
  }

  private predictSphereQuaternion(
    bodyId: number,
    serverTimeUs: number,
    angularVelocity: [number, number, number],
  ): [number, number, number, number] {
    const previous = this.dynamicBodies.get(bodyId);
    const previousServerTimeUs = this.dynamicBodyServerTimeUs.get(bodyId);
    if (!previous || previousServerTimeUs == null) {
      return [0, 0, 0, 1];
    }
    const dt = Math.max(0, Math.min((serverTimeUs - previousServerTimeUs) / 1_000_000, 0.25));
    if (dt <= 0) {
      return previous.quaternion;
    }
    const [ax, ay, az] = angularVelocity;
    const angSpeed = Math.hypot(ax, ay, az);
    if (angSpeed <= 0.0001) {
      return previous.quaternion;
    }
    const angle = angSpeed * dt;
    const nx = ax / angSpeed;
    const ny = ay / angSpeed;
    const nz = az / angSpeed;
    const s = Math.sin(angle / 2);
    const dq: [number, number, number, number] = [nx * s, ny * s, nz * s, Math.cos(angle / 2)];
    const [qx, qy, qz, qw] = previous.quaternion;
    const [dx, dy, dz, dw] = dq;
    return [
      dw * qx + dx * qw + dy * qz - dz * qy,
      dw * qy - dx * qz + dy * qw + dz * qx,
      dw * qz + dx * qy - dy * qx + dz * qw,
      dw * qw - dx * qx - dy * qy - dz * qz,
    ];
  }

  /**
   * Process a server packet directly (for testing without a real socket).
   * In production, packets arrive via the socket; in tests, call this directly.
   */
  handlePacket(
    packet: ServerPacket,
    source: 'wt-datagram' | 'wt-reliable' | 'websocket' | 'local' | 'direct' = 'direct',
  ): void {
    switch (packet.type) {
      case 'welcome':
        this.playerId = packet.playerId;
        this.baselineInterpolationDelayMs = packet.interpolationDelayMs;
        this.minRemoteInterpolationDelayMs =
          (1000 / Math.max(packet.snapshotHz, 1)) * NetcodeClient.REMOTE_PLAYER_BUFFER_RATIO;
        this.interpolationDelayMs = this.baselineInterpolationDelayMs;
        this.dynamicBodyInterpolationDelayMs = Math.min(
          packet.interpolationDelayMs,
          NetcodeClient.MAX_DYNAMIC_BODY_INTERPOLATION_DELAY_MS,
        );
        // Tell the clock the server's tick rate so hysteresis thresholds are correct.
        this.serverClock.setSimHz(packet.simHz);
        // Don't seed clock from welcome — it arrives with unpredictable
        // latency (TLS handshake, etc.) and skews the initial offset.
        // The first snapshot will initialize the estimator instead.
        console.info('[netcode] Welcome — playerId:', packet.playerId, { transport: this.transport, simHz: packet.simHz, interpolationDelayMs: packet.interpolationDelayMs });
        this.config.onWelcome?.(packet.playerId);
        break;
      case 'playerRoster':
        this.applyPlayerRoster(packet);
        break;
      case 'dynamicBodyMeta':
        this.applyDynamicBodyMeta(packet);
        break;
      case 'localPlayerEnergy':
        this.applyLocalPlayerEnergy(packet);
        break;
      case 'batterySync':
        this.applyBatterySync(packet);
        break;
      case 'snapshot': {
        if (packet.serverTick <= this.latestServerTick) {
          this.debugTelemetry.observeDroppedSnapshot(source, packet.serverTick, this.latestServerTick);
          break;
        }
        this.latestServerTick = packet.serverTick;
        this.serverClock.observe(packet.serverTimeUs, performance.now() * 1000);
        // Use adaptive interpolation delay from WASM when available (jitter*4 + 5ms).
        const adaptiveDelayMs = this.serverClock.getInterpolationDelayMs();
        if (adaptiveDelayMs > 0) {
          this.interpolationDelayMs = Math.round(
            Math.max(adaptiveDelayMs, this.minRemoteInterpolationDelayMs) * 100,
          ) / 100;
          this.dynamicBodyInterpolationDelayMs = Math.round(
            Math.min(
              adaptiveDelayMs,
              NetcodeClient.MAX_DYNAMIC_BODY_INTERPOLATION_DELAY_MS,
            ) * 100,
          ) / 100;
        }
        this.debugTelemetry.observeAcceptedSnapshot(
          source,
          packet.serverTick,
          packet.playerStates.length,
          packet.dynamicBodyStates.length,
        );

        // Update dynamic bodies BEFORE reconciliation so that input replay
        // collides with the correct (same-tick) collider positions.
        for (const db of packet.dynamicBodyStates) {
          const meters = netDynamicBodyStateToMeters(db);
          this.dynamicBodies.set(db.id, meters);
          this.dynamicBodyServerTimeUs.set(db.id, packet.serverTimeUs);
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
            this.dynamicBodyServerTimeUs.delete(id);
            this.dynamicBodyInterpolator.remove(id);
          }
        }
        this.debugTelemetry.observeAuthoritativeDynamicBodies(this.dynamicBodies);

        const knownIds = new Set<number>();
        let localPlayerState: NetPlayerState | null = null;
        for (const ps of packet.playerStates) {
          knownIds.add(ps.id);
          if (ps.id === this.playerId) {
            this.localPlayerHp = ps.hp;
            this.localPlayerFlags = ps.flags;
            localPlayerState = ps;
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
              flags: ps.flags,
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
        if (localPlayerState) {
          this.config.onLocalSnapshot?.(packet.ackInputSeq, localPlayerState);
        }

        // Handle vehicle states
        const knownVehicleIds = new Set<number>();
        for (const vs of packet.vehicleStates) {
          knownVehicleIds.add(vs.id);
          const m = netVehicleStateToMeters(vs);
          this.vehicles.set(vs.id, m);
          this.vehicleLastSeenTick.set(vs.id, packet.serverTick);
          this.vehicleServerTimeUs.set(vs.id, packet.serverTimeUs);

          // Route local vehicle snapshot to driver-side prediction
          if (vs.driverId === this.playerId && vs.driverId !== 0) {
            this.localDrivenVehicleId = vs.id;
            this.config.onLocalVehicleSnapshot?.(vs, packet.ackInputSeq);
          } else if (vs.driverId === 0 && this.localDrivenVehicleId === vs.id) {
            this.localDrivenVehicleId = null;
          }
          this.pushVehicleSample(vs.id, packet.serverTimeUs, m);
        }
        // Keep last-known vehicle state briefly when a strict-budget snapshot omits it.
        for (const [id, lastSeenTick] of this.vehicleLastSeenTick) {
          if (packet.serverTick - lastSeenTick > NetcodeClient.VEHICLE_STALE_TICKS) {
            this.vehicleLastSeenTick.delete(id);
            this.vehicles.delete(id);
            this.vehicleServerTimeUs.delete(id);
            this.vehicleInterpolator.remove(id);
          }
        }
        break;
      }
      case 'snapshotV2': {
        if (packet.serverTick <= this.latestServerTick) {
          this.debugTelemetry.observeDroppedSnapshot(source, packet.serverTick, this.latestServerTick);
          break;
        }
        this.applySnapshotV2(packet, source);
        break;
      }
      case 'chunkFull':
      case 'chunkDiff':
        this.config.onWorldPacket?.(packet);
        break;
      case 'shotResult':
        this.debugTelemetry.observeShotResult(
          packet.shotId,
          packet.confirmed,
          packet.hitPlayerId,
          packet.hitZone,
          packet.serverResolution,
          packet.serverDynamicBodyId,
          packet.serverDynamicHitToiCm,
          packet.serverDynamicImpulseCenti,
        );
        this.config.onShotResult?.(packet);
        break;
      case 'damageEvent':
        this.config.onDamageEvent?.(packet);
        break;
      case 'shotFired':
        this.config.onShotFired?.(packet);
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

  getVehicleObservedAgeMs(id: number, localTimeUs = performance.now() * 1000): number | null {
    const sampleServerTimeUs = this.vehicleServerTimeUs.get(id);
    if (sampleServerTimeUs == null) return null;
    return Math.max(0, (this.serverClock.serverNowUs(localTimeUs) - sampleServerTimeUs) / 1000);
  }

  sampleRemoteDynamicBody(id: number, renderTimeUs?: number): DynamicBodySample | null {
    const t = renderTimeUs ?? this.getDynamicBodyRenderTimeUs();
    return this.dynamicBodyInterpolator.sample(id, t);
  }

  getDynamicBodyRenderTimeUs(localTimeUs?: number): number {
    return this.serverClock.renderTimeUs(
      this.dynamicBodyInterpolationDelayMs * 1000,
      localTimeUs,
    );
  }

  getDynamicBodyObservedAgeMs(id: number, localTimeUs = performance.now() * 1000): number | null {
    const sampleServerTimeUs = this.dynamicBodyServerTimeUs.get(id);
    if (sampleServerTimeUs == null) return null;
    return Math.max(0, (this.serverClock.serverNowUs(localTimeUs) - sampleServerTimeUs) / 1000);
  }

  recordFrameDebugMetrics(
    playerCorrectionMagnitude: number,
    vehicleCorrectionMagnitude: number,
    dynamicCorrectionMagnitude: number,
    pendingInputCount: number,
  ): void {
    this.debugTelemetry.observeFrameMetrics(
      playerCorrectionMagnitude,
      vehicleCorrectionMagnitude,
      dynamicCorrectionMagnitude,
      pendingInputCount,
    );
  }

  recordLocalShotFired(
    shotId: number,
    shot: Omit<LocalShotTelemetry, 'baselineBodyPosition'>,
  ): void {
    this.debugTelemetry.observeLocalShotFired(shotId, {
      ...shot,
      baselineBodyPosition: shot.predictedDynamicBodyId != null
        ? this.dynamicBodies.get(shot.predictedDynamicBodyId)?.position ?? null
        : null,
    });
  }

  getDebugTelemetrySnapshot() {
    return this.debugTelemetry.snapshot();
  }

  /** Reset all state (for reconnection). */
  reset(): void {
    this.playerId = 0;
    this.latestServerTick = 0;
    this.interpolationDelayMs = 100;
    this.dynamicBodyInterpolationDelayMs = NetcodeClient.MAX_DYNAMIC_BODY_INTERPOLATION_DELAY_MS;
    this.baselineInterpolationDelayMs = 100;
    this.minRemoteInterpolationDelayMs = 0;
    this.remotePlayers.clear();
    this.playerIdByHandle.clear();
    this.dynamicBodies.clear();
    this.dynamicBodyMetaByHandle.clear();
    this.dynamicBodyServerTimeUs.clear();
    this.dynamicBodyLastSeenTick.clear();
    this.dynamicBodyInterpolator.retainOnly(new Set());
    this.vehicles.clear();
    this.vehicleLastSeenTick.clear();
    this.vehicleInterpolator.retainOnly(new Set());
    this.batteries.clear();
    this.localPlayerEnergy = 0;
  }
}

function batteryStateToMeters(state: NetBatteryState): BatteryStateMeters {
  return {
    id: state.id,
    position: [state.pxMm / 1000, state.pyMm / 1000, state.pzMm / 1000],
    energy: state.energyCenti / 100,
    radius: state.radiusCm / 100,
    height: state.heightCm / 100,
  };
}

function describeDisconnectReason(prefix: string, reason: unknown): string {
  if (reason == null) {
    return `${prefix} closed`;
  }
  if (typeof reason === 'string') {
    return `${prefix} closed (${reason})`;
  }
  if (reason instanceof Error) {
    return `${prefix} closed (${reason.message})`;
  }
  return `${prefix} closed (${String(reason)})`;
}
