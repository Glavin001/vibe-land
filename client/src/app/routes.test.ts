import { describe, expect, it } from 'vitest';
import { resolveAppRoute } from './routes';

describe('resolveAppRoute', () => {
  it('routes the launcher paths', () => {
    expect(resolveAppRoute('/')).toEqual({ kind: 'launcher' });
    expect(resolveAppRoute('/index.html')).toEqual({ kind: 'launcher' });
    expect(resolveAppRoute('/unknown')).toEqual({ kind: 'launcher' });
  });

  it('routes multiplayer and practice pages', () => {
    expect(resolveAppRoute('/play')).toEqual({ kind: 'game', mode: 'multiplayer' });
    expect(resolveAppRoute('/play/')).toEqual({ kind: 'game', mode: 'multiplayer' });
    expect(resolveAppRoute('/practice')).toEqual({ kind: 'game', mode: 'practice' });
  });

  it('preserves diagnostics pages', () => {
    expect(resolveAppRoute('/stats')).toEqual({ kind: 'stats' });
    expect(resolveAppRoute('/loadtest')).toEqual({ kind: 'loadtest' });
  });
});

