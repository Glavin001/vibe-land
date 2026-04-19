import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INPUT_BINDINGS, loadInputBindings } from './bindings';

describe('loadInputBindings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills in the default aimSecondaryKey for older saved keyboard bindings', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => JSON.stringify({
          keyboard: {
            ...DEFAULT_INPUT_BINDINGS.keyboard,
            aimSecondaryKey: undefined,
          },
          gamepad: DEFAULT_INPUT_BINDINGS.gamepad,
        }),
      },
    });

    const bindings = loadInputBindings();

    expect(bindings.keyboard.aimSecondaryKey).toBe(DEFAULT_INPUT_BINDINGS.keyboard.aimSecondaryKey);
  });

  it('fills in newer keyboard and gamepad bindings for older saved configs', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => JSON.stringify({
          keyboard: {
            ...DEFAULT_INPUT_BINDINGS.keyboard,
            melee: undefined,
            aimSecondaryMouseButton: undefined,
            aimSecondaryKey: undefined,
          },
          gamepad: {
            ...DEFAULT_INPUT_BINDINGS.gamepad,
            aimSecondaryButton: undefined,
          },
        }),
      },
    });

    const bindings = loadInputBindings();

    expect(bindings.keyboard.melee).toBe(DEFAULT_INPUT_BINDINGS.keyboard.melee);
    expect(bindings.keyboard.aimSecondaryMouseButton).toBe(DEFAULT_INPUT_BINDINGS.keyboard.aimSecondaryMouseButton);
    expect(bindings.keyboard.aimSecondaryKey).toBe(DEFAULT_INPUT_BINDINGS.keyboard.aimSecondaryKey);
    expect(bindings.gamepad.aimSecondaryButton).toBe(DEFAULT_INPUT_BINDINGS.gamepad.aimSecondaryButton);
  });
});
