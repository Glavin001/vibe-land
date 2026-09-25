import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INPUT_BINDINGS } from './bindings';
import { KeyboardMouseInputSource } from './keyboardMouse';
import { createPointerCaptureRequest, getPointerMode, setPointerMode } from './pointerMode';

// A small DOM event harness, so tests exercise the attached handlers without
// adding a browser/DOM dependency to the input unit suite.
let doc: EventTarget & { pointerLockElement: unknown; activeElement: unknown; hasFocus: () => boolean };
let win: EventTarget;
class Element extends EventTarget {
  tagName = 'CANVAS'; tabIndex = -1; isContentEditable = false;
  contains(target: unknown) { return target === this; }
  closest() { return this.tagName === 'BUTTON' || this.tagName === 'INPUT' ? this : null; }
  focus() { doc.activeElement = this; }
  blur() { doc.activeElement = null; this.dispatchEvent(new Event('blur')); }
}
function send(target: EventTarget, name: string, properties: Record<string, unknown>) {
  const event = new Event(name, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
}
beforeEach(() => {
  doc = Object.assign(new EventTarget(), { pointerLockElement: null, activeElement: null, hasFocus: () => true });
  win = new EventTarget();
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win); vi.stubGlobal('HTMLElement', Element);
  setPointerMode('capture');
});
afterEach(() => { setPointerMode('capture'); vi.unstubAllGlobals(); });

describe('pointer capture fallback', () => {
  it('deduplicates pending requests and falls back after a rejection without retry storms', async () => {
    let reject!: (error: Error) => void;
    const request = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const canvas = { requestPointerLock: request } as unknown as HTMLElement;
    const capture = createPointerCaptureRequest();
    capture(canvas); capture(canvas);
    expect(request).toHaveBeenCalledTimes(1);
    reject(new Error('Embedded browser cannot capture')); await Promise.resolve();
    expect(getPointerMode()).toBe('drag');
    capture(canvas); expect(request).toHaveBeenCalledTimes(1);
  });

  it('handles absent APIs and synchronous failures', () => {
    createPointerCaptureRequest()({} as HTMLElement);
    expect(getPointerMode()).toBe('drag');
    setPointerMode('capture');
    createPointerCaptureRequest()({ requestPointerLock: () => { throw Error('Unsupported'); } } as unknown as HTMLElement);
    expect(getPointerMode()).toBe('drag');
  });

  it('keeps normal capture after success and permits another gesture after Escape', async () => {
    const request = vi.fn(() => Promise.resolve());
    const canvas = { requestPointerLock: request } as unknown as HTMLElement;
    const capture = createPointerCaptureRequest();
    capture(canvas); await Promise.resolve();
    expect(getPointerMode()).toBe('capture');
    doc.pointerLockElement = canvas; capture(canvas);
    expect(request).toHaveBeenCalledTimes(1);
    doc.pointerLockElement = null; capture(canvas);
    expect(request).toHaveBeenCalledTimes(2);
    await Promise.resolve();
  });
});

describe('embedded mouse controls', () => {
  let source: KeyboardMouseInputSource, canvas: Element;
  const sample = () => source.sample(false, 'onFoot', DEFAULT_INPUT_BINDINGS);
  const mouse = (name: string, x: number, y: number, buttons: number, button = 0, target: Element = canvas) =>
    send(doc, name, { clientX: x, clientY: y, buttons, button, target, movementX: 0, movementY: 0 });
  beforeEach(() => {
    setPointerMode('drag'); canvas = new Element(); source = new KeyboardMouseInputSource();
    source.attach(canvas as unknown as HTMLElement);
  });
  afterEach(() => source.detach());

  it('uses drag position deltas when embedded browsers supply zero movementX/Y, without firing', () => {
    mouse('mousedown', 100, 100, 1);
    mouse('mousemove', 140, 115, 1);
    const action = sample();
    expect(action.lookX).toBeLessThan(0); expect(action.lookY).toBeLessThan(0);
    expect(action.firePrimary).toBe(false);
    mouse('mouseup', 140, 115, 0);
    expect(sample().firePrimary).toBe(false);
    mouse('mousemove', 180, 115, 0);
    expect(sample().lookX).toBeCloseTo(0);
  });

  it('fires exactly once for a click, and retains keyboard movement and ADS', () => {
    mouse('mousedown', 100, 100, 1); mouse('mouseup', 100, 100, 0);
    expect(sample().firePrimary).toBe(true); expect(sample().firePrimary).toBe(false);
    send(win, 'keydown', { code: DEFAULT_INPUT_BINDINGS.keyboard.moveForward, target: canvas });
    send(win, 'keydown', { code: DEFAULT_INPUT_BINDINGS.keyboard.aimSecondaryKey, target: canvas });
    const action = sample(); expect(action.moveY).toBe(1); expect(action.aimSecondary).toBe(true);
  });

  it('does not turn UI clicks into shots or capture typing, and clears held input on blur', () => {
    mouse('mousedown', 100, 100, 1);
    send(win, 'keydown', { code: 'KeyW', target: canvas });
    const button = new Element(); button.tagName = 'BUTTON';
    mouse('mousedown', 100, 100, 1, 0, button); mouse('mouseup', 100, 100, 0, 0, button);
    expect(sample().firePrimary).toBe(false); expect(sample().moveY).toBe(0);
    send(win, 'keydown', { code: 'KeyW', target: button }); expect(sample().moveY).toBe(0);
    mouse('mousedown', 100, 100, 1); send(win, 'keydown', { code: 'KeyW', target: canvas });
    canvas.blur(); expect(sample().moveY).toBe(0); expect(source.hasPointerControl).toBe(false);
  });

  it('preserves native locked mouse look and held firing', () => {
    setPointerMode('capture'); doc.pointerLockElement = canvas;
    mouse('mousedown', 100, 100, 1);
    send(doc, 'mousemove', { movementX: 10, movementY: -5, target: canvas });
    const action = source.sample(true, 'onFoot', DEFAULT_INPUT_BINDINGS);
    expect(action.lookX).toBeLessThan(0); expect(action.lookY).toBeGreaterThan(0);
    expect(action.firePrimary).toBe(true);
    expect(source.sample(true, 'onFoot', DEFAULT_INPUT_BINDINGS).firePrimary).toBe(true);
    mouse('mouseup', 100, 100, 0);
    expect(source.sample(true, 'onFoot', DEFAULT_INPUT_BINDINGS).firePrimary).toBe(false);
  });
});
