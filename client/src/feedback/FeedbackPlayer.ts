// Derived from Kinema (https://github.com/2600th/Kinema), MIT License.
// See CREDITS.md at the repo root.
//
// Lightweight parallel effect runner inspired by Unity's Feel / MMFeedbacks.
// Each effect has a duration and optional lifecycle callbacks; the player
// advances them together on each `update(dt)`.

export interface FeedbackEffect {
  duration: number;
  onStart?(): void;
  onUpdate?(t: number): void;
  onComplete?(): void;
}

interface ActiveEffect {
  effect: FeedbackEffect;
  elapsed: number;
}

export class FeedbackPlayer {
  private activeEffects: ActiveEffect[] = [];

  play(effects: FeedbackEffect[]): void {
    for (const effect of effects) {
      effect.onStart?.();
      if (effect.duration <= 0) {
        effect.onUpdate?.(1);
        effect.onComplete?.();
      } else {
        this.activeEffects.push({ effect, elapsed: 0 });
      }
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.activeEffects.length) {
      const entry = this.activeEffects[i];
      entry.elapsed += dt;
      const t = Math.min(entry.elapsed / entry.effect.duration, 1);
      entry.effect.onUpdate?.(t);
      if (t >= 1) {
        entry.effect.onComplete?.();
        // Swap-remove for O(1) deletion.
        this.activeEffects[i] =
          this.activeEffects[this.activeEffects.length - 1];
        this.activeEffects.pop();
      } else {
        i++;
      }
    }
  }

  clear(): void {
    this.activeEffects.length = 0;
  }
}
