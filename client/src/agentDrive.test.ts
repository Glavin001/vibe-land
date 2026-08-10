import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  agentDriveBridge,
  isAgentDriveActive,
  sampleAgentDrive,
} from './agentDrive';

describe('agentDrive', () => {
  afterEach(() => {
    agentDriveBridge.clear();
    vi.unstubAllGlobals();
  });

  it('exposes versioned bridge', () => {
    expect(agentDriveBridge.version).toBe(1);
  });

  it('overrides look and movement while active', () => {
    agentDriveBridge.look(1.25, -0.2);
    agentDriveBridge.move({ forward: 1, strafe: -0.5 });
    agentDriveBridge.setSprint(true);

    expect(isAgentDriveActive()).toBe(true);
    const sample = sampleAgentDrive(performance.now(), 0, 0);
    expect(sample).not.toBeNull();
    expect(sample!.yaw).toBeCloseTo(1.25);
    expect(sample!.pitch).toBeCloseTo(-0.2);
    expect(sample!.moveY).toBe(1);
    expect(sample!.moveX).toBe(-0.5);
    expect(sample!.buttons & (1 << 6)).not.toBe(0); // BTN_SPRINT
  });

  it('lookAt faces a world point from the e2e position', () => {
    vi.stubGlobal('window', {
      __VIBE_E2E__: {
        version: 1,
        snapshot: () => ({
          position: [0, 1, 45],
        }),
      },
    });
    agentDriveBridge.lookAt(0, 1, 0);
    const status = agentDriveBridge.status();
    // From +Z toward origin => yaw ≈ π
    expect(status.yaw).toBeCloseTo(Math.PI, 5);
    expect(status.pitch ?? 0).toBeCloseTo(0, 5);
  });

  it('expires timed move and fire pulses', () => {
    vi.useFakeTimers();
    agentDriveBridge.move({ forward: 1, durationMs: 100 });
    agentDriveBridge.fire({ holdMs: 50 });
    expect(sampleAgentDrive(performance.now(), 0, 0)?.firePrimary).toBe(true);
    vi.advanceTimersByTime(60);
    expect(sampleAgentDrive(performance.now(), 0, 0)?.firePrimary).toBe(false);
    expect(sampleAgentDrive(performance.now(), 0, 0)?.moveY).toBe(1);
    vi.advanceTimersByTime(50);
    expect(isAgentDriveActive()).toBe(false);
    vi.useRealTimers();
  });
});
