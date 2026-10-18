import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SoundPalettePanel, type SoundPalettePanelProps } from './SoundPalettePanel';
import { DEFAULT_PALETTE } from './soundPalette';

function render(patch: Partial<SoundPalettePanelProps> = {}) {
  const props: SoundPalettePanelProps = {
    choices: { ...DEFAULT_PALETTE }, onChoose: vi.fn(), onAudition: vi.fn().mockResolvedValue(undefined),
    onStop: vi.fn(), reflections: false, onReflectionsChange: vi.fn(), onPlayScene: vi.fn(), ...patch,
  };
  return { html: renderToStaticMarkup(createElement(SoundPalettePanel, props)), props };
}

describe('sound casting controls', () => {
  it('exposes every role with separate preview and selection actions without auto-playing', () => {
    const { html, props } = render();
    expect(html.match(/aria-label="Edit /g)).toHaveLength(7);
    expect(html.match(/aria-label="Preview /g)).toHaveLength(3);
    expect(html.match(/aria-label="Use .+? in mix"/g)).toHaveLength(3);
    expect(props.onChoose).not.toHaveBeenCalled();
    expect(props.onAudition).not.toHaveBeenCalled();
    expect(html).toContain('the original bank contains no recording of a full building collapse');
    expect(html).toContain('Preview one isolated layer. Use in mix restores the full original recipe for this role.');
    expect(html).toContain('Heavy individual masonry hits and breaks');
  });
  it('shows externally restored choices and room settings without confusing them with preview history', () => {
    const { html } = render({ choices: { ...DEFAULT_PALETTE, masonryImpact: 'natural' }, reflections: true });
    expect(html).toMatch(/aria-label="Use Recording focus in mix" aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Use Original layer in mix" aria-pressed="false"/);
    expect(html).toMatch(/aria-pressed="true">With reflections/);
    expect(html).toContain('Current choice not previewed');
  });
});
