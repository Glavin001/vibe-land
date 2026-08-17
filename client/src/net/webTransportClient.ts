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
import { isCityPacketKind } from '../city/wire';

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
  protocol_version: number;
  physics_backend: number;
  client_movement_mode: number;
  city_world?: boolean;
  city_manifest_hash?: string;
  city_wire_version?: number;
};

/** Generous enough for a cold server, short enough that a player is not stranded. */
const WELCOME_TIMEOUT_MS = 8000;

export type WebTransportGameClientOptions = {
  matchId: string;
  sessionConfigEndpoint?: string;
  /**
   * Session config resolved elsewhere (the control plane relays it, because a
   * rented box's self-signed cert makes a direct fetch to it impossible).
   * When set, no HTTP request is made.
   */
  sessionConfig?: SessionConfigResponse;
  onReliablePacket?: (packet: ServerReliablePacket) => void;
  onDatagramPacket?: (packet: ServerDatagramPacket, receivedLocalUs: number) => void;
  /** Raw city destruction packets (kinds 119-122), reliable or datagram. */
  onCityPacket?: (bytes: Uint8Array) => void;
  onWelcome?: (packet: WelcomePacket) => void;
  onClose?: (reason?: unknown) => void;
};

export class WebTransportGameClient {
  private transport: WebTransportLike | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /**
   * Uplink used for input and commands. Safari implements WebTransport
   * datagram receive but not send, so rather than abandoning the session to
   * WebSocket we keep the downlink on datagrams and move the (tiny) uplink
   * onto the control stream.
   */
  private controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private uplink: 'datagram' | 'stream' = 'datagram';
  /**
   * Resolves when the server admits us. A transport that opens but is never
   * answered is indistinguishable from a healthy one until this times out --
   * which is precisely how a client/server handshake mismatch turns into an
   * endless "Connecting...".
   */
  private welcomeResolve: (() => void) | null = null;
  private readonly welcomed = new Promise<void>((resolve) => {
    this.welcomeResolve = resolve;
  });
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
    const sessionConfig =
      options.sessionConfig ??
      (await fetchSessionConfig(options.matchId, options.sessionConfigEndpoint));
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
    // Wait for the server to actually admit us before declaring this transport
    // usable. Without this the caller's fallback can never trigger for a server
    // that accepts the connection and then says nothing, and the player waits
    // forever instead of dropping to a transport that works.
    await client.awaitWelcome(WELCOME_TIMEOUT_MS);
    return client;
  }

  private async awaitWelcome(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`server did not send Welcome within ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([this.welcomed, timeout]);
    } catch (error) {
      this.close('no welcome from server');
      throw error;
    } finally {
      clearTimeout(timer);
    }
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

    // `?uplink=stream` forces the Safari path on any browser, so it can be
    // exercised without an iOS device.
    const forceStream =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('uplink') === 'stream';
    const canSendDatagrams = Boolean(transport.datagrams?.writable) && !forceStream;
    this.uplink = canSendDatagrams ? 'datagram' : 'stream';
    if (canSendDatagrams) {
      this.datagramWriter = transport.datagrams.writable.getWriter();
    } else {
      console.info(
        '[webtransport] datagram send unavailable — using the control stream for uplink ' +
          '(downlink stays on datagrams)',
      );
    }

    const control = await transport.createBidirectionalStream();
    const controlWriter = control.writable.getWriter();
    await controlWriter.write(frameReliablePacket(encodeClientHello({ matchId: this.options.matchId })));
    if (this.uplink === 'stream') {
      // Held open: everything the player does travels over it from here.
      this.controlWriter = controlWriter;
    } else {
      await controlWriter.close();
    }
    console.info('[webtransport] ClientHello sent, waiting for Welcome...');

    this.startReliableReader(control.readable);
    this.startDatagramReader(transport.datagrams.readable);
    transport.closed
      .then((reason) => this.handleClosed(reason))
      .catch((error) => this.handleClosed(error));
  }

  /** True when this session can still send, whichever uplink it settled on. */
  private canSend(): boolean {
    return !this.closed && (this.datagramWriter !== null || this.controlWriter !== null);
  }

  /**
   * Send one client packet. Datagrams when available; otherwise the same bytes
   * length-prefixed on the control stream, which the server reads identically.
   */
  private sendClientPacket(packet: Uint8Array): void {
    if (this.closed) return;
    if (this.datagramWriter) {
      void this.datagramWriter.write(packet).catch((error) => this.handleClosed(error));
      return;
    }
    if (this.controlWriter) {
      void this.controlWriter
        .write(frameReliablePacket(packet))
        .catch((error) => this.handleClosed(error));
    }
  }

  sendInputBundle(frames: InputFrame[]): void {
    if (!this.canSend() || frames.length === 0) {
      return;
    }
    this.writeLatestInputDatagram(encodeInputBundle(frames));
  }

  sendCityResync(bytes: Uint8Array): void {
    if (!this.canSend()) {
      return;
    }
    this.sendClientPacket(bytes);
  }

  sendFire(command: FireCmd): void {
    if (!this.canSend()) {
      return;
    }
    this.sendClientPacket(encodeFirePacket(command));
  }

  sendMelee(command: MeleeCmd): void {
    if (!this.canSend()) {
      return;
    }
    this.sendClientPacket(encodeMeleePacket(command));
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    if (!this.canSend()) {
      return;
    }
    this.sendClientPacket(encodeBlockEditPacket(cmd));
  }

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    if (!this.canSend()) {
      return;
    }
    this.sendClientPacket(encodeVehicleEnterPacket(vehicleId, seat));
  }

  sendVehicleExit(vehicleId: number): void {
    if (!this.canSend()) {
      return;
    }
    this.sendClientPacket(encodeVehicleExitPacket(vehicleId));
  }

  sendRawDatagram(packet: Uint8Array): void {
    if (!this.canSend()) {
      return;
    }
    this.sendClientPacket(packet);
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
    this.controlWriter?.releaseLock();
    this.controlWriter = null;
    this.transport?.close({ closeCode: 0, reason });
    this.transport = null;
  }

  private writeLatestInputDatagram(packet: Uint8Array): void {
    if (!this.canSend()) {
      return;
    }
    if (this.inputDatagramWriteInFlight) {
      this.queuedInputDatagram = packet;
      return;
    }
    this.flushInputDatagram(packet);
  }

  private flushInputDatagram(packet: Uint8Array): void {
    // Stale input is worthless -- the next bundle supersedes it -- so only one
    // write is ever in flight and newer input replaces whatever is queued.
    const writer = this.datagramWriter ?? this.controlWriter;
    if (this.closed || !writer) {
      this.inputDatagramWriteInFlight = false;
      this.queuedInputDatagram = null;
      return;
    }
    const bytes = this.datagramWriter ? packet : frameReliablePacket(packet);
    this.inputDatagramWriteInFlight = true;
    void writer.write(bytes)
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
            if (packetBytes.length > 0 && isCityPacketKind(packetBytes[0])) {
              this.options.onCityPacket?.(packetBytes);
              continue;
            }
            const packet = decodeServerReliablePacket(packetBytes);
            if (packet.type === 'welcome') {
              console.info('[webtransport] Welcome received — playerId:', packet.playerId, {
                simHz: packet.simHz,
                interpolationDelayMs: packet.interpolationDelayMs,
              });
              this.welcomeResolve?.();
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

          if (isCityPacketKind(value[0])) {
            this.options.onCityPacket?.(value);
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

export async function fetchSessionConfig(matchId: string, endpoint = '/session-config'): Promise<SessionConfigResponse> {
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set('match_id', matchId);
  console.info('[webtransport] GET', url.toString());
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch session config: HTTP ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<SessionConfigResponse>;
}
