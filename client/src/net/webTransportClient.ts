import {
  PKT_PING,
  bytesFromHex,
  decodeServerDatagramPacket,
  decodeServerReliablePacket,
  encodeBlockEditPacket,
  encodeClientHello,
  encodeFirePacket,
  encodeInputBundle,
  encodeMeleePacket,
  encodePingPacket,
  encodeVehicleEnterPacket,
  encodeVehicleExitPacket,
  frameReliablePacket,
  parseFramedReliablePackets,
  type BlockEditCmd,
  type FireCmd,
  type InputFrame,
  type MeleeCmd,
  type ServerDatagramPacket,
  type ServerReliablePacket,
  type WelcomePacket,
} from './protocol';
import { getUsername } from '../app/username';

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
  sessionConfigEndpoint?: string;
  onReliablePacket?: (packet: ServerReliablePacket) => void;
  onDatagramPacket?: (packet: ServerDatagramPacket, receivedLocalUs: number) => void;
  onWelcome?: (packet: WelcomePacket) => void;
  onClose?: (reason?: unknown) => void;
};

export class WebTransportGameClient {
  private transport: WebTransportLike | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private inputDatagramWriteInFlight = false;
  private queuedInputDatagram: Uint8Array | null = null;
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
    console.info('[webtransport] fetching session config for match:', options.matchId);
    const sessionConfig = await fetchSessionConfig(options.matchId, options.sessionConfigEndpoint);
    console.info('[webtransport] session config:', {
      url: sessionConfig.url,
      certMode: sessionConfig.server_certificate_hash_hex ? 'self-signed (pinned hash)' : 'CA-signed',
      certHash: sessionConfig.server_certificate_hash_hex || '(none — CA cert)',
      simHz: sessionConfig.sim_hz,
      snapshotHz: sessionConfig.snapshot_hz,
      interpolationDelayMs: sessionConfig.interpolation_delay_ms,
    });
    const client = new WebTransportGameClient(sessionConfig, options);
    await client.open();
    return client;
  }

  private async open(): Promise<void> {
    const WebTransportCtor = (window as unknown as { WebTransport?: WebTransportConstructorLike }).WebTransport;
    if (!WebTransportCtor) {
      throw new Error('WebTransport is not available in this browser');
    }

    // Use certificate pinning only for self-signed certs (dev mode).
    // CA-signed certs (production) use normal TLS validation — no hash needed.
    const certHash = this.sessionConfig.server_certificate_hash_hex;
    const transportOptions: WebTransportOptionsLike = {
      allowPooling: false,
      requireUnreliable: true,
      congestionControl: 'low-latency',
      ...(certHash ? {
        serverCertificateHashes: [{
          algorithm: 'sha-256',
          value: bytesFromHex(certHash),
        }],
      } : {}),
    };

    console.info(`[webtransport] connecting to ${this.sessionConfig.url}`, {
      certPinning: !!certHash,
      options: { allowPooling: false, requireUnreliable: true, congestionControl: 'low-latency' },
    });
    const t0 = performance.now();
    const transport = new WebTransportCtor(this.sessionConfig.url, transportOptions);

    this.transport = transport;
    await transport.ready;
    console.info(`[webtransport] QUIC connection ready (${(performance.now() - t0).toFixed(1)}ms handshake)`);

    const datagramWriter = transport.datagrams.writable.getWriter();
    this.datagramWriter = datagramWriter;

    const control = await transport.createBidirectionalStream();
    const controlWriter = control.writable.getWriter();
    await controlWriter.write(frameReliablePacket(encodeClientHello({
      matchId: this.options.matchId,
      username: getUsername(),
    })));
    await controlWriter.close();
    console.info('[webtransport] ClientHello sent, waiting for Welcome...');

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
    this.writeLatestInputDatagram(encodeInputBundle(frames));
  }

  sendFire(command: FireCmd): void {
    if (this.closed || !this.datagramWriter) {
      return;
    }
    void this.datagramWriter.write(encodeFirePacket(command)).catch((error) => this.handleClosed(error));
  }

  sendMelee(command: MeleeCmd): void {
    if (this.closed || !this.datagramWriter) {
      return;
    }
    void this.datagramWriter.write(encodeMeleePacket(command)).catch((error) => this.handleClosed(error));
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    if (this.closed || !this.datagramWriter) {
      return;
    }
    void this.datagramWriter.write(encodeBlockEditPacket(cmd)).catch((error) => this.handleClosed(error));
  }

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    if (this.closed || !this.datagramWriter) {
      return;
    }
    void this.datagramWriter.write(encodeVehicleEnterPacket(vehicleId, seat)).catch((error) => this.handleClosed(error));
  }

  sendVehicleExit(vehicleId: number): void {
    if (this.closed || !this.datagramWriter) {
      return;
    }
    void this.datagramWriter.write(encodeVehicleExitPacket(vehicleId)).catch((error) => this.handleClosed(error));
  }

  sendRawDatagram(packet: Uint8Array): void {
    if (this.closed || !this.datagramWriter) {
      return;
    }
    void this.datagramWriter.write(packet).catch((error) => this.handleClosed(error));
  }

  close(reason = 'client closed'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.inputDatagramWriteInFlight = false;
    this.queuedInputDatagram = null;
    this.datagramWriter?.releaseLock();
    this.datagramWriter = null;
    this.transport?.close({ closeCode: 0, reason });
    this.transport = null;
  }

  private writeLatestInputDatagram(packet: Uint8Array): void {
    if (this.closed || !this.datagramWriter) {
      return;
    }
    if (this.inputDatagramWriteInFlight) {
      this.queuedInputDatagram = packet;
      return;
    }
    this.flushInputDatagram(packet);
  }

  private flushInputDatagram(packet: Uint8Array): void {
    const writer = this.datagramWriter;
    if (this.closed || !writer) {
      this.inputDatagramWriteInFlight = false;
      this.queuedInputDatagram = null;
      return;
    }
    this.inputDatagramWriteInFlight = true;
    void writer.write(packet)
      .then(() => {
        this.inputDatagramWriteInFlight = false;
        const queued = this.queuedInputDatagram;
        this.queuedInputDatagram = null;
        if (queued) {
          this.flushInputDatagram(queued);
        }
      })
      .catch((error) => {
        this.inputDatagramWriteInFlight = false;
        this.queuedInputDatagram = null;
        this.handleClosed(error);
      });
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
            if (packet.type === 'welcome') {
              console.info('[webtransport] Welcome received — playerId:', packet.playerId, {
                simHz: packet.simHz,
                interpolationDelayMs: packet.interpolationDelayMs,
              });
              this.options.onWelcome?.(packet);
            }
            this.options.onReliablePacket?.(packet);
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

          // Auto-respond to server-initiated latency pings (PKT_PING = 110)
          if (value[0] === PKT_PING && value.length >= 5) {
            const nonce = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(1, true);
            void this.datagramWriter?.write(encodePingPacket(nonce))?.catch(() => {});
            continue;
          }

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
    if (reason !== undefined && reason !== null) {
      console.warn('[webtransport] connection closed:', reason);
    } else {
      console.info('[webtransport] connection closed (clean)');
    }
    this.options.onClose?.(reason);
  }
}

async function fetchSessionConfig(matchId: string, endpoint = '/session-config'): Promise<SessionConfigResponse> {
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set('match_id', matchId);
  console.info('[webtransport] GET', url.toString());
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch session config: HTTP ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<SessionConfigResponse>;
}
