import { afterEach, describe, expect, it } from 'vitest';

import { cityTapeRecorder } from './cityTape';

const packet = (n: number) => new Uint8Array([n, n + 1, n + 2]);

describe('cityTapeRecorder ownership', () => {
  afterEach(() => {
    // Leave no recording behind for the next case, whoever owns it.
    for (let session = 0; session < 1000 && cityTapeRecorder.recording; session += 1) cityTapeRecorder.stop(session);
  });

  it('records and stops a manual tape', () => {
    const session = cityTapeRecorder.start('manual');
    expect(session).toBeGreaterThan(0);
    cityTapeRecorder.push(packet(1));
    const tape = cityTapeRecorder.stop(session);
    expect(tape?.packets.length).toBe(1);
    expect(cityTapeRecorder.recording).toBe(false);
  });

  it('keeps a manual recording when the hot-spot timer that started it fires', () => {
    const hotspot = cityTapeRecorder.start('hotspot');
    cityTapeRecorder.push(packet(1));
    const manual = cityTapeRecorder.start('manual');
    expect(manual).toBeGreaterThan(hotspot);
    expect(cityTapeRecorder.currentOwner).toBe('manual');
    // The hot-spot's 20 s timer expires: its stale session must stop nothing.
    expect(cityTapeRecorder.stop(hotspot)).toBeNull();
    expect(cityTapeRecorder.recording).toBe(true);
    cityTapeRecorder.push(packet(2));
    const tape = cityTapeRecorder.stop(manual);
    // The takeover keeps what the hot-spot had captured.
    expect(tape?.packets.length).toBe(2);
  });

  it('does not let the hot-spot watch or e2e start over a manual recording', () => {
    const manual = cityTapeRecorder.start('manual');
    expect(cityTapeRecorder.start('hotspot')).toBe(0);
    expect(cityTapeRecorder.start('e2e')).toBe(0);
    expect(cityTapeRecorder.currentOwner).toBe('manual');
    expect(cityTapeRecorder.stop(manual)).not.toBeNull();
  });

  it('never lets a stale session stop a later recording', () => {
    const first = cityTapeRecorder.start('hotspot');
    expect(cityTapeRecorder.stop(first)).not.toBeNull();
    const second = cityTapeRecorder.start('hotspot');
    expect(cityTapeRecorder.stop(first)).toBeNull();
    expect(cityTapeRecorder.stop(0)).toBeNull();
    expect(cityTapeRecorder.recording).toBe(true);
    expect(cityTapeRecorder.stop(second)).not.toBeNull();
  });

  it('keeps a long manual recording whole across repeated hot-spot attempts', () => {
    const manual = cityTapeRecorder.start('manual');
    for (let i = 0; i < 50; i += 1) {
      cityTapeRecorder.push(packet(i));
      const attempt = cityTapeRecorder.start('hotspot');
      expect(attempt).toBe(0);
      expect(cityTapeRecorder.stop(attempt)).toBeNull();
    }
    expect(cityTapeRecorder.stop(manual)?.packets.length).toBe(50);
  });
});
