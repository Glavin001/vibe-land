import { describe, expect, it } from 'vitest';
import { EnergyDisplay } from './energyDisplay';

/**
 * What the server sends for a steady drain (server/src/energy_stream.rs): the
 * value each time the displayed integer changes, at most every 100 ms.
 */
function serverMessages(start: number, perSec: number, seconds: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let lastInt = Number.NaN;
  let lastAt = Number.NEGATIVE_INFINITY;
  for (let tick = 0; tick <= seconds * 60; tick += 1) {
    const t = (tick * 1000) / 60;
    const v = Math.round((start - (perSec * tick) / 60) * 100) / 100;
    if (Math.floor(v) !== lastInt && t - lastAt >= 100 - 1e-9) {
      out.push([t, v]);
      lastInt = Math.floor(v);
      lastAt = t;
    }
  }
  return out;
}

/** The HUD reads the value at 10 Hz (useDebugStats OVERLAY_UPDATE_INTERVAL_MS). */
function hudReadings(display: EnergyDisplay, messages: Array<[number, number]>, untilMs: number) {
  const readings: Array<{ t: number; shown: number; server: number }> = [];
  let next = 0;
  for (let t = 0; t <= untilMs; t += 100 / 6) {
    while (next < messages.length && messages[next][0] <= t) {
      display.onSample(messages[next][1], messages[next][0]);
      next += 1;
    }
    readings.push({ t, shown: display.value(t), server: display.serverValue });
  }
  return readings;
}

describe('EnergyDisplay', () => {
  it('shows a new value exactly on arrival', () => {
    const d = new EnergyDisplay();
    d.onSample(543.21, 1000);
    expect(d.value(1000)).toBe(543.21);
    // With one sample there is no rate yet: it holds.
    expect(d.value(5000)).toBe(543.21);
  });

  it('keeps the HUD integer equal to the server value and never climbs between messages', () => {
    const d = new EnergyDisplay();
    const readings = hudReadings(d, serverMessages(1000, 3, 10), 10_000);
    for (let i = 1; i < readings.length; i += 1) {
      const { shown, server } = readings[i];
      // The integer the HUD prints is always the one the server last sent.
      expect(Math.floor(shown)).toBe(Math.floor(server));
      expect(shown).toBeLessThanOrEqual(server);
      // A drain only ever goes down on screen.
      expect(shown).toBeLessThanOrEqual(readings[i - 1].shown + 1e-9);
    }
  });

  it('moves the decimal smoothly instead of freezing between once-a-second messages', () => {
    const d = new EnergyDisplay();
    const readings = hudReadings(d, serverMessages(1000, 1, 10), 10_000);
    const late = readings.filter((r) => r.t > 2000);
    // Frame-to-frame change stays near the true drain (1/s = 0.0167 per frame)
    // -- no 1.0 jumps once a second.
    let maxStep = 0;
    for (let i = 1; i < late.length; i += 1) maxStep = Math.max(maxStep, late[i - 1].shown - late[i].shown);
    expect(maxStep).toBeLessThan(0.1);
    // And it is close to the truth throughout.
    for (const r of late) {
      const truth = 1000 - r.t / 1000;
      expect(Math.abs(r.shown - truth)).toBeLessThan(0.1);
    }
  });

  it('applies a gain (battery, respawn) at once', () => {
    const d = new EnergyDisplay();
    d.onSample(500.9, 0);
    d.onSample(499.9, 1000);
    expect(d.value(1500)).toBeLessThan(499.9);
    d.onSample(800, 1600);
    expect(d.value(1600)).toBe(800);
    // No drain is extrapolated from before the gain.
    expect(d.value(2500)).toBe(800);
  });

  it('does not extrapolate from a burst right after a keyframe', () => {
    const d = new EnergyDisplay();
    d.onSample(500.4, 1000); // keyframe
    d.onSample(499.9, 1001); // a change 1 ms later: 500 units/s, not a real drain
    expect(d.value(1500)).toBe(499.9);
  });

  it('does not reuse a rate across a long silence', () => {
    const d = new EnergyDisplay();
    d.onSample(500.5, 0);
    d.onSample(499.5, 1000);
    d.onSample(480.5, 60_000); // after a minute in a menu
    expect(d.value(61_000)).toBe(480.5);
  });

  it('never shows below zero or below the integer the server reported', () => {
    const d = new EnergyDisplay();
    d.onSample(1.5, 0);
    d.onSample(0.5, 100);
    expect(d.value(10_000)).toBe(0);
    d.onSample(0, 200);
    expect(d.value(10_000)).toBe(0);
  });

  it('reset forgets the rate and the value', () => {
    const d = new EnergyDisplay();
    d.onSample(501, 0);
    d.onSample(500.5, 500);
    d.reset();
    expect(d.value(600)).toBe(0);
    d.onSample(900, 700);
    expect(d.value(1700)).toBe(900);
  });
});
