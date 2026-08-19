// Render-quality switches the player can flip at runtime.
//
// Currently one: shadows. The city draws every chunk into the shadow map as
// well as the main pass, which on desktop is invisible and on a phone is not --
// measured 20-23 fps on an iPhone against 60-67 fps on a desktop GPU rendering
// the same 24,105-chunk scene, with the server at a healthy 60 Hz and the
// network idle, so the cost is entirely local rasterisation.
//
// Default off for touch devices. That is a guess about *why* the phone is slow
// (shadow pass vs draw volume vs fill), which is exactly what this toggle
// exists to settle: flip it on the device that is actually slow and read the
// fps. The netlab harness runs desktop Chrome and cannot reproduce the phone,
// so this measurement has to happen on the hardware.

import { isTouchDevice } from '../device';

const STORAGE_KEY = 'vibe.render.shadows';

export type RenderQualityState = { shadows: boolean };

type Listener = (state: RenderQualityState) => void;

const listeners = new Set<Listener>();

function defaultShadows(): boolean {
  return !isTouchDevice();
}

function readStored(): boolean | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // Private-mode Safari throws on localStorage access. A device that cannot
    // remember the setting should still be able to toggle it for this session.
  }
  return null;
}

let shadows: boolean = readStored() ?? defaultShadows();

export function shadowsEnabled(): boolean {
  return shadows;
}

export function setShadowsEnabled(next: boolean): void {
  if (next === shadows) return;
  shadows = next;
  try {
    localStorage?.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Not fatal -- see readStored.
  }
  const state: RenderQualityState = { shadows };
  for (const listener of listeners) listener(state);
}

/** Subscribe to changes; returns an unsubscribe. */
export function onRenderQualityChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the current value came from the player rather than the default. */
export function shadowsAreExplicit(): boolean {
  return readStored() !== null;
}
