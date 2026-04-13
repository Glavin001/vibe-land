// State machine hook for the calibration wizard.
//
// Responsibilities:
//  - Build a knob queue from the active device family.
//  - For each knob, run a bracketing loop (drillA → drillB → ask → repeat).
//  - On every transition into drillA/drillB, write the candidate value into
//    the input settings store so the player feels it live during the drill.
//  - On convergence, write the final value and advance to the next knob.
//  - On full completion, bump `meta.revision` and flag the first-run prompt
//    as dismissed so it never pops again.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { DeviceFamily } from '../input/types';
import { updateInputSettings, getInputSettings } from '../input/inputSettingsStore';
import type { InputSettings } from '../input/inputSettings';
import {
  bisectStep,
  GAMEPAD_KNOB_QUEUE,
  KNOB_SPECS,
  MOUSE_KNOB_QUEUE,
  nextAbPair,
  type Bracket,
  type KnobId,
  type KnobSpec,
  type Preference,
} from './bisect';
import type { DrillKind, DrillResult } from './drills/drillTypes';

export type CalibrationPhase =
  | 'intro'
  | 'drillA'
  | 'betweenAB'
  | 'drillB'
  | 'ask'
  | 'betweenRounds'
  | 'result'
  | 'done';

export type CalibrationRoundRecord = {
  knobId: KnobId;
  round: number;
  a: number;
  b: number;
  aResult: DrillResult | null;
  bResult: DrillResult | null;
  prefer: Preference | null;
  warning?: string;
};

export type CalibrationSessionState = {
  family: DeviceFamily;
  knobQueue: KnobId[];
  knobIndex: number;
  currentKnob: KnobSpec | null;
  phase: CalibrationPhase;
  round: number;
  bracket: Bracket;
  a: number;
  b: number;
  aResult: DrillResult | null;
  bResult: DrillResult | null;
  savedValues: Partial<Record<KnobId, number>>;
  lastConvergedValue: number | null;
  lastWarning: string | null;
  runKeyA: number;
  runKeyB: number;
};

export type UseCalibrationSessionReturn = {
  state: CalibrationSessionState;
  start: (family: DeviceFamily) => void;
  cancel: () => void;
  beginDrillA: () => void;
  onDrillAComplete: (result: DrillResult) => void;
  beginDrillB: () => void;
  onDrillBComplete: (result: DrillResult) => void;
  answerPreference: (prefer: Preference) => void;
  advanceFromResult: () => void;
  skipCurrentKnob: () => void;
  acceptCurrentBracket: () => void;
  close: () => void;
  drillKindForCurrent: () => DrillKind | null;
};

function queueForFamily(family: DeviceFamily): KnobId[] {
  return family === 'gamepad' ? GAMEPAD_KNOB_QUEUE : MOUSE_KNOB_QUEUE;
}

function initialState(): CalibrationSessionState {
  return {
    family: 'keyboardMouse',
    knobQueue: [],
    knobIndex: 0,
    currentKnob: null,
    phase: 'intro',
    round: 0,
    bracket: { lo: 0, hi: 1 },
    a: 0,
    b: 0,
    aResult: null,
    bResult: null,
    savedValues: {},
    lastConvergedValue: null,
    lastWarning: null,
    runKeyA: 0,
    runKeyB: 0,
  };
}

/**
 * Write a knob value into the live input settings so subsequent input frames
 * pick it up immediately. This is the "live preview" during each drill.
 */
function writeKnob(id: KnobId, value: number): void {
  updateInputSettings((draft: InputSettings) => {
    switch (id) {
      case 'mouse.sensitivity':
        draft.mouse.sensitivity = value;
        break;
      case 'mouse.yOverXRatio':
        draft.mouse.yOverXRatio = value;
        break;
      case 'gamepad.yawSpeed':
        draft.gamepad.yawSpeed = value;
        break;
      case 'gamepad.yOverXRatio':
        draft.gamepad.yOverXRatio = value;
        break;
      case 'gamepad.curveExponent':
        draft.gamepad.curveExponent = value;
        break;
      case 'gamepad.aimDeadzone':
        draft.gamepad.aimDeadzone = value;
        break;
    }
    return draft;
  });
}

function readCurrentKnob(id: KnobId): number {
  const s = getInputSettings();
  switch (id) {
    case 'mouse.sensitivity': return s.mouse.sensitivity;
    case 'mouse.yOverXRatio': return s.mouse.yOverXRatio;
    case 'gamepad.yawSpeed': return s.gamepad.yawSpeed;
    case 'gamepad.yOverXRatio': return s.gamepad.yOverXRatio;
    case 'gamepad.curveExponent': return s.gamepad.curveExponent;
    case 'gamepad.aimDeadzone': return s.gamepad.aimDeadzone;
  }
}

export function useCalibrationSession(): UseCalibrationSessionReturn {
  const [state, setState] = useState<CalibrationSessionState>(initialState);
  // Run-key counter so FlickDrill/TrackDrill fully reset between A and B runs.
  const runKeyCounter = useRef(0);

  const start = useCallback((family: DeviceFamily) => {
    const queue = queueForFamily(family);
    if (queue.length === 0) return;
    const firstKnob = KNOB_SPECS[queue[0]];
    // Seed bracket around the user's current value (if it's inside the spec
    // range) so returning users don't have to re-converge from scratch.
    const current = readCurrentKnob(queue[0]);
    const bracket: Bracket = {
      lo: Math.min(firstKnob.startLo, Math.max(firstKnob.min, current * 0.5)),
      hi: Math.max(firstKnob.startHi, Math.min(firstKnob.max, current * 2)),
    };
    // If nudging the bracket collapsed it, fall back to the spec defaults.
    const safeBracket: Bracket = bracket.hi > bracket.lo
      ? bracket
      : { lo: firstKnob.startLo, hi: firstKnob.startHi };
    const pair = nextAbPair(safeBracket, firstKnob.scale);
    setState({
      ...initialState(),
      family,
      knobQueue: queue,
      knobIndex: 0,
      currentKnob: firstKnob,
      phase: 'intro',
      round: 0,
      bracket: safeBracket,
      a: pair.a,
      b: pair.b,
      runKeyA: 0,
      runKeyB: 0,
    });
  }, []);

  const cancel = useCallback(() => {
    setState(initialState);
  }, []);

  const beginDrillA = useCallback(() => {
    setState((prev) => {
      if (!prev.currentKnob) return prev;
      writeKnob(prev.currentKnob.id, prev.a);
      runKeyCounter.current += 1;
      return { ...prev, phase: 'drillA', aResult: null, bResult: null, runKeyA: runKeyCounter.current };
    });
  }, []);

  const onDrillAComplete = useCallback((result: DrillResult) => {
    setState((prev) => ({ ...prev, aResult: result, phase: 'betweenAB' }));
  }, []);

  const beginDrillB = useCallback(() => {
    setState((prev) => {
      if (!prev.currentKnob) return prev;
      writeKnob(prev.currentKnob.id, prev.b);
      runKeyCounter.current += 1;
      return { ...prev, phase: 'drillB', runKeyB: runKeyCounter.current };
    });
  }, []);

  const onDrillBComplete = useCallback((result: DrillResult) => {
    setState((prev) => ({ ...prev, bResult: result, phase: 'ask' }));
  }, []);

  const answerPreference = useCallback((prefer: Preference) => {
    setState((prev) => {
      if (!prev.currentKnob) return prev;
      const aScore = prev.aResult?.score ?? 0;
      const bScore = prev.bResult?.score ?? 0;
      const step = bisectStep({
        spec: prev.currentKnob,
        bracket: prev.bracket,
        a: prev.a,
        b: prev.b,
        prefer,
        aScore,
        bScore,
        round: prev.round,
      });
      if (step.done) {
        writeKnob(prev.currentKnob.id, step.value);
        const savedValues = { ...prev.savedValues, [prev.currentKnob.id]: step.value };
        return {
          ...prev,
          phase: 'result',
          savedValues,
          lastConvergedValue: step.value,
          lastWarning: step.warning ?? null,
        };
      }
      // Non-done → set up the next bracket and move into the betweenRounds
      // phase. That phase shows a "Start next comparison" button which
      // kicks off drillA with the NEW `a` value. Previously this set phase
      // to 'betweenAB' by mistake, which left the user stuck in a loop
      // seeing only "Start drill B" prompts after every answer.
      return {
        ...prev,
        phase: 'betweenRounds',
        bracket: step.bracket,
        a: step.a,
        b: step.b,
        round: prev.round + 1,
        aResult: null,
        bResult: null,
        lastWarning: step.warning ?? null,
      };
    });
  }, []);

  const advanceFromResult = useCallback(() => {
    setState((prev) => {
      const nextIndex = prev.knobIndex + 1;
      if (nextIndex >= prev.knobQueue.length) {
        // Full completion — persist dismissal + bump revision.
        updateInputSettings((draft) => {
          draft.meta.firstRunPromptDismissed = true;
          draft.meta.revision += 1;
          return draft;
        });
        return { ...prev, phase: 'done' };
      }
      const nextKnob = KNOB_SPECS[prev.knobQueue[nextIndex]];
      const current = readCurrentKnob(nextKnob.id);
      const bracket: Bracket = {
        lo: Math.min(nextKnob.startLo, Math.max(nextKnob.min, current * 0.5)),
        hi: Math.max(nextKnob.startHi, Math.min(nextKnob.max, current * 2)),
      };
      const safeBracket: Bracket = bracket.hi > bracket.lo
        ? bracket
        : { lo: nextKnob.startLo, hi: nextKnob.startHi };
      const pair = nextAbPair(safeBracket, nextKnob.scale);
      return {
        ...prev,
        knobIndex: nextIndex,
        currentKnob: nextKnob,
        phase: 'intro',
        round: 0,
        bracket: safeBracket,
        a: pair.a,
        b: pair.b,
        aResult: null,
        bResult: null,
        lastConvergedValue: null,
        lastWarning: null,
      };
    });
  }, []);

  const skipCurrentKnob = useCallback(() => {
    // Skip writes nothing; leaves the knob at whatever value it currently has.
    setState((prev) => ({ ...prev, phase: 'result', lastConvergedValue: null, lastWarning: null }));
  }, []);

  const acceptCurrentBracket = useCallback(() => {
    setState((prev) => {
      if (!prev.currentKnob) return prev;
      const spec = prev.currentKnob;
      const mid = spec.scale === 'log'
        ? Math.sqrt(prev.bracket.lo * prev.bracket.hi)
        : (prev.bracket.lo + prev.bracket.hi) / 2;
      writeKnob(spec.id, mid);
      const savedValues = { ...prev.savedValues, [spec.id]: mid };
      return {
        ...prev,
        phase: 'result',
        savedValues,
        lastConvergedValue: mid,
        lastWarning: null,
      };
    });
  }, []);

  const close = useCallback(() => {
    setState(initialState);
  }, []);

  const drillKindForCurrent = useCallback((): DrillKind | null => {
    return state.currentKnob?.drill ?? null;
  }, [state.currentKnob]);

  return useMemo(
    () => ({
      state,
      start,
      cancel,
      beginDrillA,
      onDrillAComplete,
      beginDrillB,
      onDrillBComplete,
      answerPreference,
      advanceFromResult,
      skipCurrentKnob,
      acceptCurrentBracket,
      close,
      drillKindForCurrent,
    }),
    [
      state,
      start,
      cancel,
      beginDrillA,
      onDrillAComplete,
      beginDrillB,
      onDrillBComplete,
      answerPreference,
      advanceFromResult,
      skipCurrentKnob,
      acceptCurrentBracket,
      close,
      drillKindForCurrent,
    ],
  );
}
