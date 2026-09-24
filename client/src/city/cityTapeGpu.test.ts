// The recorder puts each frame's GPU time on the tape frame that describes
// that frame, although the timer result lands a few frames later.

import { afterEach, describe, expect, it, vi } from 'vitest';

const gpu = vi.hoisted(() => ({
  serial: 0,
  status: 'EXT_disjoint_timer_query_webgl2' as 'EXT_disjoint_timer_query_webgl2' | 'unavailable' | 'unknown',
  listeners: new Set<(frame: number, totalMs: number, maxPassMs: number) => void>(),
  counters: { framesResolved: 0, disjoints: 0, queriesDiscarded: 0, framesExpired: 0, queriesRefused: 0, lagFramesMax: 0, lagFramesSum: 0 },
}));

vi.mock('./renderStats', () => ({
  currentGpuFrameSerial: () => gpu.serial,
  gpuTimerStatus: () => gpu.status,
  gpuTimerCounters: () => ({ ...gpu.counters }),
  onGpuFrameResult: (listener: (frame: number, totalMs: number, maxPassMs: number) => void) => {
    gpu.listeners.add(listener);
    return () => gpu.listeners.delete(listener);
  },
}));

import { cityTapeRecorder, decodeCityTape, encodeCityTape } from './cityTape';

const camera = { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
const land = (frame: number, totalMs: number, maxPassMs: number) => {
  for (const listener of gpu.listeners) listener(frame, totalMs, maxPassMs);
};

describe('tape GPU times', () => {
  afterEach(() => {
    for (let session = 0; session < 1000 && cityTapeRecorder.recording; session += 1) cityTapeRecorder.stop(session);
    gpu.serial = 0;
    gpu.status = 'EXT_disjoint_timer_query_webgl2';
  });

  it('assigns a late GPU result to the frame it measured', () => {
    const session = cityTapeRecorder.start('e2e');
    // Frame serials 10..13 are drawn; each noteFrame (during serial s)
    // describes serial s - 1.
    for (const serial of [11, 12, 13, 14]) {
      gpu.serial = serial;
      cityTapeRecorder.noteFrame(16, 3, camera);
      // Results land two frames late, and serial 12's never does.
      if (serial - 3 >= 10 && serial - 3 !== 12) land(serial - 3, 10 + serial - 3, 5);
    }
    land(13, 23, 9);
    gpu.counters = { ...gpu.counters, framesResolved: gpu.counters.framesResolved + 3, disjoints: gpu.counters.disjoints + 1, lagFramesSum: gpu.counters.lagFramesSum + 7, lagFramesMax: 3 };
    const tape = cityTapeRecorder.stop(session)!;
    expect(tape.header.gpuTimerStats).toMatchObject({ framesResolved: 3, disjoints: 1, framesTimedOnTape: 3, lagFramesMax: 3 });
    expect(tape.header.gpuTimerStats!.lagFramesMean).toBeCloseTo(7 / 3);
    expect(tape.header.gpuTimer).toBe('EXT_disjoint_timer_query_webgl2');
    const ms = Array.from(tape.frames!.gpu!.ms);
    expect(ms[0]).toBe(20);
    expect(ms[1]).toBe(21);
    expect(Number.isNaN(ms[2])).toBe(true);
    expect(ms[3]).toBe(23);
    expect(tape.frames!.gpu!.maxPassMs[3]).toBe(9);
    // And it survives the file.
    const back = decodeCityTape(encodeCityTape(tape));
    expect(back.frames!.gpu!.ms[1]).toBe(21);
    expect(Number.isNaN(back.frames!.gpu!.ms[2])).toBe(true);
  });

  it('keeps a result that lands before its frame is noted (lag 0)', () => {
    const session = cityTapeRecorder.start('e2e');
    // Serial 20 ends; the next rAF's markFrameStart drains its result, then
    // advances to 21, and only then does the governor note serial 20.
    land(20, 8.5, 6);
    gpu.serial = 21;
    cityTapeRecorder.noteFrame(16, 3, camera);
    land(21, 9.5, 7);
    gpu.serial = 22;
    cityTapeRecorder.noteFrame(16, 3, camera);
    const tape = cityTapeRecorder.stop(session)!;
    expect(Array.from(tape.frames!.gpu!.ms)).toEqual([8.5, 9.5]);
    expect(Array.from(tape.frames!.gpu!.maxPassMs)).toEqual([6, 7]);
  });

  it('ignores results that arrive after the tape stopped, and stops listening', () => {
    const session = cityTapeRecorder.start('e2e');
    gpu.serial = 5;
    cityTapeRecorder.noteFrame(16, 3, camera);
    const tape = cityTapeRecorder.stop(session)!;
    expect(gpu.listeners.size).toBe(0);
    land(4, 99, 99);
    expect(Number.isNaN(tape.frames!.gpu!.ms[0])).toBe(true);
  });

  it('says unavailable when the browser has no timer extension', () => {
    gpu.status = 'unavailable';
    const session = cityTapeRecorder.start('e2e');
    gpu.serial = 3;
    cityTapeRecorder.noteFrame(16, 3, camera);
    const tape = cityTapeRecorder.stop(session)!;
    expect(tape.header.gpuTimer).toBe('unavailable');
    expect(Number.isNaN(tape.frames!.gpu!.ms[0])).toBe(true);
  });
});
