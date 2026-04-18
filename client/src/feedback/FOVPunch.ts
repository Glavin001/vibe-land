// Derived from Kinema (https://github.com/2600th/Kinema), MIT License.
// See CREDITS.md at the repo root.
//
// Critically-damped spring for FOV kick on weapon fire / speed impulses.
// Call `punch(degrees)` on the event, add `update(dt)` to the base FOV.

export class FOVPunch {
  private currentPunch = 0;
  private velocity = 0;
  private stiffness = 150;
  private damping = 12;

  punch(amount: number): void {
    this.velocity += amount * 30;
  }

  update(dt: number): number {
    const force =
      -this.stiffness * this.currentPunch - this.damping * this.velocity;
    this.velocity += force * dt;
    this.currentPunch += this.velocity * dt;

    if (
      Math.abs(this.currentPunch) < 0.001 &&
      Math.abs(this.velocity) < 0.01
    ) {
      this.currentPunch = 0;
      this.velocity = 0;
    }

    return this.currentPunch;
  }

  reset(): void {
    this.currentPunch = 0;
    this.velocity = 0;
  }
}
