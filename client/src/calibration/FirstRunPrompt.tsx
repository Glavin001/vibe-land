// One-time "Want to calibrate?" prompt shown on first visit to the firing
// range. Rendered by App.tsx when there's no existing input-settings
// localStorage entry and the meta.firstRunPromptDismissed flag is false.

import type { CSSProperties } from 'react';

type FirstRunPromptProps = {
  visible: boolean;
  onStart: () => void;
  onDismiss: () => void;
};

const backdropStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.55)',
  backdropFilter: 'blur(4px)',
};

const panelStyle: CSSProperties = {
  maxWidth: 420,
  padding: '22px 26px',
  borderRadius: 14,
  color: '#edf6ff',
  background: 'rgba(7, 11, 16, 0.72)',
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
  backdropFilter: 'blur(18px)',
  textAlign: 'center',
  fontFamily: 'system-ui, sans-serif',
};

const titleStyle: CSSProperties = {
  fontSize: 22,
  margin: '0 0 8px',
  fontWeight: 600,
};

const bodyStyle: CSSProperties = {
  fontSize: 14,
  margin: '0 0 20px',
  opacity: 0.82,
  lineHeight: 1.5,
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  justifyContent: 'center',
};

const primaryButtonStyle: CSSProperties = {
  padding: '9px 18px',
  borderRadius: 999,
  border: '1px solid rgba(149, 233, 255, 0.45)',
  background: 'rgba(149, 233, 255, 0.22)',
  color: '#edf6ff',
  fontSize: 13,
  cursor: 'pointer',
  fontWeight: 600,
};

const secondaryButtonStyle: CSSProperties = {
  padding: '9px 18px',
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.16)',
  background: 'rgba(255,255,255,0.06)',
  color: '#edf6ff',
  fontSize: 13,
  cursor: 'pointer',
};

export function FirstRunPrompt({ visible, onStart, onDismiss }: FirstRunPromptProps) {
  if (!visible) return null;
  return (
    <div style={backdropStyle}>
      <div style={panelStyle}>
        <h2 style={titleStyle}>Want to calibrate your aim?</h2>
        <p style={bodyStyle}>
          We'll run a few short drills under two settings at a time and ask which felt
          better. You don't need to know any numbers — just trust your feel. Takes about
          two minutes.
        </p>
        <div style={buttonRowStyle}>
          <button type="button" style={primaryButtonStyle} onClick={onStart}>
            Yes, let's calibrate
          </button>
          <button type="button" style={secondaryButtonStyle} onClick={onDismiss}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
