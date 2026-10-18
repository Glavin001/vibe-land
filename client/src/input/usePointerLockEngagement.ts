import { useEffect } from 'react';
import { createPointerCaptureRequest, isInputControl, setPointerMode } from './pointerMode';

// Pointer lock requires a user gesture — there's no way around it. What we
// can do is make the gesture frictionless: listen for ANY keydown/pointerdown
// at the document level, lock on the first one, and re-arm if the user
// presses Escape. This makes portal-arrival feel as close to "instant" as the
// platform allows: the player presses W to start moving and the camera locks
// without ever clicking a join overlay.

type Options = {
  enabled: boolean;
  getCanvas: () => HTMLElement | null;
};

export function usePointerLockEngagement({ enabled, getCanvas }: Options): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof document === 'undefined') return;

    const tryLock = createPointerCaptureRequest();

    const onGesture = (event: Event): void => {
      if (isInputControl(event.target)) return;
      // Read the fields, not instanceof: the native app's runtime delivers
      // plain event objects, so instanceof never matched there and every key
      // -- a held Escape's repeats, the Cmd of Cmd+Tab -- took the pointer back.
      if (event.type === 'keydown') {
        const key = event as KeyboardEvent;
        // Escape releases the pointer; a held key repeats; Cmd or Alt starts
        // a system shortcut (Cmd+Tab to leave), not play.
        if (key.code === 'Escape' || key.repeat || key.metaKey || key.altKey || key.key === 'Meta' || key.key === 'Alt') return;
      }
      if ((event as PointerEvent).pointerType === 'touch') return;
      const canvas = getCanvas();
      if (canvas) tryLock(canvas);
    };

    const onPointerLockChange = (): void => {
      if (document.pointerLockElement === getCanvas()) setPointerMode('capture');
    };

    document.addEventListener('keydown', onGesture, true);
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    return () => {
      document.removeEventListener('keydown', onGesture, true);
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
    };
  }, [enabled, getCanvas]);
}
