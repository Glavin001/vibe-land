import type { GameMode } from './gameMode';

export type AppRoute =
  | { kind: 'launcher' }
  | { kind: 'game'; mode: GameMode }
  | { kind: 'sharedPractice'; id: string }
  | { kind: 'hostedWorld'; worldId: string; arenaId?: string }
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

const SHARED_PRACTICE_PREFIX = '/practice/shared/';
const HOSTED_WORLD_PREFIX = '/play/world/';

export function resolveAppRoute(pathname: string, search?: string): AppRoute {
  const params = new URLSearchParams(search ?? '');
  const publishedId = params.get('published') ?? undefined;
  const normalized = normalizePathname(pathname);

  if (normalized.startsWith(HOSTED_WORLD_PREFIX)) {
    const rest = normalized.slice(HOSTED_WORLD_PREFIX.length);
    const parts = rest.split('/');
    const worldId = decodeURIComponent(parts[0] ?? '');
    const arenaId = parts[1] ? decodeURIComponent(parts[1]) : undefined;
    if (worldId) {
      return { kind: 'hostedWorld', worldId, arenaId };
    }
  }

  if (normalized.startsWith(SHARED_PRACTICE_PREFIX)) {
    const rest = normalized.slice(SHARED_PRACTICE_PREFIX.length);
    const id = rest.split('/')[0] ?? '';
    if (id) {
      return { kind: 'sharedPractice', id: decodeURIComponent(id) };
    }
  }

  switch (normalized) {
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
