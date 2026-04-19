export type RuntimeEnv = {
  VITE_MULTIPLAYER_HTTP_ORIGIN?: string;
};

export type LocationLike = {
  origin: string;
};

export type MultiplayerBackend = {
  httpOrigin: string;
  sessionConfigEndpoint: string;
  statsWebSocketUrl: string;
  createMatchWebSocketUrl: (
    matchId: string,
    identity: string,
    token: string,
    options?: { username?: string },
  ) => string;
};

function normalizeOrigin(rawValue: string | undefined, fallbackOrigin: string): string {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return fallbackOrigin;
  }
  return new URL(trimmed).origin;
}

function withPath(origin: string, pathname: string): string {
  return new URL(pathname, `${origin}/`).toString();
}

export function resolveMultiplayerBackend(
  env: RuntimeEnv = import.meta.env as RuntimeEnv,
  locationLike: LocationLike = window.location,
): MultiplayerBackend {
  const httpOrigin = normalizeOrigin(env.VITE_MULTIPLAYER_HTTP_ORIGIN, locationLike.origin);
  const wsProtocol = httpOrigin.startsWith('https:') ? 'wss:' : 'ws:';
  const wsOrigin = `${wsProtocol}//${new URL(httpOrigin).host}`;

  return {
    httpOrigin,
    sessionConfigEndpoint: withPath(httpOrigin, '/session-config'),
    statsWebSocketUrl: withPath(wsOrigin, '/ws/stats'),
    createMatchWebSocketUrl: (
      matchId: string,
      identity: string,
      token: string,
      options?: { username?: string },
    ) => {
      const url = new URL(`/ws/${encodeURIComponent(matchId)}`, `${wsOrigin}/`);
      url.searchParams.set('identity', identity);
      url.searchParams.set('token', token);
      const username = options?.username?.trim();
      if (username) {
        url.searchParams.set('username', username);
      }
      return url.toString();
    },
  };
}
