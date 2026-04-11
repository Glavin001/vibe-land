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

export type LocalPreviewTransportHandlers = {
  onPacket?: (packet: ServerPacket) => void;
  onClose?: () => void;
};

export class LocalPreviewTransport {
  private session: WasmLocalSession | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private constructor(private readonly handlers: LocalPreviewTransportHandlers = {}) {}

  static async connect(
    handlers: LocalPreviewTransportHandlers = {},
  ): Promise<LocalPreviewTransport> {
    await initSharedPhysics();
    const transport = new LocalPreviewTransport(handlers);
    transport.session = new WasmLocalSession();
    transport.session.connect();
    transport.flushPackets();
    transport.tickHandle = setInterval(() => {
      if (!transport.session || transport.closed) {
        return;
      }
      transport.session.tick(FIXED_DT);
      transport.flushPackets();
    }, 1000 / 60);
    return transport;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
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
