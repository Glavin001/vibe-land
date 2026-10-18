import { describe, expect, it, vi } from 'vitest';

import { joinServer, resolveControlPlane, toSessionConfig, type JoinReady } from './join';

const readyResponse: JoinReady = {
  ready: true,
  matchId: 'city-abc12345',
  url: 'https://203.0.113.9:40687/game',
  certHashHex: 'deadbeef',
  session: {
    url: 'https://203.0.113.9:40687/game',
    sim_hz: 60,
    snapshot_hz: 30,
    interpolation_delay_ms: 100,
    protocol_version: 3,
    physics_backend: 2,
    client_movement_mode: 1,
    city_manifest_hash: 'abc123',
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resolveControlPlane', () => {
  it('is disabled by default, leaving the direct-connect path untouched', () => {
    expect(resolveControlPlane('', {})).toBeNull();
  });

  it('uses the build-time control plane when configured', () => {
    const config = resolveControlPlane('', { VITE_CONTROL_PLANE_URL: 'https://cp.example.com' });
    expect(config?.baseUrl).toBe('https://cp.example.com');
  });

  it('lets a query param override the build, so one bundle can target a scratch deploy', () => {
    const config = resolveControlPlane('?controlPlane=http://127.0.0.1:9001', {
      VITE_CONTROL_PLANE_URL: 'https://cp.example.com',
    });
    expect(config?.baseUrl).toBe('http://127.0.0.1:9001');
  });

  it('strips a trailing slash so paths do not end up doubled', () => {
    const config = resolveControlPlane('?controlPlane=https://cp.example.com/', {});
    expect(config?.baseUrl).toBe('https://cp.example.com');
  });

  it('ignores a malformed URL rather than throwing on startup', () => {
    expect(resolveControlPlane('?controlPlane=not-a-url', {})).toBeNull();
  });

  it('accepts a same-origin path, which dev uses to dodge mixed-content blocking', () => {
    expect(resolveControlPlane('?controlPlane=/cp', {})?.baseUrl).toBe('/cp');
  });
});

describe('joinServer', () => {
  it('returns immediately when a server is already running', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(readyResponse));
    const result = await joinServer({ baseUrl: 'https://cp.test' }, { fetchImpl: fetchImpl as any });

    expect(result.matchId).toBe('city-abc12345');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits through a cold start and reports progress while it boots', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ ready: false, phase: 'SEARCHING', etaSeconds: 300, retryAfterSeconds: 5 }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ ready: false, phase: 'BOOTING', etaSeconds: 120, retryAfterSeconds: 5 }),
        )
        .mockResolvedValue(jsonResponse(readyResponse));

      const progress: string[] = [];
      const promise = joinServer(
        { baseUrl: 'https://cp.test' },
        { fetchImpl: fetchImpl as any, onProgress: (p) => progress.push(p.phase) },
      );

      await vi.advanceTimersByTimeAsync(20_000);
      const result = await promise;

      expect(result.ready).toBe(true);
      expect(progress).toEqual(['SEARCHING', 'BOOTING']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never polls faster than the floor, even if the server asks it to', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ ready: false, phase: 'BOOTING', etaSeconds: 60, retryAfterSeconds: 0 }),
        )
        .mockResolvedValue(jsonResponse(readyResponse));

      const promise = joinServer({ baseUrl: 'https://cp.test' }, { fetchImpl: fetchImpl as any });

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // still waiting out the floor

      await vi.advanceTimersByTimeAsync(5000);
      await promise;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on an errored control plane instead of polling forever', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(
      joinServer({ baseUrl: 'https://cp.test' }, { fetchImpl: fetchImpl as any }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('stops waiting when the caller aborts', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ready: false, phase: 'BOOTING', etaSeconds: 60, retryAfterSeconds: 5 }),
        );

      const promise = joinServer(
        { baseUrl: 'https://cp.test' },
        { fetchImpl: fetchImpl as any, signal: controller.signal },
      );
      const assertion = expect(promise).rejects.toThrow(/abort/i);

      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('toSessionConfig', () => {
  it('produces the shape the transport already consumes', () => {
    const config = toSessionConfig(readyResponse);

    expect(config.url).toBe('https://203.0.113.9:40687/game');
    expect(config.server_certificate_hash_hex).toBe('deadbeef');
    expect(config.match_id).toBe('city-abc12345');
    expect(config.protocol_version).toBe(3);
  });

  it('marks a city match as a city world so destruction streaming bootstraps', () => {
    expect(toSessionConfig(readyResponse).city_world).toBe(true);
  });

  it('does not claim a city world when the server shipped no manifest', () => {
    const withoutManifest: JoinReady = {
      ...readyResponse,
      session: { ...readyResponse.session, city_manifest_hash: undefined },
    };
    expect(toSessionConfig(withoutManifest).city_world).toBe(false);
  });

  it('does not treat a non-city match as a city world', () => {
    const plain: JoinReady = { ...readyResponse, matchId: 'default' };
    expect(toSessionConfig(plain).city_world).toBe(false);
  });
});
