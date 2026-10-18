import { beforeEach, describe, expect, it } from 'vitest';

import { clearDustShots, matchDustShot, registerDustShot } from './dustShots';

describe('dust shots', () => {
  beforeEach(() => clearDustShots());

  it('matches a break in the shot corridor, a few times, then not', () => {
    registerDustShot({ ox: 0, oy: 1.6, oz: 0, dx: 0, dy: 0, dz: 1, ex: null, ey: null, ez: null, weapon: 3, atMs: 1000 });
    expect(matchDustShot(1, 3, 20, 1500)).not.toBeNull();
    expect(matchDustShot(-1, 2, 22, 1500)).not.toBeNull();
    expect(matchDustShot(0, 2, 24, 1500)).not.toBeNull();
    expect(matchDustShot(0, 2, 26, 1500)).toBeNull();
  });

  it('does not match behind the shooter, far off the line, or after the shot has expired', () => {
    registerDustShot({ ox: 0, oy: 1.6, oz: 0, dx: 0, dy: 0, dz: 1, ex: null, ey: null, ez: null, weapon: 3, atMs: 1000 });
    expect(matchDustShot(0, 2, -5, 1500)).toBeNull();
    expect(matchDustShot(12, 2, 20, 1500)).toBeNull();
    expect(matchDustShot(0, 2, 20, 7000)).toBeNull();
  });

  it('lets a thrown ball sag with distance and a hitscan end count directly', () => {
    registerDustShot({ ox: 0, oy: 1.6, oz: 0, dx: 0, dy: 0, dz: 1, ex: null, ey: null, ez: null, weapon: 3, atMs: 0 });
    // 60 m out the ball has dropped several metres.
    expect(matchDustShot(0, -3, 60, 100)).not.toBeNull();
    clearDustShots();
    registerDustShot({ ox: 0, oy: 1.6, oz: 0, dx: 0, dy: 0, dz: 1, ex: 0, ey: 10, ez: 30, weapon: 1, atMs: 0 });
    expect(matchDustShot(2, 12, 31, 100)).not.toBeNull();
  });
});
