export function detectTouchControls(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    navigator.maxTouchPoints > 0
    || window.matchMedia('(pointer: coarse)').matches
    || 'ontouchstart' in window
  );
}
