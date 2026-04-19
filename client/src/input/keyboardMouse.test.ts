import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_BINDINGS } from './bindings';
import { KeyboardMouseInputSource } from './keyboardMouse';

describe('KeyboardMouseInputSource', () => {
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
