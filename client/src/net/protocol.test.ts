import { describe, it, expect } from 'vitest';
import {
  encodeInputBundle,
  encodeFirePacket,
  encodeMeleePacket,
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
  type MeleeCmd,
  PKT_MELEE,
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_JUMP,
  BTN_SPRINT,
  PKT_SNAPSHOT,
  PKT_SNAPSHOT_V2,
  PKT_WELCOME,
  PKT_SHOT_FIRED,
  PKT_SHOT_RESULT,
  PKT_PLAYER_ROSTER,
  PKT_DYNAMIC_BODY_META,
  PKT_LOCAL_PLAYER_ENERGY,
  PKT_BATTERY_SYNC,
  PKT_PING,
  PKT_PONG,
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
      clientDynamicInterpMs: 5,
      dir: [0, 0, 1],
    };
    const encoded = encodeFirePacket(fire);
    const view = new DataView(encoded.buffer);
    expect(encoded.length).toBe(26);
    expect(view.getUint16(1, true)).toBe(9);
    expect(view.getUint32(3, true)).toBe(1234);
    expect(view.getUint8(7)).toBe(1);
    expect(view.getUint32(8, true)).toBe(9_876_543);
    expect(view.getUint16(16, true)).toBe(66);
  });
});

describe('encodeMeleePacket', () => {
  it('encodes swing id, timing, and yaw/pitch with round-trip precision', () => {
    const cmd: MeleeCmd = {
      seq: 0x1234,
      swingId: 0xabcdef01,
      clientTimeUs: 123_456_789,
      yaw: 0.75,
      pitch: -0.25,
    };
    const encoded = encodeMeleePacket(cmd);
    const view = new DataView(encoded.buffer);
    expect(encoded.length).toBe(1 + 2 + 4 + 8 + 2 + 2);
    expect(view.getUint8(0)).toBe(PKT_MELEE);
    expect(view.getUint16(1, true)).toBe(0x1234);
    expect(view.getUint32(3, true)).toBe(0xabcdef01);
    // clientTimeUs u64 LE
    const lo = view.getUint32(7, true);
    const hi = view.getUint32(11, true);
    expect(lo + hi * 0x100000000).toBe(123_456_789);
    // yaw / pitch round-trip via angleToI16 / i16ToAngle (yaw wraps to [0,2π))
    const yawOut = i16ToAngle(view.getInt16(15, true));
    expect(yawOut).toBeCloseTo(0.75, 2);
    const pitchOut = i16ToAngle(view.getInt16(17, true));
    // -0.25 wraps to 2π - 0.25 when roundtripped through angleToI16's unsigned form
    const expected = pitchOut > Math.PI ? pitchOut - 2 * Math.PI : pitchOut;
    expect(expected).toBeCloseTo(-0.25, 2);
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

function buildSnapshotV2Binary(): Uint8Array {
  const size = 1 + 4 + 2 + 4 + 4 + 4 + 1 + 1 + 1 + 1 + 12 + 19 + 20 + 30;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  view.setUint8(o++, PKT_SNAPSHOT_V2);
  view.setUint32(o, 25, true); o += 4;
  view.setUint16(o, 9, true); o += 2;
  view.setInt32(o, 10_000, true); o += 4;
  view.setInt32(o, 2_000, true); o += 4;
  view.setInt32(o, -4_000, true); o += 4;
  view.setUint8(o++, 1);
  view.setUint8(o++, 1);
  view.setUint8(o++, 0);
  view.setUint8(o++, 1);

  view.setInt16(o, 100, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setUint8(o++, 100);
  view.setUint8(o++, 1);

  view.setUint8(o++, 2);
  view.setInt16(o, 2000, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 400, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 200, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setUint8(o++, 80);
  view.setUint8(o++, 1);

  view.setUint16(o, 7, true); o += 2;
  view.setInt16(o, 1200, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, -800, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 100, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 250, true); o += 2;

  view.setUint8(o++, 3);
  view.setUint8(o++, 0);
  view.setUint8(o++, 2);
  view.setUint8(o++, 0);
  view.setInt16(o, 3200, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 32767, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;
  view.setInt16(o, 0, true); o += 2;

  return buf;
}

describe('snapshot V2 decode', () => {
  it('decodes relative V2 snapshot sections', () => {
    const packet = decodeServerDatagramPacket(buildSnapshotV2Binary());
    expect(packet.type).toBe('snapshotV2');
    expect(packet.serverTick).toBe(25);
    expect(packet.ackInputSeq).toBe(9);
    expect(packet.anchorPxMm).toBe(10_000);
    expect(packet.remotePlayers).toHaveLength(1);
    expect(packet.remotePlayers[0].handle).toBe(2);
    expect(packet.sphereStates).toHaveLength(1);
    expect(packet.sphereStates[0].handle).toBe(7);
    expect(packet.vehicleStates).toHaveLength(1);
    expect(packet.vehicleStates[0].handle).toBe(3);
    expect(packet.vehicleStates[0].driverHandle).toBe(2);
  });
});

function buildPlayerRosterBinary(): Uint8Array {
  const username = 'alice';
  const nameBytes = new TextEncoder().encode(username);
  const size = 1 + 1 + 1 + 4 + 1 + nameBytes.length + 2 + 2;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;
  view.setUint8(o++, PKT_PLAYER_ROSTER);
  view.setUint8(o++, 1);
  view.setUint8(o++, 7);
  view.setUint32(o, 44, true); o += 4;
  view.setUint8(o++, nameBytes.length);
  buf.set(nameBytes, o); o += nameBytes.length;
  view.setUint16(o, 3, true); o += 2;
  view.setUint16(o, 1, true); o += 2;
  return buf;
}

function buildDynamicBodyMetaBinary(): Uint8Array {
  const size = 1 + 2 + 13;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;
  view.setUint8(o++, PKT_DYNAMIC_BODY_META);
  view.setUint16(o, 1, true); o += 2;
  view.setUint16(o, 7, true); o += 2;
  view.setUint32(o, 7001, true); o += 4;
  view.setUint8(o++, 1);
  view.setUint16(o, 30, true); o += 2;
  view.setUint16(o, 30, true); o += 2;
  view.setUint16(o, 30, true); o += 2;
  return buf;
}

describe('V2 metadata decode', () => {
  it('decodes player roster packets', () => {
    const packet = decodeServerReliablePacket(buildPlayerRosterBinary());
    expect(packet.type).toBe('playerRoster');
    expect(packet.entries).toEqual([
      { handle: 7, playerId: 44, username: 'alice', kills: 3, deaths: 1 },
    ]);
  });

  it('decodes dynamic body metadata with canonical body ids', () => {
    const packet = decodeServerReliablePacket(buildDynamicBodyMetaBinary());
    expect(packet.type).toBe('dynamicBodyMeta');
    expect(packet.entries).toEqual([
      {
        handle: 7,
        bodyId: 7001,
        shapeType: 1,
        halfExtents: [0.3, 0.3, 0.3],
      },
    ]);
  });
});

function buildLocalPlayerEnergyBinary(energyCenti = 12345): Uint8Array {
  const buf = new Uint8Array(1 + 4);
  const view = new DataView(buf.buffer);
  view.setUint8(0, PKT_LOCAL_PLAYER_ENERGY);
  view.setUint32(1, energyCenti, true);
  return buf;
}

function buildBatterySyncBinary(): Uint8Array {
  const buf = new Uint8Array(1 + 1 + 2 + 2 + 24 + 4);
  const view = new DataView(buf.buffer);
  let o = 0;
  view.setUint8(o++, PKT_BATTERY_SYNC);
  view.setUint8(o++, 1);
  view.setUint16(o, 1, true); o += 2;
  view.setUint16(o, 1, true); o += 2;
  view.setUint32(o, 77, true); o += 4;
  view.setInt32(o, 1500, true); o += 4;
  view.setInt32(o, 250, true); o += 4;
  view.setInt32(o, -2000, true); o += 4;
  view.setUint32(o, 4321, true); o += 4;
  view.setUint16(o, 60, true); o += 2;
  view.setUint16(o, 140, true); o += 2;
  view.setUint32(o, 88, true);
  return buf;
}

describe('energy and battery reliable decode', () => {
  it('decodes owner-only local energy packets', () => {
    const packet = decodeServerReliablePacket(buildLocalPlayerEnergyBinary(54321));
    expect(packet).toEqual({ type: 'localPlayerEnergy', energyCenti: 54321 });
  });

  it('decodes battery sync packets with state and removals', () => {
    const packet = decodeServerReliablePacket(buildBatterySyncBinary());
    expect(packet.type).toBe('batterySync');
    if (packet.type === 'batterySync') {
      expect(packet.fullResync).toBe(true);
      expect(packet.batteryStates).toEqual([
        {
          id: 77,
          pxMm: 1500,
          pyMm: 250,
          pzMm: -2000,
          energyCenti: 4321,
          radiusCm: 60,
          heightCm: 140,
        },
      ]);
      expect(packet.removedIds).toEqual([88]);
    }
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
  kills?: number;
  deaths?: number;
}): Uint8Array {
  const size = 1 + 4 + 2 + 2 + 8 + 2 + 2 + 2;
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
  view.setUint16(o, opts.interpolationDelayMs ?? 66, true); o += 2;
  view.setUint16(o, opts.kills ?? 0, true); o += 2;
  view.setUint16(o, opts.deaths ?? 0, true);

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
  serverResolution?: number;
  serverDynamicBodyId?: number;
  serverDynamicHitToiCm?: number;
  serverDynamicImpulseCenti?: number;
}): Uint8Array {
  const size = 1 + 4 + 1 + 1 + 4 + 1 + 1 + 4 + 2 + 2;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  view.setUint8(o++, PKT_SHOT_RESULT);
  view.setUint32(o, opts.shotId ?? 1, true); o += 4;
  view.setUint8(o++, opts.weapon ?? 1);
  view.setUint8(o++, (opts.confirmed ?? true) ? 1 : 0);
  view.setUint32(o, opts.hitPlayerId ?? 2, true); o += 4;
  view.setUint8(o++, opts.hitZone ?? 1);
  view.setUint8(o++, opts.serverResolution ?? 0);
  view.setUint32(o, opts.serverDynamicBodyId ?? 0, true); o += 4;
  view.setUint16(o, opts.serverDynamicHitToiCm ?? 0, true); o += 2;
  view.setUint16(o, opts.serverDynamicImpulseCenti ?? 0, true);

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

function buildShotFiredBinary(opts: {
  shooterPlayerId?: number;
  shotId?: number;
  weapon?: number;
  hitKind?: number;
  hitZone?: number;
  serverFireTimeUs?: number;
  originPxMm?: number;
  originPyMm?: number;
  originPzMm?: number;
  endPxMm?: number;
  endPyMm?: number;
  endPzMm?: number;
}): Uint8Array {
  const size = 1 + 4 + 4 + 1 + 1 + 1 + 8 + 12 + 12;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;

  view.setUint8(o++, PKT_SHOT_FIRED);
  view.setUint32(o, opts.shooterPlayerId ?? 10, true); o += 4;
  view.setUint32(o, opts.shotId ?? 7, true); o += 4;
  view.setUint8(o++, opts.weapon ?? 1);
  view.setUint8(o++, opts.hitKind ?? 1);
  view.setUint8(o++, opts.hitZone ?? 2);
  view.setBigUint64(o, BigInt(opts.serverFireTimeUs ?? 0), true); o += 8;
  view.setInt32(o, opts.originPxMm ?? 100, true); o += 4;
  view.setInt32(o, opts.originPyMm ?? 200, true); o += 4;
  view.setInt32(o, opts.originPzMm ?? 300, true); o += 4;
  view.setInt32(o, opts.endPxMm ?? 400, true); o += 4;
  view.setInt32(o, opts.endPyMm ?? 500, true); o += 4;
  view.setInt32(o, opts.endPzMm ?? 600, true);

  return buf;
}

describe('shotFired packet decode', () => {
  it('decodes broadcast shot-fired packets', () => {
    const binary = buildShotFiredBinary({
      shooterPlayerId: 42,
      shotId: 99,
      weapon: 1,
      hitKind: 1,
      hitZone: 2,
      serverFireTimeUs: 1_234_567_890,
      originPxMm: 1500,
      originPyMm: 2000,
      originPzMm: -3000,
      endPxMm: 4500,
      endPyMm: 2100,
      endPzMm: -3050,
    });
    const packet = decodeServerReliablePacket(binary);

    expect(packet.type).toBe('shotFired');
    if (packet.type === 'shotFired') {
      expect(packet.shooterPlayerId).toBe(42);
      expect(packet.shotId).toBe(99);
      expect(packet.weapon).toBe(1);
      expect(packet.hitKind).toBe(1);
      expect(packet.hitZone).toBe(2);
      expect(packet.serverFireTimeUs).toBe(1_234_567_890);
      expect(packet.originPxMm).toBe(1500);
      expect(packet.endPzMm).toBe(-3050);
    }
  });

  it('dispatches shot-fired packets through decodeServerPacket', () => {
    const binary = buildShotFiredBinary({});
    const packet = decodeServerPacket(binary);
    expect(packet.type).toBe('shotFired');
  });
});

describe('reliable ping/pong decode', () => {
  it('decodes server ping packets on the reliable path', () => {
    const binary = new Uint8Array(5);
    const view = new DataView(binary.buffer);
    view.setUint8(0, PKT_PING);
    view.setUint32(1, 0xdeadbeef, true);

    const packet = decodeServerReliablePacket(binary);
    expect(packet).toEqual({ type: 'serverPing', value: 0xdeadbeef });
  });

  it('decodes pong packets on the reliable path', () => {
    const binary = new Uint8Array(5);
    const view = new DataView(binary.buffer);
    view.setUint8(0, PKT_PONG);
    view.setUint32(1, 0x12345678, true);

    const packet = decodeServerReliablePacket(binary);
    expect(packet).toEqual({ type: 'pong', value: 0x12345678 });
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

  it('dispatches local energy and battery sync packets', () => {
    expect(decodeServerPacket(buildLocalPlayerEnergyBinary()).type).toBe('localPlayerEnergy');
    expect(decodeServerPacket(buildBatterySyncBinary()).type).toBe('batterySync');
  });

  it('throws on unknown packet kind', () => {
    const buf = new Uint8Array([255]);
    expect(() => decodeServerPacket(buf)).toThrow('unknown server packet kind');
  });
});
