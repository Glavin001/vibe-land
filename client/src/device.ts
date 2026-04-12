export function isTouchDevice(): boolean {
  return (
    navigator.maxTouchPoints > 0
    || window.matchMedia('(pointer: coarse)').matches
    || 'ontouchstart' in window
  );
}
