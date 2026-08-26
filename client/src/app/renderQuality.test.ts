// Shadow toggle defaults and persistence.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadFresh(opts: {
  touch: boolean;
  stored?: string | null;
  storedTier?: string;
  storedAo?: string;
}) {
  vi.resetModules();
  vi.doMock('../device', () => ({ isTouchDevice: () => opts.touch }));
  const store = new Map<string, string>();
  if (opts.stored != null) store.set('vibe.render.shadows', opts.stored);
  if (opts.storedTier != null) store.set('vibe.render.tier', opts.storedTier);
  if (opts.storedAo != null) store.set('vibe.render.ao', opts.storedAo);
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

  it('tier defaults fast on touch, pretty elsewhere, stored choice wins', async () => {
    expect((await loadFresh({ touch: true })).module.qualityTier()).toBe('fast');
    expect((await loadFresh({ touch: false })).module.qualityTier()).toBe('pretty');
    expect(
      (await loadFresh({ touch: true, storedTier: 'pretty' })).module.qualityTier(),
    ).toBe('pretty');
  });

  it('tier drives every derived flag consistently', async () => {
    const { module } = await loadFresh({ touch: true });
    // FAST: everything expensive off, dpr capped below the R3F default.
    expect(module.maxDpr()).toBeLessThan(2);
    expect(module.antialiasEnabled()).toBe(false);
    expect(module.flatToneMapping()).toBe(true);
    expect(module.skyEnabled()).toBe(false);
    expect(module.weatherEnabled()).toBe(false);
    expect(module.cityPbrLighting()).toBe(false);

    const seen: string[] = [];
    module.onRenderQualityChange((s) => seen.push(s.tier));
    module.setQualityTier('pretty');
    expect(seen).toEqual(['pretty']);
    expect(module.maxDpr()).toBe(2);
    expect(module.antialiasEnabled()).toBe(true);
    expect(module.flatToneMapping()).toBe(false);
    expect(module.skyEnabled()).toBe(true);
    expect(module.weatherEnabled()).toBe(true);
    expect(module.cityPbrLighting()).toBe(true);
    // No-op set must not notify (consumers walk live meshes on change).
    module.setQualityTier('pretty');
    expect(seen).toEqual(['pretty']);
  });

  // The two knobs are independent: turning shadows on must not drag the whole
  // tier up, and picking PRETTY must not force shadows on a phone that turned
  // them off.
  it('shadows and tier are independent', async () => {
    const { module } = await loadFresh({ touch: true });
    module.setShadowsEnabled(true);
    expect(module.qualityTier()).toBe('fast');
    module.setQualityTier('pretty');
    expect(module.shadowsEnabled()).toBe(true);
    module.setShadowsEnabled(false);
    expect(module.qualityTier()).toBe('pretty');
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

// Ambient occlusion. Effectively "PRETTY tier AND the player has not said no",
// because it takes over the render loop with an offscreen scene pass -- the
// one flag in this module that is a conjunction rather than a plain read.
describe('ambient occlusion', () => {
  it('defaults off on touch devices and on elsewhere', async () => {
    expect((await loadFresh({ touch: true })).module.ambientOcclusionPreferred()).toBe(false);
    expect((await loadFresh({ touch: false })).module.ambientOcclusionPreferred()).toBe(true);
  });

  it('needs both the PRETTY tier and the preference', async () => {
    const { module } = await loadFresh({ touch: false });
    expect(module.ambientOcclusionEnabled()).toBe(true);
    // A phone that opts into PRETTY should still be able to keep the extra
    // scene pass off.
    module.setAmbientOcclusionEnabled(false);
    expect(module.ambientOcclusionEnabled()).toBe(false);
    module.setAmbientOcclusionEnabled(true);
    module.setQualityTier('fast');
    expect(module.ambientOcclusionPreferred()).toBe(true);
    expect(module.ambientOcclusionEnabled()).toBe(false);
  });

  it('persists and notifies, and a stored choice beats the device default', async () => {
    const { module, store } = await loadFresh({ touch: false });
    const seen: boolean[] = [];
    module.onRenderQualityChange((s) => seen.push(s.ao));
    module.setAmbientOcclusionEnabled(false);
    expect(store.get('vibe.render.ao')).toBe('0');
    expect(seen).toEqual([false]);
    module.setAmbientOcclusionEnabled(false);
    expect(seen).toEqual([false]);

    const stored = await loadFresh({ touch: true, storedAo: '1' });
    expect(stored.module.ambientOcclusionPreferred()).toBe(true);
  });
});
