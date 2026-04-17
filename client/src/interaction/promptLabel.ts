// Derived from Kinema's InteractionManager.buildPromptLabel (MIT).
// See CREDITS.md at the repo root.
//
// HUD-only helper: given an interactable and optional access gate, returns
// the string to display in the interaction prompt ("Press F to ..." etc).

import type { IInteractable } from './Interactable';

export interface PromptLabelOptions {
  interactKey?: string;
  locked?: { allowed: boolean; reason?: string };
}

export function buildInteractionPromptLabel(
  target: IInteractable | null,
  options: PromptLabelOptions = {},
): string | null {
  if (!target) return null;
  const { interactKey = 'F', locked } = options;
  if (locked && !locked.allowed) {
    return locked.reason ?? 'Locked';
  }
  const spec = target.getInteractionSpec?.();
  const verb =
    spec?.mode === 'hold' ? `Hold ${interactKey} to` : `Press ${interactKey} to`;
  return `${verb} ${target.label}`;
}
