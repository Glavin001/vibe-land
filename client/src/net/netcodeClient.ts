import type { VehicleAsset, VehicleRigPacket } from '../vehicles/vehicleStream';
import { SERVER_CLOSE_MARKER } from './disconnectReason';
import { CITY_WIRE_VERSION } from '../city/wire';
import { GameSocket } from './gameSocket';
import { EnergyDisplay } from './energyDisplay';
import { BodyStreamPresence, MOVING_BODY_SPEED_MS } from './bodyPresence';
import {
  BODY_LEAD_CONFIG,
  BodyLeadHorizon,
  BodyLeadTrack,
  type BodyLeadConfig,
  type BodyLeadCounters,
} from './bodyLead';
import { NetDebugTelemetry, type LocalShotTelemetry } from './debugTelemetry';
import { WebTransportGameClient, type SessionConfigResponse } from './webTransportClient';
import type { RawPacketListener } from './inbound';
import { setTransportNote } from '../app/connectPhase';
import {
  browserSupportsWebTransport,
  websocketTransportEnabled,
  WebSocketTransportDisabledError,
  WEBSOCKET_DISABLED_MESSAGE,
} from './transportPolicy';
import { PacketImpairment } from '../loadtest/networkModel';
import { resolveNetlabImpairment } from '../netlab/impairment';
import {
  DynamicBodyInterpolator,
  PlayerInterpolator,
  RenderClock,
  ServerClockEstimator,
  VehicleInterpolator,
  sampleDynamicBodyTrack,
  type DynamicBodySample,
  type PlayerSample,
  type VehicleSample,
} from './interpolation';
import {
  type BatteryStateMeters,
  type BatterySyncPacket,
  type DamageEventPacket,
  encodeDebugStatsPacket,
  encodeCityCameraDrop,
  type CityCameraDropCmd,
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
  CLIENT_MOVEMENT_THIN_AUTHORITATIVE,
  PHYSICS_BACKEND_RAPIER,
  SERVER_TICK_US,
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
  onLocalVehicleSnapshot?: (vehicleState: NetVehicleState, ackInputSeq: number, serverTimeUs: number) => void;
  onWorldPacket?: (packet: ServerWorldPacket) => void;
  onShotResult?: (packet: ServerPacket) => void;
  onDamageEvent?: (packet: DamageEventPacket) => void;
  onShotFired?: (packet: ShotFiredPacket) => void;
  onPacket?: (packet: ServerPacket) => void;
  /** Raw city destruction packets (kinds 119-122). WebTransport only. */
  onCityPacket?: (bytes: Uint8Array) => void;
  /**
   * Every inbound packet as the transport received it, with its channel,
   * before any routing or decoding: what a city tape records.
   */
  onRawPacket?: RawPacketListener;
  /** Each WebSocket round-trip sample the server clock is fed (the tape keeps them). */
  onRttSample?: (rttMs: number) => void;
  /**
   * The local clock in ms, `performance.now()` unless given. /cityreplay runs
   * a client on the tape's clock, so arrivals, clock-offset samples and render
   * times all live on the time base the recording had.
   */
  nowMs?: () => number;
  /**
   * Spectating (the tape replay): the player the snapshots are about is drawn
   * like any other player, from its interpolated snapshots, instead of being
   * left to local prediction and a first-person camera.
   */
  spectateLocalPlayer?: boolean;
  /** Overrides of the predictive body lead's settings (bodyLead.ts); tests and tools. */
  bodyLead?: Partial<BodyLeadConfig>;
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
 *   await client.connectWithFallback(matchId, wsUrl, sessionConfigEndpoint);
 *   // each frame: sample remote players
 *   const sample = client.sampleRemotePlayer(id);
 *   // send inputs
 *   client.sendInputs(cmds);
 */
export class NetcodeClient {
  private customVehicles = new Map<number, VehicleAsset>();
  private vehicleRigs = new Map<number, VehicleRigPacket>();
  private attachVehicleAsset(state: VehicleStateMeters): void {
    state.customVehicle = this.customVehicles.get(state.id);
    state.customRig = this.vehicleRigs.get(state.id);
  }

  private static readonly VEHICLE_STALE_TICKS = 180;
  /** How far back (ticks) a late snapshot's drop records are kept. */
  private static readonly LATE_SNAPSHOT_HORIZON_TICKS = 600;
  /**
   * The dynamic-body delay until snapshots have arrived to size it from. After
   * that the delay is the server clock's recommendation: the 95th percentile
   * of server time elapsing between snapshot arrivals, never less than one
   * observed snapshot interval, at most 250 ms. (This was a 16 ms cap under
   * a jitter*4+5 ms delay that collapsed to 5 ms on loopback, so bodies were
   * drawn past their newest snapshot in 91% of frames on a slow server.)
   */
  static readonly INITIAL_DYNAMIC_BODY_INTERPOLATION_DELAY_MS = 16;
  static readonly REMOTE_PLAYER_BUFFER_RATIO = 0.5;

  readonly interpolator: PlayerInterpolator;
  readonly serverClock: ServerClockEstimator;
  readonly vehicleInterpolator: VehicleInterpolator;
  readonly dynamicBodyInterpolator: DynamicBodyInterpolator;

  playerId = 0;
  /**
   * Render clocks: server time minus an interpolation delay, slewed so the
   * render time never goes backwards while the delay adapts. Remote players
   * and vehicles use one; dynamic bodies, meteors and the driven car another.
   */
  private readonly playerRenderClock = new RenderClock();
  private readonly dynamicBodyRenderClock = new RenderClock();
  /**
   * Predictive snapshot bodies (bodyLead.ts): how far the newest snapshot
   * runs ahead of the dynamic-body render time, and each drawn body's lead
   * past it. A body whose last two samples show free fall is drawn up to that
   * far ahead; every other body, and every body with the lead off, at the
   * render time.
   */
  private readonly bodyLeadConfig: BodyLeadConfig;
  private readonly bodyLeadHorizon: BodyLeadHorizon;
  private readonly bodyLeads = new Map<number, BodyLeadTrack>();
  private readonly bodyLeadCounters: BodyLeadCounters = { warps: 0, warpedMs: 0 };
  /**
   * The local player's own avatar in thin-authoritative mode, which the camera
   * follows: one observed snapshot interval behind, not the 95th-percentile
   * gap, so the camera does not take on the remote players' buffer. A late
   * snapshot holds it at the newest one for that long instead.
   */
  private readonly localPlayerRenderClock = new RenderClock();
  private baselineInterpolationDelayMs = 100;
  private minRemoteInterpolationDelayMs = 0;
  latestServerTick = 0;
  rttMs = 0;
  localPlayerHp = 100;
  /** Smoothed between the server's rate-limited energy messages. */
  private readonly energyDisplay = new EnergyDisplay();
  localPlayerFlags = 0;
  protocolVersion = 1;
  physicsBackend = PHYSICS_BACKEND_RAPIER;
  clientMovementMode = 0;
  localSupport: {
    handle: number;
    localPosition: [number, number, number];
    velocity: [number, number, number];
    angularVelocity: [number, number, number];
    flags: number;
  } | null = null;

  get usesThinAuthoritativeMovement(): boolean {
    return this.clientMovementMode === CLIENT_MOVEMENT_THIN_AUTHORITATIVE;
  }

  /** The player/vehicle interpolation delay in use, ms of server time. */
  get interpolationDelayMs(): number {
    return this.playerRenderClock.delayMs;
  }

  /** The dynamic-body interpolation delay in use, ms of server time. */
  get dynamicBodyInterpolationDelayMs(): number {
    return this.dynamicBodyRenderClock.delayMs;
  }

  /** The player delay the render clock is slewing towards, ms. */
  get targetInterpolationDelayMs(): number {
    return this.playerRenderClock.targetDelayMs;
  }

  /** The dynamic-body delay the render clock is slewing towards, ms. */
  get targetDynamicBodyInterpolationDelayMs(): number {
    return this.dynamicBodyRenderClock.targetDelayMs;
  }

  /**
   * Point the render clocks at the server clock's recommended delay, as of a
   * snapshot that arrived at `localTimeUs`. Each clock is first brought up to
   * that instant under its old target, so its delay slews per unit of server
   * time whether it is read once a frame or not at all.
   */
  private adoptAdaptiveDelays(localTimeUs: number, newestServerUs: number): void {
    const adaptiveDelayMs = this.serverClock.getInterpolationDelayMs();
    if (adaptiveDelayMs <= 0) return;
    const serverNowUs = this.serverClock.serverNowUs(localTimeUs);
    this.playerRenderClock.retarget(
      Math.max(adaptiveDelayMs, this.minRemoteInterpolationDelayMs),
      serverNowUs,
      localTimeUs,
    );
    this.dynamicBodyRenderClock.retarget(adaptiveDelayMs, serverNowUs, localTimeUs);
    this.localPlayerRenderClock.retarget(
      Math.min(adaptiveDelayMs, this.serverClock.getSnapshotIntervalMs()),
      serverNowUs,
      localTimeUs,
    );
    // The body lead's horizon: how far this snapshot runs ahead of the
    // dynamic-body render time as it arrives. Read only once the clock has
    // been read by a frame (retarget has just brought it to this instant, so
    // the read changes nothing), and not at all with the lead off.
    if (this.bodyLeadConfig.enabled && this.dynamicBodyRenderClock.started) {
      const renderUs = this.dynamicBodyRenderClock.renderTimeUs(serverNowUs, localTimeUs);
      this.bodyLeadHorizon.observeArrival(newestServerUs, renderUs, localTimeUs);
    }
  }

  private pushVehicleSample(
    vehicleId: number,
    serverTimeUs: number,
    meters: VehicleStateMeters,
    snapshotIntervalUs = 0,
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
    }, snapshotIntervalUs);
  }

  /**
   * The snapshot interval (server time) a rest hold is placed at: a player or
   * vehicle that starts moving after a gap is held where it stood until the
   * snapshot before the one it moved in (interpolation.ts `insertWithRestHold`).
   */
  private snapshotIntervalUs(): number {
    return this.serverClock.getSnapshotIntervalMs() * 1000;
  }

  /**
   * Whether the client has dropped this body (`dynamic`) or vehicle since the
   * snapshot at `serverTick`: a late snapshot must not bring it back.
   */
  private droppedSince(kind: 'dynamic' | 'vehicle', id: number, serverTick: number): boolean {
    const droppedAt = (kind === 'dynamic' ? this.dynamicBodyDroppedAtTick : this.vehicleDroppedAtTick).get(id);
    return droppedAt !== undefined && droppedAt >= serverTick;
  }

  /** Forget drop records a late snapshot could no longer be older than. */
  private pruneDropRecords(): void {
    for (const records of [this.dynamicBodyDroppedAtTick, this.vehicleDroppedAtTick]) {
      if (records.size < 64) continue;
      for (const [id, tick] of records) {
        if (this.latestServerTick - tick > NetcodeClient.LATE_SNAPSHOT_HORIZON_TICKS) records.delete(id);
      }
    }
  }

  readonly remotePlayers = new Map<number, RemotePlayer>();
  readonly dynamicBodies = new Map<number, DynamicBodyStateMeters>();
  readonly vehicles = new Map<number, VehicleStateMeters>();
  readonly batteries = new Map<number, BatteryStateMeters>();
  /** Which streamed bodies are still in the stream (bodyPresence.ts). */
  private readonly dynamicBodyPresence = new BodyStreamPresence();
  private simHz = 60;
  private readonly vehicleLastSeenTick = new Map<number, number>();
  private readonly dynamicBodyServerTimeUs = new Map<number, number>();
  /**
   * Bodies the stream has dropped whose last snapshot the dynamic-body render
   * clock has not reached yet: id -> that snapshot's server time. They are
   * drawn up to it, never past it (no extrapolation of a body that is gone),
   * and removed once the render time is there (`retireUnstreamedBodies`).
   */
  private readonly dynamicBodyLeaving = new Map<number, number>();
  /**
   * Bodies and vehicles the server said its stream stopped carrying
   * (SnapshotV2 removals): id -> the server time of the first tick without
   * them. Drawn until the render time reaches it, then removed. A server
   * without the section leaves these empty and the inference above decides.
   */
  private readonly dynamicBodyRemovedAtUs = new Map<number, number>();
  private readonly vehicleRemovedAtUs = new Map<number, number>();
  /**
   * Bodies and vehicles the client dropped: id -> the newest snapshot tick
   * then. A snapshot from before that tick that arrives late (out of order)
   * does not bring them back.
   */
  private readonly dynamicBodyDroppedAtTick = new Map<number, number>();
  private readonly vehicleDroppedAtTick = new Map<number, number>();
  private readonly vehicleServerTimeUs = new Map<number, number>();
  private readonly playerIdByHandle = new Map<number, number>();
  private localDrivenVehicleId: number | null = null;
  private readonly dynamicBodyMetaByHandle = new Map<number, { bodyId: number; shapeType: number; halfExtents: [number, number, number] }>();
  private readonly debugTelemetry = new NetDebugTelemetry();

  private socket: GameSocket | null = null;
  private wtClient: WebTransportGameClient | null = null;

  // Netlab in-process impairment (null unless ?netlab=1&impair=<profile>).
  private inboundImpairment: PacketImpairment<{
    packet: ServerPacket;
    source: 'wt-datagram' | 'wt-reliable' | 'websocket';
  }> | null = null;
  private outboundImpairment: PacketImpairment<InputCmd[]> | null = null;
  private cityImpairment: PacketImpairment<Uint8Array> | null = null;

  sendCityResync(bytes: Uint8Array): void {
    if (this.wtClient) {
      this.wtClient.sendCityResync(bytes);
    } else {
      this.socket?.sendRaw(bytes);
    }
  }

  citySessionConfig(): {
    cityWorld: boolean;
    manifestHash?: string;
    baseUrl: string;
    wireVersion: number;
  } {
    const config = this.wtClient?.sessionConfig;
    return {
      cityWorld: Boolean(config?.city_world && config?.city_manifest_hash),
      manifestHash: config?.city_manifest_hash,
      // A server that predates the field speaks v2; that is the only version
      // it could have meant.
      wireVersion: config?.city_wire_version ?? CITY_WIRE_VERSION,
      // Page-relative: the manifest is served over the game server's HTTP
      // port, which is not the WebTransport port in `config.url`, so that URL
      // cannot be used to derive it. In dev the Vite proxy resolves this; on a
      // rented box the manifest is not reachable from the browser at all
      // (self-signed origin), and the city client degrades with a warning.
      baseUrl: '',
    };
  }
  private config: NetcodeClientConfig;
  private readonly nowMs: () => number;
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
    this.nowMs = config.nowMs ?? (() => performance.now());
    this.bodyLeadConfig = { ...BODY_LEAD_CONFIG, ...config.bodyLead };
    this.bodyLeadHorizon = new BodyLeadHorizon(this.bodyLeadConfig);
    this.playerRenderClock.setTargetDelayMs(this.baselineInterpolationDelayMs);
    this.dynamicBodyRenderClock.setTargetDelayMs(NetcodeClient.INITIAL_DYNAMIC_BODY_INTERPOLATION_DELAY_MS);
    this.localPlayerRenderClock.setTargetDelayMs(NetcodeClient.INITIAL_DYNAMIC_BODY_INTERPOLATION_DELAY_MS);
    this.interpolator = new PlayerInterpolator();
    this.serverClock = new ServerClockEstimator();
    this.vehicleInterpolator = new VehicleInterpolator();
    this.dynamicBodyInterpolator = new DynamicBodyInterpolator();

    const impair = resolveNetlabImpairment(
      typeof window !== 'undefined' ? window.location.search : '',
    );
    if (impair) {
      // Distinct seeds per direction/stream so loss patterns are independent,
      // the way they are on a real link.
      this.inboundImpairment = new PacketImpairment(impair.link, impair.seed, (delivery) =>
        this.handlePacket(delivery.packet, delivery.source),
      );
      this.outboundImpairment = new PacketImpairment(impair.link, impair.seed + 1, (cmds) =>
        this.sendInputsNow(cmds),
      );
      this.cityImpairment = new PacketImpairment(impair.link, impair.seed + 2, (bytes) =>
        this.config.onCityPacket?.(bytes),
      );
      console.info('[netlab] in-process impairment active', impair);
    }
  }

  /**
   * Feed a packet that arrived over the real network, routing through the
   * netlab impairment when one is active. Local/direct sources bypass this.
   */
  private deliverNetworkPacket(
    packet: ServerPacket,
    source: 'wt-datagram' | 'wt-reliable' | 'websocket',
  ): void {
    if (this.inboundImpairment) {
      this.inboundImpairment.enqueue({ packet, source });
      return;
    }
    this.handlePacket(packet, source);
  }

  private deliverCityPacket(bytes: Uint8Array): void {
    if (this.cityImpairment) {
      this.cityImpairment.enqueue(bytes);
      return;
    }
    this.config.onCityPacket?.(bytes);
  }

  /**
   * Open the game WebSocket. Refuses unless the build opted in with
   * `VITE_ENABLE_WEBSOCKET=1` (see transportPolicy.ts): WebSocket is disabled,
   * and this guard keeps any other caller from reaching it either.
   */
  connect(wsUrl: string): void {
    if (!websocketTransportEnabled()) {
      throw new WebSocketTransportDisabledError('build with VITE_ENABLE_WEBSOCKET=1 to enable it');
    }
    this.closedByClient = false;
    this.socket = new GameSocket({
      onPacket: (packet: ServerPacket) => this.deliverNetworkPacket(packet, 'websocket'),
      onCityPacket: (bytes) => this.deliverCityPacket(bytes),
      onRawPacket: this.config.onRawPacket,
      onClose: (event) => {
        this.notifyDisconnect(
          `websocket closed (code=${event.code}${event.reason ? `, reason=${event.reason}` : ''})`,
        );
      },
      onRttUpdated: (rttMs: number) => {
        this.config.onRttSample?.(rttMs);
        this.observeRtt(rttMs);
      },
    });
    this.socket.connect(wsUrl);
  }

  /**
   * Connect over WebTransport. WebSocket is DISABLED: never selected, never a
   * fallback.
   *
   * The two transports are not interchangeable for this game: WebTransport
   * carries poses on unreliable datagrams, WebSocket on an ordered reliable
   * stream. Falling back silently means the player is on a different wire from
   * the one the game is designed and measured against -- and it hides the real
   * failure, which is that QUIC could not connect. When WebTransport fails the
   * player is told so ("WebTransport unavailable; WebSocket transport is
   * disabled") and the error propagates.
   *
   * The single opt-in is the build-time `VITE_ENABLE_WEBSOCKET=1`; only then
   * is `wsUrl` tried, and only after WebTransport has failed.
   */
  async connectWithFallback(
    matchId: string,
    wsUrl: string,
    sessionConfigEndpoint?: string,
    options: { sessionConfig?: SessionConfigResponse } = {},
  ): Promise<void> {
    this.closedByClient = false;
    const hasWebTransport = browserSupportsWebTransport();
    // Default DENY: only the build-time opt-in reaches the WebSocket path.
    const allowWs = websocketTransportEnabled();
    console.info('[netcode] connect', { matchId, browserSupportsWT: hasWebTransport, websocketEnabled: allowWs });

    let wtFailure: string;
    if (hasWebTransport) {
      console.info('[netcode] attempting WebTransport (QUIC/UDP)...');
      try {
        const wt = await WebTransportGameClient.connect({
          matchId,
          sessionConfigEndpoint,
          sessionConfig: options.sessionConfig,
          onReliablePacket: (packet) => this.deliverNetworkPacket(packet as ServerPacket, 'wt-reliable'),
          onDatagramPacket: (packet) => this.deliverNetworkPacket(packet as ServerPacket, 'wt-datagram'),
          onCityPacket: (bytes) => this.deliverCityPacket(bytes),
          onRawPacket: this.config.onRawPacket,
          onClose: (reason) => { this.notifyDisconnect(describeDisconnectReason('webtransport', reason)); },
        });
        this.wtClient = wt;
        setTransportNote(null);
        console.info('[netcode] ✓ connected via WebTransport (QUIC/UDP)', wt.sessionConfig.url);
        return;
      } catch (err) {
        wtFailure = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (!allowWs) {
          // No fallback. The note is set first so the player sees the reason
          // instead of being bounced silently back to the join screen.
          setTransportNote(`${WEBSOCKET_DISABLED_MESSAGE} (${wtFailure})`);
          console.error('[netcode] WebTransport failed and WebSocket transport is disabled', err);
          throw new WebSocketTransportDisabledError(wtFailure);
        }
        console.warn('[netcode] WebTransport failed -- WebSocket enabled by VITE_ENABLE_WEBSOCKET=1', err);
      }
    } else {
      wtFailure = 'this browser does not support WebTransport';
      console.info('[netcode] WebTransport not supported in this browser');
      if (!allowWs) {
        setTransportNote(`${WEBSOCKET_DISABLED_MESSAGE} (${wtFailure})`);
        throw new WebSocketTransportDisabledError(wtFailure);
      }
    }

    setTransportNote(`WebTransport unavailable (${wtFailure}) — using WebSocket (VITE_ENABLE_WEBSOCKET=1)`);
    console.info('[netcode] connecting via WebSocket (TCP):', wsUrl);
    this.connect(wsUrl);
  }

  /** A round-trip sample for the server clock (WebSocket pongs; a tape's RTT records). */
  observeRtt(rttMs: number): void {
    this.rttMs = rttMs;
    this.serverClock.observeRtt(rttMs);
  }

  ping(): void {
    // WebTransport RTT is measured server-side via server-initiated pings
    if (!this.wtClient) {
      this.socket?.ping();
    }
  }

  disconnect(): void {
    this.closedByClient = true;
    this.inboundImpairment?.dispose();
    this.outboundImpairment?.dispose();
    this.cityImpairment?.dispose();
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
    if (this.outboundImpairment && cmds.length > 0) {
      this.outboundImpairment.enqueue(cmds);
      return;
    }
    this.sendInputsNow(cmds);
  }

  private sendInputsNow(cmds: InputCmd[]): void {
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

  sendCityCameraDrop(cmd: CityCameraDropCmd): boolean {
    if (this.wtClient) return this.wtClient.sendCityCameraDrop(cmd);
    if (!this.socket) return false;
    this.socket.sendRaw(encodeCityCameraDrop(cmd));
    return true;
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

  getLocalDrivenVehicleId(): number | null {
    return this.localDrivenVehicleId;
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

  /** The local player's energy for the HUD, smoothed between messages. */
  get localPlayerEnergy(): number {
    return this.energyDisplay.value(performance.now());
  }

  private applyLocalPlayerEnergy(packet: LocalPlayerEnergyPacket): void {
    this.energyDisplay.onSample(packet.energyCenti / 100, performance.now());
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
    const arrivedUs = this.nowMs() * 1000;
    this.serverClock.observe(packet.serverTimeUs, arrivedUs, packet.serverWallUs);
    this.adoptAdaptiveDelays(arrivedUs, packet.serverTimeUs);
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
    this.localSupport = packet.selfState.supportHandle
      ? {
          handle: packet.selfState.supportHandle,
          localPosition: packet.selfState.supportLocalPosition ?? [0, 0, 0],
          velocity: packet.selfState.supportVelocity ?? [0, 0, 0],
          angularVelocity: packet.selfState.supportAngularVelocity ?? [0, 0, 0],
          flags: packet.selfState.supportFlags ?? 0,
        }
      : null;
    if (this.usesThinAuthoritativeMovement) {
      const meters = netStateToMeters(localState);
      this.interpolator.push(this.playerId, {
        serverTimeUs: packet.serverTimeUs,
        position: meters.position,
        velocity: meters.velocity,
        yaw: meters.yaw,
        pitch: meters.pitch,
        hp: meters.hp,
        flags: localState.flags,
      });
    }
    if (this.config.spectateLocalPlayer) {
      this.spectateLocal(packet.serverTimeUs, localState, !this.usesThinAuthoritativeMovement);
    }
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
      }, this.snapshotIntervalUs());
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
      this.dynamicBodyPresence.seen(bodyId, packet.serverTick, Math.hypot(...velocity), position, velocity);
      this.dynamicBodyLeaving.delete(bodyId);
      this.dynamicBodyRemovedAtUs.delete(bodyId);
      this.dynamicBodyDroppedAtTick.delete(bodyId);
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
      this.dynamicBodyPresence.seen(bodyId, packet.serverTick, Math.hypot(...meters.velocity), meters.position, meters.velocity);
      this.dynamicBodyLeaving.delete(bodyId);
      this.dynamicBodyRemovedAtUs.delete(bodyId);
      this.dynamicBodyDroppedAtTick.delete(bodyId);
    }
    this.applyBodyRemovals(packet);
    // The anchor is the recipient position the server selected this snapshot's
    // bodies around (snapshot_builder.rs), so a moving body gone from it past
    // the interest radius is out of the stream now (bodyPresence.ts).
    this.retireUnstreamedBodies(packet.serverTick, packet.serverTimeUs, anchorPos);
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
      if (driverPlayerId !== this.playerId && this.localDrivenVehicleId === vehicleId) {
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
      this.attachVehicleAsset(meters);
      this.vehicles.set(vehicleId, meters);
      this.vehicleRemovedAtUs.delete(vehicleId);
      this.vehicleDroppedAtTick.delete(vehicleId);
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
        this.config.onLocalVehicleSnapshot?.(localVehicleState, packet.ackInputSeq, packet.serverTimeUs);
      }
      this.pushVehicleSample(vehicleId, packet.serverTimeUs, meters, this.snapshotIntervalUs());
    }
    this.applyVehicleRemovals(packet);
    // Vehicles are drawn on the player render clock.
    const vehiclesRenderedUpToUs = packet.serverTimeUs - this.interpolationDelayMs * 1000;
    for (const [id, removedAtUs] of this.vehicleRemovedAtUs) {
      if (removedAtUs <= vehiclesRenderedUpToUs) this.removeVehicle(id);
    }
    for (const [id, lastSeenTick] of this.vehicleLastSeenTick) {
      if (packet.serverTick - lastSeenTick > NetcodeClient.VEHICLE_STALE_TICKS) {
        this.removeVehicle(id);
      }
    }
    this.pruneDropRecords();
  }

  /** The vehicles this snapshot's removals section names (`vehicleRemovedAtUs`). */
  private applyVehicleRemovals(packet: SnapshotV2Packet): void {
    for (const removal of packet.removals ?? []) {
      if (!removal.vehicle || !this.vehicles.has(removal.handle)) continue;
      const removedAtUs = removal.removedTick * SERVER_TICK_US;
      // A sample from the removal tick on means it came back.
      if ((this.vehicleServerTimeUs.get(removal.handle) ?? -Infinity) >= removedAtUs) continue;
      this.vehicleRemovedAtUs.set(removal.handle, removedAtUs);
    }
  }

  private removeVehicle(id: number): void {
    if(this.localDrivenVehicleId===id)this.localDrivenVehicleId=null;
    this.vehicleDroppedAtTick.set(id, this.latestServerTick);
    this.vehicleLastSeenTick.delete(id);
    this.vehicles.delete(id);
    this.vehicleServerTimeUs.delete(id);
    this.vehicleInterpolator.remove(id);
    this.vehicleRemovedAtUs.delete(id);
  }

  /**
   * The bodies this snapshot's removals section names (a server that sends
   * it): held at their last sample and removed once the render time reaches
   * the first tick without them (`retireUnstreamedBodies`), instead of when
   * bodyPresence.ts can infer it (up to a cold refresh, 1 s, later).
   */
  private applyBodyRemovals(packet: SnapshotV2Packet): void {
    for (const removal of packet.removals ?? []) {
      if (removal.vehicle) continue;
      const bodyId = this.dynamicBodyMetaByHandle.get(removal.handle)?.bodyId;
      if (bodyId === undefined || !this.dynamicBodies.has(bodyId)) continue;
      const removedAtUs = removal.removedTick * SERVER_TICK_US;
      const lastUs = this.dynamicBodyServerTimeUs.get(bodyId);
      // A sample from the removal tick on means it came back.
      if (lastUs !== undefined && lastUs >= removedAtUs) continue;
      this.dynamicBodyPresence.delete(bodyId);
      if (lastUs !== undefined) this.dynamicBodyLeaving.set(bodyId, lastUs);
      // A body at rest is where it was last seen until it goes: drawn there
      // until the removal tick. A moving one is not, and is held no longer
      // than its last sample, as bodyPresence.ts's own verdict would.
      const velocity = this.dynamicBodies.get(bodyId)?.velocity ?? [0, 0, 0];
      const moving = Math.hypot(velocity[0], velocity[1], velocity[2]) > MOVING_BODY_SPEED_MS;
      this.dynamicBodyRemovedAtUs.set(bodyId, moving && lastUs !== undefined ? lastUs : removedAtUs);
    }
  }

  /**
   * A snapshot older than the newest one applied: it arrived out of order.
   * The client used to drop it whole, and a cold refresh it carried went with
   * it (38% of snapshots on the lab's poor-mobile link, where vehicles at
   * rest then went undrawn: docs/netcode-tuning.md, scoreboard gap 5). Now
   * what it carries that is still news is applied, and nothing newer is
   * undone:
   *
   * - a player, body or vehicle whose own newest sample is older than this
   *   snapshot (one at rest, whose refresh this is, or one entering the
   *   stream) is applied as the newest snapshot would apply it, unless the
   *   client has dropped it since (`droppedSince`);
   * - an entity with newer samples gets this one added to its interpolation
   *   buffer, in order, filling the gap it left;
   * - its removals are noted (each is checked against newer samples).
   *
   * The clocks, the local player's state and prediction, and the inference of
   * bodies gone from the stream (bodyPresence.ts) follow only the newest
   * snapshot, as before; the removals it notes take effect at the next one.
   */
  private applyLateSnapshotV2(packet: SnapshotV2Packet): void {
    const tUs = packet.serverTimeUs;
    const tick = packet.serverTick;
    const intervalUs = this.snapshotIntervalUs();
    const anchorPos: [number, number, number] = [
      packet.anchorPxMm / 1000,
      packet.anchorPyMm / 1000,
      packet.anchorPzMm / 1000,
    ];
    const at = (dx: number, dy: number, dz: number): [number, number, number] => [
      anchorPos[0] + q2_5mmToMeters(dx),
      anchorPos[1] + q2_5mmToMeters(dy),
      anchorPos[2] + q2_5mmToMeters(dz),
    ];

    if (this.usesThinAuthoritativeMovement || this.config.spectateLocalPlayer) {
      const self = netStateToMeters({
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
      });
      this.interpolator.push(this.playerId, {
        serverTimeUs: tUs,
        position: self.position,
        velocity: self.velocity,
        yaw: self.yaw,
        pitch: self.pitch,
        hp: self.hp,
        flags: packet.selfState.flags,
      });
    }

    for (const player of packet.remotePlayers) {
      const id = this.playerIdByHandle.get(player.handle);
      // (A handle the roster no longer lists is a player that has left.)
      if (id == null || id === this.playerId) continue;
      const sample = {
        serverTimeUs: tUs,
        position: at(player.dxQ2_5mm, player.dyQ2_5mm, player.dzQ2_5mm),
        velocity: [player.vxCms / 100, player.vyCms / 100, player.vzCms / 100] as [number, number, number],
        yaw: (player.yawI16 & 0xffff) / 65535 * Math.PI * 2,
        pitch: (player.pitchI16 & 0xffff) / 65535 * Math.PI * 2,
        hp: player.hp,
        flags: player.flags,
      };
      const newest = this.interpolator.latest(id);
      this.interpolator.push(id, sample, intervalUs);
      if (!newest || newest.serverTimeUs < tUs) {
        this.remotePlayers.set(id, { id, position: sample.position, yaw: sample.yaw, pitch: sample.pitch, hp: sample.hp, flags: sample.flags });
      }
    }

    const applyBody = (bodyId: number, body: DynamicBodyStateMeters): void => {
      if (this.droppedSince('dynamic', bodyId, tick)) return;
      const lastUs = this.dynamicBodyServerTimeUs.get(bodyId);
      const sample = {
        serverTimeUs: tUs,
        position: body.position,
        quaternion: body.quaternion,
        halfExtents: body.halfExtents,
        velocity: body.velocity,
        angularVelocity: body.angularVelocity,
        shapeType: body.shapeType,
      };
      if (lastUs !== undefined && lastUs >= tUs) {
        if (this.dynamicBodies.has(bodyId)) this.dynamicBodyInterpolator.push(bodyId, sample);
        return;
      }
      // Newer than anything the client has of this body.
      this.dynamicBodies.set(bodyId, body);
      this.dynamicBodyServerTimeUs.set(bodyId, tUs);
      this.dynamicBodyInterpolator.push(bodyId, sample);
      if ((this.dynamicBodyPresence.lastSeenTick(bodyId) ?? -Infinity) < tick) {
        this.dynamicBodyPresence.seen(bodyId, tick, Math.hypot(...body.velocity), body.position, body.velocity);
      }
      // Leaving the stream (inferred or named after this snapshot): drawn up
      // to this sample now, still not past it.
      if (this.dynamicBodyLeaving.has(bodyId)) this.dynamicBodyLeaving.set(bodyId, tUs);
      const removedAtUs = this.dynamicBodyRemovedAtUs.get(bodyId);
      if (removedAtUs !== undefined && tUs >= removedAtUs) this.dynamicBodyRemovedAtUs.delete(bodyId);
    };
    for (const sphere of packet.sphereStates) {
      const meta = this.dynamicBodyMetaByHandle.get(sphere.handle);
      if (!meta) continue;
      const bodyId = meta.bodyId;
      const angularVelocity: [number, number, number] = [sphere.wxMrads / 1000, sphere.wyMrads / 1000, sphere.wzMrads / 1000];
      const lastUs = this.dynamicBodyServerTimeUs.get(bodyId);
      // A sphere's orientation is integrated, not streamed: from the newest
      // sample when this one is newer, else where its track has it then.
      const quaternion = lastUs === undefined || lastUs < tUs
        ? this.predictSphereQuaternion(bodyId, tUs, angularVelocity)
        : sampleDynamicBodyTrack(this.dynamicBodyInterpolator.samples(bodyId), tUs)?.quaternion ?? [0, 0, 0, 1];
      applyBody(bodyId, {
        id: bodyId,
        shapeType: meta.shapeType,
        position: at(sphere.dxQ2_5mm, sphere.dyQ2_5mm, sphere.dzQ2_5mm),
        quaternion,
        halfExtents: meta.halfExtents,
        velocity: [sphere.vxCms / 100, sphere.vyCms / 100, sphere.vzCms / 100],
        angularVelocity,
      });
    }
    for (const box of packet.boxStates) {
      const meta = this.dynamicBodyMetaByHandle.get(box.handle);
      if (!meta) continue;
      applyBody(meta.bodyId, {
        id: meta.bodyId,
        shapeType: meta.shapeType,
        position: at(box.dxQ2_5mm, box.dyQ2_5mm, box.dzQ2_5mm),
        quaternion: [box.qxSnorm / 32767, box.qySnorm / 32767, box.qzSnorm / 32767, box.qwSnorm / 32767],
        halfExtents: meta.halfExtents,
        velocity: [box.vxCms / 100, box.vyCms / 100, box.vzCms / 100],
        angularVelocity: [box.wxMrads / 1000, box.wyMrads / 1000, box.wzMrads / 1000],
      });
    }
    this.applyBodyRemovals(packet);

    for (const vehicle of packet.vehicleStates) {
      const vehicleId = vehicle.handle;
      if (this.droppedSince('vehicle', vehicleId, tick)) continue;
      const resolvedDriver = vehicle.driverHandle === 0 ? 0 : (this.playerIdByHandle.get(vehicle.driverHandle) ?? 0);
      const meters: VehicleStateMeters = {
        id: vehicleId,
        vehicleType: vehicle.vehicleType,
        flags: vehicle.flags,
        driverId: resolvedDriver !== 0
          ? resolvedDriver
          : vehicle.driverHandle !== 0 && this.localDrivenVehicleId === vehicleId ? this.playerId : 0,
        position: at(vehicle.dxQ2_5mm, vehicle.dyQ2_5mm, vehicle.dzQ2_5mm),
        quaternion: [vehicle.qxSnorm / 32767, vehicle.qySnorm / 32767, vehicle.qzSnorm / 32767, vehicle.qwSnorm / 32767],
        linearVelocity: [vehicle.vxCms / 100, vehicle.vyCms / 100, vehicle.vzCms / 100],
        angularVelocity: [vehicle.wxMrads / 1000, vehicle.wyMrads / 1000, vehicle.wzMrads / 1000],
        wheelData: [0, 0, 0, 0],
      };
      const lastUs = this.vehicleServerTimeUs.get(vehicleId);
      if (lastUs !== undefined && lastUs >= tUs) {
        if (this.vehicles.has(vehicleId)) this.pushVehicleSample(vehicleId, tUs, meters, intervalUs);
        continue;
      }
      // Newer than anything the client has of this vehicle (a parked car's
      // refresh, or its first sends): drawn from it, as if it were on time.
      this.attachVehicleAsset(meters);
      this.vehicles.set(vehicleId, meters);
      this.vehicleServerTimeUs.set(vehicleId, tUs);
      this.vehicleLastSeenTick.set(vehicleId, Math.max(tick, this.vehicleLastSeenTick.get(vehicleId) ?? -Infinity));
      const removedAtUs = this.vehicleRemovedAtUs.get(vehicleId);
      if (removedAtUs !== undefined && tUs >= removedAtUs) this.vehicleRemovedAtUs.delete(vehicleId);
      this.pushVehicleSample(vehicleId, tUs, meters, intervalUs);
    }
    this.applyVehicleRemovals(packet);
  }

  /**
   * The spectated player into the remote set: interpolated (unless thin
   * authoritative movement has already pushed this sample) and listed.
   */
  private spectateLocal(serverTimeUs: number, state: NetPlayerState, push: boolean): void {
    const m = netStateToMeters(state);
    if (push) {
      this.interpolator.push(this.playerId, {
        serverTimeUs,
        position: m.position,
        velocity: m.velocity,
        yaw: m.yaw,
        pitch: m.pitch,
        hp: m.hp,
        flags: state.flags,
      });
    }
    this.remotePlayers.set(this.playerId, {
      id: this.playerId,
      position: m.position,
      yaw: m.yaw,
      pitch: m.pitch,
      hp: m.hp,
      flags: state.flags,
    });
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
      case 'vehicleAsset': {
        this.customVehicles.set(packet.handle, packet.vehicle);
        const vehicle = this.vehicles.get(packet.handle);
        if (vehicle) this.attachVehicleAsset(vehicle);
        break;
      }
      case 'vehicleRig': {
        const previous = this.vehicleRigs.get(packet.handle);
        if (previous && packet.serverTick <= previous.serverTick) break;
        this.vehicleRigs.set(packet.handle, packet);
        const vehicle = this.vehicles.get(packet.handle);
        if (vehicle) this.attachVehicleAsset(vehicle);
        break;
      }
      case 'welcome':
        this.playerId = packet.playerId;
        this.protocolVersion = packet.protocolVersion;
        this.physicsBackend = packet.physicsBackend;
        this.clientMovementMode = packet.clientMovementMode;
        this.baselineInterpolationDelayMs = packet.interpolationDelayMs;
        this.minRemoteInterpolationDelayMs =
          (1000 / Math.max(packet.snapshotHz, 1)) * NetcodeClient.REMOTE_PLAYER_BUFFER_RATIO;
        // Until snapshots arrive to size the delays from.
        this.playerRenderClock.setTargetDelayMs(this.baselineInterpolationDelayMs);
        this.dynamicBodyRenderClock.setTargetDelayMs(
          Math.min(packet.interpolationDelayMs, NetcodeClient.INITIAL_DYNAMIC_BODY_INTERPOLATION_DELAY_MS),
        );
        // The server's nominal tick rate: the clock's starting delay is one tick.
        this.serverClock.setSimHz(packet.simHz);
        this.simHz = Math.max(1, packet.simHz);
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
        const arrivedUs = this.nowMs() * 1000;
        this.serverClock.observe(packet.serverTimeUs, arrivedUs);
        this.adoptAdaptiveDelays(arrivedUs, packet.serverTimeUs);
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
          this.dynamicBodyPresence.seen(db.id, packet.serverTick, Math.hypot(...meters.velocity));
          this.dynamicBodyLeaving.delete(db.id);
        }
        this.retireUnstreamedBodies(packet.serverTick, packet.serverTimeUs);
        this.debugTelemetry.observeAuthoritativeDynamicBodies(this.dynamicBodies);

        const knownIds = new Set<number>();
        let localPlayerState: NetPlayerState | null = null;
        for (const ps of packet.playerStates) {
          knownIds.add(ps.id);
          if (ps.id === this.playerId) {
            this.localPlayerHp = ps.hp;
            this.localPlayerFlags = ps.flags;
            localPlayerState = ps;
            if (this.config.spectateLocalPlayer) {
              this.spectateLocal(packet.serverTimeUs, ps, !this.usesThinAuthoritativeMovement);
            }
            if (this.usesThinAuthoritativeMovement) {
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
            }
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
          this.attachVehicleAsset(m);
          this.vehicles.set(vs.id, m);
          this.vehicleLastSeenTick.set(vs.id, packet.serverTick);
          this.vehicleServerTimeUs.set(vs.id, packet.serverTimeUs);

          // Route local vehicle snapshot to driver-side prediction
          if (vs.driverId === this.playerId && vs.driverId !== 0) {
            this.localDrivenVehicleId = vs.id;
            this.config.onLocalVehicleSnapshot?.(vs, packet.ackInputSeq, packet.serverTimeUs);
          } else if (vs.driverId !== this.playerId && this.localDrivenVehicleId === vs.id) {
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
          if (packet.serverTick < this.latestServerTick) this.applyLateSnapshotV2(packet);
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

  /**
   * The render time for players and vehicles: rate-aware server time minus the
   * player delay. Never goes backwards.
   */
  getRenderTimeUs(localTimeUs = this.nowMs() * 1000): number {
    return this.playerRenderClock.renderTimeUs(
      this.serverClock.serverNowUs(localTimeUs),
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

  getVehicleObservedAgeMs(id: number, localTimeUs = this.nowMs() * 1000): number | null {
    const sampleServerTimeUs = this.vehicleServerTimeUs.get(id);
    if (sampleServerTimeUs == null) return null;
    return Math.max(0, (this.serverClock.serverNowUs(localTimeUs) - sampleServerTimeUs) / 1000);
  }

  sampleRemoteDynamicBody(id: number, renderTimeUs?: number): DynamicBodySample | null {
    const t = renderTimeUs ?? this.getDynamicBodyRenderTimeUs();
    const lastUs = this.dynamicBodyLeaving.get(id);
    return this.dynamicBodyInterpolator.sample(id, lastUs !== undefined ? Math.min(t, lastUs) : t);
  }

  /**
   * A body as it is drawn at server time `drawUs` (the render time plus its
   * lead): its track there, never past its last sample once it is leaving
   * the stream. Pure: the lead is not moved (`dynamicBodyDrawTimeUs` does).
   */
  sampleDynamicBodyDraw(id: number, drawUs: number): DynamicBodySample | null {
    return this.sampleRemoteDynamicBody(id, drawUs);
  }

  /**
   * The server time body `id` is drawn at for render time `renderUs`: the
   * render time plus the body's lead (bodyLead.ts), moved toward its goal
   * for this render time. The render time itself with the lead off, and for
   * a body not in free fall once its lead has run out. Idempotent for one
   * render time.
   */
  dynamicBodyDrawTimeUs(id: number, renderUs: number): number {
    if (!this.bodyLeadConfig.enabled) return renderUs;
    let track = this.bodyLeads.get(id);
    if (!track) {
      track = new BodyLeadTrack();
      this.bodyLeads.set(id, track);
    }
    // A body leaving the stream is drawn up to its last sample and held
    // there until it is removed (at the render time): it gives its lead up,
    // so it is not held there that much longer.
    const horizonUs = this.dynamicBodyLeaving.has(id) ? 0 : this.bodyLeadHorizon.horizonUs();
    return track.advance(
      renderUs,
      this.dynamicBodyInterpolator.samples(id),
      horizonUs,
      this.bodyLeadConfig,
      (t) => this.sampleDynamicBodyDraw(id, t)?.position ?? null,
      this.bodyLeadCounters,
    );
  }

  /** The lead a free-falling body is drawn at now, us (0 with the lead off). */
  getDynamicBodyLeadHorizonUs(): number {
    return this.bodyLeadConfig.enabled ? this.bodyLeadHorizon.horizonUs() : 0;
  }

  /** The body lead's settings (Netlab records them). */
  dynamicBodyLeadConfig(): BodyLeadConfig {
    return { ...this.bodyLeadConfig };
  }

  /** The body lead's counters (Netlab's client stats). */
  dynamicBodyLeadStats(): { enabled: boolean; aheadMs: number; horizonMs: number; warps: number; warpedMs: number } {
    return {
      enabled: this.bodyLeadConfig.enabled,
      aheadMs: this.bodyLeadHorizon.aheadUs / 1000,
      horizonMs: this.getDynamicBodyLeadHorizonUs() / 1000,
      ...this.bodyLeadCounters,
    };
  }

  /**
   * A streamed body as a spectator sees it: interpolated at the dynamic-body
   * render time, else its latest state. The live runtime draws this for any
   * body the local player is not interacting with; the tape replay, for all.
   * A body in free fall is drawn at its lead past the render time
   * (`dynamicBodyDrawTimeUs`).
   */
  getInterpolatedDynamicBodyState(id: number): DynamicBodyStateMeters | null {
    const renderUs = this.getDynamicBodyRenderTimeUs();
    const drawUs = this.dynamicBodyDrawTimeUs(id, renderUs);
    const sample = this.sampleDynamicBodyDraw(id, drawUs);
    if (sample) {
      this.bodyLeads.get(id)?.drawn(sample.position);
      return {
        id,
        shapeType: sample.shapeType,
        position: sample.position,
        quaternion: sample.quaternion,
        halfExtents: sample.halfExtents,
        velocity: sample.velocity,
        angularVelocity: sample.angularVelocity,
      };
    }
    return this.dynamicBodies.get(id) ?? null;
  }

  /**
   * The render time for the local player's own avatar (thin-authoritative
   * mode): one snapshot interval behind server time. Never goes backwards.
   */
  getLocalPlayerRenderTimeUs(localTimeUs = this.nowMs() * 1000): number {
    return this.localPlayerRenderClock.renderTimeUs(
      this.serverClock.serverNowUs(localTimeUs),
      localTimeUs,
    );
  }

  /**
   * The render time for dynamic bodies (and meteors, and the driven car):
   * rate-aware server time minus the dynamic-body delay. Never goes backwards.
   */
  getDynamicBodyRenderTimeUs(localTimeUs = this.nowMs() * 1000): number {
    return this.dynamicBodyRenderClock.renderTimeUs(
      this.serverClock.serverNowUs(localTimeUs),
      localTimeUs,
    );
  }

  /**
   * Drop the bodies the snapshot at `serverTick` shows are no longer streamed
   * to this client (retired by the server, or out of interest): see
   * bodyPresence.ts. They stop being drawn then, not 4 s later.
   */
  private retireUnstreamedBodies(
    serverTick: number,
    serverTimeUs: number,
    recipient: [number, number, number] | null = null,
  ): void {
    const intervalTicks = this.serverClock.getSnapshotIntervalMs() / (1000 / this.simHz);
    // The render time is about this snapshot's time less the interpolation
    // delay. A body that left the stream is removed once that has passed its
    // last snapshot; until then it is drawn at most up to it. (A body known
    // gone the moment it leaves the interest radius, bodyPresence.ts, still
    // has a delay's worth of its track ahead of the render clock: removing it
    // there drew nothing for those frames while truth had it in interest.)
    const renderedUpToUs = serverTimeUs - this.dynamicBodyInterpolationDelayMs * 1000;
    for (const id of this.dynamicBodyPresence.endSnapshot(serverTick, intervalTicks, recipient)) {
      const lastUs = this.dynamicBodyServerTimeUs.get(id);
      if (lastUs !== undefined && lastUs > renderedUpToUs) {
        this.dynamicBodyLeaving.set(id, lastUs);
      } else {
        this.removeDynamicBody(id);
      }
    }
    for (const [id, lastUs] of this.dynamicBodyLeaving) {
      // Named in a removals section: truth has it until that tick, so it is
      // drawn (held at its last sample) until the render time is there.
      const until = Math.max(lastUs, this.dynamicBodyRemovedAtUs.get(id) ?? -Infinity);
      if (until <= renderedUpToUs) this.removeDynamicBody(id);
    }
    for (const [id, removedAtUs] of this.dynamicBodyRemovedAtUs) {
      if (!this.dynamicBodyLeaving.has(id) && removedAtUs <= renderedUpToUs) this.removeDynamicBody(id);
    }
  }

  private removeDynamicBody(id: number): void {
    this.bodyLeads.delete(id);
    this.dynamicBodyDroppedAtTick.set(id, this.latestServerTick);
    this.dynamicBodies.delete(id);
    this.dynamicBodyServerTimeUs.delete(id);
    this.dynamicBodyInterpolator.remove(id);
    this.dynamicBodyLeaving.delete(id);
    this.dynamicBodyRemovedAtUs.delete(id);
  }

  /** A body's buffered snapshots, oldest first. */
  getDynamicBodySamples(id: number): readonly DynamicBodySample[] {
    return this.dynamicBodyInterpolator.samples(id);
  }

  /**
   * How many server ticks of snapshots have arrived since this body was last
   * in one; null if it is not known. Unlike an age measured against the
   * estimated server clock, it does not grow while the server is stalled:
   * a body is missing from the stream only if newer snapshots left it out.
   */
  getDynamicBodyTicksSinceSeen(id: number): number | null {
    const lastSeen = this.dynamicBodyPresence.lastSeenTick(id);
    return lastSeen == null ? null : Math.max(0, this.latestServerTick - lastSeen);
  }

  getDynamicBodyObservedAgeMs(id: number, localTimeUs = this.nowMs() * 1000): number | null {
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
    this.baselineInterpolationDelayMs = 100;
    this.playerRenderClock.setTargetDelayMs(this.baselineInterpolationDelayMs);
    this.playerRenderClock.reset();
    this.dynamicBodyRenderClock.setTargetDelayMs(NetcodeClient.INITIAL_DYNAMIC_BODY_INTERPOLATION_DELAY_MS);
    this.dynamicBodyRenderClock.reset();
    this.bodyLeadHorizon.reset();
    this.bodyLeads.clear();
    this.localPlayerRenderClock.setTargetDelayMs(NetcodeClient.INITIAL_DYNAMIC_BODY_INTERPOLATION_DELAY_MS);
    this.localPlayerRenderClock.reset();
    this.minRemoteInterpolationDelayMs = 0;
    this.remotePlayers.clear();
    this.playerIdByHandle.clear();
    this.dynamicBodies.clear();
    this.dynamicBodyMetaByHandle.clear();
    this.dynamicBodyServerTimeUs.clear();
    this.dynamicBodyLeaving.clear();
    this.dynamicBodyRemovedAtUs.clear();
    this.dynamicBodyDroppedAtTick.clear();
    this.vehicleDroppedAtTick.clear();
    this.dynamicBodyPresence.clear();
    this.dynamicBodyInterpolator.retainOnly(new Set());
    this.vehicles.clear();
    this.customVehicles.clear();
    this.vehicleRigs.clear();
    this.vehicleLastSeenTick.clear();
    this.vehicleRemovedAtUs.clear();
    this.vehicleInterpolator.retainOnly(new Set());
    this.batteries.clear();
    this.energyDisplay.reset();
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
  // WebTransport's `closed` resolves with the server's close info; a server
  // that refuses a session (e.g. a /city match it cannot host) says why here.
  if (typeof reason === 'object' && typeof (reason as { reason?: unknown }).reason === 'string') {
    const info = reason as { closeCode?: number; reason: string };
    if (info.reason.length > 0) {
      return `${prefix} ${SERVER_CLOSE_MARKER}${info.reason}`;
    }
    return `${prefix} closed (code ${info.closeCode ?? 0})`;
  }
  return `${prefix} closed (${String(reason)})`;
}

