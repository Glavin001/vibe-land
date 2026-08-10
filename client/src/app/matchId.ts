const DEFAULT_MATCH_ID = 'default';

/**
 * Default match id implied by a route. `/city` maps to a `city`-prefixed id,
 * which is what makes the server build the destructible mini-city for the
 * match (see server/src/city.rs `is_city_match`).
 */
export function defaultMatchIdForPath(pathname: string): string {
  const normalized = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
  return normalized === '/city' ? 'city-default' : DEFAULT_MATCH_ID;
}

export function resolveRequestedMatchId(
  search: string,
  fallback = DEFAULT_MATCH_ID,
): string {
  const params = new URLSearchParams(search);
  const requested = params.get('match') ?? params.get('matchId');
  const trimmed = requested?.trim();
  return trimmed ? trimmed : fallback;
}

export function buildMatchHref(
  pathname: string,
  matchId: string,
  fallback = DEFAULT_MATCH_ID,
): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (!matchId || matchId === fallback) {
    return normalizedPath;
  }
  const params = new URLSearchParams();
  params.set('match', matchId);
  return `${normalizedPath}?${params.toString()}`;
}
