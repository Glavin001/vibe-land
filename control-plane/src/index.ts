import { bearerToken, readConfig, safeEqual, type Env } from './config';
import type { HeartbeatBody } from './types';

export { FleetDO } from './fleet-do';

/**
 * HTTP surface of the control plane. Deliberately thin: it authenticates,
 * parses, and forwards to the single FleetDO. No storage, no Vast calls, no
 * decisions -- so a Worker redeploy can never disturb a live fleet.
 *
 * Player game traffic never passes through here. This hands out an address and
 * a certificate hash; the browser then talks straight to the GPU box over
 * WebTransport.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers ?? {}) },
  });
}

function fleetStub(env: Env) {
  return env.FLEET.get(env.FLEET.idFromName('fleet')) as unknown as {
    join(): Promise<unknown>;
    heartbeat(body: HeartbeatBody): Promise<{ drain: boolean }>;
    fleet(): Promise<unknown>;
    kill(id: string): Promise<{ ok: boolean }>;
    registerStatic(id: string): Promise<{ serverDoId: string }>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === '/join' && request.method === 'GET') {
        return json(await fleetStub(env).join());
      }

      if (path === '/servers/heartbeat' && request.method === 'POST') {
        const token = bearerToken(request);
        if (!token || !safeEqual(token, env.HEARTBEAT_TOKEN ?? '')) {
          return json({ error: 'unauthorized' }, { status: 401 });
        }
        const body = (await request.json()) as HeartbeatBody;
        if (!body?.server_do_id) {
          return json({ error: 'server_do_id required' }, { status: 400 });
        }
        return json(await fleetStub(env).heartbeat(body));
      }

      if (path === '/healthz' && request.method === 'GET') {
        return json({ status: 'ok' });
      }

      // ------------------------------------------------------------- admin
      const admin = () => {
        const token = bearerToken(request);
        return Boolean(token && safeEqual(token, env.ADMIN_TOKEN ?? ''));
      };

      if (path === '/fleet' && request.method === 'GET') {
        if (!admin()) return json({ error: 'unauthorized' }, { status: 401 });
        const config = readConfig(env);
        return json({ image: config.serverImage, servers: await fleetStub(env).fleet() });
      }

      if (path.startsWith('/kill/') && request.method === 'POST') {
        if (!admin()) return json({ error: 'unauthorized' }, { status: 401 });
        const id = decodeURIComponent(path.slice('/kill/'.length));
        const result = await fleetStub(env).kill(id);
        return json(result, { status: result.ok ? 200 : 404 });
      }

      if (path === '/admin/register-static' && request.method === 'POST') {
        if (!admin()) return json({ error: 'unauthorized' }, { status: 401 });
        const body = (await request.json()) as { server_do_id?: string };
        if (!body?.server_do_id) {
          return json({ error: 'server_do_id required' }, { status: 400 });
        }
        return json(await fleetStub(env).registerStatic(body.server_do_id));
      }

      return json({ error: 'not found' }, { status: 404 });
    } catch (error) {
      console.log(JSON.stringify({ event: 'request_error', path, error: String(error) }));
      return json({ error: 'internal error' }, { status: 500 });
    }
  },
};
