// Where an inbound server packet came from, and how the client reads it.
//
// Every byte the server sends reaches the client on one of three channels:
// the WebTransport control stream, WebTransport datagrams, or the WebSocket
// fallback. The transports route each one the same way -- city kinds go to
// the city client untouched, the rest are decoded as game packets for the
// netcode client -- and a city tape records them per channel so /cityreplay
// can route and decode them the same way again, with this same code.

import {
  decodeServerDatagramPacket,
  decodeServerPacket,
  decodeServerReliablePacket,
  type ServerPacket,
} from './protocol';
import { PKT_PING } from './sharedConstants';
import { isCityPacketKind } from '../city/wire';

export type InboundChannel = 'wt-reliable' | 'wt-datagram' | 'websocket';

/** Called by a transport for every packet it receives, before routing. */
export type RawPacketListener = (bytes: Uint8Array, channel: InboundChannel) => void;

export type InboundRoute =
  | { route: 'city' }
  /** WebTransport latency probe; the transport answers it and nothing else reads it. */
  | { route: 'ping' }
  | { route: 'game'; packet: ServerPacket };

/**
 * How the live transports route one packet: city stream, a WebTransport ping,
 * or a game packet decoded with that channel's decoder (reliable-stream
 * packets, datagrams, or the WebSocket's single mixed stream).
 */
export function routeInboundPacket(bytes: Uint8Array, channel: InboundChannel): InboundRoute {
  if (bytes.length > 0 && isCityPacketKind(bytes[0])) return { route: 'city' };
  if (channel === 'wt-datagram' && bytes[0] === PKT_PING && bytes.length >= 5) return { route: 'ping' };
  return { route: 'game', packet: decodeInboundGamePacket(bytes, channel) };
}

export function decodeInboundGamePacket(bytes: Uint8Array, channel: InboundChannel): ServerPacket {
  switch (channel) {
    case 'wt-reliable':
      return decodeServerReliablePacket(bytes) as ServerPacket;
    case 'wt-datagram':
      return decodeServerDatagramPacket(bytes) as ServerPacket;
    case 'websocket':
      return decodeServerPacket(bytes);
  }
}
