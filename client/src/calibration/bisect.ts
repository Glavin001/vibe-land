// Pure bracketing logic for the calibration wizard.
//
// Given a knob spec, a current bracket [lo, hi], the two values the player
// just compared (a, b), their preference (a/b/same), and the composite drill
// scores for both, decide either:
//   - the knob has converged → return the final value, or
//   - a new bracket and a new [a, b] pair for the next round.
//
// Preference is the primary signal. Score is a tiebreaker (when the user
// says "same") and a sanity check (warns on a strong score/preference
// mismatch — caller can log or ignore).

export type KnobId =
  | 'mouse.sensitivity'
  | 'mouse.yOverXRatio'
  | 'gamepad.yawSpeed'
  | 'gamepad.yOverXRatio'
  | 'gamepad.curveExponent'
  | 'gamepad.aimDeadzone';

export type KnobScale = 'linear' | 'log';

export type KnobSpec = {
  id: KnobId;
  label: string;
  description: string;
  min: number;
  max: number;
  startLo: number;
  startHi: number;
  precision: number;
  maxRounds: number;
  scale: KnobScale;
  // Which drill this knob uses for scoring.
  drill: 'flick' | 'flickVertical' | 'track' | 'trackEdge';
};

export type Preference = 'a' | 'b' | 'same';

export type Bracket = { lo: number; hi: number };

export type AbPair = { a: number; b: number };

export type BisectInput = {
  spec: KnobSpec;
  bracket: Bracket;
  a: number;
  b: number;
  prefer: Preference;
  // Normalized composite score per drill: higher = better. Range ~[0, 1].
  aScore: number;
  bScore: number;
  round: number;
};

export type BisectOutput =
  | { done: true; value: number; warning?: string }
  | { done: false; bracket: Bracket; a: number; b: number; warning?: string };

// --- midpoint helpers ---

function linMid(lo: number, hi: number): number {
  return (lo + hi) / 2;
}

function logMid(lo: number, hi: number): number {
  // Geometric mean is the log-scale midpoint.
  // Both lo and hi must be strictly positive for all calibrated knobs.
  return Math.sqrt(lo * hi);
}

export function midpoint(lo: number, hi: number, scale: KnobScale): number {
  return scale === 'log' ? logMid(lo, hi) : linMid(lo, hi);
}

function lerpScale(lo: number, hi: number, t: number, scale: KnobScale): number {
  if (scale === 'log') {
    const logLo = Math.log(lo);
    const logHi = Math.log(hi);
    return Math.exp(logLo + (logHi - logLo) * t);
  }
  return lo + (hi - lo) * t;
}

// --- next A/B pair within a bracket ---

/**
 * Choose the next pair of comparison values inside a bracket. We pick at 33%
 * and 67% of the bracket (in the chosen scale) so the two points are
 * noticeably different but neither is right at the edge.
 */
export function nextAbPair(bracket: Bracket, scale: KnobScale): AbPair {
  return {
    a: lerpScale(bracket.lo, bracket.hi, 1 / 3, scale),
    b: lerpScale(bracket.lo, bracket.hi, 2 / 3, scale),
  };
}

// --- termination ---

function bracketWidth(bracket: Bracket, scale: KnobScale): number {
  if (scale === 'log') {
    // Use a log-space width so "close enough" is sensible for log knobs.
    return Math.log(bracket.hi) - Math.log(bracket.lo);
  }
  return bracket.hi - bracket.lo;
}

function effectivePrecision(spec: KnobSpec): number {
  if (spec.scale === 'log') {
    // Interpret `precision` as an absolute tolerance around the current
    // midpoint, converted into log-space width.
    const mid = midpoint(spec.startLo, spec.startHi, 'log');
    return Math.log((mid + spec.precision) / Math.max(mid - spec.precision, 1e-9));
  }
  return spec.precision;
}

// --- main step ---

/**
 * Combine preference and score to update the bracket, then either terminate
 * or produce the next A/B pair.
 *
 * Preference mapping:
 *   - 'a' → discard everything ≥ mid(a, b). Warn if score strongly disagrees.
 *   - 'b' → discard everything ≤ mid(a, b). Warn if score strongly disagrees.
 *   - 'same' → tighten around the midpoint. If score gap is large enough,
 *              break the tie with score.
 */
export function bisectStep(input: BisectInput): BisectOutput {
  const { spec, bracket, a, b, prefer, aScore, bScore, round } = input;
  const scale = spec.scale;
  const mid = midpoint(a, b, scale);
  const d = aScore - bScore; // positive → A scored better

  let nextBracket: Bracket;
  let warning: string | undefined;

  const effectivePrefer: Preference = (() => {
    if (prefer !== 'same') return prefer;
    if (d > 0.15) return 'a';
    if (d < -0.15) return 'b';
    return 'same';
  })();

  if (effectivePrefer === 'a') {
    nextBracket = { lo: bracket.lo, hi: mid };
    if (prefer === 'a' && d < -0.25) warning = 'Felt better than it scored — trust your feel.';
  } else if (effectivePrefer === 'b') {
    nextBracket = { lo: mid, hi: bracket.hi };
    if (prefer === 'b' && d > 0.25) warning = 'Felt better than it scored — trust your feel.';
  } else {
    // Truly "same" with no score signal — tighten symmetrically around mid.
    nextBracket = {
      lo: midpoint(bracket.lo, a, scale),
      hi: midpoint(b, bracket.hi, scale),
    };
  }

  const widthNow = bracketWidth(nextBracket, scale);
  const prec = effectivePrecision(spec);
  const reachedPrecision = widthNow <= prec;
  const reachedMaxRounds = round + 1 >= spec.maxRounds;

  if (reachedPrecision || reachedMaxRounds) {
    return {
      done: true,
      value: midpoint(nextBracket.lo, nextBracket.hi, scale),
      warning,
    };
  }

  const nextPair = nextAbPair(nextBracket, scale);
  return {
    done: false,
    bracket: nextBracket,
    a: nextPair.a,
    b: nextPair.b,
    warning,
  };
}

// --- knob specs ---
// Starting brackets are picked narrower than the hard range so the first
// round gives the player a "clearly different but still playable" A and B.
// Max rounds is kept small (3–4) — the goal is convergence in ~2 minutes,
// not perfection.

export const KNOB_SPECS: Record<KnobId, KnobSpec> = {
  'mouse.sensitivity': {
    id: 'mouse.sensitivity',
    label: 'Mouse sensitivity',
    description: 'How far the camera turns per mouse count. The single biggest feel knob.',
    min: 0.0005,
    max: 0.01,
    startLo: 0.0015,
    startHi: 0.006,
    precision: 0.0003,
    maxRounds: 4,
    scale: 'log',
    drill: 'flick',
  },
  'mouse.yOverXRatio': {
    id: 'mouse.yOverXRatio',
    label: 'Vertical / horizontal ratio',
    description: 'How fast vertical look is compared to horizontal. 1.0 = the same.',
    min: 0.5,
    max: 1.5,
    startLo: 0.7,
    startHi: 1.3,
    precision: 0.08,
    maxRounds: 3,
    scale: 'linear',
    drill: 'flickVertical',
  },
  'gamepad.yawSpeed': {
    id: 'gamepad.yawSpeed',
    label: 'Stick look speed',
    description: 'How fast the camera turns at full right-stick deflection.',
    min: 1.0,
    max: 5.5,
    startLo: 1.8,
    startHi: 4.2,
    precision: 0.2,
    maxRounds: 4,
    scale: 'log',
    drill: 'flick',
  },
  'gamepad.yOverXRatio': {
    id: 'gamepad.yOverXRatio',
    label: 'Vertical / horizontal ratio',
    description: 'Vertical look speed as a multiplier of horizontal.',
    min: 0.4,
    max: 1.3,
    startLo: 0.55,
    startHi: 1.0,
    precision: 0.08,
    maxRounds: 3,
    scale: 'linear',
    drill: 'flickVertical',
  },
  'gamepad.curveExponent': {
    id: 'gamepad.curveExponent',
    label: 'Response curve',
    description: 'How linear (low) or twitchy/precise (high) the aim stick feels.',
    min: 1.0,
    max: 3.0,
    startLo: 1.3,
    startHi: 2.5,
    precision: 0.15,
    maxRounds: 3,
    scale: 'linear',
    drill: 'track',
  },
  'gamepad.aimDeadzone': {
    id: 'gamepad.aimDeadzone',
    label: 'Aim-stick deadzone',
    description: 'How far you have to push the stick before the camera starts moving.',
    min: 0.03,
    max: 0.25,
    startLo: 0.06,
    startHi: 0.18,
    precision: 0.02,
    maxRounds: 3,
    scale: 'linear',
    drill: 'trackEdge',
  },
};

export function knobSpec(id: KnobId): KnobSpec {
  return KNOB_SPECS[id];
}

export const MOUSE_KNOB_QUEUE: KnobId[] = ['mouse.sensitivity', 'mouse.yOverXRatio'];

export const GAMEPAD_KNOB_QUEUE: KnobId[] = [
  'gamepad.yawSpeed',
  'gamepad.yOverXRatio',
  'gamepad.curveExponent',
  'gamepad.aimDeadzone',
];
