import type { GameMode } from './gameMode';

export type AppRoute =
  | { kind: 'launcher' }
  | { kind: 'game'; mode: GameMode }
  | { kind: 'stats' }
  | { kind: 'loadtest' }
  | { kind: 'builder'; page: 'world'; publishedId?: string }
  | { kind: 'gallery' };

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return normalized || '/';
}

export function resolveAppRoute(pathname: string, search?: string): AppRoute {
  const params = new URLSearchParams(search ?? '');
  const publishedId = params.get('published') ?? undefined;
  switch (normalizePathname(pathname)) {
    case '/':
    case '/index.html':
      return { kind: 'launcher' };
    case '/play':
      return { kind: 'game', mode: 'multiplayer' };
    case '/practice':
      return { kind: 'game', mode: 'practice' };
    case '/stats':
      return { kind: 'stats' };
    case '/loadtest':
      return { kind: 'loadtest' };
    case '/builder/world':
    case '/godmode':
      return { kind: 'builder', page: 'world', publishedId };
    case '/gallery':
      return { kind: 'gallery' };
    default:
      return { kind: 'launcher' };
  }
}
