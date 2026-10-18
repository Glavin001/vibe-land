// The current weapon, bottom right as in Call of Duty, with the slots it
// cycles through. Number keys pick (1 rifle, 2 cannon, 3 meteor strike); the
// scroll wheel and gamepad Y step through them (input/keyboardMouse.ts,
// city/shotMode.ts). The native app draws the same in its overlay
// (native/NativeWeaponHud.tsx).

import { SHOT_MODE_LABELS, SHOT_MODES } from '../city/shotMode';
import { useShotMode } from '../city/useShotMode';

export function WeaponHud() {
  const current = useShotMode();
  return (
    <div
      data-testid="weapon-hud"
      style={{
        position: 'absolute',
        right: 18,
        bottom: 18,
        padding: '8px 12px',
        borderRadius: 6,
        background: 'rgba(8, 12, 18, 0.55)',
        color: '#e8edf2',
        fontFamily: 'Menlo, monospace',
        pointerEvents: 'none',
        zIndex: 6,
        textAlign: 'right',
      }}
    >
      <div data-testid="weapon-hud-name" style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>
        {SHOT_MODE_LABELS[current].toUpperCase()}
      </div>
      <div style={{ fontSize: 12, marginTop: 4 }}>
        {SHOT_MODES.map((mode, i) => (
          <span key={mode} style={{ marginLeft: 10, color: mode === current ? '#ffd166' : '#8b96a2' }}>
            {i + 1} {SHOT_MODE_LABELS[mode]}
          </span>
        ))}
      </div>
      <div style={{ fontSize: 10, marginTop: 3, color: '#8b96a2' }}>scroll or 1-{SHOT_MODES.length} to switch</div>
    </div>
  );
}
