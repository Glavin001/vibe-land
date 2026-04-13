// Shared types between the calibration drills and the wizard state machine.

export type DrillKind = 'flick' | 'flickVertical' | 'track' | 'trackEdge';

/**
 * Raw per-drill measurements. The wizard normalizes these into a [0, 1]
 * composite score for the bisect algorithm.
 */
export type DrillResult = {
  kind: DrillKind;
  // Composite score in [0, 1], higher = better. The drill computes this
  // from the raw fields below so the wizard stays device-agnostic.
  score: number;
  hits: number;
  attempts: number;
  // Total duration in milliseconds the drill actually ran (capped at drill timeout).
  totalTimeMs: number;
  // Mean angular error from crosshair to target in radians (tracking drills only).
  meanErrorRad?: number;
};

/**
 * Props passed to a drill component. The drill owns its own target placement,
 * input listening, and scoring; the parent only tells it when to start,
 * provides a seed (for deterministic target order), and listens for the final
 * result on completion.
 */
export type DrillProps = {
  // Unique key — change this to force the drill to reset.
  runKey: number;
  // When true, the drill counts down and runs. When false, it stays inert
  // (useful between drills so the UI can show instructions without the player
  // accidentally triggering targets).
  running: boolean;
  // Called exactly once when the drill finishes on its own (completion or
  // timeout). Not called when the parent tears the drill down early.
  onComplete: (result: DrillResult) => void;
};
