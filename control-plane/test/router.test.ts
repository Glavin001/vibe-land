import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { HeartbeatBody } from '../src/types';

/**
 * The router is the only part of this system exposed to the open internet, and
 * `/join` is what stands between strangers and our GPU bill -- so the tests
 * that matter here are the ones about who is allowed to do what.
 */

const heartbeat: HeartbeatBody = {
  server_do_id: 'router-test-box',
  ip: '203.0.113.9',
  udp_port: 40687,
  cert_hash: 'deadbeef',
  active_matches: 0,
  players: 0,
  capacity: 6,
  session: {
    url: 'https://203.0.113.9:40687/game',
    sim_hz: 60,
    snapshot_hz: 30,
    interpolation_delay_ms: 100,
    protocol_version: 3,
    physics_backend: 2,
    client_movement_mode: 1,
  },
};

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return SELF.fetch(`https://cp.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('heartbeat auth', () => {
  it('rejects an unauthenticated heartbeat', async () => {
    const response = await post('/servers/heartbeat', heartbeat);
    expect(response.status).toBe(401);
  });

  it('rejects a heartbeat bearing the wrong token', async () => {
    const response = await post('/servers/heartbeat', heartbeat, 'not-the-token');
    expect(response.status).toBe(401);
  });

  it('accepts a correctly authenticated heartbeat', async () => {
    const response = await post('/servers/heartbeat', heartbeat, 'test-heartbeat');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drain: false });
  });

  it('rejects a heartbeat with no server id rather than guessing', async () => {
    const response = await post('/servers/heartbeat', { ip: '1.2.3.4' }, 'test-heartbeat');
    expect(response.status).toBe(400);
  });
});

describe('admin auth', () => {
  it('refuses to expose the fleet without the admin token', async () => {
    // The fleet view lists live endpoints and spend; it is not public.
    const response = await SELF.fetch('https://cp.test/fleet');
    expect(response.status).toBe(401);
  });

  it('will not accept the heartbeat token as an admin credential', async () => {
    const response = await SELF.fetch('https://cp.test/fleet', {
      headers: { Authorization: 'Bearer test-heartbeat' },
    });
    expect(response.status).toBe(401);
  });

  it('serves the fleet to an admin', async () => {
    const response = await SELF.fetch('https://cp.test/fleet', {
      headers: { Authorization: 'Bearer test-admin' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { servers: unknown[] };
    expect(Array.isArray(body.servers)).toBe(true);
  });

  it('refuses an unauthenticated kill', async () => {
    const response = await post('/kill/anything', {});
    expect(response.status).toBe(401);
  });
});

describe('join', () => {
  it('is reachable without credentials and answers with a pending boot', async () => {
    const response = await SELF.fetch('https://cp.test/join');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ready: boolean; retryAfterSeconds?: number };
    expect(body.ready).toBe(false);
    // Clients poll on this value; without it they would hammer the endpoint.
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(5);
  });

  it('allows a browser on another origin to call it', async () => {
    // The game client is served from Vercel, the control plane from Workers --
    // without CORS the whole flow fails in the browser but passes in curl.
    const response = await SELF.fetch('https://cp.test/join');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('answers preflight', async () => {
    const response = await SELF.fetch('https://cp.test/join', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});

describe('unknown routes', () => {
  it('404s rather than falling through to something', async () => {
    const response = await SELF.fetch('https://cp.test/nope');
    expect(response.status).toBe(404);
  });
});
