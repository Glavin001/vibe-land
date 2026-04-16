import { describe, expect, it } from 'vitest';

import { FixedInputBundler } from './fixedInputBundler';

describe('FixedInputBundler', () => {
  it('emits one input per fixed tick', () => {
    const bundler = new FixedInputBundler(1 / 60, 4);
    const inputs = bundler.produce(1 / 60, {
      moveX: 0,
      moveY: 1,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.seq).toBe(1);
    expect(inputs[0]?.moveY).toBe(127);
  });

  it('caps catchup steps and preserves next sequence', () => {
    const bundler = new FixedInputBundler(1 / 60, 2);
    const inputs = bundler.produce(5 / 60, {
      moveX: 0,
      moveY: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    });

    expect(inputs.map((input) => input.seq)).toEqual([1, 2]);
    expect(bundler.peekNextSeq()).toBe(3);
  });

  it('reset clears accumulated time and sequence state', () => {
    const bundler = new FixedInputBundler(1 / 60, 4);
    bundler.produce(3 / 60, {
      moveX: 0,
      moveY: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    });

    bundler.reset(10);

    const inputs = bundler.produce(1 / 60, {
      moveX: 1,
      moveY: 0,
      yaw: 0.25,
      pitch: -0.1,
      buttons: 0,
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.seq).toBe(10);
  });
});
