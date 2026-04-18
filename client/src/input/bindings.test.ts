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
});
