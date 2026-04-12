import type { GameMode } from './gameMode';

export type AppRoute =
  | { kind: 'launcher' }
  | { kind: 'game'; mode: GameMode }
  | { kind: 'stats' }
  | { kind: 'loadtest' };

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return normalized || '/';
}

export function resolveAppRoute(pathname: string): AppRoute {
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
    default:
      return { kind: 'launcher' };
  }
}

