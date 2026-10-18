#!/usr/bin/env node
/**
 * A fake Vast.ai marketplace, good enough to drive the real control plane.
 *
 * Mirrors exactly the four calls in `src/vast.ts`. The point is to exercise the
 * full provisioning lifecycle -- including the failure paths that are hard to
 * induce on a real marketplace -- without spending money or waiting on a boot.
 *
 * Usage:
 *   node mock-vast/server.mjs [--port 5175] [--fail-create N] [--exit-after MS] [--local-box]
 *
 *   --fail-create N   first N create calls fail, as if the offer went stale
 *   --exit-after MS   instances flip to 'exited' after MS, as if the container died
 *   --local-box       created instances describe THIS machine, and the env block
 *                     the game server needs is printed for copy-paste
 */

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(name);

const PORT = Number(flag('--port', 5175));
const FAIL_CREATE = Number(flag('--fail-create', 0));
const EXIT_AFTER = Number(flag('--exit-after', 0));
const LOCAL_BOX = has('--local-box');
const PUBLIC_IP = process.env.PUBLIC_IPADDR ?? '127.0.0.1';

let nextInstanceId = 9000;
let createCalls = 0;
const instances = new Map();

const OFFERS = [
  { id: 101, machine_id: 5001, dph_total: 0.34, gpu_name: 'RTX 4090', geolocation: 'US' },
  { id: 102, machine_id: 5002, dph_total: 0.41, gpu_name: 'RTX 4090', geolocation: 'US' },
  { id: 103, machine_id: 5003, dph_total: 0.52, gpu_name: 'RTX 4090', geolocation: 'CA' },
];

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function snapshot(instance) {
  const dead = EXIT_AFTER > 0 && Date.now() - instance.createdAt > EXIT_AFTER;
  return {
    id: instance.id,
    actual_status: dead ? 'exited' : instance.status,
    status_msg: dead ? 'container exited' : null,
    public_ipaddr: instance.publicIp,
    label: instance.label,
    dph_total: instance.dph,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};

  console.log(`[mock-vast] ${req.method} ${path}`);

  if (req.method === 'PUT' && path === '/api/v0/bundles/') {
    return send(res, 200, { offers: OFFERS });
  }

  const createMatch = /^\/api\/v0\/asks\/(\d+)\/$/.exec(path);
  if (req.method === 'PUT' && createMatch) {
    createCalls += 1;
    if (createCalls <= FAIL_CREATE) {
      console.log(`[mock-vast] rejecting create #${createCalls} (--fail-create ${FAIL_CREATE})`);
      return send(res, 400, { success: false, msg: 'offer no longer available' });
    }
    const id = nextInstanceId++;
    const offerId = Number(createMatch[1]);
    const offer = OFFERS.find((candidate) => candidate.id === offerId);
    instances.set(id, {
      id,
      status: 'loading',
      label: body.label ?? null,
      publicIp: LOCAL_BOX ? PUBLIC_IP : '203.0.113.9',
      dph: offer?.dph_total ?? 0.4,
      createdAt: Date.now(),
      env: body.env ?? {},
    });
    // A real boot takes minutes; flip to running promptly so local runs are
    // about the state machine rather than about waiting.
    setTimeout(() => {
      const instance = instances.get(id);
      if (instance) instance.status = 'running';
    }, 3000);

    console.log(`[mock-vast] created instance ${id} from offer ${offerId}`);
    if (LOCAL_BOX) printLocalBoxEnv(body.env ?? {});
    return send(res, 200, { success: true, new_contract: id });
  }

  const showMatch = /^\/api\/v0\/instances\/(\d+)\/$/.exec(path);
  if (req.method === 'GET' && showMatch) {
    const instance = instances.get(Number(showMatch[1]));
    if (!instance) return send(res, 404, { error: 'not found' });
    return send(res, 200, { instances: snapshot(instance) });
  }

  if (req.method === 'GET' && path === '/api/v0/instances/') {
    return send(res, 200, { instances: [...instances.values()].map(snapshot) });
  }

  if (req.method === 'DELETE' && showMatch) {
    const id = Number(showMatch[1]);
    if (!instances.has(id)) return send(res, 404, { error: 'not found' });
    instances.delete(id);
    console.log(`[mock-vast] destroyed instance ${id}`);
    return send(res, 200, { success: true });
  }

  return send(res, 404, { error: `unhandled ${req.method} ${path}` });
});

function printLocalBoxEnv(env) {
  const udp = process.env.VAST_UDP_PORT_4433 ?? '4433';
  console.log(`
[mock-vast] --local-box: run the game server on THIS machine with:

  export CONTROL_PLANE_URL=${env.CONTROL_PLANE_URL ?? ''}
  export SERVER_DO_ID=${env.SERVER_DO_ID ?? ''}
  export HEARTBEAT_TOKEN=${env.HEARTBEAT_TOKEN ?? ''}
  export MATCHES_PER_BOX=${env.MATCHES_PER_BOX ?? '6'}
  export HEARTBEAT_PUBLIC_IP=${PUBLIC_IP}
  export HEARTBEAT_UDP_PORT=${udp}
`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[mock-vast] listening on http://127.0.0.1:${PORT} ` +
      `(fail-create=${FAIL_CREATE} exit-after=${EXIT_AFTER || 'never'} local-box=${LOCAL_BOX})`,
  );
});
