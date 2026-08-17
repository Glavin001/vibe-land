import { describe, expect, it, beforeEach } from 'vitest';

import {
  FRAME_COLUMNS,
  isRecording,
  recordEvent,
  recordFrame,
  __testing,
  type RecorderFrameSample,
  type RecorderStatsInput,
} from './recorder';

// The module installs itself on `window` in the browser; under vitest's node
// environment there is no window, so drive the same object directly.
function bridge() {
  return __testing.bridge;
}

const STATS: RecorderStatsInput = {
  fps: 60,
  pingMs: 20,
  serverTick: 100,
  interpolationDelayMs: 33,
  dynamicBodyInterpolationDelayMs: 16,
  clockOffsetUs: 1234,
  snapshotsPerSec: 30,
  jitterMs: 2,
  lastSnapshotGapMs: 33,
  staleSnapshotsDropped: 0,
  reliableSnapshotsReceived: 0,
  datagramSnapshotsReceived: 500,
  pendingInputs: 3,
  predictionTicks: 2,
  playerCorrectionMagnitude: 0.01,
  vehicleCorrectionMagnitude: 0,
  physicsStepMs: 1.5,
  onGround: true,
  inVehicle: false,
};

function sample(overrides: Partial<RecorderFrameSample> = {}): RecorderFrameSample {
  return {
    tMs: 0,
    frameDeltaMs: 16.7,
    renderedPosition: [1, 2, 3],
    authoritativePosition: [1, 2, 3],
    authoritativeVelocity: [0, 0, 0],
    camYaw: 0,
    camPitch: 0,
    stats: STATS,
    ...overrides,
  };
}

function columnOf(row: number[], name: string): number {
  const idx = FRAME_COLUMNS.indexOf(name as (typeof FRAME_COLUMNS)[number]);
  expect(idx).toBeGreaterThanOrEqual(0);
  return row[idx];
}

describe('netlab recorder', () => {
  beforeEach(() => {
    bridge().stop();
  });

  it('drops frames and events on the floor when inactive', () => {
    expect(isRecording()).toBe(false);
    recordFrame(sample());
    recordEvent('note', { a: 1 });
    bridge().start({ maxFrames: 8 });
    expect(bridge().drainFrames(0, 100).rows).toHaveLength(0);
    expect(bridge().drainEvents(0, 100).events).toHaveLength(0);
  });

  it('records frames in schema order and derives the presentation offset', () => {
    bridge().start({ maxFrames: 64 });
    recordFrame(sample({
      tMs: 5,
      renderedPosition: [1.5, 2, 3],
      authoritativePosition: [1, 2, 3],
    }));
    const drained = bridge().drainFrames(0, 100);

    expect(drained.rows).toHaveLength(1);
    expect(drained.schema).toEqual(FRAME_COLUMNS);
    expect(drained.nextIndex).toBe(1);
    expect(drained.lostFrames).toBe(0);

    const row = drained.rows[0];
    expect(columnOf(row, 'tMs')).toBe(5);
    expect(columnOf(row, 'presOffX')).toBeCloseTo(0.5);
    expect(columnOf(row, 'presOffMag')).toBeCloseTo(0.5);
    expect(columnOf(row, 'pendingInputs')).toBe(3);
    expect(columnOf(row, 'onGround')).toBe(1);
    expect(columnOf(row, 'inVehicle')).toBe(0);
  });

  it('resumes draining from a cursor without repeating rows', () => {
    bridge().start({ maxFrames: 64 });
    for (let i = 0; i < 5; i += 1) recordFrame(sample({ tMs: i }));

    const first = bridge().drainFrames(0, 2);
    expect(first.rows.map((r) => columnOf(r, 'tMs'))).toEqual([0, 1]);

    const second = bridge().drainFrames(first.nextIndex, 100);
    expect(second.rows.map((r) => columnOf(r, 'tMs'))).toEqual([2, 3, 4]);
    expect(second.lostFrames).toBe(0);
  });

  it('reports lost frames rather than silently serving overwritten data', () => {
    bridge().start({ maxFrames: 4 });
    for (let i = 0; i < 6; i += 1) recordFrame(sample({ tMs: i }));

    const drained = bridge().drainFrames(0, 100);
    // Capacity 4, six written: the first two are gone and must be declared.
    expect(drained.lostFrames).toBe(2);
    expect(drained.fromIndex).toBe(2);
    expect(drained.rows.map((r) => columnOf(r, 'tMs'))).toEqual([2, 3, 4, 5]);
    expect(bridge().stop().droppedFrames).toBe(2);
  });

  it('emits a transport_change event only on an actual change', () => {
    bridge().start({ maxFrames: 64 });
    recordFrame(sample({ transport: 'webtransport' }));
    recordFrame(sample({ transport: 'webtransport' }));
    recordFrame(sample({ transport: 'websocket' }));

    const events = bridge().drainEvents(0, 100).events.filter((e) => e.type === 'transport_change');
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ from: 'webtransport', to: 'websocket' });
  });

  it('keeps event sequence numbers monotonic across drains', () => {
    bridge().start({ maxFrames: 16 });
    recordEvent('note', { i: 0 });
    recordEvent('note', { i: 1 });
    const first = bridge().drainEvents(0, 1);
    expect(first.events.map((e) => e.seq)).toEqual([0]);

    recordEvent('note', { i: 2 });
    const second = bridge().drainEvents(first.nextSeq, 100);
    expect(second.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('reports a clock anchor so telemetry can be aligned with video', () => {
    const info = bridge().clockInfo();
    expect(info.perfNowMs).toBeGreaterThanOrEqual(0);
    expect(info.dateNowMs).toBeGreaterThan(1_600_000_000_000);
  });
});
