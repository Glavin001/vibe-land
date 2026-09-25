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

/** One request at a time. Handles absent APIs, synchronous throws and rejections. */
export function createPointerCaptureRequest() {
  let pending = false;
  return (canvas: HTMLElement) => {
    if (pending || getPointerMode() === 'drag' || document.pointerLockElement) return;
    pending = true;
    const failed = () => { pending = false; setPointerMode('drag'); };
    try {
      if (typeof canvas.requestPointerLock !== 'function') { failed(); return; }
      Promise.resolve(canvas.requestPointerLock()).then(() => { pending = false; }, failed);
    } catch { failed(); }
  };
}
