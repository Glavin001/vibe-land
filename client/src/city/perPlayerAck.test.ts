import { describe, expect, it } from 'vitest';
import { encodePerPlayerAck } from './perPlayerAck';

describe('encodePerPlayerAck', () => {
  // Pinned against vibe_land_perplayer::wire::encode_ack(0x0102_0304,
  // 0x8000_0000_0000_0005), which server/src/protocol.rs's
  // per_player_ack_decodes_on_both_paths decodes.
  it('matches the Rust layout byte for byte', () => {
    expect(Array.from(encodePerPlayerAck(0x0102_0304, 0x0000_0005, 0x8000_0000))).toEqual([
      135, 0x04, 0x03, 0x02, 0x01, 0x05, 0, 0, 0, 0, 0, 0, 0x80,
    ]);
  });

  // encode_ack(.., Some(42)): the event ack appended as a u32.
  it('appends the event ack when given', () => {
    expect(Array.from(encodePerPlayerAck(0x0102_0304, 0x0000_0005, 0x8000_0000, 42)).slice(13)).toEqual([42, 0, 0, 0]);
  });

  // encode_ack_missing(.., 42, [(0x8003, 0xFFFF)]): then the bodies whose
  // records could not be decoded, as decode_ack_missing reads them.
  it('names the bodies it could not decode', () => {
    expect(Array.from(encodePerPlayerAck(5, 0, 0, 42, [0x8003, 0xffff])).slice(13)).toEqual([
      42, 0, 0, 0, 1, 0x03, 0x80, 0, 0, 0xff, 0xff, 0, 0,
    ]);
    expect(encodePerPlayerAck(5, 0, 0, 42, []).length).toBe(17);
  });
});
