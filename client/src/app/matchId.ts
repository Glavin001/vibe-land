const DEFAULT_MATCH_ID = 'default';

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
