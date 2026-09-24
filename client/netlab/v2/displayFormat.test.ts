import { describe, expect, it } from 'vitest';

import {
  decodeDisplay,
  encodeDisplayFrame,
  encodeDisplayHeader,
  ENTITY_BYTES,
  eventOrder,
  FRAME_HEADER_BYTES,
  frameSchedule,
  KIND_BODY,
} from './displayFormat';

describe('VLDISP01', () => {
  it('round-trips frames byte for byte (the Rust scorer reads this layout)', () => {
    const header = encodeDisplayHeader({ clockOriginMs: 5 });
    const frame = encodeDisplayFrame({
      tMs: 10.5,
      sampleMs: 8,
      offsetUs: -3,
      interpDelayMs: 50,
      dynDelayMs: 40,
      renderUs: 1000,
      dynRenderUs: 900,
      entities: [{ kind: KIND_BODY, flags: 1, id: 42, position: [1, 2, 3], quaternion: [0, 0, 0, 1], ageMs: 12.5 }],
    });
    expect(frame.length).toBe(FRAME_HEADER_BYTES + ENTITY_BYTES);
    const bytes = new Uint8Array(header.length + frame.length);
    bytes.set(header, 0);
    bytes.set(frame, header.length);
    const { header: back, frames } = decodeDisplay(bytes);
    expect(back).toEqual({ clockOriginMs: 5 });
    expect(frames).toHaveLength(1);
    expect(frames[0].tMs).toBe(10.5);
    expect(frames[0].sampleMs).toBe(8);
    expect(frames[0].dynRenderUs).toBe(900);
    expect(frames[0].entities[0].id).toBe(42);
    expect(Array.from(frames[0].entities[0].position)).toEqual([1, 2, 3]);
    expect(frames[0].entities[0].ageMs).toBe(12.5);
  });
});

describe('frameSchedule', () => {
  it('uses the recorded frames inside the replay window', () => {
    const frames = frameSchedule('recorded', [5, 10, 20, 30], 8, 25);
    expect(frames).toEqual([{ sampleMs: 10, probeMs: 10 }, { sampleMs: 20, probeMs: 20 }]);
  });

  it('shifts the draw by the given per-frame amount', () => {
    const frames = frameSchedule('recorded', [10, 20], 0, 100, [2, -3]);
    expect(frames).toEqual([{ sampleMs: 8, probeMs: 10 }, { sampleMs: 23, probeMs: 20 }]);
  });

  it('builds a fixed cadence', () => {
    const frames = frameSchedule('120', null, 0, 25);
    expect(frames.map((f) => f.probeMs.toFixed(3))).toEqual(['0.000', '8.333', '16.667', '25.000']);
  });

  it('refuses recorded frames when the tape has none', () => {
    expect(() => frameSchedule('recorded', null, 0, 1)).toThrow(/no frame samples/);
  });
});

describe('eventOrder', () => {
  it('delivers packets before a frame at the same instant, both in time order', () => {
    expect(eventOrder([1, 5, 5, 9], [5, 6])).toEqual([
      ['p', 0], ['p', 1], ['p', 2], ['f', 0], ['f', 1], ['p', 3],
    ]);
  });
});
