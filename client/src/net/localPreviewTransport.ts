import { initSharedPhysics, WasmLocalSession } from '../wasm/sharedPhysics';
import {
  decodeServerPacket,
  encodeBlockEditPacket,
  encodeFirePacket,
  encodeInputBundle,
  encodePingPacket,
  encodeVehicleEnterPacket,
  encodeVehicleExitPacket,
  type BlockEditCmd,
  type FireCmd,
  type InputCmd,
  type ServerPacket,
} from './protocol';

const FIXED_DT = 1 / 60;
const MAX_CATCHUP_TICKS = 4;

export type LocalPreviewTransportHandlers = {
  onPacket?: (packet: ServerPacket) => void;
  onClose?: () => void;
  worldJson?: string;
};

export class LocalPreviewTransport {
  private session: WasmLocalSession | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private tickAccumulatorSec = 0;
  private lastTickTimeMs = 0;

  private constructor(private readonly handlers: LocalPreviewTransportHandlers = {}) {}

  static async connect(
    handlers: LocalPreviewTransportHandlers = {},
  ): Promise<LocalPreviewTransport> {
    await initSharedPhysics();
    const transport = new LocalPreviewTransport(handlers);
    const LocalSessionCtor = WasmLocalSession as unknown as new (worldJson?: string) => WasmLocalSession;
    transport.session = new LocalSessionCtor(handlers.worldJson);
    transport.session.connect();
    transport.flushPackets();
    transport.lastTickTimeMs = performance.now();
    transport.tickHandle = setInterval(() => {
      if (!transport.session || transport.closed) {
        return;
      }
      const nowMs = performance.now();
      const elapsedSec = Math.min(Math.max((nowMs - transport.lastTickTimeMs) / 1000, 0), 0.1);
      transport.lastTickTimeMs = nowMs;
      transport.tickAccumulatorSec += elapsedSec;
      let ticks = 0;
      while (transport.tickAccumulatorSec >= FIXED_DT && ticks < MAX_CATCHUP_TICKS) {
        transport.session.tick(FIXED_DT);
        transport.tickAccumulatorSec -= FIXED_DT;
        ticks += 1;
      }
      if (transport.tickAccumulatorSec > FIXED_DT) {
        transport.tickAccumulatorSec = FIXED_DT;
      }
      transport.flushPackets();
    }, 1000 / 60);
    return transport;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.tickAccumulatorSec = 0;
    this.lastTickTimeMs = 0;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.session?.disconnect();
    this.flushPackets();
    this.session?.free();
    this.session = null;
    this.handlers.onClose?.();
  }

  sendInputs(cmds: InputCmd[]): void {
    if (cmds.length === 0) {
      return;
    }
    this.sendRaw(encodeInputBundle(cmds));
  }

  sendFire(cmd: FireCmd): void {
    this.sendRaw(encodeFirePacket(cmd));
  }

  /**
   * Spawn a bot as a real player inside the local session. Returns `true`
   * if the bot id was accepted.
   */
  connectBot(botId: number): boolean {
    if (!this.session || this.closed) return false;
    return this.session.connectBot(botId);
  }

  /** Remove a previously spawned bot. */
  disconnectBot(botId: number): boolean {
    if (!this.session || this.closed) return false;
    const removed = this.session.disconnectBot(botId);
    this.flushPackets();
    return removed;
  }

  /** Push an InputCmd bundle for a specific bot id. */
  sendBotInputs(botId: number, cmds: InputCmd[]): void {
    if (cmds.length === 0 || !this.session || this.closed) return;
    const bytes = encodeInputBundle(cmds);
    try {
      this.session.handleBotPacket(botId, bytes);
    } catch (error) {
      console.warn('[local-preview] bot input rejected', error);
    }
    this.flushPackets();
  }

  /**
   * Override a bot's max horizontal move speed in meters/second. Pass
   * `null` to restore the KCC's default walk/sprint tiers. Returns true
   * if the id was a known bot.
   */
  setBotMaxSpeed(botId: number, maxSpeedMps: number | null): boolean {
    if (!this.session || this.closed) return false;
    // WASM takes a negative sentinel for "clear override".
    const value = maxSpeedMps === null ? -1 : maxSpeedMps;
    return this.session.setBotMaxSpeed(botId, value);
  }

  /** Push a fire packet for a specific bot id. */
  sendBotFire(botId: number, cmd: FireCmd): void {
    if (!this.session || this.closed) return;
    const bytes = encodeFirePacket(cmd);
    try {
      this.session.handleBotPacket(botId, bytes);
    } catch (error) {
      console.warn('[local-preview] bot fire rejected', error);
    }
    this.flushPackets();
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    this.sendRaw(encodeBlockEditPacket(cmd));
  }

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    this.sendRaw(encodeVehicleEnterPacket(vehicleId, seat));
  }

  sendVehicleExit(vehicleId: number): void {
    this.sendRaw(encodeVehicleExitPacket(vehicleId));
  }

  ping(): void {
    this.sendRaw(encodePingPacket(0));
  }

  private sendRaw(bytes: Uint8Array): void {
    if (!this.session || this.closed) {
      return;
    }
    try {
      this.session.handleClientPacket(bytes);
    } catch (error) {
      console.warn('[local-preview] client packet rejected', error);
    }
    this.flushPackets();
  }

  private flushPackets(): void {
    if (!this.session || this.closed) {
      return;
    }
    const blob = this.session.drainPackets();
    let offset = 0;
    while (offset + 4 <= blob.length) {
      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      const packetLen = view.getUint32(offset, true);
      offset += 4;
      if (packetLen === 0 || offset + packetLen > blob.length) {
        break;
      }
      const packet = blob.slice(offset, offset + packetLen);
      offset += packetLen;
      this.handlers.onPacket?.(decodeServerPacket(packet));
    }
  }
}
