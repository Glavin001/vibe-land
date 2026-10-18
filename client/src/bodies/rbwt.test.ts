import { describe, expect, it } from 'vitest';

import { fnv1a, RbwtState } from './rbwt';
import { loadBodyLabConfig } from './transports';

function packet(frame: number, sequence: number, x: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x42, 0x57, 0x54, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, 1, true);
  view.setBigUint64(8, BigInt(sequence), true);
  view.setUint32(16, frame, true);
  view.setUint16(20, 0, true);
  view.setUint16(22, 1, true);
  view.setBigUint64(24, 1_000_000n, true);
  view.setUint32(32, 0, true);
  view.setFloat32(36, x, true);
  view.setFloat32(40, 2, true);
  view.setFloat32(44, 3, true);
  view.setInt16(54, 32767, true);
  return bytes;
}

describe('RBWT state', () => {
  it('decodes a body and ignores an older frame', () => {
    const state = new RbwtState(1);
    expect(state.apply(packet(10, 10, 4))).not.toBeNull();
    expect(state.positions[0]).toBe(4);
    expect(state.visibleBodies).toBe(1);
    expect(state.latestFrame).toBe(10);

    state.apply(packet(9, 9, 99));
    expect(state.positions[0]).toBe(4);
    expect(state.bodyUpdates).toBe(1);
    expect(state.reorderedPackets).toBe(1);
  });

  it('records stable batch-zero hashes for fan-out comparison', () => {
    const bytes = packet(12, 12, 7);
    const state = new RbwtState(1);
    state.apply(bytes, 2_000_000);
    expect(state.traces).toEqual([expect.objectContaining({
      frame: 12,
      packet: 12,
      hash: fnv1a(bytes),
      receivedAtUs: 2_000_000,
    })]);
  });
});

describe('body lab config', () => {
  it('loads direct and MoQ controls from query parameters', () => {
    const config = loadBodyLabConfig(
      '?transport=moq&bodies=10000&hz=60&duration=30&mbps=10&shards=8'
      + '&relay=https://relay.example&token=secret&ns=game/bodies&motion=formation&autostart=1',
    );
    expect(config).toMatchObject({
      transport: 'moq',
      bodies: 10_000,
      hz: 60,
      duration: 30,
      mbps: 10,
      shards: 8,
      relay: 'https://relay.example',
      token: 'secret',
      namespace: 'game/bodies',
      motion: 'formation',
      autostart: true,
    });
  });
});
