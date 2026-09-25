import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_BINDINGS } from './bindings';
import { KeyboardMouseInputSource } from './keyboardMouse';
import { resolveVehicleInput } from './resolver';
import { BTN_JUMP } from '../net/sharedConstants';

describe('KeyboardMouseInputSource', () => {
  it('keeps Space as handbrake while W is held and releases it on key-up', () => {
    const source = new KeyboardMouseInputSource() as KeyboardMouseInputSource & {
      keys: Set<string>;
    };
    source.keys.add('KeyW');
    source.keys.add('Space');
    for (let tick = 0; tick < 3; tick++) {
      const snapshot = source.sample(true, 'vehicle', DEFAULT_INPUT_BINDINGS);
      const input = resolveVehicleInput(snapshot, 0, 0, 'keyboardMouse');
      expect(input.buttons & BTN_JUMP).toBe(BTN_JUMP);
      expect(snapshot.throttle).toBe(1);
    }
    source.keys.delete('Space');
    const released = source.sample(true, 'vehicle', DEFAULT_INPUT_BINDINGS);
    expect(released.handbrake).toBe(false);
    expect(released.throttle).toBe(1);
  });

  it('treats the aimSecondary keyboard key as ADS input while pointer locked', () => {
    const source = new KeyboardMouseInputSource() as KeyboardMouseInputSource & {
      keys: Set<string>;
    };
    source.keys.add(DEFAULT_INPUT_BINDINGS.keyboard.aimSecondaryKey);

    const snapshot = source.sample(true, 'onFoot', DEFAULT_INPUT_BINDINGS);

    expect(snapshot.aimSecondary).toBe(true);
  });

  it('still requires pointer lock for aimSecondary keyboard ADS', () => {
    const source = new KeyboardMouseInputSource() as KeyboardMouseInputSource & {
      keys: Set<string>;
    };
    source.keys.add(DEFAULT_INPUT_BINDINGS.keyboard.aimSecondaryKey);

    const snapshot = source.sample(false, 'onFoot', DEFAULT_INPUT_BINDINGS);

    expect(snapshot.aimSecondary).toBe(false);
  });
});
