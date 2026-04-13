import {
  gamepadAxisLabel,
  gamepadButtonLabel,
  keyboardCodeLabel,
  mouseButtonLabel,
  type InputBindings,
} from '../input/bindings';
import type { ActionSnapshot, DeviceFamily, InputContext, InputFamilyMode } from '../input/types';
import type { ControlHintsState } from './useControlHints';

type ControlHintsOverlayProps = {
  bindings: InputBindings;
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

function formatKeyboardMoveBinding(bindings: InputBindings['keyboard']): string {
  return `${keyboardCodeLabel(bindings.moveForward)} ${keyboardCodeLabel(bindings.moveLeft)} ${keyboardCodeLabel(bindings.moveBackward)} ${keyboardCodeLabel(bindings.moveRight)}`;
}

/**
 * Label a DOM `KeyboardEvent.code` string for the hints overlay.
 * Snap-machine envelopes ship raw codes (like "KeyE" / "Space" / "KeyR")
 * that aren't constrained to our fixed `KeyboardCodeBinding` union, so
 * we format them inline instead of round-tripping through
 * `keyboardCodeLabel`.
 */
function formatDomKey(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

function buildRows(
  family: DeviceFamily,
  context: InputContext,
  action: ActionSnapshot | null,
  bindings: InputBindings,
  machineBindings: ReadonlyArray<{
    action: string;
    posKey: string;
    negKey: string | null;
    scale: number;
  }>,
  machineChannels: Int8Array,
): RowSpec[] {
  if (context === 'snapMachine') {
    // Snap-machine hints: one row per action channel + a trailing
    // Exit row showing the dedicated `machineExit` key. Each action
    // row lights up based on its live channel value so the player
    // sees keys register in real time.
    const rows: RowSpec[] = machineBindings.map((binding, idx) => {
      const raw = machineChannels.length > idx ? machineChannels[idx] : 0;
      const magnitude = clamp01(Math.abs(raw) / 127);
      return {
        command: binding.action,
        binding: binding.negKey
          ? `${formatDomKey(binding.negKey)} / ${formatDomKey(binding.posKey)}`
          : formatDomKey(binding.posKey),
        value: magnitude,
        active: magnitude > 0.01,
      };
    });
    rows.push({
      command: 'Exit Machine',
      binding: keyboardCodeLabel(bindings.keyboard.machineExit),
      value: boolValue(action?.interactPressed ?? false),
      active: action?.interactPressed ?? false,
    });
    return rows;
  }
  if (context === 'vehicle') {
    if (family === 'gamepad') {
      const gamepad = bindings.gamepad;
      return [
        { command: 'Steer', binding: gamepadAxisLabel(gamepad.moveXAxis), value: clamp01(Math.abs(action?.steer ?? 0)) },
        { command: 'Throttle', binding: gamepadButtonLabel(gamepad.throttleButton), value: clamp01(action?.throttle ?? 0) },
        { command: 'Brake / Reverse', binding: gamepadButtonLabel(gamepad.brakeButton), value: clamp01(action?.brake ?? 0) },
        { command: 'Camera', binding: gamepadAxisLabel(gamepad.lookXAxis), value: axisStrength(action?.lookX ?? 0, action?.lookY ?? 0, 0.03) },
        { command: 'Handbrake', binding: gamepadButtonLabel(gamepad.handbrakeButton), value: boolValue(action?.handbrake ?? false), active: action?.handbrake ?? false },
        { command: 'Reset Vehicle', binding: gamepadButtonLabel(gamepad.resetVehicleButton), value: boolValue(action?.resetVehiclePressed ?? false), active: action?.resetVehiclePressed ?? false },
        { command: 'Exit Vehicle', binding: gamepadButtonLabel(gamepad.interactButton), value: boolValue(action?.interactPressed ?? false), active: action?.interactPressed ?? false },
      ];
    }
    const keyboard = bindings.keyboard;
    return [
      { command: 'Steer', binding: `${keyboardCodeLabel(keyboard.moveLeft)} / ${keyboardCodeLabel(keyboard.moveRight)}`, value: clamp01(Math.abs(action?.steer ?? action?.moveX ?? 0)) },
      { command: 'Throttle', binding: keyboardCodeLabel(keyboard.moveForward), value: clamp01(action?.throttle ?? 0) },
      { command: 'Brake / Reverse', binding: keyboardCodeLabel(keyboard.moveBackward), value: clamp01(action?.brake ?? 0) },
      { command: 'Camera', binding: 'Mouse / Trackpad', value: axisStrength(action?.lookX ?? 0, action?.lookY ?? 0, 0.03) },
      { command: 'Handbrake', binding: keyboardCodeLabel(keyboard.handbrake), value: boolValue(action?.handbrake ?? false), active: action?.handbrake ?? false },
      { command: 'Reset Vehicle', binding: keyboardCodeLabel(keyboard.resetVehicle), value: boolValue(action?.resetVehiclePressed ?? false), active: action?.resetVehiclePressed ?? false },
      { command: 'Exit Vehicle', binding: keyboardCodeLabel(keyboard.interact), value: boolValue(action?.interactPressed ?? false), active: action?.interactPressed ?? false },
    ];
  }

  if (family === 'gamepad') {
    const gamepad = bindings.gamepad;
    return [
      { command: 'Move', binding: gamepadAxisLabel(gamepad.moveXAxis), value: axisStrength(action?.moveX ?? 0, action?.moveY ?? 0) },
      { command: 'Look', binding: gamepadAxisLabel(gamepad.lookXAxis), value: axisStrength(action?.lookX ?? 0, action?.lookY ?? 0, 0.03) },
      { command: 'Shoot', binding: gamepadButtonLabel(gamepad.firePrimaryButton), value: clamp01(action?.firePrimaryValue ?? 0), active: action?.firePrimary ?? false },
      { command: 'Jump', binding: gamepadButtonLabel(gamepad.jumpButton), value: boolValue(action?.jump ?? false), active: action?.jump ?? false },
      { command: 'Sprint', binding: gamepadButtonLabel(gamepad.sprintButton), value: boolValue(action?.sprint ?? false), active: action?.sprint ?? false },
      { command: 'Crouch', binding: gamepadButtonLabel(gamepad.crouchButton), value: boolValue(action?.crouch ?? false), active: action?.crouch ?? false },
      { command: 'Interact / Car', binding: gamepadButtonLabel(gamepad.interactButton), value: boolValue(action?.interactPressed ?? false), active: action?.interactPressed ?? false },
      { command: 'Remove Block', binding: gamepadButtonLabel(gamepad.blockRemoveButton), value: boolValue(action?.blockRemovePressed ?? false), active: action?.blockRemovePressed ?? false },
      { command: 'Place Block', binding: gamepadButtonLabel(gamepad.blockPlaceButton), value: boolValue(action?.blockPlacePressed ?? false), active: action?.blockPlacePressed ?? false },
      { command: 'Material 1 / 2', binding: `${gamepadButtonLabel(gamepad.materialSlot1Button)} / ${gamepadButtonLabel(gamepad.materialSlot2Button)}`, value: boolValue(Boolean(action?.materialSlot1Pressed || action?.materialSlot2Pressed)), active: Boolean(action?.materialSlot1Pressed || action?.materialSlot2Pressed) },
    ];
  }

  const keyboard = bindings.keyboard;
  return [
    { command: 'Move', binding: formatKeyboardMoveBinding(keyboard), value: axisStrength(action?.moveX ?? 0, action?.moveY ?? 0) },
    { command: 'Look', binding: 'Mouse / Trackpad', value: axisStrength(action?.lookX ?? 0, action?.lookY ?? 0, 0.03) },
    { command: 'Shoot', binding: mouseButtonLabel(keyboard.firePrimaryMouseButton), value: clamp01(action?.firePrimaryValue ?? 0), active: action?.firePrimary ?? false },
    { command: 'Jump', binding: keyboardCodeLabel(keyboard.jump), value: boolValue(action?.jump ?? false), active: action?.jump ?? false },
    { command: 'Sprint', binding: keyboardCodeLabel(keyboard.sprint), value: boolValue(action?.sprint ?? false), active: action?.sprint ?? false },
    { command: 'Crouch', binding: keyboardCodeLabel(keyboard.crouch), value: boolValue(action?.crouch ?? false), active: action?.crouch ?? false },
    { command: 'Interact / Car', binding: keyboardCodeLabel(keyboard.interact), value: boolValue(action?.interactPressed ?? false), active: action?.interactPressed ?? false },
    { command: 'Remove Block', binding: keyboardCodeLabel(keyboard.blockRemove), value: boolValue(action?.blockRemovePressed ?? false), active: action?.blockRemovePressed ?? false },
    { command: 'Place Block', binding: keyboardCodeLabel(keyboard.blockPlace), value: boolValue(action?.blockPlacePressed ?? false), active: action?.blockPlacePressed ?? false },
    { command: 'Material 1 / 2', binding: `${keyboardCodeLabel(keyboard.materialSlot1)} / ${keyboardCodeLabel(keyboard.materialSlot2)}`, value: boolValue(Boolean(action?.materialSlot1Pressed || action?.materialSlot2Pressed)), active: Boolean(action?.materialSlot1Pressed || action?.materialSlot2Pressed) },
  ];
}

const MODE_OPTIONS: Array<{ mode: InputFamilyMode; label: string }> = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'keyboardMouse', label: 'Keyboard' },
  { mode: 'gamepad', label: 'Gamepad' },
];

export function ControlHintsOverlay({
  bindings,
  state,
  visible,
  inputFamilyMode,
  onInputFamilyModeChange,
}: ControlHintsOverlayProps) {
  if (!visible) return null;

  const family = state.activeFamily ?? 'keyboardMouse';
  const context = state.context;
  const rows = buildRows(
    family,
    context,
    state.action,
    bindings,
    state.machineBindings,
    state.machineChannels,
  );
  const contextLabel =
    context === 'snapMachine'
      ? state.machineDisplayName ?? 'Machine'
      : context === 'vehicle'
        ? 'Vehicle'
        : 'On Foot';
  const title = `${family === 'gamepad' ? 'Gamepad' : 'Keyboard + Mouse'} · ${contextLabel}`;

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
