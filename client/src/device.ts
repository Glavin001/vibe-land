let cachedIsTouch: boolean | null = null;

export function isTouchDevice(): boolean {
  if (cachedIsTouch !== null) return cachedIsTouch;
  if (typeof window === 'undefined') {
    return false;
  }
  cachedIsTouch =
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
    || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
    || 'ontouchstart' in window;
  return cachedIsTouch;
}
