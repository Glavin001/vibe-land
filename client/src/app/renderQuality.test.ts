// Shadow toggle defaults and persistence.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadFresh(opts: { touch: boolean; stored?: string | null }) {
  vi.resetModules();
  vi.doMock('../device', () => ({ isTouchDevice: () => opts.touch }));
  const store = new Map<string, string>();
  if (opts.stored != null) store.set('vibe.render.shadows', opts.stored);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  return { module: await import('./renderQuality'), store };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../device');
});

describe('shadow defaults', () => {
  it('defaults off on touch devices', async () => {
    const { module } = await loadFresh({ touch: true });
    expect(module.shadowsEnabled()).toBe(false);
  });

  it('defaults on elsewhere', async () => {
    const { module } = await loadFresh({ touch: false });
    expect(module.shadowsEnabled()).toBe(true);
  });

  // A phone player who deliberately turns shadows on must not have the mobile
  // default silently turn them off again on the next load.
  it('a stored choice beats the device default', async () => {
    const on = await loadFresh({ touch: true, stored: '1' });
    expect(on.module.shadowsEnabled()).toBe(true);
    const off = await loadFresh({ touch: false, stored: '0' });
    expect(off.module.shadowsEnabled()).toBe(false);
  });
});

describe('toggling', () => {
  it('persists and notifies subscribers', async () => {
    const { module, store } = await loadFresh({ touch: true });
    const seen: boolean[] = [];
    module.onRenderQualityChange((s) => seen.push(s.shadows));

    module.setShadowsEnabled(true);
    expect(module.shadowsEnabled()).toBe(true);
    expect(store.get('vibe.render.shadows')).toBe('1');
    expect(seen).toEqual([true]);

    // No-op writes must not fire listeners: the city layer reacts by walking
    // every batch, and a redundant notify would do that for nothing.
    module.setShadowsEnabled(true);
    expect(seen).toEqual([true]);
  });

  it('unsubscribes cleanly', async () => {
    const { module } = await loadFresh({ touch: false });
    const seen: boolean[] = [];
    const off = module.onRenderQualityChange((s) => seen.push(s.shadows));
    off();
    module.setShadowsEnabled(false);
    expect(seen).toEqual([]);
  });

  // Private-mode Safari throws on localStorage; the toggle still has to work
  // for the session, which is exactly the device this feature is aimed at.
  it('still toggles when localStorage is unavailable', async () => {
    vi.resetModules();
    vi.doMock('../device', () => ({ isTouchDevice: () => true }));
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const module = await import('./renderQuality');
    expect(module.shadowsEnabled()).toBe(false);
    expect(() => module.setShadowsEnabled(true)).not.toThrow();
    expect(module.shadowsEnabled()).toBe(true);
  });
});
