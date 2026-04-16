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

  it('routes the world builder page', () => {
    expect(resolveAppRoute('/builder/world')).toEqual({ kind: 'builder', page: 'world' });
    expect(resolveAppRoute('/builder/world/')).toEqual({ kind: 'builder', page: 'world' });
  });

  it('parses a published id from the query string', () => {
    expect(resolveAppRoute('/builder/world', '?published=abc123')).toEqual({
      kind: 'builder',
      page: 'world',
      publishedId: 'abc123',
    });
  });

  it('maps legacy /godmode to the builder for backwards compatibility', () => {
    expect(resolveAppRoute('/godmode')).toEqual({ kind: 'builder', page: 'world' });
    expect(resolveAppRoute('/godmode/')).toEqual({ kind: 'builder', page: 'world' });
    expect(resolveAppRoute('/godmode', '?published=xyz')).toEqual({
      kind: 'builder',
      page: 'world',
      publishedId: 'xyz',
    });
  });

  it('routes the gallery page', () => {
    expect(resolveAppRoute('/gallery')).toEqual({ kind: 'gallery' });
  });

  it('routes /practice/shared/:id to the shared-practice runner', () => {
    expect(resolveAppRoute('/practice/shared/abc123')).toEqual({ kind: 'sharedPractice', id: 'abc123' });
    expect(resolveAppRoute('/practice/shared/abc123/')).toEqual({ kind: 'sharedPractice', id: 'abc123' });
  });

  it('decodes url-encoded shared practice ids', () => {
    expect(resolveAppRoute('/practice/shared/foo%20bar')).toEqual({ kind: 'sharedPractice', id: 'foo bar' });
  });

  it('falls back to launcher when /practice/shared/ has no id', () => {
    expect(resolveAppRoute('/practice/shared/')).toEqual({ kind: 'launcher' });
  });

  it('preserves diagnostics pages', () => {
    expect(resolveAppRoute('/stats')).toEqual({ kind: 'stats' });
    expect(resolveAppRoute('/loadtest')).toEqual({ kind: 'loadtest' });
  });
});
