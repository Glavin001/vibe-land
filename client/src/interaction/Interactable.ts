// Derived from Kinema's interaction/Interactable.ts (MIT), decoupled from
// Kinema's client-side RAPIER types so vibe-land can drive interaction
// detection from its existing Rust-authoritative + shared-WASM pipeline
// rather than a client-local physics instance.
// See CREDITS.md at the repo root.

import type * as THREE from 'three';

export type InteractionMode = 'press' | 'hold';

export interface InteractionSpec {
  mode: InteractionMode;
  holdDuration?: number;
}

export interface InteractionAccess {
  allowed: boolean;
  reason?: string;
}

/**
 * Contract for any object the player can interact with.
 *
 * vibe-land integration note:
 *  - State-changing interactions MUST flow through the Rust authority in
 *    `shared/` — this interface is for the client-visual focus + prompt
 *    layer only. The `interact()` call should dispatch an intent, not
 *    mutate world state locally.
 *  - `player` is typed as `unknown` here so concrete implementations can
 *    depend on vibe-land's own player model without this module importing
 *    it. Cast inside `canInteract` / `interact`.
 */
export interface IInteractable {
  readonly id: string;
  readonly label: string;
  readonly position: THREE.Vector3;
  update(dt: number): void;
  onFocus(): void;
  onBlur(): void;
  getInteractionSpec?(): InteractionSpec;
  canInteract?(player: unknown): InteractionAccess;
  setHoldProgress?(progress: number | null): void;
  interact(player: unknown): void;
  dispose(): void;
}
