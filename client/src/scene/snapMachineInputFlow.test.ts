import { describe, expect, it, beforeAll } from 'vitest';
import { KeyboardMouseInputSource } from '../input/keyboardMouse';
import { DEFAULT_INPUT_BINDINGS } from '../input/bindings';
import { resolveSnapMachineInput } from '../input/resolver';

// Same `window` shim as `keyboardMouse.test.ts` — vitest runs in Node
// by default and KeyboardMouseInputSource touches `window` in
// `attach()`. We never `attach()` here, we just poke the internal
// state directly.
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

/**
 * Rebuild the per-frame "live machine channels" exactly the way
 * `GameWorld.tsx` does it. This lets us verify the full pipeline
 * (sample → enrich → resolve → dispatch) without having to mount the
 * React tree.
 */
function computeLiveChannels(
  source: KeyboardMouseInputSource,
  actionChannels: string[],
  bindings: Array<{ action: string; posKey: string; negKey: string | null; scale: number }>,
): Int8Array {
  const channels = new Int8Array(8);
  for (let idx = 0; idx < actionChannels.length && idx < 8; idx += 1) {
    const action = actionChannels[idx];
    const binding = bindings.find((b) => b.action === action);
    if (!binding) continue;
    let value = 0;
    if (source.isCodeDown(binding.posKey)) value += 1;
    if (binding.negKey && source.isCodeDown(binding.negKey)) value -= 1;
    channels[idx] = Math.max(-127, Math.min(127, Math.round(value * 127)));
  }
  return channels;
}

describe('snap-machine input flow (GameWorld + resolver)', () => {
  it('holding E on the 4-wheel car populates motorSpin positive', () => {
    const source = new KeyboardMouseInputSource();
    const bindings = [{ action: 'motorSpin', posKey: 'KeyE', negKey: 'KeyQ', scale: 1 }];
    const actionChannels = ['motorSpin'];

    seed(source, ['KeyE'], []);
    const channels = computeLiveChannels(source, actionChannels, bindings);
    expect(channels[0]).toBe(127);

    const resolved = resolveSnapMachineInput(
      { family: 'keyboardMouse', activityId: 1, moveX: 0, moveY: 0, lookX: 0, lookY: 0, steer: 0,
        throttle: 0, brake: 0, jump: false, sprint: false, crouch: false, firePrimary: false,
        firePrimaryValue: 0, handbrake: false, interactPressed: false, resetVehiclePressed: false,
        blockRemovePressed: false, blockPlacePressed: false, materialSlot1Pressed: false,
        materialSlot2Pressed: false },
      0, 0, 'keyboardMouse', channels,
    );
    expect(resolved.machineChannels?.[0]).toBe(127);
    expect(resolved.buttons).toBe(0);
    // `interactPressed` in the resolved result comes from the
    // ActionSnapshot — NOT from KeyE. With `context === 'snapMachine'`
    // the sample routes interactPressed via the `machineExit` key
    // (KeyB). Neither KeyB is held nor justPressed → false.
    expect(resolved.interactPressed).toBe(false);
  });

  it('holding Q on the 4-wheel car populates motorSpin negative', () => {
    const source = new KeyboardMouseInputSource();
    const bindings = [{ action: 'motorSpin', posKey: 'KeyE', negKey: 'KeyQ', scale: 1 }];
    seed(source, ['KeyQ'], []);
    const channels = computeLiveChannels(source, ['motorSpin'], bindings);
    expect(channels[0]).toBe(-127);
  });

  it('crane: holding W populates armPitch, holding D populates armYaw, holding R populates armPitchElbow', () => {
    const source = new KeyboardMouseInputSource();
    const bindings = [
      { action: 'armPitch', posKey: 'KeyW', negKey: 'KeyS', scale: 1 },
      { action: 'armPitchElbow', posKey: 'KeyR', negKey: 'KeyF', scale: 1 },
      { action: 'armYaw', posKey: 'KeyD', negKey: 'KeyA', scale: 1 },
    ];
    // Crane derives action_channels alphabetically: armPitch (0),
    // armPitchElbow (1), armYaw (2).
    const actionChannels = ['armPitch', 'armPitchElbow', 'armYaw'];

    seed(source, ['KeyW', 'KeyD', 'KeyR'], []);
    const channels = computeLiveChannels(source, actionChannels, bindings);
    expect(channels[0]).toBe(127); // armPitch+
    expect(channels[1]).toBe(127); // armPitchElbow+
    expect(channels[2]).toBe(127); // armYaw+
  });

  it('pressing E while operating a snap-machine does NOT fire exit', () => {
    // The fundamental guarantee of the `machineExit` fix: E is now a
    // pure motor key in snap-machine context, Q is pure motor
    // negative, and only B can exit. If this ever regresses the
    // user's first tap of E after entering the car will dump them
    // back to on-foot before the motor can run.
    const source = new KeyboardMouseInputSource();
    seed(source, ['KeyE'], ['KeyE']);
    const sample = source.sample(false, 'snapMachine', DEFAULT_INPUT_BINDINGS);
    expect(sample.interactPressed).toBe(false);
  });

  it('pressing B while operating a snap-machine DOES fire exit', () => {
    const source = new KeyboardMouseInputSource();
    seed(source, ['KeyB'], ['KeyB']);
    const sample = source.sample(false, 'snapMachine', DEFAULT_INPUT_BINDINGS);
    expect(sample.interactPressed).toBe(true);
  });
});
