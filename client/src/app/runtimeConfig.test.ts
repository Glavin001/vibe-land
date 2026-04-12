import { describe, expect, it } from 'vitest';
import { resolveMultiplayerBackend } from './runtimeConfig';

describe('resolveMultiplayerBackend', () => {
  it('defaults to same-origin endpoints', () => {
    const backend = resolveMultiplayerBackend({}, { origin: 'https://play.example.com' });

    expect(backend.httpOrigin).toBe('https://play.example.com');
    expect(backend.sessionConfigEndpoint).toBe('https://play.example.com/session-config');
    expect(backend.statsWebSocketUrl).toBe('wss://play.example.com/ws/stats');
    expect(backend.createMatchWebSocketUrl('default', 'player-1', 'token')).toBe(
      'wss://play.example.com/ws/default?identity=player-1&token=token',
    );
  });

  it('uses the configured multiplayer origin when provided', () => {
    const backend = resolveMultiplayerBackend(
      { VITE_MULTIPLAYER_HTTP_ORIGIN: 'http://game.example.com:4001' },
      { origin: 'https://app.example.com' },
    );

    expect(backend.httpOrigin).toBe('http://game.example.com:4001');
    expect(backend.sessionConfigEndpoint).toBe('http://game.example.com:4001/session-config');
    expect(backend.statsWebSocketUrl).toBe('ws://game.example.com:4001/ws/stats');
    expect(backend.createMatchWebSocketUrl('default', 'player-1', 'token')).toBe(
      'ws://game.example.com:4001/ws/default?identity=player-1&token=token',
    );
  });
});
