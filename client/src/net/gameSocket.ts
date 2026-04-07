import {
  decodeServerPacket,
  encodeBlockEditPacket,
  encodeFirePacket,
  encodeInputBundle,
  encodeInputPacket,
  encodePingPacket,
  type BlockEditCmd,
  type FireCmd,
  type InputCmd,
  type ServerPacket,
} from './protocol';

export type GameSocketHandlers = {
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  onPacket?: (packet: ServerPacket) => void;
  onRttUpdated?: (rttMs: number) => void;
};

export class GameSocket {
  private ws: WebSocket | null = null;
  private pendingClientPings = new Map<number, number>();
  private nextPingNonce = 1;

  constructor(private readonly handlers: GameSocketHandlers = {}) {}

  connect(url: string): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onerror = (event) => this.handlers.onError?.(event);
    ws.onclose = (event) => this.handlers.onClose?.(event);
    ws.onmessage = (event) => this.handleMessage(event.data);
    this.ws = ws;
  }

  disconnect(code?: number, reason?: string): void {
    this.ws?.close(code, reason);
    this.ws = null;
  }

  sendInput(cmd: InputCmd): void {
    this.sendRaw(encodeInputPacket(cmd));
  }

  sendInputs(cmds: InputCmd[]): void {
    if (cmds.length === 0) {
      return;
    }
    if (cmds.length === 1) {
      this.sendInput(cmds[0]);
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

  ping(): number {
    const nonce = this.nextPingNonce++;
    this.pendingClientPings.set(nonce, performance.now());
    this.sendRaw(encodePingPacket(nonce));
    return nonce;
  }

  private handleMessage(data: Blob | ArrayBuffer | string): void {
    if (typeof data === 'string') {
      return;
    }

    if (data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => this.handleArrayBuffer(buffer));
      return;
    }

    this.handleArrayBuffer(data);
  }

  private handleArrayBuffer(buffer: ArrayBuffer): void {
    const packet = decodeServerPacket(buffer);

    if (packet.type === 'serverPing') {
      // Authoritative server latency measurement for lag compensation.
      this.sendRaw(encodePingPacket(packet.value));
      return;
    }

    if (packet.type === 'pong') {
      const sentAt = this.pendingClientPings.get(packet.value);
      if (sentAt != null) {
        this.pendingClientPings.delete(packet.value);
        this.handlers.onRttUpdated?.(performance.now() - sentAt);
      }
    }

    this.handlers.onPacket?.(packet);
  }

  private sendRaw(packet: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(packet);
  }
}
