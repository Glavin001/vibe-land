import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/config';
import type { FleetRow, HeartbeatBody, JoinPending, JoinReady, JoinResponse } from '../src/types';

/**
 * The RPC surface under test, spelled out locally rather than derived from the
 * class: `DurableObjectStub<FleetDO>` expands into a type deep enough to defeat
 * the checker, and this also documents exactly what callers depend on.
 */
interface FleetStub extends DurableObjectStub {
  join(): Promise<JoinResponse>;
  heartbeat(body: HeartbeatBody): Promise<{ drain: boolean }>;
  fleet(): Promise<FleetRow[]>;
  kill(id: string): Promise<{ ok: boolean }>;
  registerStatic(id: string): Promise<{ serverDoId: string }>;
}

const testEnv = env as unknown as Env;

/**
 * The fleet spends real money, so these tests are written against the failure
 * modes rather than the happy path: every one of them asserts that a box either
 * gets destroyed when it should, or is never abandoned while still billing.
 */

// A fresh DO per test -- state is the subject here, so it must not leak.
let counter = 0;
function freshStub(): FleetStub {
  const id = testEnv.FLEET.idFromName(`fleet-test-${counter++}`);
  return testEnv.FLEET.get(id) as unknown as FleetStub;
}

interface MockOptions {
  createFails?: number;
  instanceStatus?: string;
  deleteFails?: number;
  listInstances?: unknown[];
}

/** Stands in for the Vast marketplace and records what was asked of it. */
function mockVast(options: MockOptions = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  let creates = 0;
  let deletes = 0;

  vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (method === 'PUT' && url.pathname === '/api/v0/bundles/') {
      return Response.json({
        offers: [
          { id: 101, machine_id: 5001, dph_total: 0.3, gpu_name: 'RTX 4090', geolocation: 'US' },
          { id: 102, machine_id: 5002, dph_total: 0.4, gpu_name: 'RTX 4090', geolocation: 'US' },
          { id: 103, machine_id: 5003, dph_total: 0.5, gpu_name: 'RTX 4090', geolocation: 'US' },
          { id: 104, machine_id: 5004, dph_total: 0.6, gpu_name: 'RTX 4090', geolocation: 'US' },
          { id: 105, machine_id: 5005, dph_total: 0.7, gpu_name: 'RTX 4090', geolocation: 'US' },
          { id: 106, machine_id: 5006, dph_total: 0.8, gpu_name: 'RTX 4090', geolocation: 'US' },
        ],
      });
    }
    if (method === 'PUT' && /^\/api\/v0\/asks\/\d+\/$/.test(url.pathname)) {
      creates += 1;
      if (creates <= (options.createFails ?? 0)) {
        return Response.json({ success: false }, { status: 400 });
      }
      return Response.json({ success: true, new_contract: 9000 + creates });
    }
    if (method === 'GET' && url.pathname === '/api/v0/instances/') {
      return Response.json({ instances: options.listInstances ?? [] });
    }
    if (method === 'GET' && /^\/api\/v0\/instances\/\d+\/$/.test(url.pathname)) {
      return Response.json({
        instances: {
          id: 9001,
          actual_status: options.instanceStatus ?? 'running',
          public_ipaddr: '203.0.113.9',
          dph_total: 0.3,
        },
      });
    }
    if (method === 'DELETE' && /^\/api\/v0\/instances\/\d+\/$/.test(url.pathname)) {
      deletes += 1;
      if (deletes <= (options.deleteFails ?? 0)) {
        return Response.json({ error: 'boom' }, { status: 500 });
      }
      return Response.json({ success: true });
    }
    return Response.json({ error: 'unexpected' }, { status: 404 });
  });

  return {
    calls,
    creates: () => creates,
    deletes: () => deletes,
    deleteCalls: () => calls.filter((call) => call.method === 'DELETE'),
  };
}

function heartbeatBody(serverDoId: string, overrides: Partial<HeartbeatBody> = {}): HeartbeatBody {
  return {
    server_do_id: serverDoId,
    ip: '203.0.113.9',
    udp_port: 40687,
    cert_hash: 'deadbeef',
    active_matches: 1,
    players: 1,
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
    ...overrides,
  };
}

/** Drive the state machine forward N alarm ticks. */
async function tick(stub: FleetStub, times = 1) {
  for (let i = 0; i < times; i++) {
    await runDurableObjectAlarm(stub);
  }
}

/** Rewrite stored timestamps to simulate elapsed time without waiting. */
async function ageBy(stub: FleetStub, column: string, ms: number) {
  // Cast through `any`: the helper's generics expand into a type the checker
  // gives up on (TS2589) when applied to a DO with this many RPC methods.
  await (runInDurableObject as any)(stub, (instance: any) => {
    instance.ctx.storage.sql.exec(
      `UPDATE servers SET ${column} = ${column} - ? WHERE ${column} IS NOT NULL`,
      ms,
    );
  });
}

async function phaseOf(stub: FleetStub): Promise<string> {
  const rows = await stub.fleet();
  return rows[0]?.phase ?? 'NONE';
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('provisioning', () => {
  it('boots a server on first join and reports it ready once it heartbeats', async () => {
    const vast = mockVast();
    const stub = freshStub();

    const first = (await stub.join()) as JoinPending;
    expect(first.ready).toBe(false);
    expect(first.phase).toBe('SEARCHING');

    await tick(stub, 2); // select an offer, then create
    expect(await phaseOf(stub)).toBe('BOOTING');
    expect(vast.creates()).toBe(1);

    await tick(stub); // poll status -- 'running' alone must NOT promote
    expect(await phaseOf(stub)).toBe('BOOTING');

    const [row] = await stub.fleet();
    await stub.heartbeat(heartbeatBody(row.serverDoId));
    expect(await phaseOf(stub)).toBe('READY');

    const joined = (await stub.join()) as JoinReady;
    expect(joined.ready).toBe(true);
    expect(joined.url).toBe('https://203.0.113.9:40687/game');
    expect(joined.certHashHex).toBe('deadbeef');
  });

  it('never returns an endpoint without the certificate hash needed to reach it', async () => {
    mockVast();
    const stub = freshStub();
    await stub.join();
    await tick(stub, 2);
    const [row] = await stub.fleet();
    await stub.heartbeat(heartbeatBody(row.serverDoId));

    const joined = (await stub.join()) as JoinReady;
    // A URL without its pinned hash is unusable: the browser cannot verify a
    // self-signed cert any other way, so handing one out is a silent dead end.
    expect(joined.certHashHex).toBeTruthy();
    expect(joined.session.url).toBeTruthy();
  });

  it('rents only one box when several players arrive at an empty fleet', async () => {
    mockVast();
    const stub = freshStub();

    await Promise.all([stub.join(), stub.join(), stub.join()]);
    await tick(stub, 3);

    const rows = await stub.fleet();
    expect(rows).toHaveLength(1);
  });

  it('tries a different host when the offer is taken, without reusing the bad machine', async () => {
    const vast = mockVast({ createFails: 2 });
    const stub = freshStub();
    await stub.join();

    await tick(stub, 6);

    const creates = vast.calls.filter((call) => /asks/.test(call.path));
    const offerIds = creates.map((call) => call.path);
    expect(new Set(offerIds).size).toBe(offerIds.length); // never retried the same offer
    expect(await phaseOf(stub)).toBe('BOOTING');
  });

  it('gives up with no_capacity rather than shopping forever', async () => {
    mockVast({ createFails: 99 });
    const stub = freshStub();
    await stub.join();

    await tick(stub, 20);

    expect(await phaseOf(stub)).toBe('DEAD');
    const [row] = await stub.fleet();
    expect(row.deadReason).toBe('no_capacity');
    expect(row.attempt).toBeLessThanOrEqual(5);
  });

  it('adopts an instance it already paid for after an eviction mid-create', async () => {
    // The DO died between sending the create and storing the id. The rental
    // exists and is billing; re-creating would double the bill and orphan one.
    const stub = freshStub();
    mockVast();
    await stub.join();
    await tick(stub); // select offer

    const [row] = await stub.fleet();
    const label = `vl-${row.serverDoId}`;
    await (runInDurableObject as any)(stub, (instance: any) => {
      instance.ctx.storage.sql.exec(
        'UPDATE servers SET create_intent = 1, pending_offer_id = NULL WHERE server_do_id = ?',
        row.serverDoId,
      );
    });

    const vast = mockVast({
      listInstances: [
        { id: 9999, actual_status: 'running', label, dph_total: 0.3, public_ipaddr: '203.0.113.9' },
      ],
    });
    await tick(stub);

    const [after] = await stub.fleet();
    expect(after.vastInstanceId).toBe(9999);
    expect(after.phase).toBe('BOOTING');
    expect(vast.creates()).toBe(0); // crucially, did not rent a second box
  });
});

describe('reaping', () => {
  async function readyServer(options: MockOptions = {}) {
    const vast = mockVast(options);
    const stub = freshStub();
    await stub.join();
    await tick(stub, 2);
    const [row] = await stub.fleet();
    await stub.heartbeat(heartbeatBody(row.serverDoId));
    return { stub, vast, serverDoId: row.serverDoId };
  }

  it('destroys a server that stops heartbeating', async () => {
    const { stub, vast } = await readyServer();

    await ageBy(stub, 'last_heartbeat_at', 91_000);
    await tick(stub); // notices silence, schedules the kill
    await tick(stub); // issues the DELETE

    expect(vast.deleteCalls()).toHaveLength(1);
    const [row] = await stub.fleet();
    expect(row.phase).toBe('DEAD');
    expect(row.deadReason).toBe('heartbeat_lost');
  });

  it('destroys an idle server once no players remain', async () => {
    const { stub, vast, serverDoId } = await readyServer();

    await stub.heartbeat(heartbeatBody(serverDoId, { players: 0, active_matches: 1 }));
    await ageBy(stub, 'idle_since', 11 * 60_000);
    await ageBy(stub, 'last_heartbeat_at', 0);
    await tick(stub, 2);

    expect(vast.deleteCalls()).toHaveLength(1);
    expect((await stub.fleet())[0].deadReason).toBe('idle');
  });

  it('keeps a busy server alive and clears the idle timer when players return', async () => {
    const { stub, vast, serverDoId } = await readyServer();

    await stub.heartbeat(heartbeatBody(serverDoId, { players: 0 }));
    await ageBy(stub, 'idle_since', 5 * 60_000);
    await stub.heartbeat(heartbeatBody(serverDoId, { players: 2 }));
    await ageBy(stub, 'idle_since', 6 * 60_000);
    await tick(stub, 2);

    expect(vast.deleteCalls()).toHaveLength(0);
    expect(await phaseOf(stub)).toBe('READY');
  });

  it('destroys a wedged server at the spend cap even while it keeps heartbeating', async () => {
    // The dangerous failure: a server healthy enough to report in, but useless.
    // Nothing about its own reports can save it from the cap.
    const { stub, vast, serverDoId } = await readyServer();

    await ageBy(stub, 'boot_started_at', 20 * 3_600_000); // ~$6 at $0.30/h
    await stub.heartbeat(heartbeatBody(serverDoId, { players: 99 }));
    await tick(stub, 2);

    expect(vast.deleteCalls()).toHaveLength(1);
    expect((await stub.fleet())[0].deadReason).toBe('hard_cap');
  });

  it('destroys a server past the uptime cap', async () => {
    const { stub, vast, serverDoId } = await readyServer();

    await ageBy(stub, 'boot_started_at', 7 * 3_600_000);
    await stub.heartbeat(heartbeatBody(serverDoId));
    await tick(stub, 2);

    expect(vast.deleteCalls()).toHaveLength(1);
    expect((await stub.fleet())[0].deadReason).toBe('hard_cap');
  });

  it('retries a failing DELETE forever and never marks the box dead early', async () => {
    // Marking DEAD on an unconfirmed delete is how instances get orphaned:
    // the row stops being tracked while Vast keeps billing.
    const { stub, vast } = await readyServer({ deleteFails: 3 });

    await ageBy(stub, 'last_heartbeat_at', 91_000);
    await tick(stub, 3);

    expect(await phaseOf(stub)).not.toBe('DEAD');
    expect(vast.deleteCalls().length).toBeGreaterThanOrEqual(2);

    await tick(stub, 2); // the delete finally lands
    expect(await phaseOf(stub)).toBe('DEAD');
  });

  it('abandons a host whose container died during boot and tries another', async () => {
    mockVast({ instanceStatus: 'exited' });
    const stub = freshStub();
    await stub.join();
    await tick(stub, 2);
    expect(await phaseOf(stub)).toBe('BOOTING');

    await tick(stub); // sees 'exited'
    await tick(stub); // deletes, then re-searches
    expect(await phaseOf(stub)).toBe('SEARCHING');
  });

  it('abandons a host that never finishes booting', async () => {
    mockVast({ instanceStatus: 'loading' });
    const stub = freshStub();
    await stub.join();
    await tick(stub, 2);

    await ageBy(stub, 'boot_started_at', 8 * 60_000);
    await tick(stub, 2);

    expect(await phaseOf(stub)).toBe('SEARCHING');
  });

  it('stops routing players to a server the moment it is doomed', async () => {
    const { stub } = await readyServer();
    await ageBy(stub, 'last_heartbeat_at', 91_000);
    await tick(stub); // kill scheduled, DELETE not yet issued

    const result = (await stub.join()) as JoinPending;
    expect(result.ready).toBe(false);
  });
});

describe('capacity', () => {
  it('does not overfill a box between heartbeats', async () => {
    // Heartbeats are 30 s apart. Without an optimistic hold, a burst of joins
    // would all read the same stale player count and pile onto one server.
    mockVast();
    const stub = freshStub();
    await stub.join();
    await tick(stub, 2);
    const [row] = await stub.fleet();
    await stub.heartbeat(heartbeatBody(row.serverDoId, { players: 15 })); // cap is 16

    const first = (await stub.join()) as JoinReady;
    expect(first.ready).toBe(true);

    const second = await stub.join();
    expect(second.ready).toBe(false); // the 16th seat was already promised
  });
});

describe('static registration', () => {
  it('runs a hand-started box through the same lifecycle without touching Vast', async () => {
    const vast = mockVast();
    const stub = freshStub();

    await stub.registerStatic('dev-box');
    await stub.heartbeat(heartbeatBody('dev-box'));

    expect(await phaseOf(stub)).toBe('READY');
    const joined = (await stub.join()) as JoinReady;
    expect(joined.ready).toBe(true);
    expect(joined.matchId).toBe('city-dev-box');
    expect(vast.calls).toHaveLength(0);
  });

  it('ignores heartbeats from a server it has already given up on', async () => {
    mockVast();
    const stub = freshStub();
    const result = await stub.heartbeat(heartbeatBody('ghost'));
    expect(result.drain).toBe(false);
    expect(await stub.fleet()).toHaveLength(0);
  });
});

describe('operator-run boxes', () => {
  it('never reaps a static box for being idle or expensive', async () => {
    // These caps exist to stop paying for a rental. A box we did not rent
    // costs nothing, and reaping it strands players: with nothing able to boot
    // a replacement, /join has no server to offer and never will.
    const vast = mockVast();
    const stub = freshStub();
    await stub.registerStatic('operator-box');
    await stub.heartbeat(heartbeatBody('operator-box', { players: 0 }));

    await ageBy(stub, 'idle_since', 60 * 60_000);
    await ageBy(stub, 'boot_started_at', 24 * 3_600_000);
    await tick(stub, 2);

    expect(await phaseOf(stub)).toBe('READY');
    expect(vast.deleteCalls()).toHaveLength(0);
  });

  it('still destroys a static box that stops heartbeating', async () => {
    // Liveness is not cost: a silent box cannot serve anyone.
    mockVast();
    const stub = freshStub();
    await stub.registerStatic('operator-box');
    await stub.heartbeat(heartbeatBody('operator-box'));

    await ageBy(stub, 'last_heartbeat_at', 91_000);
    await tick(stub, 2);

    expect(await phaseOf(stub)).toBe('DEAD');
    expect((await stub.fleet())[0].deadReason).toBe('heartbeat_lost');
  });
});
