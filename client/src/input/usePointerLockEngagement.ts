import { useEffect } from 'react';

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

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function usePointerLockEngagement({ enabled, getCanvas }: Options): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof document === 'undefined') return;

    let armed = true;

    const tryLock = (): void => {
      if (!armed) return;
      if (document.pointerLockElement !== null) return;
      const canvas = getCanvas();
      if (!canvas) return;
      armed = false;
      const result = (canvas as HTMLElement & {
        requestPointerLock: () => Promise<void> | void;
      }).requestPointerLock();
      // Some browsers return a Promise; older ones return void. Either way,
      // a failure should re-arm so the next gesture tries again.
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {
          armed = true;
        });
      }
    };

    const onGesture = (event: Event): void => {
      if (isTextInputTarget(event.target)) return;
      tryLock();
    };

    const onPointerLockChange = (): void => {
      if (document.pointerLockElement === null) {
        // Lock lost (Escape pressed, tab switch, etc.) — re-arm so the next
        // user gesture re-locks.
        armed = true;
      }
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
