import { describe, expect, it } from 'vitest';
import {
  KNOB_SPECS,
  bisectStep,
  midpoint,
  nextAbPair,
  type Bracket,
  type KnobSpec,
} from './bisect';

const linearSpec: KnobSpec = {
  ...KNOB_SPECS['gamepad.curveExponent'],
  maxRounds: 99, // disable round-cap for mid-flow tests
  precision: 0.001, // disable precision-cap for mid-flow tests
};

const logSpec: KnobSpec = {
  ...KNOB_SPECS['mouse.sensitivity'],
  maxRounds: 99,
  precision: 0.00001,
};

describe('midpoint', () => {
  it('is arithmetic for linear scale', () => {
    expect(midpoint(0, 10, 'linear')).toBe(5);
  });

  it('is geometric for log scale', () => {
    expect(midpoint(1, 100, 'log')).toBeCloseTo(10);
    expect(midpoint(0.001, 0.01, 'log')).toBeCloseTo(Math.sqrt(0.001 * 0.01));
  });
});

describe('nextAbPair', () => {
  it('returns 33%/67% split in linear scale', () => {
    const { a, b } = nextAbPair({ lo: 0, hi: 3 }, 'linear');
    expect(a).toBeCloseTo(1);
    expect(b).toBeCloseTo(2);
  });

  it('returns log-spaced split in log scale', () => {
    const { a, b } = nextAbPair({ lo: 1, hi: 1000 }, 'log');
    expect(a).toBeCloseTo(10);
    expect(b).toBeCloseTo(100);
  });
});

describe('bisectStep — linear knob', () => {
  const bracket: Bracket = { lo: 1.0, hi: 3.0 };
  const a = 1.5;
  const b = 2.5;

  it("prefer='a' shrinks hi down to mid(a,b)", () => {
    const out = bisectStep({
      spec: linearSpec,
      bracket,
      a,
      b,
      prefer: 'a',
      aScore: 0.8,
      bScore: 0.7,
      round: 0,
    });
    expect(out.done).toBe(false);
    if (!out.done) {
      expect(out.bracket.lo).toBe(1.0);
      expect(out.bracket.hi).toBeCloseTo(2.0);
    }
  });

  it("prefer='b' shrinks lo up to mid(a,b)", () => {
    const out = bisectStep({
      spec: linearSpec,
      bracket,
      a,
      b,
      prefer: 'b',
      aScore: 0.6,
      bScore: 0.9,
      round: 0,
    });
    expect(out.done).toBe(false);
    if (!out.done) {
      expect(out.bracket.lo).toBeCloseTo(2.0);
      expect(out.bracket.hi).toBe(3.0);
    }
  });

  it("prefer='same' with no score signal tightens symmetrically", () => {
    const out = bisectStep({
      spec: linearSpec,
      bracket,
      a,
      b,
      prefer: 'same',
      aScore: 0.7,
      bScore: 0.7,
      round: 0,
    });
    expect(out.done).toBe(false);
    if (!out.done) {
      // mid(lo, a) = 1.25, mid(b, hi) = 2.75
      expect(out.bracket.lo).toBeCloseTo(1.25);
      expect(out.bracket.hi).toBeCloseTo(2.75);
    }
  });

  it("prefer='same' with strong A score is treated as 'a'", () => {
    const out = bisectStep({
      spec: linearSpec,
      bracket,
      a,
      b,
      prefer: 'same',
      aScore: 0.9,
      bScore: 0.4,
      round: 0,
    });
    expect(out.done).toBe(false);
    if (!out.done) {
      expect(out.bracket.hi).toBeCloseTo(2.0); // same as prefer='a' outcome
    }
  });

  it('emits a warning when preference strongly disagrees with score', () => {
    const out = bisectStep({
      spec: linearSpec,
      bracket,
      a,
      b,
      prefer: 'a',
      aScore: 0.1,
      bScore: 0.9, // B objectively crushed A, but player picked A
      round: 0,
    });
    expect(out.warning).toBeTruthy();
  });
});

describe('bisectStep — log knob', () => {
  const bracket: Bracket = { lo: 0.0015, hi: 0.006 };
  const { a, b } = nextAbPair(bracket, 'log');

  it("prefer='b' in a log bracket uses geometric midpoint", () => {
    const out = bisectStep({
      spec: logSpec,
      bracket,
      a,
      b,
      prefer: 'b',
      aScore: 0.5,
      bScore: 0.8,
      round: 0,
    });
    expect(out.done).toBe(false);
    if (!out.done) {
      const expectedLo = Math.sqrt(a * b);
      expect(out.bracket.lo).toBeCloseTo(expectedLo, 6);
      expect(out.bracket.hi).toBe(0.006);
    }
  });
});

describe('bisectStep — termination', () => {
  it('terminates at maxRounds', () => {
    const spec: KnobSpec = { ...linearSpec, maxRounds: 1 };
    const out = bisectStep({
      spec,
      bracket: { lo: 1.0, hi: 3.0 },
      a: 1.5,
      b: 2.5,
      prefer: 'a',
      aScore: 0.8,
      bScore: 0.5,
      round: 0, // round+1 === maxRounds → terminate
    });
    expect(out.done).toBe(true);
    if (out.done) {
      // Converged value should be inside the new bracket [1.0, 2.0]
      expect(out.value).toBeGreaterThanOrEqual(1.0);
      expect(out.value).toBeLessThanOrEqual(2.0);
    }
  });

  it('terminates when bracket collapses under precision', () => {
    // Set precision wider than the full bracket so any step ends immediately.
    const spec: KnobSpec = { ...linearSpec, precision: 10 };
    const out = bisectStep({
      spec,
      bracket: { lo: 1.0, hi: 3.0 },
      a: 1.5,
      b: 2.5,
      prefer: 'b',
      aScore: 0.5,
      bScore: 0.8,
      round: 0,
    });
    expect(out.done).toBe(true);
  });
});
