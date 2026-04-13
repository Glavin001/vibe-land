// Top-level modal that drives the calibration wizard. Renders phase-specific
// UI (intro, drill countdowns, A/B comparison question, convergence result)
// and exposes a `sceneExtras` node that the parent mounts inside the R3F
// scene — that's how the drill target meshes end up in the live firing range.

import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { DeviceFamily } from '../input/types';
import { FlickDrill } from './drills/FlickDrill';
import { TrackDrill } from './drills/TrackDrill';
import type { DrillResult } from './drills/drillTypes';
import { useCalibrationSession, type CalibrationPhase } from './useCalibrationSession';

type CalibrationOverlayProps = {
  visible: boolean;
  activeFamily: DeviceFamily | null;
  onRequestClose: () => void;
  onRenderSceneExtras: (extras: ReactNode) => void;
};

const rootStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 30,
  display: 'flex',
  flexDirection: 'column',
  pointerEvents: 'none',
  color: '#edf6ff',
  fontFamily: 'system-ui, sans-serif',
};

const headerStyle: CSSProperties = {
  margin: '16px auto 0',
  pointerEvents: 'auto',
  padding: '10px 18px',
  minWidth: 340,
  maxWidth: 560,
  borderRadius: 12,
  background: 'rgba(7, 11, 16, 0.58)',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: '0 18px 40px rgba(0,0,0,0.25)',
  backdropFilter: 'blur(18px)',
  textAlign: 'center',
};

const bottomPanelStyle: CSSProperties = {
  margin: 'auto auto 32px',
  pointerEvents: 'auto',
  padding: '18px 22px',
  minWidth: 420,
  maxWidth: 620,
  borderRadius: 14,
  background: 'rgba(7, 11, 16, 0.72)',
  border: '1px solid rgba(255,255,255,0.10)',
  boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
  backdropFilter: 'blur(18px)',
};

const progressTrackStyle: CSSProperties = {
  height: 6,
  borderRadius: 999,
  background: 'rgba(255,255,255,0.08)',
  overflow: 'hidden',
  marginTop: 6,
};

const progressFillStyle = (pct: number): CSSProperties => ({
  width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
  height: '100%',
  background: 'linear-gradient(90deg, rgba(116,220,255,0.78), rgba(129,255,191,0.78))',
  transition: 'width 120ms linear',
});

const pillButtonStyle: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.06)',
  color: '#edf6ff',
  fontSize: 13,
  cursor: 'pointer',
};

const primaryPillStyle: CSSProperties = {
  ...pillButtonStyle,
  border: '1px solid rgba(149, 233, 255, 0.45)',
  background: 'rgba(149, 233, 255, 0.24)',
  fontWeight: 600,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  justifyContent: 'center',
  flexWrap: 'wrap',
};

const smallMutedStyle: CSSProperties = { fontSize: 12, opacity: 0.68 };

function phaseTitle(phase: CalibrationPhase, knobLabel: string, round: number, maxRounds: number): string {
  switch (phase) {
    case 'intro':          return `Next up: ${knobLabel}`;
    case 'drillA':         return `Config A — round ${round + 1} of up to ${maxRounds}`;
    case 'betweenAB':      return 'Ready for Config B';
    case 'drillB':         return `Config B — round ${round + 1} of up to ${maxRounds}`;
    case 'ask':            return 'Which felt better?';
    case 'betweenRounds':  return `Narrowing in — round ${round + 1} of up to ${maxRounds}`;
    case 'result':         return 'Got it — saved.';
    case 'done':           return "You're calibrated.";
  }
}

export function CalibrationOverlay({
  visible,
  activeFamily,
  onRequestClose,
  onRenderSceneExtras,
}: CalibrationOverlayProps) {
  const session = useCalibrationSession();
  const { state } = session;

  // Auto-start the session when the overlay becomes visible and we know
  // which device to calibrate.
  useEffect(() => {
    if (visible && activeFamily && state.knobQueue.length === 0) {
      session.start(activeFamily);
    }
    if (!visible && state.knobQueue.length > 0) {
      session.cancel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeFamily]);

  // Mount drill components into the R3F scene via the parent callback.
  // Only render the active drill during drillA/drillB — between phases and
  // during the ask step, no drill targets should be visible.
  const sceneExtras = useMemo<ReactNode>(() => {
    if (!visible || !state.currentKnob) return null;
    const drill = state.currentKnob.drill;
    if (state.phase === 'drillA') {
      if (drill === 'flick' || drill === 'flickVertical') {
        return (
          <FlickDrill
            kind={drill}
            runKey={state.runKeyA}
            running={true}
            onComplete={session.onDrillAComplete}
          />
        );
      }
      if (drill === 'track' || drill === 'trackEdge') {
        return (
          <TrackDrill
            kind={drill}
            runKey={state.runKeyA}
            running={true}
            onComplete={session.onDrillAComplete}
          />
        );
      }
    }
    if (state.phase === 'drillB') {
      if (drill === 'flick' || drill === 'flickVertical') {
        return (
          <FlickDrill
            kind={drill}
            runKey={state.runKeyB}
            running={true}
            onComplete={session.onDrillBComplete}
          />
        );
      }
      if (drill === 'track' || drill === 'trackEdge') {
        return (
          <TrackDrill
            kind={drill}
            runKey={state.runKeyB}
            running={true}
            onComplete={session.onDrillBComplete}
          />
        );
      }
    }
    return null;
  }, [visible, state.currentKnob, state.phase, state.runKeyA, state.runKeyB, session.onDrillAComplete, session.onDrillBComplete]);

  useEffect(() => {
    onRenderSceneExtras(sceneExtras);
    return () => onRenderSceneExtras(null);
  }, [sceneExtras, onRenderSceneExtras]);

  if (!visible) return null;

  const knob = state.currentKnob;
  const totalKnobs = state.knobQueue.length;
  const knobProgress = totalKnobs > 0 ? (state.knobIndex + (state.phase === 'done' ? 1 : 0)) / totalKnobs : 0;

  return (
    <div style={rootStyle}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 13, opacity: 0.9, fontWeight: 600 }}>
            Calibration · {state.family === 'gamepad' ? 'Gamepad' : 'Mouse & Keyboard'}
          </div>
          <div style={smallMutedStyle}>
            {totalKnobs > 0 ? `Knob ${Math.min(state.knobIndex + 1, totalKnobs)}/${totalKnobs}` : ''}
          </div>
          <button
            type="button"
            style={{ ...pillButtonStyle, padding: '4px 10px', fontSize: 12 }}
            onClick={() => {
              session.cancel();
              onRequestClose();
            }}
          >
            Close
          </button>
        </div>
        <div style={progressTrackStyle}>
          <div style={progressFillStyle(knobProgress)} />
        </div>
      </div>

      <div style={bottomPanelStyle}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
          {knob
            ? phaseTitle(state.phase, knob.label, state.round, knob.maxRounds)
            : phaseTitle(state.phase, '', 0, 0)}
        </div>
        {knob && state.phase === 'intro' && (
          <IntroPhase
            description={knob.description}
            onStart={session.beginDrillA}
            onSkip={session.skipCurrentKnob}
          />
        )}
        {knob && state.phase === 'drillA' && (
          <DrillActivePhase label="A" drillKind={knob.drill} />
        )}
        {knob && state.phase === 'betweenAB' && (
          <BetweenPhase onStart={session.beginDrillB} />
        )}
        {knob && state.phase === 'drillB' && (
          <DrillActivePhase label="B" drillKind={knob.drill} />
        )}
        {knob && state.phase === 'ask' && (
          <AskPhase
            onAnswer={session.answerPreference}
            aResult={state.aResult}
            bResult={state.bResult}
            onAccept={session.acceptCurrentBracket}
            onSkip={session.skipCurrentKnob}
          />
        )}
        {knob && state.phase === 'betweenRounds' && (
          <BetweenRoundsPhase
            onStart={session.beginDrillA}
            onAccept={session.acceptCurrentBracket}
            onSkip={session.skipCurrentKnob}
          />
        )}
        {knob && state.phase === 'result' && (
          <ResultPhase
            knobLabel={knob.label}
            value={state.lastConvergedValue}
            warning={state.lastWarning}
            onNext={session.advanceFromResult}
          />
        )}
        {state.phase === 'done' && (
          <DonePhase onClose={() => {
            session.close();
            onRequestClose();
          }} />
        )}
      </div>
    </div>
  );
}

function IntroPhase({
  description,
  onStart,
  onSkip,
}: {
  description: string;
  onStart: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <p style={{ fontSize: 13, opacity: 0.82, lineHeight: 1.5, margin: '4px 0 16px' }}>
        {description}
      </p>
      <div style={rowStyle}>
        <button type="button" style={primaryPillStyle} onClick={onStart}>
          Start drill A
        </button>
        <button type="button" style={pillButtonStyle} onClick={onSkip}>
          Skip this knob
        </button>
      </div>
    </>
  );
}

function BetweenPhase({ onStart }: { onStart: () => void }) {
  return (
    <>
      <p style={{ fontSize: 13, opacity: 0.82, margin: '4px 0 16px' }}>
        Now try drill B — same targets, different setting.
      </p>
      <div style={rowStyle}>
        <button type="button" style={primaryPillStyle} onClick={onStart}>
          Start drill B
        </button>
      </div>
    </>
  );
}

function BetweenRoundsPhase({
  onStart,
  onAccept,
  onSkip,
}: {
  onStart: () => void;
  onAccept: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <p style={{ fontSize: 13, opacity: 0.82, margin: '4px 0 16px' }}>
        Good. Let's narrow in with a new pair of settings — same drill, new values.
      </p>
      <div style={rowStyle}>
        <button type="button" style={primaryPillStyle} onClick={onStart}>
          Start next comparison
        </button>
        <button type="button" style={pillButtonStyle} onClick={onAccept}>
          Accept current
        </button>
        <button type="button" style={pillButtonStyle} onClick={onSkip}>
          Skip knob
        </button>
      </div>
    </>
  );
}

function DrillActivePhase({
  label,
  drillKind,
}: {
  label: 'A' | 'B';
  drillKind: string;
}) {
  const instructions = drillKind === 'track' || drillKind === 'trackEdge'
    ? 'Track the moving target. Stay close to it.'
    : 'Flick to each target and click to shoot.';
  return (
    <div style={{ pointerEvents: 'none' }}>
      <p style={{ fontSize: 13, opacity: 0.85, margin: '4px 0 8px' }}>
        Config <strong>{label}</strong> · {instructions}
      </p>
      <p style={smallMutedStyle}>
        Buttons are disabled while the drill runs. It will end automatically.
      </p>
    </div>
  );
}

function AskPhase({
  onAnswer,
  aResult,
  bResult,
  onAccept,
  onSkip,
}: {
  onAnswer: (prefer: 'a' | 'b' | 'same') => void;
  aResult: DrillResult | null;
  bResult: DrillResult | null;
  onAccept: () => void;
  onSkip: () => void;
}) {
  const aScore = aResult ? Math.round(aResult.score * 100) : null;
  const bScore = bResult ? Math.round(bResult.score * 100) : null;
  return (
    <>
      <p style={{ fontSize: 13, opacity: 0.82, margin: '4px 0 14px' }}>
        Trust your feel. Drill scores are a hint, not a verdict.
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          Score A: <strong>{aScore ?? '—'}</strong>
        </div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          Score B: <strong>{bScore ?? '—'}</strong>
        </div>
      </div>
      <div style={rowStyle}>
        <button type="button" style={primaryPillStyle} onClick={() => onAnswer('a')}>
          A felt better
        </button>
        <button type="button" style={pillButtonStyle} onClick={() => onAnswer('same')}>
          About the same
        </button>
        <button type="button" style={primaryPillStyle} onClick={() => onAnswer('b')}>
          B felt better
        </button>
      </div>
      <div style={{ ...rowStyle, marginTop: 10 }}>
        <button type="button" style={pillButtonStyle} onClick={onAccept}>
          Accept current
        </button>
        <button type="button" style={pillButtonStyle} onClick={onSkip}>
          Skip knob
        </button>
      </div>
    </>
  );
}

function ResultPhase({
  knobLabel,
  value,
  warning,
  onNext,
}: {
  knobLabel: string;
  value: number | null;
  warning: string | null;
  onNext: () => void;
}) {
  return (
    <>
      <p style={{ fontSize: 13, opacity: 0.85, margin: '4px 0 10px' }}>
        <strong>{knobLabel}</strong> saved
        {value != null ? <> at <code style={{ opacity: 0.9 }}>{value.toFixed(4)}</code></> : null}
        .
      </p>
      {warning && (
        <p style={{ ...smallMutedStyle, color: '#ffd27a', marginBottom: 10 }}>{warning}</p>
      )}
      <div style={rowStyle}>
        <button type="button" style={primaryPillStyle} onClick={onNext}>
          Next
        </button>
      </div>
    </>
  );
}

function DonePhase({ onClose }: { onClose: () => void }) {
  return (
    <>
      <p style={{ fontSize: 13, opacity: 0.85, margin: '4px 0 14px' }}>
        Your settings are saved. You can re-run calibration anytime from the button in
        the top right.
      </p>
      <div style={rowStyle}>
        <button type="button" style={primaryPillStyle} onClick={onClose}>
          Back to the range
        </button>
      </div>
    </>
  );
}
