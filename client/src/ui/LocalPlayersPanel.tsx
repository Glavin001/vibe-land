import { useEffect, useState } from 'react';
import type { LocalDeviceAssignment } from '../input/types';
import {
  MAX_LOCAL_PLAYERS,
  deviceKey,
  isDeviceTakenBy,
  type LocalPlayerSlot,
} from '../app/localPlayers';

interface LocalPlayersPanelProps {
  visible: boolean;
  slots: LocalPlayerSlot[];
  onAddSlot: () => void;
  onRemoveSlot: (slotId: number) => void;
  onChangeDevice: (slotId: number, device: LocalDeviceAssignment) => void;
}

interface GamepadOption {
  index: number;
  label: string;
  connected: boolean;
}

function snapshotGamepads(): GamepadOption[] {
  const pads = (typeof navigator !== 'undefined' ? navigator.getGamepads?.() : null) ?? [];
  const options: GamepadOption[] = [];
  for (let index = 0; index < 4; index += 1) {
    const pad = pads[index];
    options.push({
      index,
      label: pad && pad.connected ? (pad.id || `Gamepad ${index}`) : `Gamepad ${index} (disconnected)`,
      connected: Boolean(pad && pad.connected),
    });
  }
  return options;
}

function useGamepadOptions(): GamepadOption[] {
  const [options, setOptions] = useState<GamepadOption[]>(() => snapshotGamepads());
  useEffect(() => {
    const refresh = () => setOptions(snapshotGamepads());
    window.addEventListener('gamepadconnected', refresh);
    window.addEventListener('gamepaddisconnected', refresh);
    // Browsers only fire gamepad events after interaction; poll lightly.
    const interval = window.setInterval(refresh, 1500);
    return () => {
      window.removeEventListener('gamepadconnected', refresh);
      window.removeEventListener('gamepaddisconnected', refresh);
      window.clearInterval(interval);
    };
  }, []);
  return options;
}

function deviceToValue(device: LocalDeviceAssignment): string {
  return device.family === 'keyboardMouse' ? 'kbm' : `gp:${device.index}`;
}

function valueToDevice(value: string): LocalDeviceAssignment | null {
  if (value === 'kbm') return { family: 'keyboardMouse' };
  if (value.startsWith('gp:')) {
    const index = Number.parseInt(value.slice(3), 10);
    if (Number.isFinite(index) && index >= 0 && index < 4) {
      return { family: 'gamepad', index };
    }
  }
  return null;
}

export function LocalPlayersPanel({
  visible,
  slots,
  onAddSlot,
  onRemoveSlot,
  onChangeDevice,
}: LocalPlayersPanelProps) {
  const [open, setOpen] = useState(false);
  const pads = useGamepadOptions();

  if (!visible) return null;

  const canAdd = slots.length < MAX_LOCAL_PLAYERS;

  return (
    <div className="absolute right-2 top-[5.25rem] z-[12] flex flex-col items-end gap-1 font-sans text-white">
      <button
        type="button"
        className="min-w-28 rounded-md border border-white/[0.12] bg-black/60 px-3 py-1.5 text-left text-xs text-white shadow-[0_8px_18px_rgba(0,0,0,0.3)] backdrop-blur-sm transition-colors hover:bg-black/[0.72]"
        onClick={() => setOpen((value) => !value)}
        data-testid="local-players-toggle"
      >
        {open ? '▼ Players' : '▶ Players'} · {slots.length}
      </button>
      {open && (
        <div
          className="flex min-w-[20rem] max-w-[28rem] flex-col gap-3 rounded-xl border border-white/[0.12] bg-black/70 px-3 py-3 shadow-[0_14px_36px_rgba(0,0,0,0.42)] backdrop-blur-md"
          data-testid="local-players-panel"
        >
          <div className="text-[11px] uppercase tracking-[0.12em] text-white/60">
            Local split-screen
          </div>
          {slots.map((slot) => {
            const options: Array<{ value: string; label: string; disabledReason: string | null }> = [];
            const keyboardTaker = isDeviceTakenBy({ family: 'keyboardMouse' }, slots, slot.slotId);
            options.push({
              value: 'kbm',
              label: 'Keyboard & Mouse',
              disabledReason: keyboardTaker != null ? `(Player ${keyboardTaker + 1})` : null,
            });
            for (const pad of pads) {
              const taker = isDeviceTakenBy({ family: 'gamepad', index: pad.index }, slots, slot.slotId);
              const suffix = !pad.connected ? ' (disconnected)' : taker != null ? ` (Player ${taker + 1})` : '';
              options.push({
                value: `gp:${pad.index}`,
                label: `Gamepad ${pad.index}${suffix}`,
                disabledReason: taker != null ? `Player ${taker + 1}` : null,
              });
            }
            const currentValue = deviceToValue(slot.device);
            return (
              <div
                key={slot.slotId}
                className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-2"
                data-testid={`local-player-slot-${slot.slotId}`}
              >
                <span className="w-10 shrink-0 text-[11px] uppercase tracking-[0.12em] text-white/60">
                  P{slot.slotId + 1}
                </span>
                <select
                  className="flex-1 rounded border border-white/10 bg-black/60 px-2 py-1 text-xs text-white"
                  value={currentValue}
                  onChange={(event) => {
                    const next = valueToDevice(event.target.value);
                    if (next) onChangeDevice(slot.slotId, next);
                  }}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.disabledReason != null && option.value !== currentValue}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {slot.slotId !== 0 && (
                  <button
                    type="button"
                    onClick={() => onRemoveSlot(slot.slotId)}
                    className="rounded border border-white/10 bg-black/60 px-2 py-1 text-[11px] text-white/80 hover:bg-white/[0.08]"
                    data-testid={`local-player-remove-${slot.slotId}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="self-start rounded border border-white/10 bg-black/60 px-3 py-1.5 text-xs text-white disabled:opacity-40"
            onClick={onAddSlot}
            disabled={!canAdd}
            data-testid="local-players-add"
          >
            + Add player
          </button>
          <div className="text-[10px] text-white/40">
            Each device can only be owned by one player. Disconnected gamepads contribute no input until replugged.
          </div>
        </div>
      )}
    </div>
  );
}

export function deviceLabel(device: LocalDeviceAssignment, pads: GamepadOption[]): string {
  if (device.family === 'keyboardMouse') return 'Keyboard & Mouse';
  const pad = pads.find((entry) => entry.index === device.index);
  return pad ? pad.label : `Gamepad ${device.index}`;
}

export { deviceKey };
