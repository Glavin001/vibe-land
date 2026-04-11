import type { ActionSnapshot, DeviceFamily, InputContext, InputFamilyMode } from '../input/types';
import type { ControlHintsState } from './useControlHints';

type ControlHintsOverlayProps = {
  state: ControlHintsState;
  visible: boolean;
  inputFamilyMode: InputFamilyMode;
  onInputFamilyModeChange: (mode: InputFamilyMode) => void;
};

type RowSpec = {
  command: string;
  binding: string;
  value: number;
  active?: boolean;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function axisStrength(x: number, y: number, divisor = 1): number {
  return clamp01(Math.hypot(x, y) / divisor);
}

function boolValue(value: boolean): number {
  return value ? 1 : 0;
}

function buildRows(family: DeviceFamily, context: InputContext, action: ActionSnapshot | null): RowSpec[] {
  if (context === 'vehicle') {
    if (family === 'gamepad') {
      return [
        { command: 'Steer', binding: 'Left Stick', value: clamp01(Math.abs(action?.steer ?? 0)) },
        { command: 'Throttle', binding: 'RT', value: clamp01(action?.throttle ?? 0) },
        { command: 'Brake / Reverse', binding: 'LT', value: clamp01(action?.brake ?? 0) },
        { command: 'Camera', binding: 'Right Stick', value: axisStrength(action?.lookX ?? 0, action?.lookY ?? 0, 0.03) },
        { command: 'Handbrake', binding: 'A', value: boolValue(action?.handbrake ?? false), active: action?.handbrake ?? false },
        { command: 'Exit Vehicle', binding: 'X', value: boolValue(action?.interactPressed ?? false), active: action?.interactPressed ?? false },
      ];
    }
    return [
      { command: 'Steer', binding: 'A / D', value: clamp01(Math.abs(action?.steer ?? action?.moveX ?? 0)) },
      { command: 'Throttle', binding: 'W', value: clamp01(action?.throttle ?? 0) },
      { command: 'Brake / Reverse', binding: 'S', value: clamp01(action?.brake ?? 0) },
      { command: 'Camera', binding: 'Mouse / Trackpad', value: axisStrength(action?.lookX ?? 0, action?.lookY ?? 0, 0.03) },
      { command: 'Handbrake', binding: 'Space', value: boolValue(action?.handbrake ?? false), active: action?.handbrake ?? false },
      { command: 'Exit Vehicle', binding: 'E', value: boolValue(action?.interactPressed ?? false), active: action?.interactPressed ?? false },
    ];
  }

  if (family === 'gamepad') {
    return [
      { command: 'Move', binding: 'Left Stick', value: axisStrength(action?.moveX ?? 0, action?.moveY ?? 0) },
      { command: 'Look', binding: 'Right Stick', value: axisStrength(action?.lookX ?? 0, action?.lookY ?? 0, 0.03) },
      { command: 'Shoot', binding: 'RT', value: clamp01(action?.firePrimaryValue ?? 0), active: action?.firePrimary ?? false },
      { command: 'Jump', binding: 'A', value: boolValue(action?.jump ?? false), active: action?.jump ?? false },
      { command: 'Sprint', binding: 'L3', value: boolValue(action?.sprint ?? false), active: action?.sprint ?? false },
      { command: 'Crouch', binding: 'B', value: boolValue(action?.crouch ?? false), active: action?.crouch ?? false },
      { command: 'Interact / Car', binding: 'X', value: boolValue(action?.interactPressed ?? false), active: action?.interactPressed ?? false },
      { command: 'Remove Block', binding: 'LB', value: boolValue(action?.blockRemovePressed ?? false), active: action?.blockRemovePressed ?? false },
      { command: 'Place Block', binding: 'RB', value: boolValue(action?.blockPlacePressed ?? false), active: action?.blockPlacePressed ?? false },
      { command: 'Material 1 / 2', binding: 'D-Pad L / R', value: boolValue(Boolean(action?.materialSlot1Pressed || action?.materialSlot2Pressed)), active: Boolean(action?.materialSlot1Pressed || action?.materialSlot2Pressed) },
    ];
  }

  return [
    { command: 'Move', binding: 'WASD / Arrows', value: axisStrength(action?.moveX ?? 0, action?.moveY ?? 0) },
    { command: 'Look', binding: 'Mouse / Trackpad', value: axisStrength(action?.lookX ?? 0, action?.lookY ?? 0, 0.03) },
    { command: 'Shoot', binding: 'Mouse 1', value: clamp01(action?.firePrimaryValue ?? 0), active: action?.firePrimary ?? false },
    { command: 'Jump', binding: 'Space', value: boolValue(action?.jump ?? false), active: action?.jump ?? false },
    { command: 'Sprint', binding: 'Shift', value: boolValue(action?.sprint ?? false), active: action?.sprint ?? false },
    { command: 'Crouch', binding: 'Ctrl / C', value: boolValue(action?.crouch ?? false), active: action?.crouch ?? false },
    { command: 'Interact / Car', binding: 'E', value: boolValue(action?.interactPressed ?? false), active: action?.interactPressed ?? false },
    { command: 'Remove Block', binding: 'Q', value: boolValue(action?.blockRemovePressed ?? false), active: action?.blockRemovePressed ?? false },
    { command: 'Place Block', binding: 'F', value: boolValue(action?.blockPlacePressed ?? false), active: action?.blockPlacePressed ?? false },
    { command: 'Material 1 / 2', binding: '1 / 2', value: boolValue(Boolean(action?.materialSlot1Pressed || action?.materialSlot2Pressed)), active: Boolean(action?.materialSlot1Pressed || action?.materialSlot2Pressed) },
  ];
}

const MODE_OPTIONS: Array<{ mode: InputFamilyMode; label: string }> = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'keyboardMouse', label: 'Keyboard' },
  { mode: 'gamepad', label: 'Gamepad' },
];

export function ControlHintsOverlay({
  state,
  visible,
  inputFamilyMode,
  onInputFamilyModeChange,
}: ControlHintsOverlayProps) {
  if (!visible) return null;

  const family = state.activeFamily ?? 'keyboardMouse';
  const context = state.context;
  const rows = buildRows(family, context, state.action);
  const title = `${family === 'gamepad' ? 'Gamepad' : 'Keyboard + Mouse'} · ${context === 'vehicle' ? 'Vehicle' : 'On Foot'}`;

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 16,
        transform: 'translateX(-50%)',
        zIndex: 8,
        width: 880,
        maxWidth: 'calc(100% - 32px)',
        padding: '12px 14px',
        borderRadius: 14,
        background: 'rgba(7, 11, 16, 0.58)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 18px 40px rgba(0,0,0,0.25)',
        backdropFilter: 'blur(18px)',
        pointerEvents: 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.9 }}>{title}</div>
          <div style={{ display: 'flex', gap: 6, pointerEvents: 'auto' }}>
            {MODE_OPTIONS.map((option) => {
              const selected = option.mode === inputFamilyMode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => onInputFamilyModeChange(option.mode)}
                  style={{
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: selected ? 'rgba(149, 233, 255, 0.24)' : 'rgba(255,255,255,0.06)',
                    color: selected ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.65)',
                    borderRadius: 999,
                    padding: '5px 10px',
                    fontSize: 11,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ fontSize: 11, opacity: 0.5 }}>
          {inputFamilyMode === 'auto' ? 'last used wins' : `${inputFamilyMode === 'gamepad' ? 'gamepad' : 'keyboard'} locked`}
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: '8px 14px',
        }}
      >
        {rows.map((row) => (
          <div
            key={`${context}-${family}-${row.command}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 120px 1fr',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
            }}
          >
            <div style={{ fontSize: 12, color: row.active ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.72)' }}>{row.command}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{row.binding}</div>
            <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${clamp01(row.value) * 100}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: row.active
                    ? 'linear-gradient(90deg, rgba(252,244,163,0.95), rgba(255,123,92,0.95))'
                    : 'linear-gradient(90deg, rgba(116,220,255,0.78), rgba(129,255,191,0.78))',
                  opacity: clamp01(row.value) > 0 ? 1 : 0.18,
                  transition: 'width 40ms linear, opacity 80ms linear',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
