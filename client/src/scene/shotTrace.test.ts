import { describe, expect, it } from 'vitest';
import {
  isShotTraceActive,
  pickShotTraceIntercept,
  pruneExpiredTraces,
  shotTraceColor,
  type LocalShotTrace,
} from './shotTrace';

function makeTrace(partial: Partial<LocalShotTrace> = {}): LocalShotTrace {
  return {
    id: 0,
    shooterId: null,
    origin: [0, 0, 0],
    end: [1, 0, 0],
    kind: 'miss',
    expiresAtMs: 150,
    ...partial,
  };
}

describe('pickShotTraceIntercept', () => {
  it('uses closest remote hit when it beats the world blocker', () => {
    const result = pickShotTraceIntercept(12, [{ distance: 7, kind: 'body' }], 80);
    expect(result).toEqual({ distance: 7, kind: 'body' });
  });

  it('uses the world blocker when no remote hit is closer', () => {
    const result = pickShotTraceIntercept(6, [{ distance: 10, kind: 'head' }], 80);
    expect(result).toEqual({ distance: 6, kind: 'world' });
  });

  it('falls back to miss distance when nothing is hit', () => {
    const result = pickShotTraceIntercept(null, [], 80);
    expect(result).toEqual({ distance: 80, kind: 'miss' });
  });
});

describe('shotTraceColor', () => {
  it('maps kinds to stable colors', () => {
    expect(shotTraceColor('miss')).toBe(0x9df6ff);
    expect(shotTraceColor('world')).toBe(0xffefb0);
    expect(shotTraceColor('body')).toBe(0xff9a5c);
    expect(shotTraceColor('head')).toBe(0xff4b4b);
  });
});

describe('isShotTraceActive', () => {
  it('reports whether the trace is still alive', () => {
    expect(isShotTraceActive(makeTrace({ expiresAtMs: 150 }), 100)).toBe(true);
    expect(isShotTraceActive(makeTrace({ expiresAtMs: 150 }), 150)).toBe(false);
  });
});

describe('pruneExpiredTraces', () => {
  it('removes expired entries in place while preserving order', () => {
    const traces: LocalShotTrace[] = [
      makeTrace({ id: 1, expiresAtMs: 50 }),
      makeTrace({ id: 2, expiresAtMs: 150 }),
      makeTrace({ id: 3, expiresAtMs: 90 }),
      makeTrace({ id: 4, expiresAtMs: 200 }),
    ];
    pruneExpiredTraces(traces, 100);
    expect(traces.map((t) => t.id)).toEqual([2, 4]);
  });

  it('leaves an empty list untouched', () => {
    const traces: LocalShotTrace[] = [];
    pruneExpiredTraces(traces, 1000);
    expect(traces).toEqual([]);
  });
});
