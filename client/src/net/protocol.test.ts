import { describe, it, expect } from 'vitest';
import {
  encodeInputBundle,
  encodeFirePacket,
  decodeServerPacket,
  decodeServerDatagramPacket,
  decodeServerReliablePacket,
  metersToMm,
  mmToMeters,
  angleToI16,
  i16ToAngle,
  f32ToSnorm16,
  snorm16ToF32,
  clampI8,
  buildInputFrame,
  encodeBlockEditPacket,
  type InputFrame,
  type NetPlayerState,
  type FireCmd,
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_JUMP,
  BTN_SPRINT,
  PKT_SNAPSHOT,
  PKT_WELCOME,
  PKT_SHOT_RESULT,
} from './protocol';

// ──────────────────────────────────────────────
// Unit conversions
// ──────────────────────────────────────────────

describe('unit conversions', () => {
  describe('metersToMm / mmToMeters', () => {
    it('round-trips correctly for positive values', () => {
      expect(mmToMeters(metersToMm(5.123))).toBeCloseTo(5.123, 3);
    });

    it('round-trips correctly for negative values', () => {
      expect(mmToMeters(metersToMm(-3.456))).toBeCloseTo(-3.456, 3);
    });

    it('round-trips zero', () => {
      expect(mmToMeters(metersToMm(0))).toBe(0);
    });

    it('handles large values', () => {
      const val = 2_000_000; // 2 million meters
      expect(mmToMeters(metersToMm(val))).toBeCloseTo(val, 0);
    });
  });

  describe('angleToI16 / i16ToAngle', () => {
    it('round-trips 0 radians', () => {
      expect(i16ToAngle(angleToI16(0))).toBeCloseTo(0, 3);
    });

    it('round-trips PI/2', () => {
      const result = i16ToAngle(angleToI16(Math.PI / 2));
      expect(result).toBeCloseTo(Math.PI / 2, 2);
    });

    it('round-trips PI', () => {
      const result = i16ToAngle(angleToI16(Math.PI));
      expect(result).toBeCloseTo(Math.PI, 2);
    });

    it('wraps negative angles to [0, 2PI)', () => {
      const result = i16ToAngle(angleToI16(-Math.PI / 4));
      // -PI/4 wraps to 7PI/4
      expect(result).toBeCloseTo(7 * Math.PI / 4, 2);
    });

    it('wraps angles > 2PI', () => {
      const result = i16ToAngle(angleToI16(3 * Math.PI));
      // 3PI wraps to PI
      expect(result).toBeCloseTo(Math.PI, 2);
    });
  });

  describe('f32ToSnorm16 / snorm16ToF32', () => {
    it('round-trips 0', () => {
      expect(snorm16ToF32(f32ToSnorm16(0))).toBeCloseTo(0, 3);
    });

    it('round-trips 1', () => {
      expect(snorm16ToF32(f32ToSnorm16(1))).toBeCloseTo(1, 3);
    });

    it('round-trips -1', () => {
      expect(snorm16ToF32(f32ToSnorm16(-1))).toBeCloseTo(-1, 3);
    });

    it('clamps values > 1', () => {
      expect(f32ToSnorm16(1.5)).toBe(32767);
    });

    it('clamps values < -1', () => {
      expect(f32ToSnorm16(-1.5)).toBe(-32767);
    });
  });

  describe('clampI8', () => {
    it('clamps to -127', () => {
      expect(clampI8(-200)).toBe(-127);
    });

    it('clamps to 127', () => {
      expect(clampI8(200)).toBe(127);
    });

    it('rounds fractional values', () => {
      expect(clampI8(3.7)).toBe(4);
    });

    it('passes through values in range', () => {
      expect(clampI8(50)).toBe(50);
    });
  });
});

// ──────────────────────────────────────────────
// buildInputFrame
// ──────────────────────────────────────────────

describe('buildInputFrame', () => {
  it('converts forward button to moveY=127', () => {
    const frame = buildInputFrame(1, BTN_FORWARD, 0, 0);
    expect(frame.moveY).toBe(127);
    expect(frame.moveX).toBe(0);
  });

  it('converts back button to moveY=-127', () => {
    const frame = buildInputFrame(1, BTN_BACK, 0, 0);
    expect(frame.moveY).toBe(-127);
  });

  it('converts left button to moveX=-127', () => {
    const frame = buildInputFrame(1, BTN_LEFT, 0, 0);
    expect(frame.moveX).toBe(-127);
  });

  it('converts right button to moveX=127', () => {
    const frame = buildInputFrame(1, BTN_RIGHT, 0, 0);
    expect(frame.moveX).toBe(127);
  });

  it('forward+right gives moveY=127 moveX=127', () => {
    const frame = buildInputFrame(1, BTN_FORWARD | BTN_RIGHT, 0, 0);
    expect(frame.moveY).toBe(127);
    expect(frame.moveX).toBe(127);
  });

  it('forward+back cancel to moveY=0', () => {
    const frame = buildInputFrame(1, BTN_FORWARD | BTN_BACK, 0, 0);
    expect(frame.moveY).toBe(0);
  });

  it('preserves sequence number with u16 mask', () => {
    const frame = buildInputFrame(0x10001, 0, 0, 0);
    expect(frame.seq).toBe(1); // masked to 16-bit
  });

  it('preserves yaw and pitch', () => {
    const frame = buildInputFrame(1, 0, 1.5, -0.3);
    expect(frame.yaw).toBe(1.5);
    expect(frame.pitch).toBe(-0.3);
  });
});

// ──────────────────────────────────────────────
// InputBundle encode/decode round-trip
// ──────────────────────────────────────────────

describe('encodeInputBundle', () => {
  it('throws on empty bundle', () => {
    expect(() => encodeInputBundle([])).toThrow('input bundle cannot be empty');
  });

  it('throws on bundle > 255 frames', () => {
    const frames: InputFrame[] = Array.from({ length: 256 }, (_, i) => ({
      seq: i, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0,
    }));
    expect(() => encodeInputBundle(frames)).toThrow('input bundle too large');
  });

  it('encodes single frame', () => {
    const frame: InputFrame = {
      seq: 42, buttons: BTN_FORWARD | BTN_JUMP, moveX: 0, moveY: 127,
      yaw: 1.0, pitch: -0.5,
    };
    const encoded = encodeInputBundle([frame]);
    expect(encoded.length).toBe(1 + 1 + 10); // type + count + frame
  });

  it('encodes max 255 frames', () => {
    const frames: InputFrame[] = Array.from({ length: 255 }, (_, i) => ({
      seq: i, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0,
    }));
    const encoded = encodeInputBundle(frames);
    expect(encoded.length).toBe(1 + 1 + 255 * 10);
  });
});

describe('encodeFirePacket', () => {
  it('encodes fire timing and direction', () => {
    const fire: FireCmd = {
      seq: 9,
      shotId: 1234,
      weapon: 1,
      clientFireTimeUs: 9_876_543,
      clientInterpMs: 66,
      dir: [0, 0, 1],
    };
    const encoded = encodeFirePacket(fire);
    const view = new DataView(encoded.buffer);
    expect(encoded.length).toBe(24);
    expect(view.getUint16(1, true)).toBe(9);
    expect(view.getUint32(3, true)).toBe(1234);
    expect(view.getUint8(7)).toBe(1);
    expect(view.getUint32(8, true)).toBe(9_876_543);
    expect(view.getUint16(16, true)).toBe(66);
  });
});

// ──────────────────────────────────────────────
// Snapshot encoding helpers (build binary manually)
// ──────────────────────────────────────────────

function buildSnapshotBinary(opts: {
  serverTimeUs?: number;
  serverTick?: number;
  ackInputSeq?: number;
  players?: NetPlayerState[];
}): Uint8Array {
  const players = opts.players ?? [];
  const size = 1 + 8 + 4 + 2 + 2 + 2 + 2 + 2 + players.length * 29;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  view.setUint8(o++, PKT_SNAPSHOT);

  // serverTimeUs as u64 LE
  const timeUs = opts.serverTimeUs ?? 1_000_000;
  view.setUint32(o, timeUs & 0xffffffff, true);
  view.setUint32(o + 4, Math.floor(timeUs / 0x100000000), true);
  o += 8;

  view.setUint32(o, opts.serverTick ?? 1, true); o += 4;
  view.setUint16(o, opts.ackInputSeq ?? 0, true); o += 2;
  view.setUint16(o, players.length, true); o += 2;
  view.setUint16(o, 0, true); o += 2; // projectile count
  view.setUint16(o, 0, true); o += 2; // dynamic body count
  view.setUint16(o, 0, true); o += 2; // vehicle count

  for (const p of players) {
    view.setUint32(o, p.id, true); o += 4;
    view.setInt32(o, p.pxMm, true); o += 4;
    view.setInt32(o, p.pyMm, true); o += 4;
    view.setInt32(o, p.pzMm, true); o += 4;
    view.setInt16(o, p.vxCms, true); o += 2;
    view.setInt16(o, p.vyCms, true); o += 2;
    view.setInt16(o, p.vzCms, true); o += 2;
    view.setInt16(o, p.yawI16, true); o += 2;
    view.setInt16(o, p.pitchI16, true); o += 2;
    view.setUint8(o, p.hp); o += 1;
    view.setUint16(o, p.flags, true); o += 2;
  }

  return buf;
}

describe('snapshot decode', () => {
  it('decodes empty snapshot (no players)', () => {
    const binary = buildSnapshotBinary({ players: [] });
    const packet = decodeServerDatagramPacket(binary);
    expect(packet.type).toBe('snapshot');
    expect(packet.playerStates).toHaveLength(0);
  });

  it('decodes snapshot with multiple players', () => {
    const players: NetPlayerState[] = [
      { id: 1, pxMm: 5000, pyMm: 1000, pzMm: 3000, vxCms: 100, vyCms: 0, vzCms: 200, yawI16: 1000, pitchI16: -500, hp: 90, flags: 1 },
      { id: 2, pxMm: -5000, pyMm: 2000, pzMm: -3000, vxCms: -100, vyCms: 50, vzCms: -200, yawI16: -1000, pitchI16: 500, hp: 55, flags: 0 },
    ];
    const binary = buildSnapshotBinary({
      serverTick: 42,
      ackInputSeq: 100,
      players,
    });
    const packet = decodeServerDatagramPacket(binary);

    expect(packet.type).toBe('snapshot');
    expect(packet.serverTick).toBe(42);
    expect(packet.ackInputSeq).toBe(100);
    expect(packet.playerStates).toHaveLength(2);
    expect(packet.playerStates[0].id).toBe(1);
    expect(packet.playerStates[0].pxMm).toBe(5000);
    expect(packet.playerStates[0].hp).toBe(90);
    expect(packet.playerStates[1].id).toBe(2);
    expect(packet.playerStates[1].pxMm).toBe(-5000);
  });

  it('preserves position precision (millimeters)', () => {
    const player: NetPlayerState = {
      id: 1, pxMm: 12345, pyMm: -6789, pzMm: 1, vxCms: 0, vyCms: 0, vzCms: 0,
      yawI16: 0, pitchI16: 0, hp: 77, flags: 0,
    };
    const binary = buildSnapshotBinary({ players: [player] });
    const packet = decodeServerDatagramPacket(binary);

    expect(packet.playerStates[0].pxMm).toBe(12345);
    expect(packet.playerStates[0].pyMm).toBe(-6789);
    expect(packet.playerStates[0].pzMm).toBe(1);
    expect(packet.playerStates[0].hp).toBe(77);
  });
});

// ──────────────────────────────────────────────
// Welcome packet decode
// ──────────────────────────────────────────────

function buildWelcomeBinary(opts: {
  playerId?: number;
  simHz?: number;
  snapshotHz?: number;
  serverTimeUs?: number;
  interpolationDelayMs?: number;
}): Uint8Array {
  const size = 1 + 4 + 2 + 2 + 8 + 2;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  view.setUint8(o++, PKT_WELCOME);
  view.setUint32(o, opts.playerId ?? 1, true); o += 4;
  view.setUint16(o, opts.simHz ?? 60, true); o += 2;
  view.setUint16(o, opts.snapshotHz ?? 30, true); o += 2;
  const timeUs = opts.serverTimeUs ?? 1_000_000;
  view.setUint32(o, timeUs & 0xffffffff, true);
  view.setUint32(o + 4, Math.floor(timeUs / 0x100000000), true);
  o += 8;
  view.setUint16(o, opts.interpolationDelayMs ?? 66, true);

  return buf;
}

describe('welcome packet decode', () => {
  it('decodes all fields correctly', () => {
    const binary = buildWelcomeBinary({
      playerId: 42,
      simHz: 60,
      snapshotHz: 30,
      serverTimeUs: 5_000_000,
      interpolationDelayMs: 100,
    });
    const packet = decodeServerReliablePacket(binary);

    expect(packet.type).toBe('welcome');
    if (packet.type === 'welcome') {
      expect(packet.playerId).toBe(42);
      expect(packet.simHz).toBe(60);
      expect(packet.snapshotHz).toBe(30);
      expect(packet.serverTimeUs).toBe(5_000_000);
      expect(packet.interpolationDelayMs).toBe(100);
    }
  });
});

// ──────────────────────────────────────────────
// ShotResult packet decode
// ──────────────────────────────────────────────

function buildShotResultBinary(opts: {
  shotId?: number;
  weapon?: number;
  confirmed?: boolean;
  hitPlayerId?: number;
  hitZone?: number;
}): Uint8Array {
  const size = 1 + 4 + 1 + 1 + 4 + 1;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  view.setUint8(o++, PKT_SHOT_RESULT);
  view.setUint32(o, opts.shotId ?? 1, true); o += 4;
  view.setUint8(o++, opts.weapon ?? 1);
  view.setUint8(o++, (opts.confirmed ?? true) ? 1 : 0);
  view.setUint32(o, opts.hitPlayerId ?? 2, true); o += 4;
  view.setUint8(o++, opts.hitZone ?? 1);

  return buf;
}

describe('shotResult packet decode', () => {
  it('decodes confirmed hit', () => {
    const binary = buildShotResultBinary({
      shotId: 123,
      weapon: 1,
      confirmed: true,
      hitPlayerId: 5,
    });
    const packet = decodeServerReliablePacket(binary);

    expect(packet.type).toBe('shotResult');
    if (packet.type === 'shotResult') {
      expect(packet.shotId).toBe(123);
      expect(packet.weapon).toBe(1);
      expect(packet.confirmed).toBe(true);
      expect(packet.hitPlayerId).toBe(5);
      expect(packet.hitZone).toBe(1);
    }
  });

  it('decodes unconfirmed hit', () => {
    const binary = buildShotResultBinary({ confirmed: false, hitZone: 0 });
    const packet = decodeServerReliablePacket(binary);
    if (packet.type === 'shotResult') {
      expect(packet.confirmed).toBe(false);
      expect(packet.hitZone).toBe(0);
    }
  });

  it('decodes authoritative headshot zone', () => {
    const binary = buildShotResultBinary({ confirmed: true, hitZone: 2 });
    const packet = decodeServerReliablePacket(binary);
    if (packet.type === 'shotResult') {
      expect(packet.hitZone).toBe(2);
    }
  });
});

// ──────────────────────────────────────────────
// decodeServerPacket (unified entry point)
// ──────────────────────────────────────────────

describe('decodeServerPacket', () => {
  it('dispatches welcome packets', () => {
    const binary = buildWelcomeBinary({});
    const packet = decodeServerPacket(binary);
    expect(packet.type).toBe('welcome');
  });

  it('dispatches snapshot packets', () => {
    const binary = buildSnapshotBinary({});
    const packet = decodeServerPacket(binary);
    expect(packet.type).toBe('snapshot');
  });

  it('dispatches shotResult packets', () => {
    const binary = buildShotResultBinary({});
    const packet = decodeServerPacket(binary);
    expect(packet.type).toBe('shotResult');
  });

  it('throws on unknown packet kind', () => {
    const buf = new Uint8Array([255]);
    expect(() => decodeServerPacket(buf)).toThrow('unknown server packet kind');
  });
});
