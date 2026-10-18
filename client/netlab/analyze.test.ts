import { describe, expect, it } from 'vitest';

import { computeClientMetrics, type FrameTable, type RecorderEventRow } from './analyze';
import { FRAME_COLUMNS } from '../src/netlab/recorder';

const FPS = 60;
const DT_MS = 1000 / FPS;
const SNAPSHOT_HZ = 30;
/** analyze.ts skips the first 3 s; give every fixture a settled prefix. */
const SETTLE_FRAMES = Math.ceil((3000 / DT_MS) * 1.2);

interface SynthFrame {
  render: [number, number, number];
  authVel: [number, number, number];
  /** Authoritative position. Defaults to `render` (a perfectly tracking client). */
  auth?: [number, number, number];
  correction?: number;
  pendingInputs?: number;
}

/** Build a FrameTable with the real schema so column indices match production. */
function buildFrames(frames: SynthFrame[]): FrameTable {
  const index = new Map(FRAME_COLUMNS.map((c, i) => [c, i]));
  const rows = frames.map((f, i) => {
    const row = new Array<number>(FRAME_COLUMNS.length).fill(0);
    const set = (name: string, value: number): void => {
      row[index.get(name as (typeof FRAME_COLUMNS)[number])!] = value;
    };
    set('tMs', i * DT_MS);
    set('frameDeltaMs', DT_MS);
    set('renderX', f.render[0]);
    set('renderY', f.render[1]);
    set('renderZ', f.render[2]);
    const auth = f.auth ?? f.render;
    set('authX', auth[0]);
    set('authY', auth[1]);
    set('authZ', auth[2]);
    set('authVelX', f.authVel[0]);
    set('authVelY', f.authVel[1]);
    set('authVelZ', f.authVel[2]);
    set('playerCorrectionM', f.correction ?? 0);
    set('pendingInputs', f.pendingInputs ?? 0);
    set('remoteX', Number.NaN);
    set('remoteY', Number.NaN);
    set('remoteZ', Number.NaN);
    return row;
  });
  return {
    columns: [...FRAME_COLUMNS],
    rows,
    col(name: string): number {
      const i = index.get(name as (typeof FRAME_COLUMNS)[number]);
      if (i === undefined) throw new Error(`missing column ${name}`);
      return i;
    },
  };
}

/** Steady 5 m/s motion along +X. */
function steadyMotion(count: number, startX = 0): SynthFrame[] {
  const speed = 5;
  const step = speed / FPS;
  return Array.from({ length: count }, (_, i) => ({
    render: [startX + i * step, 0, 0] as [number, number, number],
    authVel: [speed, 0, 0] as [number, number, number],
  }));
}

function metricsFor(frames: SynthFrame[], events: RecorderEventRow[] = []) {
  return computeClientMetrics(buildFrames(frames), events, 0, 'mover', SNAPSHOT_HZ);
}

function snapshotEvents(count: number, gapMs: number, startTMs = 0): RecorderEventRow[] {
  return Array.from({ length: count }, (_, i) => ({
    tMs: startTMs + i * gapMs,
    seq: i,
    type: 'snapshot_received',
    data: { gapMs, source: 'wt-datagram', serverTick: i },
  }));
}

describe('netlab analyzer', () => {
  it('reports a clean bill of health for perfectly smooth motion', () => {
    const m = metricsFor(steadyMotion(SETTLE_FRAMES + 600));
    expect(m.freezePct).toBe(0);
    expect(m.microReversalPct).toBe(0);
    expect(m.teleportSteps).toBe(0);
    expect(m.excessStepP95CmP99).toBeCloseTo(0, 3);
    expect(m.correctionP95CmP99).toBeCloseTo(0, 3);
    expect(m.fpsMean).toBeCloseTo(FPS, 0);
  });

  it('detects a freeze: authority advances while the render stands still', () => {
    const frames = steadyMotion(SETTLE_FRAMES + 300);
    const heldX = frames[frames.length - 1].render[0];
    const step = 5 / FPS;
    // Authority keeps advancing for 60 frames (1 s); the render is stuck.
    for (let i = 0; i < 60; i += 1) {
      frames.push({
        render: [heldX, 0, 0],
        auth: [heldX + (i + 1) * step, 0, 0],
        authVel: [5, 0, 0],
      });
    }
    frames.push(...steadyMotion(300, heldX));

    const m = metricsFor(frames);
    expect(m.freezePct).toBeGreaterThan(5);
    expect(m.freezeRunMaxMs).toBeGreaterThan(900);
  });

  it('does not call a blocked player frozen when the client tracks authority exactly', () => {
    // Regression: a player walked into rubble keeps a 6 m/s desired KCC
    // velocity while going nowhere. Client and server agree the position is
    // static, so nothing is visually wrong — this must not score as a freeze.
    const frames = steadyMotion(SETTLE_FRAMES + 300);
    const stuck = frames[frames.length - 1].render;
    for (let i = 0; i < 120; i += 1) {
      frames.push({ render: [...stuck], auth: [...stuck], authVel: [0, -0.5, 6] });
    }

    const m = metricsFor(frames);
    expect(m.freezePct).toBe(0);
    expect(m.freezeRunMaxMs).toBe(0);
  });

  it('detects a teleport: a rendered step far beyond what velocity explains', () => {
    const frames = steadyMotion(SETTLE_FRAMES + 300);
    const lastX = frames[frames.length - 1].render[0];
    // A 3 m jump in one frame at 5 m/s (which explains only ~8 cm).
    frames.push({ render: [lastX + 3, 0, 0], authVel: [5, 0, 0] });
    frames.push(...steadyMotion(300, lastX + 3));

    const m = metricsFor(frames);
    expect(m.teleportSteps).toBe(1);
    expect(m.excessStepMaxCm).toBeGreaterThan(250);
  });

  it('detects micro-reversals the client introduced', () => {
    const frames = steadyMotion(SETTLE_FRAMES);
    let x = frames[frames.length - 1].render[0];
    let authX = x;
    const step = 5 / FPS;
    // Render oscillates forward/back while authority advances steadily.
    for (let i = 0; i < 400; i += 1) {
      x += i % 2 === 0 ? 0.12 : -0.06;
      authX += step;
      frames.push({ render: [x, 0, 0], auth: [authX, 0, 0], authVel: [5, 0, 0] });
    }
    const m = metricsFor(frames);
    expect(m.microReversalPct).toBeGreaterThan(20);
  });

  it('ignores reversals the server itself commanded', () => {
    // Regression: a player stumbling over rubble genuinely reverses. The
    // client rendering that faithfully is correct behaviour, not jitter.
    const frames = steadyMotion(SETTLE_FRAMES);
    let x = frames[frames.length - 1].render[0];
    for (let i = 0; i < 400; i += 1) {
      x += i % 2 === 0 ? 0.12 : -0.06;
      // Authority follows exactly the same bouncing path.
      frames.push({ render: [x, 0, 0], auth: [x, 0, 0], authVel: [5, 0, 0] });
    }
    const m = metricsFor(frames);
    expect(m.microReversalPct).toBe(0);
  });

  it('measures corrections at the tail, not the mean', () => {
    const frames = steadyMotion(SETTLE_FRAMES + 600).map((f) => ({ ...f, correction: 0 }));
    // One bad second: 0.5 m corrections. A mean over the run would bury this.
    for (let i = 100; i < 160; i += 1) frames[SETTLE_FRAMES + i].correction = 0.5;

    const m = metricsFor(frames);
    expect(m.correctionMaxCm).toBeCloseTo(50, 0);
    expect(m.correctionP95CmP99).toBeGreaterThan(40);
  });

  it('flags a correction onset only when it crosses the visibility threshold', () => {
    const frames = steadyMotion(SETTLE_FRAMES + 600).map((f) => ({ ...f, correction: 0 }));
    // Two separate excursions above 0.15 m, with a return to 0 between them.
    for (let i = 100; i < 120; i += 1) frames[SETTLE_FRAMES + i].correction = 0.3;
    for (let i = 300; i < 320; i += 1) frames[SETTLE_FRAMES + i].correction = 0.3;
    // A sub-threshold wobble that must NOT count.
    for (let i = 400; i < 420; i += 1) frames[SETTLE_FRAMES + i].correction = 0.05;

    const m = metricsFor(frames);
    const onsets = (m.correctionOnsetsPerMin * m.durationS) / 60;
    expect(Math.round(onsets)).toBe(2);
  });

  it('scales snapshot-gap gates to the negotiated cadence', () => {
    const frames = steadyMotion(SETTLE_FRAMES + 300);
    const events = snapshotEvents(400, 33.3, 3600);
    const m = metricsFor(frames, events);
    expect(m.snapshotCadenceMs).toBeCloseTo(1000 / SNAPSHOT_HZ, 3);
    expect(m.snapshotGapP95Ms).toBeCloseTo(33.3, 1);
  });

  it('abstains on rate metrics when there are too few moving frames to be meaningful', () => {
    // Mostly stationary: authoritative velocity below the moving threshold.
    const frames: SynthFrame[] = Array.from({ length: SETTLE_FRAMES + 200 }, () => ({
      render: [0, 0, 0] as [number, number, number],
      authVel: [0, 0, 0] as [number, number, number],
    }));
    const m = metricsFor(frames);
    expect(Number.isNaN(m.freezePct)).toBe(true);
    expect(Number.isNaN(m.microReversalPct)).toBe(true);
  });

  it('counts hard snaps and stale drops from events, after the settle window', () => {
    const frames = steadyMotion(SETTLE_FRAMES + 600);
    const events: RecorderEventRow[] = [
      // Inside the settle window — spawn-time noise, must be ignored.
      { tMs: 500, seq: 0, type: 'hard_snap', data: { distM: 4 } },
      { tMs: 1000, seq: 1, type: 'stale_drop', data: {} },
      // After settle — real.
      { tMs: 5000, seq: 2, type: 'hard_snap', data: { distM: 5 } },
      { tMs: 6000, seq: 3, type: 'stale_drop', data: {} },
      { tMs: 7000, seq: 4, type: 'stale_drop', data: {} },
    ];
    const m = metricsFor(frames, events);
    expect(m.hardSnaps).toBe(1);
    expect(m.staleDropsPerMin).toBeGreaterThan(0);
    expect((m.staleDropsPerMin * m.durationS) / 60).toBeCloseTo(2, 0);
  });
});
