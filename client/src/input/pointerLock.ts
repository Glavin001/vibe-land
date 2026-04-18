// Derived from Kinema's input/pointerLock.ts (MIT). See CREDITS.md.
//
// Safari and some mobile browsers either omit `requestPointerLock` /
// `exitPointerLock` or reject their returned Promises unexpectedly. These
// helpers avoid throwing at call sites so game code can degrade gracefully
// (e.g. skip pointer-lock on iOS, still handle pointer events).

type PointerLockRequest = (options?: unknown) => Promise<void> | void;

type PointerLockCapableCanvas = HTMLCanvasElement & {
  requestPointerLock?: PointerLockRequest;
};

type PointerLockCapableDocument = Document & {
  exitPointerLock?: (() => Promise<void> | void) | undefined;
};

export function getPointerLockRequest(
  canvas: HTMLCanvasElement,
): PointerLockRequest | null {
  const requestPointerLock = (canvas as PointerLockCapableCanvas)
    .requestPointerLock;
  return typeof requestPointerLock === 'function'
    ? requestPointerLock.bind(canvas)
    : null;
}

/**
 * Best-effort request. Returns false if pointer lock isn't supported or if
 * the request synchronously threw; swallows rejected promises.
 */
export function requestPointerLockSafe(canvas: HTMLCanvasElement): boolean {
  const req = getPointerLockRequest(canvas);
  if (!req) return false;
  try {
    const result = req();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        /* ignore */
      });
    }
    return true;
  } catch {
    return false;
  }
}

export function exitPointerLockIfSupported(doc: Document = document): void {
  const exitPointerLock = (doc as PointerLockCapableDocument).exitPointerLock;
  if (typeof exitPointerLock !== 'function') return;

  try {
    const result = exitPointerLock.call(doc);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        /* ignore */
      });
    }
  } catch {
    // Browsers without full Pointer Lock support may still throw here.
  }
}
