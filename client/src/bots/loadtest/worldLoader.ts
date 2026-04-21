/**
 * Resolves the {@link WorldDocument} a load-test session should use to build
 * its shared navmesh.
 *
 * Today the server doesn't expose per-match world JSON over the
 * session-config endpoint, so this falls back to the bundled
 * {@link DEFAULT_WORLD_DOCUMENT}. A future iteration can fetch the actual
 * world from the server and cache it per `matchId` here without touching
 * call-sites.
 */
import { DEFAULT_WORLD_DOCUMENT, type WorldDocument } from '../../world/worldDocument';

export interface LoadTestWorldOptions {
  /** Match id, currently advisory — reserved for per-match worlds. */
  matchId?: string;
}

const cache = new Map<string, WorldDocument>();

export async function resolveLoadTestWorld(
  options: LoadTestWorldOptions = {},
): Promise<WorldDocument> {
  const key = options.matchId ?? '__default__';
  const cached = cache.get(key);
  if (cached) return cached;
  cache.set(key, DEFAULT_WORLD_DOCUMENT);
  return DEFAULT_WORLD_DOCUMENT;
}

/** Test/dev helper — wipe the cache so the loader re-resolves. */
export function clearLoadTestWorldCache(): void {
  cache.clear();
}
