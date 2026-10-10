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
});
