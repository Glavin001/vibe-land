import type { CSSProperties, ReactNode } from 'react';
import type { InputFamilyMode } from '../input/types';
import {
  GAMEPAD_AXIS_OPTIONS,
  GAMEPAD_BUTTON_OPTIONS,
  KEYBOARD_CODE_OPTIONS,
  MOUSE_BUTTON_OPTIONS,
  gamepadAxisLabel,
  gamepadButtonLabel,
  keyboardCodeLabel,
  mouseButtonLabel,
  type GamepadBindings,
  type InputBindings,
  type KeyboardBindings,
} from '../input/bindings';

type ControlsSettingsPanelProps = {
  open: boolean;
  bindings: InputBindings;
  inputFamilyMode: InputFamilyMode;
  onClose: () => void;
  onInputFamilyModeChange: (mode: InputFamilyMode) => void;
  onKeyboardBindingChange: <K extends keyof KeyboardBindings>(key: K, value: KeyboardBindings[K]) => void;
  onGamepadBindingChange: <K extends keyof GamepadBindings>(key: K, value: GamepadBindings[K]) => void;
  onKeyboardBindingReset: (key: keyof KeyboardBindings) => void;
  onGamepadBindingReset: (key: keyof GamepadBindings) => void;
  onResetAll: () => void;
};

type KeyboardKeyField = Exclude<keyof KeyboardBindings, 'firePrimaryMouseButton' | 'aimSecondaryMouseButton'>;

type BindingSectionProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
};

const inputModeOptions: Array<{ value: InputFamilyMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'keyboardMouse', label: 'Keyboard' },
  { value: 'gamepad', label: 'Gamepad' },
];

const keyboardRows: Array<{ key: KeyboardKeyField; label: string }> = [
  { key: 'moveForward', label: 'Move Forward' },
  { key: 'moveBackward', label: 'Move Backward' },
  { key: 'moveLeft', label: 'Move Left' },
  { key: 'moveRight', label: 'Move Right' },
  { key: 'jump', label: 'Jump' },
  { key: 'sprint', label: 'Sprint' },
  { key: 'crouch', label: 'Crouch' },
  { key: 'interact', label: 'Interact / Enter / Exit Vehicle' },
  { key: 'resetVehicle', label: 'Reset Vehicle' },
  { key: 'blockRemove', label: 'Remove Block' },
  { key: 'blockPlace', label: 'Place Block' },
  { key: 'materialSlot1', label: 'Material Slot 1' },
  { key: 'materialSlot2', label: 'Material Slot 2' },
  { key: 'handbrake', label: 'Vehicle Handbrake' },
];

const gamepadButtonRows: Array<{ key: Exclude<keyof GamepadBindings, 'moveXAxis' | 'moveYAxis' | 'lookXAxis' | 'lookYAxis'>; label: string }> = [
  { key: 'throttleButton', label: 'Vehicle Throttle' },
  { key: 'brakeButton', label: 'Vehicle Brake / Reverse' },
  { key: 'jumpButton', label: 'Jump' },
  { key: 'sprintButton', label: 'Sprint' },
  { key: 'crouchButton', label: 'Crouch' },
  { key: 'firePrimaryButton', label: 'Fire Primary' },
  { key: 'aimSecondaryButton', label: 'Aim / Scope' },
  { key: 'handbrakeButton', label: 'Vehicle Handbrake' },
  { key: 'interactButton', label: 'Interact / Enter / Exit Vehicle' },
  { key: 'resetVehicleButton', label: 'Reset Vehicle' },
  { key: 'blockRemoveButton', label: 'Remove Block' },
  { key: 'blockPlaceButton', label: 'Place Block' },
  { key: 'materialSlot1Button', label: 'Material Slot 1' },
  { key: 'materialSlot2Button', label: 'Material Slot 2' },
];

const gamepadAxisRows: Array<{ key: 'moveXAxis' | 'moveYAxis' | 'lookXAxis' | 'lookYAxis'; label: string }> = [
  { key: 'moveXAxis', label: 'Move Horizontal Axis' },
  { key: 'moveYAxis', label: 'Move Vertical Axis' },
  { key: 'lookXAxis', label: 'Look Horizontal Axis' },
  { key: 'lookYAxis', label: 'Look Vertical Axis' },
];

function BindingSection({ title, subtitle, children }: BindingSectionProps) {
  return (
    <section style={sectionStyle}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#86d6f5' }}>{title}</div>
        <div style={{ marginTop: 4, color: 'rgba(238, 247, 255, 0.6)', fontSize: 13 }}>{subtitle}</div>
      </div>
      {children}
    </section>
  );
}

export function ControlsSettingsPanel({
  open,
  bindings,
  inputFamilyMode,
  onClose,
  onInputFamilyModeChange,
  onKeyboardBindingChange,
  onGamepadBindingChange,
  onKeyboardBindingReset,
  onGamepadBindingReset,
  onResetAll,
}: ControlsSettingsPanelProps) {
  if (!open) return null;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#86d6f5' }}>
              Controls
            </div>
            <h2 style={{ margin: '10px 0 6px', fontSize: 30, lineHeight: 1, fontWeight: 700 }}>Runtime Bindings</h2>
            <p style={{ margin: 0, color: 'rgba(238, 247, 255, 0.66)', lineHeight: 1.5 }}>
              These defaults apply immediately and persist in local storage for all game sessions in this browser.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {inputModeOptions.map((option) => {
                const selected = option.value === inputFamilyMode;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => onInputFamilyModeChange(option.value)}
                    style={selected ? selectedPillStyle : pillStyle}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <button type="button" onClick={onResetAll} style={dangerButtonStyle}>Reset All</button>
            <button type="button" onClick={onClose} style={secondaryButtonStyle}>Close</button>
          </div>
        </div>

        <div style={bodyStyle}>
          <BindingSection title="Keyboard + Mouse" subtitle="Mouse look stays on pointer lock movement.">
            <div style={tableStyle}>
              {keyboardRows.map((row) => (
                <BindingRow
                  key={row.key}
                  label={row.label}
                  currentLabel={keyboardCodeLabel(bindings.keyboard[row.key])}
                  editor={(
                    <select
                      value={bindings.keyboard[row.key]}
                      onChange={(event) => onKeyboardBindingChange(row.key, event.target.value as KeyboardBindings[typeof row.key])}
                      style={selectStyle}
                    >
                      {KEYBOARD_CODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  )}
                  onReset={() => onKeyboardBindingReset(row.key)}
                />
              ))}
              <BindingRow
                label="Primary Fire"
                currentLabel={mouseButtonLabel(bindings.keyboard.firePrimaryMouseButton)}
                editor={(
                  <select
                    value={bindings.keyboard.firePrimaryMouseButton}
                    onChange={(event) => onKeyboardBindingChange('firePrimaryMouseButton', Number(event.target.value) as KeyboardBindings['firePrimaryMouseButton'])}
                    style={selectStyle}
                  >
                    {MOUSE_BUTTON_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                )}
                onReset={() => onKeyboardBindingReset('firePrimaryMouseButton')}
              />
              <BindingRow
                label="Aim / Scope"
                currentLabel={mouseButtonLabel(bindings.keyboard.aimSecondaryMouseButton)}
                editor={(
                  <select
                    value={bindings.keyboard.aimSecondaryMouseButton}
                    onChange={(event) => onKeyboardBindingChange('aimSecondaryMouseButton', Number(event.target.value) as KeyboardBindings['aimSecondaryMouseButton'])}
                    style={selectStyle}
                  >
                    {MOUSE_BUTTON_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                )}
                onReset={() => onKeyboardBindingReset('aimSecondaryMouseButton')}
              />
            </div>
          </BindingSection>

          <BindingSection title="Gamepad" subtitle="Stick axes and button mappings use the standard browser gamepad layout.">
            <div style={tableStyle}>
              {gamepadAxisRows.map((row) => (
                <BindingRow
                  key={row.key}
                  label={row.label}
                  currentLabel={gamepadAxisLabel(bindings.gamepad[row.key])}
                  editor={(
                    <select
                      value={bindings.gamepad[row.key]}
                      onChange={(event) => onGamepadBindingChange(row.key, Number(event.target.value) as GamepadBindings[typeof row.key])}
                      style={selectStyle}
                    >
                      {GAMEPAD_AXIS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  )}
                  onReset={() => onGamepadBindingReset(row.key)}
                />
              ))}
              {gamepadButtonRows.map((row) => (
                <BindingRow
                  key={row.key}
                  label={row.label}
                  currentLabel={gamepadButtonLabel(bindings.gamepad[row.key])}
                  editor={(
                    <select
                      value={bindings.gamepad[row.key]}
                      onChange={(event) => onGamepadBindingChange(row.key, Number(event.target.value) as GamepadBindings[typeof row.key])}
                      style={selectStyle}
                    >
                      {GAMEPAD_BUTTON_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  )}
                  onReset={() => onGamepadBindingReset(row.key)}
                />
              ))}
            </div>
          </BindingSection>
        </div>
      </div>
    </div>
  );
}

type BindingRowProps = {
  label: string;
  currentLabel: string;
  editor: ReactNode;
  onReset: () => void;
};

function BindingRow({ label, currentLabel, editor, onReset }: BindingRowProps) {
  return (
    <div style={rowStyle}>
      <div>
        <div style={{ fontSize: 13, color: '#eef7ff' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'rgba(238, 247, 255, 0.52)' }}>Current: {currentLabel}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {editor}
        <button type="button" onClick={onReset} style={rowResetStyle}>Reset</button>
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 25,
  background: 'rgba(3, 6, 10, 0.58)',
  backdropFilter: 'blur(12px)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  padding: 24,
};

const panelStyle: CSSProperties = {
  width: 'min(1120px, 100%)',
  maxHeight: 'min(86vh, 920px)',
  overflow: 'auto',
  borderRadius: 24,
  border: '1px solid rgba(134, 214, 245, 0.18)',
  background: 'linear-gradient(180deg, rgba(10, 17, 25, 0.98) 0%, rgba(6, 10, 16, 0.98) 100%)',
  boxShadow: '0 30px 120px rgba(0, 0, 0, 0.45)',
  padding: 24,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 18,
  alignItems: 'flex-start',
  marginBottom: 18,
  flexWrap: 'wrap',
};

const bodyStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 16,
};

const sectionStyle: CSSProperties = {
  borderRadius: 18,
  border: '1px solid rgba(134, 214, 245, 0.12)',
  background: 'rgba(13, 23, 34, 0.78)',
  padding: 16,
};

const tableStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'center',
  padding: '10px 12px',
  borderRadius: 14,
  background: 'rgba(6, 11, 17, 0.62)',
  border: '1px solid rgba(255, 255, 255, 0.05)',
};

const selectStyle: CSSProperties = {
  minWidth: 150,
  borderRadius: 10,
  border: '1px solid rgba(134, 214, 245, 0.16)',
  background: 'rgba(12, 19, 28, 0.94)',
  color: '#eef7ff',
  padding: '8px 10px',
  fontSize: 13,
};

const pillStyle: CSSProperties = {
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.06)',
  color: 'rgba(255,255,255,0.72)',
  padding: '8px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

const selectedPillStyle: CSSProperties = {
  ...pillStyle,
  background: 'rgba(116, 212, 255, 0.2)',
  color: '#eef7ff',
  border: '1px solid rgba(116, 212, 255, 0.28)',
};

const secondaryButtonStyle: CSSProperties = {
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.06)',
  color: '#eef7ff',
  padding: '10px 14px',
  fontSize: 13,
  cursor: 'pointer',
};

const dangerButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  border: '1px solid rgba(255, 134, 111, 0.3)',
  background: 'rgba(255, 134, 111, 0.16)',
};

const rowResetStyle: CSSProperties = {
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.04)',
  color: 'rgba(255,255,255,0.82)',
  padding: '8px 10px',
  fontSize: 12,
  cursor: 'pointer',
};
