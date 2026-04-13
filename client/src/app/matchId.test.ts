import { describe, expect, it } from 'vitest';
import { buildMatchHref, resolveRequestedMatchId } from './matchId';

describe('resolveRequestedMatchId', () => {
  it('uses the match query parameter when present', () => {
    expect(resolveRequestedMatchId('?match=duel-room')).toBe('duel-room');
  });

  it('falls back to matchId for backward compatibility', () => {
    expect(resolveRequestedMatchId('?matchId=legacy-room')).toBe('legacy-room');
  });

  it('returns the fallback when the query is empty', () => {
    expect(resolveRequestedMatchId('', 'custom-default')).toBe('custom-default');
    expect(resolveRequestedMatchId('?match=', 'custom-default')).toBe('custom-default');
  });
});

describe('buildMatchHref', () => {
  it('omits the query for the default match', () => {
    expect(buildMatchHref('/play', 'default')).toBe('/play');
  });

  it('includes the query for a custom match', () => {
    expect(buildMatchHref('/play', 'duel-room')).toBe('/play?match=duel-room');
  });
});
