// The in-process transport: single-player in the native app, where the
// server's match loop runs inside the same process (sim-native, loaded as a
// mystralnative native module) and packets cross in memory, not a network.
//
// It speaks exactly the WebTransport session's bytes -- the server decodes
// uplink packets as WebTransport datagrams and hands downlink packets to us
// on the same two lanes -- so everything above the transport (NetcodeClient,
// the city client, prediction) is the multiplayer client, unchanged.

import {
  encodeBlockEditPacket,
  encodeCityCameraDrop,
  encodeFirePacket,
  encodeInputBundle,
  encodeMeleePacket,
  encodePingPacket,
  encodeVehicleEnterPacket,
  encodeVehicleExitPacket,
  type BlockEditCmd,
  type CityCameraDropCmd,
  type FireCmd,
  type InputFrame,
  type MeleeCmd,
  type ServerDatagramPacket,
  type ServerReliablePacket,
} from './protocol';
import { routeInboundPacket } from './inbound';
import type { SessionConfigResponse, WebTransportGameClientOptions } from './webTransportClient';

/**
 * One player's session with an in-process match, as the native module
 * exposes it. `drain` returns every packet queued since the last call as a
 * flat list: lane flag (true = reliable) then the packet's bytes.
 */
export interface InProcessLink {
  readonly sessionConfigJson: string;
  send(packet: Uint8Array): void;
  drain(): Array<boolean | ArrayBuffer>;
  close(): void;
}

let activeLink: InProcessLink | null = null;

/** Set by the native shell before the game connects; null everywhere else. */
export function setInProcessLink(link: InProcessLink | null): void {
  activeLink = link;
}

export function inProcessLink(): InProcessLink | null {
  return activeLink;
}

/** The in-process session's config, so the runtime needs no /session-config fetch. */
export function inProcessSessionConfig(): SessionConfigResponse | null {
  return activeLink ? (JSON.parse(activeLink.sessionConfigJson) as SessionConfigResponse) : null;
}

const WELCOME_TIMEOUT_MS = 30_000;
/**
 * How often the downlink is pumped. The server's reliable queue is bounded,
 * so draining only once per rendered frame would let a stalled frame (a
 * pipeline compile) overflow it and end the session.
 */
const PUMP_INTERVAL_MS = 2;

export class InProcessGameClient {
  readonly sessionConfig: SessionConfigResponse;
  private closed = false;
  private pump: ReturnType<typeof setInterval> | null = null;
  private welcomeResolve: (() => void) | null = null;
  private readonly welcomed = new Promise<void>((resolve) => {
    this.welcomeResolve = resolve;
  });

  private constructor(
    private readonly link: InProcessLink,
    private readonly options: WebTransportGameClientOptions,
  ) {
    this.sessionConfig = JSON.parse(link.sessionConfigJson) as SessionConfigResponse;
  }

  static async connect(link: InProcessLink, options: WebTransportGameClientOptions): Promise<InProcessGameClient> {
    const client = new InProcessGameClient(link, options);
    client.pump = setInterval(() => client.drain(), PUMP_INTERVAL_MS);
    client.drain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.welcomed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`in-process match did not send Welcome within ${WELCOME_TIMEOUT_MS}ms`)),
            WELCOME_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      client.close('no welcome from in-process match');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return client;
  }

  private drain(): void {
    if (this.closed) return;
    const items = this.link.drain();
    for (let i = 0; i + 1 < items.length; i += 2) {
      const bytes = new Uint8Array(items[i + 1] as ArrayBuffer);
      if (items[i]) this.receiveReliable(bytes);
      else this.receiveDatagram(bytes);
    }
  }

  private receiveReliable(bytes: Uint8Array): void {
    this.options.onRawPacket?.(bytes, 'wt-reliable');
    const routed = routeInboundPacket(bytes, 'wt-reliable');
    if (routed.route === 'city') {
      this.options.onCityPacket?.(bytes);
      return;
    }
    if (routed.route !== 'game') return;
    const packet = routed.packet as ServerReliablePacket;
    if (packet.type === 'welcome') {
      this.welcomeResolve?.();
      this.options.onWelcome?.(packet);
    }
    this.options.onReliablePacket?.(packet);
  }

  private receiveDatagram(bytes: Uint8Array): void {
    this.options.onRawPacket?.(bytes, 'wt-datagram');
    const routed = routeInboundPacket(bytes, 'wt-datagram');
    if (routed.route === 'ping') {
      // The server measures its one-way estimate from these, as over QUIC.
      const nonce = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
      this.send(encodePingPacket(nonce));
      return;
    }
    if (routed.route === 'city') {
      this.options.onCityPacket?.(bytes);
      return;
    }
    if (routed.route !== 'game') return;
    this.options.onDatagramPacket?.(routed.packet as ServerDatagramPacket, performance.now() * 1000);
  }

  private send(packet: Uint8Array): void {
    if (!this.closed) this.link.send(packet);
  }

  sendInputBundle(frames: InputFrame[]): void {
    if (frames.length > 0) this.send(encodeInputBundle(frames));
  }

  sendCityResync(bytes: Uint8Array): void {
    this.send(bytes);
  }

  sendFire(command: FireCmd): void {
    this.send(encodeFirePacket(command));
  }

  sendCityCameraDrop(command: CityCameraDropCmd): boolean {
    if (this.closed) return false;
    this.send(encodeCityCameraDrop(command));
    return true;
  }

  sendMelee(command: MeleeCmd): void {
    this.send(encodeMeleePacket(command));
  }

  sendBlockEdit(cmd: BlockEditCmd): void {
    this.send(encodeBlockEditPacket(cmd));
  }

  sendVehicleEnter(vehicleId: number, seat = 0): void {
    this.send(encodeVehicleEnterPacket(vehicleId, seat));
  }

  sendVehicleExit(vehicleId: number): void {
    this.send(encodeVehicleExitPacket(vehicleId));
  }

  sendRawDatagram(packet: Uint8Array): void {
    this.send(packet);
  }

  close(reason = 'client closed'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pump !== null) clearInterval(this.pump);
    this.pump = null;
    // A client-initiated close is not a disconnect (as with WebTransport).
    console.info(`[in-process] session closed: ${reason}`);
    this.link.close();
  }
}
