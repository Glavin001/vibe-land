/**
 * City wire 4's upstream ack (perplayer/src/wire.rs `encode_ack`): the newest
 * keyframe-datagram ordinal received and a mask of the 64 before it (bit i:
 * `newest - 1 - i` arrived), then, when given, the first events sequence not
 * yet received (the event ack). Layout: u8 kind 135, u32 newest LE, u64 mask
 * LE[, u32 events through LE[, u8 n, then n (u32 structure, u32 body) LE:
 * bodies whose delta records could not be decoded, resent absolute]].
 */
import { PKT_PP_ACK } from './perPlayerCityClient';

export function encodePerPlayerAck(newest: number, maskLo: number, maskHi: number, eventsThrough?: number, missing?: ArrayLike<number>): Uint8Array {
  const pairs = eventsThrough === undefined ? 0 : Math.min(255, Math.floor((missing?.length ?? 0) / 2));
  const bytes = new Uint8Array(eventsThrough === undefined ? 13 : pairs > 0 ? 18 + pairs * 8 : 17);
  const view = new DataView(bytes.buffer);
  bytes[0] = PKT_PP_ACK;
  view.setUint32(1, newest >>> 0, true);
  view.setUint32(5, maskLo >>> 0, true);
  view.setUint32(9, maskHi >>> 0, true);
  if (eventsThrough !== undefined) view.setUint32(13, eventsThrough >>> 0, true);
  if (pairs > 0) {
    bytes[17] = pairs;
    for (let i = 0; i < pairs; i += 1) {
      view.setUint32(18 + i * 8, missing![i * 2] >>> 0, true);
      view.setUint32(22 + i * 8, missing![i * 2 + 1] >>> 0, true);
    }
  }
  return bytes;
}
