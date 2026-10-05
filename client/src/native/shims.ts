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

// mystral's createElement returns bare objects for anything but a canvas.
// Libraries probe and touch elements at import time (react-dom's feature
// tests, drei, stats panels), so give every element the inert DOM surface
// they expect. Nothing is laid out or drawn; the native HUD is Canvas2D.
const inertElementMethods: Record<string, (...args: any[]) => unknown> = {
  setAttribute() {},
  getAttribute: () => null,
  removeAttribute() {},
  hasAttribute: () => false,
  appendChild: (child: unknown) => child,
  removeChild: (child: unknown) => child,
  insertBefore: (child: unknown) => child,
  replaceChild: (child: unknown) => child,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
  getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  focus() {},
  blur() {},
  remove() {},
  querySelector: () => null,
  querySelectorAll: () => [],
};
function inertElement<T extends Record<string, any>>(element: T, tagName: string): T {
  if (!element || typeof element !== 'object') return element;
  for (const [name, fn] of Object.entries(inertElementMethods)) {
    if (typeof element[name] !== 'function') (element as Record<string, unknown>)[name] = fn;
  }
  const props = element as Record<string, any>;
  props.style ??= {};
  props.classList ??= { add() {}, remove() {}, toggle: () => false, contains: () => false };
  props.childNodes ??= [];
  props.children ??= [];
  props.dataset ??= {};
  props.tagName ??= tagName.toUpperCase();
  props.nodeName ??= tagName.toUpperCase();
  props.nodeType ??= 1;
  props.ownerDocument ??= doc;
  return element;
}
const nativeCreateElement = typeof doc.createElement === 'function' ? doc.createElement.bind(doc) : null;
doc.createElement = (tagName: string, ...rest: unknown[]) =>
  inertElement(nativeCreateElement ? nativeCreateElement(tagName, ...rest) ?? {} : {}, tagName);
doc.createElementNS ??= (_ns: string, tagName: string) => doc.createElement(tagName);
doc.createTextNode ??= (text: string) => ({ nodeType: 3, textContent: text });
doc.documentElement ??= inertElement({}, 'html');
inertElement(doc.documentElement, 'html');
if (doc.body) inertElement(doc.body, 'body');
if (doc.head) inertElement(doc.head, 'head');
if (g.canvas) {
  inertElement(g.canvas, 'canvas');
  // The canvas is the whole window: it contains every event target and holds
  // focus whenever the window does (input/keyboardMouse.ts checks both).
  g.canvas.contains = () => true;
  g.canvas.focus = () => { doc.activeElement = g.canvas; };
  g.canvas.blur = () => {};
  doc.activeElement = g.canvas;
}

// DOM classes code tests against with instanceof (focus checks, drei).
// Nothing in mystral is an instance of them, which is the right answer.
for (const name of [
  'Node', 'Element', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLButtonElement', 'HTMLImageElement', 'HTMLVideoElement', 'SVGElement',
]) {
  g[name] ??= class {};
}

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

// fetch() of the game server's HTTP routes (vehicle assets, city visuals,
// the city manifest), answered in-process by the sim module when single-
// player registered a link that can (net/inProcessClient.ts). Everything
// else goes to mystral's fetch.
const IN_PROCESS_ROUTES = ['/vehicle-assets/', '/city-manifest/', '/city-visuals/'];
const nativeFetch: typeof fetch = g.fetch.bind(g);
g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = raw.replace(/^[a-z]+:\/\/[^/]*/i, '');
  const link = (await import('../net/inProcessClient')).inProcessLink();
  if (link?.request && IN_PROCESS_ROUTES.some((route) => path.startsWith(route))) {
    const answer = link.request(path.split('?')[0]);
    let body = new Uint8Array(answer.body);
    if (answer.contentEncoding === 'gzip') body = (await import('fflate')).gunzipSync(body);
    const text = () => new TextDecoder().decode(body);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: '',
      url: raw,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? answer.contentType : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => text(),
      json: async () => JSON.parse(text()),
    } as unknown as Response;
  }
  return nativeFetch(input as RequestInfo, init);
};

g.queueMicrotask ??= (fn: () => void) => Promise.resolve().then(fn);

g.performance ??= { now: () => Date.now() };
g.performance.getEntriesByType ??= () => [];
g.performance.mark ??= () => {};
g.performance.measure ??= () => {};
