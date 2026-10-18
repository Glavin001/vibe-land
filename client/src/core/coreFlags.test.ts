import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreFlag } from './coreFlags';

describe('shared-core flags', () => {
  afterEach(() => vi.unstubAllGlobals());
  const at = (search: string) => vi.stubGlobal('location', { search });

  it('are on by default', () => {
    at('');
    expect(coreFlag('coreStream', undefined)).toBe(true);
    at('?match=citypp-demo&coreStream=1');
    expect(coreFlag('coreStream', undefined)).toBe(true);
  });

  it('turn off with ?name=0 or the build variable set to 0', () => {
    at('?coreStream=0');
    expect(coreFlag('coreStream', undefined)).toBe(false);
    expect(coreFlag('corePredictor', undefined)).toBe(true);
    at('');
    expect(coreFlag('coreStream', '0')).toBe(false);
    expect(coreFlag('coreStream', '1')).toBe(true);
  });
});
