/**
 * SpacetimeDB connection helper for anonymous browser players.
 *
 * Responsibilities:
 * - reuse persisted anonymous token if present
 * - persist fresh token on first connect
 * - subscribe to control-plane tables (roster, scoreboard, killfeed, match metadata)
 * - expose the identity/token needed to authenticate the gameplay websocket
 *
 * NOTE: official docs currently show both `.withDatabaseName(...)` and `.withModuleName(...)`
 * in different TypeScript snippets. This helper supports either shape.
 */

import { DbConnection } from './module_bindings';

export type SpacetimeConnectOptions = {
  host: string;
  databaseName: string;
  matchId: string;
  onReady?: (ctx: { conn: any; identity: string; token: string }) => void;
  onDisconnect?: (error?: Error) => void;
};

function applyDatabaseSelector(builder: any, databaseName: string): any {
  if (typeof builder.withDatabaseName === 'function') return builder.withDatabaseName(databaseName);
  if (typeof builder.withModuleName === 'function') return builder.withModuleName(databaseName);
  throw new Error('Generated SpacetimeDB bindings expose neither withDatabaseName nor withModuleName.');
}

export function connectSpacetime(options: SpacetimeConnectOptions) {
  const tokenKey = `${options.host}/${options.databaseName}/auth_token`;
  const savedToken = localStorage.getItem(tokenKey) ?? undefined;

  let builder = DbConnection.builder().withUri(options.host);
  builder = applyDatabaseSelector(builder, options.databaseName)
    .withToken(savedToken)
    .onConnect((conn: any, identity: any, token: string) => {
      localStorage.setItem(tokenKey, token);

      conn.subscriptionBuilder()
        .onApplied(() => {
          const identityString = identity?.toHexString?.() ?? String(identity);
          options.onReady?.({ conn, identity: identityString, token });
        })
        .subscribe([
          `SELECT * FROM match WHERE id = ${options.matchId}`,
          `SELECT * FROM match_roster WHERE match_id = ${options.matchId}`,
          `SELECT * FROM team_score WHERE match_id = ${options.matchId}`,
          `SELECT * FROM killfeed WHERE match_id = ${options.matchId}`,
        ]);
    })
    .onDisconnect((_ctx: any, error?: Error) => {
      options.onDisconnect?.(error);
    })
    .onConnectError((_ctx: any, error: Error) => {
      console.error('SpacetimeDB connect failed', error);
    });

  return builder.build();
}

export function buildGameplayWsUrl(baseWsUrl: string, matchId: string, identity: string, token: string): string {
  const url = new URL(`/ws/${matchId}`, baseWsUrl);
  url.searchParams.set('identity', identity);
  url.searchParams.set('token', token);
  return url.toString();
}
