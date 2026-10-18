/** Browsers embedded in desktop apps may reject pointer capture entirely. */
export type PointerMode = 'capture' | 'drag';
let mode: PointerMode = 'capture';
const listeners = new Set<() => void>();
export const getPointerMode = () => mode;
export const subscribePointerMode = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function setPointerMode(next: PointerMode): void {
  if (mode === next) return;
  mode = next;
  for (const listener of listeners) listener();
}

export function isInputControl(target: EventTarget | null): boolean {
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement
    && (target.isContentEditable || !!target.closest('button, a, input, textarea, select, summary, [role="button"], [role="dialog"]'));
}

/** Only an explicitly unsupported API should change the player's controls. */
export function handlePointerCaptureFailure(error: unknown): void {
  // Escape's unlock cooldown, a lost gesture, or focus changes can reject a
  // perfectly supported request. Keep capture armed for the next gesture.
  if (typeof error === 'object' && error !== null && 'name' in error
    && error.name === 'NotSupportedError') setPointerMode('drag');
}

/** One request at a time. Handles absent APIs, synchronous throws and rejections. */
export function createPointerCaptureRequest() {
  let pending = false;
  return (canvas: HTMLElement) => {
    if (pending || getPointerMode() === 'drag' || document.pointerLockElement) return;
    pending = true;
    const failed = (error: unknown) => { pending = false; handlePointerCaptureFailure(error); };
    try {
      if (typeof canvas.requestPointerLock !== 'function') { pending = false; setPointerMode('drag'); return; }
      Promise.resolve(canvas.requestPointerLock()).then(() => { pending = false; }, failed);
    } catch (error) { failed(error); }
  };
}
