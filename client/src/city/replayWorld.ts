// The game world a tape describes, beyond the city: players, vehicles,
// dynamic bodies (balls, boxes, cannonballs, meteors), shot traces.
//
// It is the live game's own NetcodeClient -- the same snapshot decoding, the
// same server-clock estimator, the same interpolators -- with two differences:
// it never connects (the tape's packets are handed to it, decoded by the same
// per-channel decoders the transports use), and its clock is the tape's, so
// every arrival is observed at the time it arrived on the recording machine
// and every render time is taken on the replay clock. Pause, slow motion and
// seeking are then just what that clock does. The recording player is
// spectated: drawn from its own snapshots like anyone else.

import { NetcodeClient, type RemotePlayer } from '../net/netcodeClient';
import { routeInboundPacket, type InboundChannel } from '../net/inbound';
import type { DynamicBodySample, PlayerSample, VehicleSample } from '../net/interpolation';
import type {
  BatteryStateMeters,
  DynamicBodyStateMeters,
  ShotFiredPacket,
  VehicleStateMeters,
} from '../net/protocol';
import type { LocalShotTrace } from '../scene/shotTrace';
import { applyServerShotFired } from '../scene/shotTraces';
import type { MeteorBodySource } from '../vfx/MeteorLayer';

export class ReplayNetWorld implements MeteorBodySource {
  readonly client: NetcodeClient;
  /** Server shot traces, on the tape clock, for the shot trace pool. */
  readonly shotTraces: LocalShotTrace[] = [];
  private nextTraceId = 1;
  /** Packets that failed to decode (a tape from a different protocol). */
  decodeErrors = 0;

  /** `clockMs` is the tape clock: ms since the recording started. */
  constructor(private readonly clockMs: () => number) {
    this.client = new NetcodeClient({
      nowMs: clockMs,
      spectateLocalPlayer: true,
      onShotFired: (packet) => this.onShotFired(packet),
    });
  }

  /**
   * A non-city packet from the tape, routed and decoded as the transport it
   * arrived on did it. Call with the tape clock at the packet's arrival time.
   */
  deliver(bytes: Uint8Array, channel: InboundChannel): void {
    let routed;
    try {
      routed = routeInboundPacket(bytes, channel);
    } catch {
      this.decodeErrors += 1;
      return;
    }
    if (routed.route !== 'game') return;
    this.client.handlePacket(routed.packet, channel);
  }

  observeRtt(rttMs: number): void {
    this.client.observeRtt(rttMs);
  }

  /** A server time (us) on the tape clock (ms), through the estimated offset. */
  serverToTapeMs(serverTimeUs: number): number {
    return (serverTimeUs - this.client.serverClock.getOffsetUs()) / 1000;
  }

  private onShotFired(packet: ShotFiredPacket): void {
    // Everyone's shots, the recording player's included: live, that player's
    // own were drawn by local prediction, which a tape does not have. Dust
    // matches shots on the wall clock the city packets are applied at.
    const nowMs = this.clockMs();
    applyServerShotFired(
      packet,
      this.shotTraces,
      () => this.nextTraceId++,
      this.client.serverClock.getOffsetUs(),
      nowMs,
      performance.now(),
    );
  }

  get playerId(): number {
    return this.client.playerId;
  }

  get state(): { dynamicBodies: Map<number, DynamicBodyStateMeters>; dynamicBodyInterpolationDelayMs: number } {
    return {
      dynamicBodies: this.client.dynamicBodies,
      dynamicBodyInterpolationDelayMs: this.client.dynamicBodyInterpolationDelayMs,
    };
  }

  get players(): Map<number, RemotePlayer> {
    return this.client.remotePlayers;
  }

  get vehicles(): Map<number, VehicleStateMeters> {
    return this.client.vehicles;
  }

  get batteries(): Map<number, BatteryStateMeters> {
    return this.client.batteries;
  }

  playerRenderTimeUs(): number {
    return this.client.getRenderTimeUs();
  }

  samplePlayer(id: number, renderTimeUs: number): PlayerSample | null {
    return this.client.interpolator.sample(id, renderTimeUs);
  }

  sampleVehicle(id: number, renderTimeUs: number): VehicleSample | null {
    return this.client.sampleRemoteVehicle(id, renderTimeUs);
  }

  getDynamicBodyRenderTimeUs(): number {
    return this.client.getDynamicBodyRenderTimeUs();
  }

  getDynamicBodyObservedAgeMs(id: number): number | null {
    return this.client.getDynamicBodyObservedAgeMs(id);
  }

  getRenderedDynamicBodyState(id: number): DynamicBodyStateMeters | null {
    return this.client.getInterpolatedDynamicBodyState(id);
  }

  getDynamicBodySamples(id: number): readonly DynamicBodySample[] {
    return this.client.getDynamicBodySamples(id);
  }

  getDynamicBodyTicksSinceSeen(id: number): number | null {
    return this.client.getDynamicBodyTicksSinceSeen(id);
  }
}
