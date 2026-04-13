import { describe, expect, it, beforeAll } from 'vitest';
import { KeyboardMouseInputSource } from './keyboardMouse';
import { DEFAULT_INPUT_BINDINGS } from './bindings';

// Vitest runs under Node by default; KeyboardMouseInputSource uses
// `window.addEventListener` in its `attach()` method. For these unit
// tests we never call `attach()` — instead we stub `window` enough to
// let the constructor run, and we directly seed the private `keys` /
// `justPressedKeys` sets via a typed escape hatch. All we care about
// is the sampling logic (context-dependent `interactPressed` routing,
// `isCodeDown`), not the event-listener plumbing.
beforeAll(() => {
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    (globalThis as { window: unknown }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
});

type Internals = {
  keys: Set<string>;
  justPressedKeys: Set<string>;
  mouseButtons: Set<number>;
};

function seed(source: KeyboardMouseInputSource, keys: string[], justPressed: string[] = keys) {
  const internals = source as unknown as Internals;
  internals.keys = new Set(keys);
  internals.justPressedKeys = new Set(justPressed);
  internals.mouseButtons = new Set();
}

describe('KeyboardMouseInputSource', () => {
  it('routes interactPressed through KeyE when on foot', () => {
    const source = new KeyboardMouseInputSource();
    seed(source, ['KeyE']);
    const sample = source.sample(false, 'onFoot', DEFAULT_INPUT_BINDINGS);
    expect(sample.interactPressed).toBe(true);
  });

  it('does NOT fire interactPressed on KeyE while operating a snap-machine', () => {
    // The whole point of the `machineExit` binding: pressing E (which
    // the upstream snap-machines control map assigns to `motorSpin+`)
    // must NOT exit the machine. Without this guard the user's first
    // tap of E after entering the car immediately kicks them back to
    // on-foot, which is exactly the bug this fix targets.
    const source = new KeyboardMouseInputSource();
    seed(source, ['KeyE']);
    const sample = source.sample(false, 'snapMachine', DEFAULT_INPUT_BINDINGS);
    expect(sample.interactPressed).toBe(false);
  });

  it('fires interactPressed on the dedicated machineExit key (KeyB) in snap-machine context', () => {
    const source = new KeyboardMouseInputSource();
    seed(source, ['KeyB']);
    const sample = source.sample(false, 'snapMachine', DEFAULT_INPUT_BINDINGS);
    expect(sample.interactPressed).toBe(true);
  });

  it('does NOT fire interactPressed on KeyB while on foot (only via KeyE)', () => {
    const source = new KeyboardMouseInputSource();
    seed(source, ['KeyB']);
    const sample = source.sample(false, 'onFoot', DEFAULT_INPUT_BINDINGS);
    expect(sample.interactPressed).toBe(false);
  });

  it('isCodeDown reflects held keys regardless of context', () => {
    const source = new KeyboardMouseInputSource();
    seed(source, ['KeyE', 'KeyQ'], []);
    expect(source.isCodeDown('KeyE')).toBe(true);
    expect(source.isCodeDown('KeyQ')).toBe(true);
    expect(source.isCodeDown('KeyR')).toBe(false);
  });
});
