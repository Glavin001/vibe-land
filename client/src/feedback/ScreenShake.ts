// Derived from Kinema (https://github.com/2600th/Kinema), MIT License.
// See CREDITS.md at the repo root.
//
// Trauma-based screen shake. Callers add trauma (0–1) on impact events
// and sample `update(dt)` each frame for camera offsets to apply.

export interface ShakeOffsets {
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

const ZERO_OFFSETS: ShakeOffsets = {
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
};

// Sin-product noise — two sin waves with incommensurate frequencies produce
// a pseudo-random, smooth signal. Each axis uses a unique seed so they don't
// correlate.
function noise(seed: number, t: number, frequency: number): number {
  return (
    Math.sin(seed * 100 + t * frequency) *
    Math.sin(seed * 50 + t * frequency * 0.7)
  );
}

const SEED_X = 1.0;
const SEED_Y = 2.3;
const SEED_Z = 3.7;
const SEED_RX = 5.1;
const SEED_RY = 7.9;
const SEED_RZ = 11.3;

export class ScreenShake {
  private trauma = 0;
  private maxOffsetX = 0.035;
  private maxOffsetY = 0.05;
  private maxOffsetZ = 0.015;
  private maxRotX = 0.012;
  private maxRotY = 0.018;
  private maxRotZ = 0.01;
  private decayRate = 3.2;
  private frequency = 18;
  private time = 0;

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, Math.max(0, this.trauma + amount));
  }

  getTrauma(): number {
    return this.trauma;
  }

  update(dt: number): ShakeOffsets {
    if (this.trauma <= 0) return ZERO_OFFSETS;

    this.time += dt;
    this.trauma = Math.max(0, this.trauma - this.decayRate * dt);

    // Quadratic intensity: small hits subtle, big hits intense.
    const shake = this.trauma * this.trauma;
    const t = this.time;
    const f = this.frequency;

    return {
      offsetX: this.maxOffsetX * shake * noise(SEED_X, t, f),
      offsetY: this.maxOffsetY * shake * noise(SEED_Y, t, f),
      offsetZ: this.maxOffsetZ * shake * noise(SEED_Z, t, f),
      rotX: this.maxRotX * shake * noise(SEED_RX, t, f),
      rotY: this.maxRotY * shake * noise(SEED_RY, t, f),
      rotZ: this.maxRotZ * shake * noise(SEED_RZ, t, f),
    };
  }

  reset(): void {
    this.trauma = 0;
    this.time = 0;
  }
}
