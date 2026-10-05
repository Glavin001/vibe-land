// Browser globals the game reads that mystralnative's minimal DOM lacks.
// Imported first by native/main.tsx, before any game module evaluates.
//
// mystral provides window, document (stub), canvas, navigator.gpu,
// requestAnimationFrame, timers, fetch, localStorage, TextEncoder and
// WebTransport. Everything here is a plain stand-in, not an emulation.

type Listener = (...args: unknown[]) => void;
const g = globalThis as Record<string, any>;

/** The page the native app "is on", for route/match parsing. */
export function setNativeLocation(pathname: string, search = ''): void {
  const origin = 'app://vibe-land';
  const location = {
    href: `${origin}${pathname}${search}`,
    origin,
    protocol: 'app:',
    host: 'vibe-land',
    hostname: 'vibe-land',
    port: '',
    pathname,
    search,
    hash: '',
    assign() {},
    replace() {},
    reload() {},
  };
  g.location = location;
  if (g.window) g.window.location = location;
  if (g.document) g.document.location = location;
}

setNativeLocation('/city');

g.window ??= g;
g.self ??= g;
g.window.devicePixelRatio ??= 1;

g.history ??= { replaceState() {}, pushState() {}, back() {}, state: null };
g.window.history ??= g.history;

g.matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
g.window.matchMedia ??= g.matchMedia;

g.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

g.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
};

const doc = g.document ?? (g.document = {});
doc.activeElement ??= null;
doc.hidden ??= false;
doc.visibilityState ??= 'visible';
doc.hasFocus ??= () => true;
doc.pointerLockElement ??= null;
doc.exitPointerLock ??= () => {};
doc.querySelector ??= () => null;
doc.querySelectorAll ??= () => [];
doc.getElementById ??= (id: string) => (id === 'canvas' ? g.canvas : null);

// React's scheduler prefers MessageChannel; a timer-backed one is enough.
g.MessageChannel ??= class {
  port1: { onmessage: Listener | null; postMessage: (data: unknown) => void; close: () => void };
  port2: { onmessage: Listener | null; postMessage: (data: unknown) => void; close: () => void };
  constructor() {
    const make = () => ({ onmessage: null as Listener | null, postMessage: (_: unknown) => {}, close() {} });
    this.port1 = make();
    this.port2 = make();
    this.port1.postMessage = (data) => setTimeout(() => this.port2.onmessage?.({ data }), 0);
    this.port2.postMessage = (data) => setTimeout(() => this.port1.onmessage?.({ data }), 0);
  }
};

g.queueMicrotask ??= (fn: () => void) => Promise.resolve().then(fn);

g.performance ??= { now: () => Date.now() };
g.performance.getEntriesByType ??= () => [];
g.performance.mark ??= () => {};
g.performance.measure ??= () => {};
