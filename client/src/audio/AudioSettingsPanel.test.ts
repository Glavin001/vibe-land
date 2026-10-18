import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioMixControls } from './AudioSettingsPanel';
import { DEFAULT_AUDIO, setAudioSettings } from './settings';

vi.mock('./engine', () => ({
  destructionAudio: () => ({ diagnostics: () => ({ sampleRate: 0, output: 'headphones', requestedOutput: 'headphones', maxChannels: 2 }) }),
}));

afterEach(() => setAudioSettings(DEFAULT_AUDIO));

describe('shared room sound controls', () => {
  it('shows dry playback explicitly and disables the unused reflection amount', () => {
    setAudioSettings({ acoustics: 'dry', space: .42 });
    const html = renderToStaticMarkup(createElement(AudioMixControls));
    expect(html).toContain('aria-label="Reflections mode"');
    expect(html).toMatch(/<option value="dry" selected="">Dry/);
    expect(html).toMatch(/<input aria-label="Reflections amount"[^>]*disabled=""/);
    expect(html).toContain('Enable reflections to adjust the room sound.');
    expect(html).toMatch(/aria-label="Reflections amount"[^>]*value="0.42"/);
  });
  it('enables the saved reflection amount when room sound is on', () => {
    setAudioSettings({ acoustics: 'reflections', space: .42 });
    const html = renderToStaticMarkup(createElement(AudioMixControls));
    expect(html).toMatch(/<option value="reflections" selected="">With reflections/);
    expect(html).not.toMatch(/<input aria-label="Reflections amount"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Reflections amount"[^>]*value="0.42"/);
  });
});
