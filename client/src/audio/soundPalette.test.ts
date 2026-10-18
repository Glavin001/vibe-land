import { describe,expect,it } from 'vitest';
import { paletteClipId, paletteSlotFor, sanitizePalette, DEFAULT_PALETTE } from './soundPalette';
import { sanitizeSettings } from './settings';
describe('sound casting choices',()=>{
  it('maps the audible role rather than treating every passing object as air',()=>{
    expect(paletteSlotFor('flyby','metal',.4)).toBe('projectileFlyby');
    expect(paletteSlotFor('flyby','wood',1)).toBe('debrisFlyby');
    expect(paletteSlotFor('flyby','stone',5)).toBe('massiveFlyby');
    expect(paletteSlotFor('impact','concrete',4)).toBe('masonryImpact');
    expect(paletteSlotFor('collapse','stone',4)).toBe('masonryCollapse');
    expect(paletteSlotFor('impact','glass',.4)).toBeNull();
  });
  it('preserves valid choices and upgrades old preferences without losing volume',()=>{
    const settings=sanitizeSettings({master:.4});
    expect(settings.master).toBe(.4);expect(settings.acoustics).toBe('dry');
    expect(settings.palette).toEqual(DEFAULT_PALETTE);
    expect(sanitizePalette({masonryImpact:'natural',metalImpact:'malicious',other:'designed'})).toEqual({...DEFAULT_PALETTE,masonryImpact:'natural'});
  });
  it('resolves only the known bank IDs and copies persisted maps',()=>{
    expect(paletteClipId('masonryImpact','natural')).toBe('masonryImpact-natural');
    expect(paletteClipId('metalCollapse','original')).toBe('debris-metal');
    const copy=sanitizePalette(DEFAULT_PALETTE);copy.masonryImpact='designed';
    expect(DEFAULT_PALETTE.masonryImpact).toBe('original');
  });
});
