// Derived from Kinema (https://github.com/2600th/Kinema), MIT License.
// See CREDITS.md at the repo root.
//
// Freeze-frame on impact. Callers trigger with a duration (typical 0.05–0.1s)
// and poll `update(dt)` — when it returns true, the simulation step should
// be skipped.

export class Hitstop {
  private remainingTime = 0;

  trigger(durationSeconds: number): void {
    this.remainingTime = Math.max(this.remainingTime, durationSeconds);
  }

  update(dt: number): boolean {
    if (this.remainingTime <= 0) return false;
    this.remainingTime -= dt;
    if (this.remainingTime < 0) this.remainingTime = 0;
    return true;
  }

  get isFrozen(): boolean {
    return this.remainingTime > 0;
  }
}
