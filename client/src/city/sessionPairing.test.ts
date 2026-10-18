// Pairing a tape with a server capture: the requests, their order, the clock
// samples they leave in the tape, and a tape that is never worse off for it
// when the server cannot pair.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cityTapeRecorder, decodeCityTape } from './cityTape';
import {
  newSessionId,
  SessionPairing,
  startPairedTape,
  stopPairedTape,
  uploadPairedTape,
} from './sessionPairing';

type Call = { url: string; method: string; body?: unknown };

/** A fetch that answers per route and remembers what it was asked. */
function fakeServer(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: init?.method ?? 'GET', body: init?.body };
    calls.push(call);
    for (const [pattern, answer] of Object.entries(routes)) {
      if (url.includes(pattern)) return answer(call);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const pairedRoutes = () => ({
  '/start': () => json({
    session_id: 's', start: { tick: 600, unix_us: 1_790_000_000_000_000, mono_us: 0 },
    server_dir: 'server', joined: false, capture_epoch_unix_us: 1_790_000_000_000_000,
  }),
  '/session-clock': () => json({ tick: 700, unix_us: 1_790_000_001_000_000, capture_mono_us: 1_000_000 }),
  '/stop': () => json({ stop: { tick: 900, unix_us: 1_790_000_005_000_000, mono_us: 5_000_000 } }),
  '/session/s/tape': () => json({ folder: 'session-s', paired: true }),
  '/tape': () => json({ folder: 'tape-1-city-default' }),
});

afterEach(() => {
  for (let session = 0; session < 1000 && cityTapeRecorder.recording; session += 1) cityTapeRecorder.stop(session);
  vi.unstubAllGlobals();
});

describe('session ids', () => {
  it('are sortable UTC stamps with a random suffix the server accepts', () => {
    const id = newSessionId(new Date(Date.UTC(2026, 8, 24, 10, 11, 12)), () => 0.5);
    expect(id).toBe('20260924-101112-iiiiii');
    expect(newSessionId()).toMatch(/^\d{8}-\d{6}-[0-9a-z]{6}$/);
    expect(newSessionId()).not.toBe(newSessionId());
  });
});

describe('SessionPairing', () => {
  it('starts, samples the clock, stops, and uploads into the session bundle', async () => {
    const { fetchFn, calls } = fakeServer(pairedRoutes());
    let now = 100;
    const pairing = new SessionPairing('city-default', 's', { fetch: fetchFn, now: () => (now += 5), clockIntervalMs: 0 });
    expect(await pairing.start(7)).toBe(true);
    expect(calls[0]).toMatchObject({ url: '/match-stats/city-default/session/s/start', method: 'POST' });
    expect(JSON.parse(String(calls[0].body))).toEqual({ player_id: 7 });
    expect(pairing.pairing).toMatchObject({ state: 'paired', startTick: 600, serverDir: 'server', joined: false });
    await pairing.sampleClock();
    expect(await pairing.stop()).toBe(true);
    expect(pairing.pairing.stopTick).toBe(900);
    // Every sample is bracketed by the page's clock, in order.
    const samples = pairing.pairing.clockSamples;
    expect(samples.map((s) => s.what)).toEqual(['start', 'clock', 'stop']);
    expect(samples.map((s) => s.serverTick)).toEqual([600, 700, 900]);
    for (const s of samples) expect(s.receivedPerfMs).toBeGreaterThan(s.sentPerfMs);
    expect(samples[1].serverMonoUs).toBe(1_000_000);
  });

  it('is unpaired, not failed, on a server without the routes', async () => {
    const { fetchFn, calls } = fakeServer({});
    const pairing = new SessionPairing('city-default', 's', { fetch: fetchFn });
    expect(await pairing.start(7)).toBe(false);
    expect(pairing.pairing.state).toBe('unpaired');
    // Nothing more is asked of a server that cannot pair.
    expect(await pairing.stop()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('survives a network failure and a refusal', async () => {
    const offline = new SessionPairing('city-default', 's', {
      fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch,
    });
    expect(await offline.start(1)).toBe(false);
    expect(offline.pairing).toMatchObject({ state: 'unpaired', error: 'Failed to fetch' });
    const { fetchFn } = fakeServer({ '/start': () => new Response('player 1 is not connected', { status: 409 }) });
    const refused = new SessionPairing('city-default', 's', { fetch: fetchFn });
    expect(await refused.start(1)).toBe(false);
    expect(refused.pairing.state).toBe('failed');
    expect(refused.pairing.error).toContain('409');
  });
});

describe('paired tapes', () => {
  it('starts the server before the tape and stops it after, and the tape carries the pairing', async () => {
    const order: string[] = [];
    const routes = pairedRoutes();
    const { fetchFn } = fakeServer({
      '/start': (call) => { order.push(`start:${cityTapeRecorder.recording}`); return routes['/start'](call); },
      '/session-clock': routes['/session-clock'],
      '/stop': (call) => { order.push(`stop:${cityTapeRecorder.recording}`); return routes['/stop'](call); },
    });
    const paired = await startPairedTape('manual', 'city-default', { fetch: fetchFn, sessionId: 's', clockIntervalMs: 0 });
    expect(paired).not.toBeNull();
    cityTapeRecorder.push(new Uint8Array([1, 2, 3]));
    const tape = await stopPairedTape(paired!);
    // The server capture was already running when the tape opened, and
    // still running when it closed.
    expect(order).toEqual(['start:false', 'stop:false']);
    expect(tape?.header.pairing).toMatchObject({ sessionId: 's', state: 'paired', startTick: 600, stopTick: 900 });
    expect(tape?.header.pairing?.clockSamples.map((s) => s.what)).toEqual(['start', 'clock', 'stop']);
    expect(tape?.header.wallClockOriginMs).toBeGreaterThan(1e12);
  });

  it('releases the server capture when another owner is already recording', async () => {
    const { fetchFn, calls } = fakeServer(pairedRoutes());
    const e2e = cityTapeRecorder.start('e2e');
    const paired = await startPairedTape('hotspot', 'city-default', { fetch: fetchFn, sessionId: 's', clockIntervalMs: 0 });
    expect(paired).toBeNull();
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['start', 'stop']);
    expect(cityTapeRecorder.currentOwner).toBe('e2e');
    cityTapeRecorder.stop(e2e);
  });

  it('uploads into the bundle when paired', async () => {
    const { fetchFn, calls } = fakeServer(pairedRoutes());
    const paired = await startPairedTape('manual', 'city-default', { fetch: fetchFn, sessionId: 's', clockIntervalMs: 0 });
    const tape = await stopPairedTape(paired!);
    const result = await uploadPairedTape('city-default', tape!, paired!.pairing);
    expect(result).toEqual({ uploaded: true, folder: 'session-s', paired: true });
    const upload = calls.find((c) => c.url.endsWith('/session/s/tape'))!;
    const sent = decodeCityTape(upload.body as Uint8Array);
    expect(sent.header.pairing?.sessionId).toBe('s');
    expect(sent.packets).toHaveLength(tape!.packets.length);
  });

  it('still records, and uploads standalone, when the server cannot pair', async () => {
    // An older server: no session routes, but the standalone tape route.
    const { fetchFn } = fakeServer({ '/match-stats/city-default/tape': () => json({ folder: 'tape-1-city-default' }) });
    vi.stubGlobal('fetch', fetchFn);
    const paired = await startPairedTape('manual', 'city-default', { fetch: fetchFn, sessionId: 's', clockIntervalMs: 0 });
    expect(paired).not.toBeNull();
    expect(cityTapeRecorder.currentOwner).toBe('manual');
    cityTapeRecorder.push(new Uint8Array([9]));
    const tape = await stopPairedTape(paired!);
    expect(tape?.packets).toHaveLength(1);
    expect(tape?.header.pairing?.state).toBe('unpaired');
    const result = await uploadPairedTape('city-default', tape!, paired!.pairing);
    expect(result).toEqual({ uploaded: true, folder: 'tape-1-city-default', paired: false });
  });

  it('falls back to the standalone upload when the bundle upload fails', async () => {
    const routes = pairedRoutes();
    const { fetchFn, calls } = fakeServer({
      '/start': routes['/start'],
      '/stop': routes['/stop'],
      '/session/s/tape': () => new Response('disk full', { status: 500 }),
      '/match-stats/city-default/tape': () => json({ folder: 'tape-2-city-default' }),
    });
    vi.stubGlobal('fetch', fetchFn);
    const paired = await startPairedTape('manual', 'city-default', { fetch: fetchFn, sessionId: 's', clockIntervalMs: 0 });
    const tape = await stopPairedTape(paired!);
    const result = await uploadPairedTape('city-default', tape!, paired!.pairing);
    expect(result).toEqual({ uploaded: true, folder: 'tape-2-city-default', paired: false });
    expect(calls.filter((c) => c.url.endsWith('/tape')).map((c) => c.url)).toEqual([
      '/match-stats/city-default/session/s/tape',
      '/match-stats/city-default/tape',
    ]);
  });
});
