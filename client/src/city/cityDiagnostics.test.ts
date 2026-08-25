import { describe, expect, it } from 'vitest';

import {
  acquireCityDiagnostics,
  cityDiagnosticsHolders,
  cityDiagnosticsWanted,
} from './cityDiagnostics';

describe('cityDiagnostics', () => {
  it('is off until someone asks', () => {
    expect(cityDiagnosticsWanted()).toBe(false);
  });

  it('stays on until the LAST holder releases', () => {
    // The panel, the recorder and the e2e bridge can all want them at once;
    // whichever releases first must not switch them off under the others.
    const panel = acquireCityDiagnostics();
    const recorder = acquireCityDiagnostics();
    expect(cityDiagnosticsWanted()).toBe(true);
    panel();
    expect(cityDiagnosticsWanted()).toBe(true);
    recorder();
    expect(cityDiagnosticsWanted()).toBe(false);
  });

  it('ignores a double release, so a strict-mode double unmount cannot go negative', () => {
    const release = acquireCityDiagnostics();
    release();
    release();
    expect(cityDiagnosticsHolders()).toBe(0);
    // A later acquire must still switch them on rather than starting at -1.
    const again = acquireCityDiagnostics();
    expect(cityDiagnosticsWanted()).toBe(true);
    again();
  });
});
