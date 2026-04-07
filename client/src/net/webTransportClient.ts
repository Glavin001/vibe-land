import {
  bytesFromHex,
  decodeServerDatagramPacket,
  decodeServerReliablePacket,
  encodeClientHello,
  encodeFirePacket,
  encodeInputBundle,
  frameReliablePacket,
  parseFramedReliablePackets,
  type FireCmd,
  type InputFrame,
  type ServerDatagramPacket,
  type ServerReliablePacket,
  type WelcomePacket,
} from './protocol';

type WebTransportHash = {
  algorithm: string;
  value: Uint8Array;
};

type WebTransportOptionsLike = {
  serverCertificateHashes?: WebTransportHash[];
  allowPooling?: boolean;
  requireUnreliable?: boolean;
  congestionControl?: 'default' | 'throughput' | 'low-latency';
};

type WebTransportBidirectionalStreamLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

type WebTransportLike = {
  readonly ready: Promise<void>;
  readonly closed: Promise<unknown>;
  readonly datagrams: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  createBidirectionalStream(): Promise<WebTransportBidirectionalStreamLike>;
  close(info?: { closeCode?: number; reason?: string }): void;
};

type WebTransportConstructorLike = new (url: string, options?: WebTransportOptionsLike) => WebTransportLike;

export type SessionConfigResponse = {
  match_id: string;
  url: string;
  server_certificate_hash_hex: string;
  sim_hz: number;
  snapshot_hz: number;
  interpolation_delay_ms: number;
};

export type WebTransportGameClientOptions = {
  matchId: string;
  onReliablePacket?: (packet: ServerReliablePacket) => void;
  onDatagramPacket?: (packet: ServerDatagramPacket, receivedLocalUs: number) => void;
  onWelcome?: (packet: WelcomePacket) => void;
  onClose?: (reason?: unknown) => void;
};

export class WebTransportGameClient {
  private transport: WebTransportLike | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closed = false;
  private closeNotified = false;

  readonly sessionConfig: SessionConfigResponse;

  private constructor(
    sessionConfig: SessionConfigResponse,
    private readonly options: WebTransportGameClientOptions,
  ) {
    this.sessionConfig = sessionConfig;
  }

  static async connect(options: WebTransportGameClientOptions): Promise<WebTransportGameClient> {
    const sessionConfig = await fetchSessionConfig(options.matchId);
    const client = new WebTransportGameClient(sessionConfig, options);
    await client.open();
    return client;
  }

  private async open(): Promise<void> {
    const WebTransportCtor = (window as unknown as { WebTransport?: WebTransportConstructorLike }).WebTransport;
    if (!WebTransportCtor) {
      throw new Error('WebTransport is not available in this browser');
    }

    const transport = new WebTransportCtor(this.sessionConfig.url, {
      allowPooling: false,
      requireUnreliable: true,
      congestionControl: 'low-latency',
      serverCertificateHashes: [{
        algorithm: 'sha-256',
        value: bytesFromHex(this.sessionConfig.server_certificate_hash_hex),
      }],
    });

    this.transport = transport;
    await transport.ready;

    const datagramWriter = transport.datagrams.writable.getWriter();
    this.datagramWriter = datagramWriter;

    const control = await transport.createBidirectionalStream();
    const controlWriter = control.writable.getWriter();
    await controlWriter.write(frameReliablePacket(encodeClientHello({ matchId: this.options.matchId })));
    await controlWriter.close();

    this.startReliableReader(control.readable);
    this.startDatagramReader(transport.datagrams.readable);
    transport.closed
      .then((reason) => this.handleClosed(reason))
      .catch((error) => this.handleClosed(error));
  }

  sendInputBundle(frames: InputFrame[]): void {
    if (this.closed || !this.datagramWriter || frames.length === 0) {
      return;
    }
    void this.datagramWriter.write(encodeInputBundle(frames)).catch((error) => this.handleClosed(error));
  }

  sendFire(command: FireCmd): void {
    if (this.closed || !this.datagramWriter) {
      return;
    }
    void this.datagramWriter.write(encodeFirePacket(command)).catch((error) => this.handleClosed(error));
  }

  close(reason = 'client closed'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.datagramWriter?.releaseLock();
    this.datagramWriter = null;
    this.transport?.close({ closeCode: 0, reason });
    this.transport = null;
  }

  private startReliableReader(stream: ReadableStream<Uint8Array>): void {
    const reader = stream.getReader();
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    void (async () => {
      try {
        while (!this.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          const parsed = parseFramedReliablePackets(buffer, value);
          buffer = parsed.buffer;
          for (const packetBytes of parsed.packets) {
            const packet = decodeServerReliablePacket(packetBytes);
            this.options.onReliablePacket?.(packet);
            if (packet.type === 'welcome') {
              this.options.onWelcome?.(packet);
            }
          }
        }
      } catch (error) {
        this.handleClosed(error);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private startDatagramReader(stream: ReadableStream<Uint8Array>): void {
    const reader = stream.getReader();

    void (async () => {
      try {
        while (!this.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          const packet = decodeServerDatagramPacket(value);
          this.options.onDatagramPacket?.(packet, performance.now() * 1000);
        }
      } catch (error) {
        this.handleClosed(error);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private handleClosed(reason?: unknown): void {
    if (!this.closed) {
      this.closed = true;
      this.datagramWriter?.releaseLock();
      this.datagramWriter = null;
      this.transport = null;
    }
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.options.onClose?.(reason);
  }
}

async function fetchSessionConfig(matchId: string): Promise<SessionConfigResponse> {
  const response = await fetch(`/session-config?match_id=${encodeURIComponent(matchId)}`);
  if (!response.ok) {
    throw new Error(`failed to fetch session config: ${response.status}`);
  }
  return response.json() as Promise<SessionConfigResponse>;
}
