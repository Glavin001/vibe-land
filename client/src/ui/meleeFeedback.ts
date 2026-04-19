/**
 * Tiny pub-sub bus for local-player melee HUD events.
 *
 * GameWorld publishes when a swing is sent (with an optional predicted hit);
 * MeleeHUD subscribes to flash animations and drive the cooldown bar.
 */

export type MeleeFeedbackEvent = {
  /** performance.now() when the swing was sent. */
  sentAtMs: number;
  /** Total cooldown this swing incurs (ms). */
  cooldownMs: number;
  /** Best-effort client-side prediction that the swing landed on a player. */
  predictedHit: boolean;
};

type Listener = (event: MeleeFeedbackEvent) => void;

const listeners = new Set<Listener>();

export function subscribeMeleeFeedback(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishMeleeFeedback(event: MeleeFeedbackEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
