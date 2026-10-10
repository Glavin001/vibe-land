/**
 * City wire 4's upstream ack (perplayer/src/wire.rs `encode_ack`): the newest
 * keyframe-datagram ordinal received and a mask of the 64 before it (bit i:
 * `newest - 1 - i` arrived), then, when given, the first events sequence not
 * yet received (the event ack). Layout: u8 kind 135, u32 newest LE, u64 mask
 * LE[, u32 events through LE].
 */
import { PKT_PP_ACK } from './perPlayerCityClient';

export function encodePerPlayerAck(newest: number, maskLo: number, maskHi: number, eventsThrough?: number): Uint8Array {
  const bytes = new Uint8Array(eventsThrough === undefined ? 13 : 17);
  const view = new DataView(bytes.buffer);
  bytes[0] = PKT_PP_ACK;
  view.setUint32(1, newest >>> 0, true);
  view.setUint32(5, maskLo >>> 0, true);
  view.setUint32(9, maskHi >>> 0, true);
  if (eventsThrough !== undefined) view.setUint32(13, eventsThrough >>> 0, true);
  return bytes;
}
