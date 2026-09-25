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
      if (event instanceof KeyboardEvent && (event.code === 'Escape' || event.repeat)) return;
      if (event instanceof PointerEvent && event.pointerType === 'touch') return;
      const canvas = getCanvas();
      if (canvas) tryLock(canvas);
    };

    const onPointerLockChange = (): void => {
      if (document.pointerLockElement === getCanvas()) setPointerMode('capture');
    };
    const onPointerLockError = () => setPointerMode('drag');

    document.addEventListener('keydown', onGesture, true);
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('pointerlockerror', onPointerLockError);

    return () => {
      document.removeEventListener('keydown', onGesture, true);
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('pointerlockerror', onPointerLockError);
    };
  }, [enabled, getCanvas]);
}
