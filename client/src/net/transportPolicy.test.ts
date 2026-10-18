// WebTransport is required; WebSocket is DISABLED unless the build opts in with
// VITE_ENABLE_WEBSOCKET=1. Pinned because the failure mode of getting this
// wrong is silent: the session still works, on a wire with completely
// different loss behaviour from the one the debris codec is designed and
// measured against.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTransportNote, setTransportNote } from '../app/connectPhase';
import { NetcodeClient } from './netcodeClient';
import { frameReliablePacket, PKT_WELCOME } from './protocol';
import {
  WEBSOCKET_DISABLED_MESSAGE,
  WebSocketTransportDisabledError,
  websocketToolingEnabled,
  websocketTransportEnabled,
} from './transportPolicy';

describe('transport policy flag', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('disables WebSocket by default', () => {
    expect(websocketTransportEnabled({})).toBe(false);
    // And in the real (test) build environment, which sets nothing.
    expect(websocketTransportEnabled()).toBe(false);
  });

  it('enables WebSocket only for the exact build-time opt-in', () => {
    expect(websocketTransportEnabled({ VITE_ENABLE_WEBSOCKET: '1' })).toBe(true);
    vi.stubEnv('VITE_ENABLE_WEBSOCKET', '1');
    expect(websocketTransportEnabled()).toBe(true);
  });

  it('is not fooled by near-miss values', () => {
    for (const value of ['', '0', 'true', 'yes', 'on', ' 1', '1 ', 'TRUE']) {
      expect(websocketTransportEnabled({ VITE_ENABLE_WEBSOCKET: value })).toBe(false);
    }
  });

  it('has no URL-parameter opt-in', () => {
    vi.stubGlobal('window', { location: { search: '?transport=ws&websocket=1' } } as unknown as Window);
    expect(websocketTransportEnabled()).toBe(false);
  });

  it('gates node tooling on the server-side variable, exactly', () => {
    expect(websocketToolingEnabled({})).toBe(false);
    expect(websocketToolingEnabled({ VIBE_ENABLE_WEBSOCKET: 'true' })).toBe(false);
    expect(websocketToolingEnabled({ VITE_ENABLE_WEBSOCKET: '1' })).toBe(false);
    expect(websocketToolingEnabled({ VIBE_ENABLE_WEBSOCKET: '1' })).toBe(true);
  });
});

// --- NetcodeClient transport selection -------------------------------------

const sessionConfig = {
  match_id: 'default', url: 'https://127.0.0.1:4434/game', server_certificate_hash_hex: '',
  sim_hz: 60, snapshot_hz: 60, interpolation_delay_ms: 100, protocol_version: 3, physics_backend: 1,
  client_movement_mode: 0,
};

/** The server's Welcome layout (see city/cityTapeFull.test.ts). */
function welcomePacket(playerId: number): Uint8Array {
  const out = new Uint8Array(23);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_WELCOME);
  view.setUint32(o, playerId, true); o += 4;
  view.setUint16(o, 3, true); o += 2; // protocol version
  view.setUint8(o++, 1); // physics backend
  view.setUint8(o++, 0); // full prediction
  view.setUint16(o, 60, true); o += 2;
  view.setUint16(o, 60, true); o += 2;
  view.setUint32(o, 1_000_000, true); o += 8; // server time (u64, low word)
  view.setUint16(o, 100, true);
  return out;
}

/** A WebTransport whose handshake either succeeds (and can then be welcomed) or fails. */
function fakeWebTransport(mode: 'ok' | 'fail') {
  let reliable: ReadableStreamDefaultController<Uint8Array> | null = null;
  const sink = () => new WritableStream<Uint8Array>({ write() {} });
  const constructed: string[] = [];
  class FakeWT {
    readonly ready: Promise<void>;
    readonly closed = new Promise<unknown>(() => {});
    readonly datagrams = {
      readable: new ReadableStream<Uint8Array>({ start: () => {} }),
      writable: sink(),
    };
    constructor(url: string) {
      constructed.push(url);
      this.ready = mode === 'ok' ? Promise.resolve() : Promise.reject(new Error('QUIC_NETWORK_IDLE_TIMEOUT'));
      // The client awaits `ready`; keep an unobserved copy from failing the run.
      this.ready.catch(() => {});
    }
    async createBidirectionalStream() {
      return { readable: new ReadableStream<Uint8Array>({ start: (c) => { reliable = c; } }), writable: sink() };
    }
    close(): void {}
  }
  return {
    FakeWT,
    constructed,
    welcome(playerId: number) {
      if (!reliable) throw new Error('control stream not open yet');
      reliable.enqueue(frameReliablePacket(welcomePacket(playerId)));
    },
  };
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static urls: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  constructor(url: string) {
    FakeWebSocket.urls.push(url);
  }
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
}

function stubBrowser(webTransport: unknown, search = ''): void {
  const win: Record<string, unknown> = { location: { search, href: 'https://localhost/' } };
  if (webTransport) win.WebTransport = webTransport;
  vi.stubGlobal('window', win);
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

const WS_URL = 'ws://localhost/ws/default?identity=p&token=t';

describe('NetcodeClient transport selection', () => {
  beforeEach(() => {
    FakeWebSocket.urls = [];
    setTransportNote(null);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setTransportNote(null);
  });

  it('connects over WebTransport by default and never touches WebSocket', async () => {
    const wt = fakeWebTransport('ok');
    stubBrowser(wt.FakeWT);
    const client = new NetcodeClient({});
    const connected = client.connectWithFallback('default', WS_URL, undefined, { sessionConfig });
    await vi.waitFor(() => expect(() => wt.welcome(7)).not.toThrow());
    await connected;
    expect(client.transport).toBe('webtransport');
    expect(wt.constructed).toEqual(['https://127.0.0.1:4434/game']);
    expect(FakeWebSocket.urls).toEqual([]);
    client.disconnect();
  });

  it('does not fall back to WebSocket when WebTransport fails', async () => {
    const wt = fakeWebTransport('fail');
    stubBrowser(wt.FakeWT);
    const client = new NetcodeClient({});
    const attempt = client.connectWithFallback('default', WS_URL, undefined, { sessionConfig });
    await expect(attempt).rejects.toBeInstanceOf(WebSocketTransportDisabledError);
    await expect(attempt).rejects.toThrow(WEBSOCKET_DISABLED_MESSAGE);
    expect(wt.constructed.length).toBe(1);
    expect(FakeWebSocket.urls).toEqual([]);
    expect(client.transport).toBe('connecting');
    // The player is told why.
    expect(getTransportNote()).toContain('WebTransport unavailable; WebSocket transport is disabled');
    expect(getTransportNote()).toContain('QUIC_NETWORK_IDLE_TIMEOUT');
  });

  it('does not use WebSocket in a browser without WebTransport', async () => {
    stubBrowser(undefined);
    const client = new NetcodeClient({});
    await expect(
      client.connectWithFallback('default', WS_URL, undefined, { sessionConfig }),
    ).rejects.toThrow(WEBSOCKET_DISABLED_MESSAGE);
    expect(FakeWebSocket.urls).toEqual([]);
    expect(getTransportNote()).toContain(WEBSOCKET_DISABLED_MESSAGE);
  });

  it('refuses a direct WebSocket connect while disabled', () => {
    stubBrowser(undefined);
    const client = new NetcodeClient({});
    expect(() => client.connect(WS_URL)).toThrow(WebSocketTransportDisabledError);
    expect(FakeWebSocket.urls).toEqual([]);
  });

  it('ignores the retired ?transport=ws URL opt-in', async () => {
    const wt = fakeWebTransport('fail');
    stubBrowser(wt.FakeWT, '?transport=ws');
    const client = new NetcodeClient({});
    await expect(
      client.connectWithFallback('default', WS_URL, undefined, { sessionConfig }),
    ).rejects.toThrow(WEBSOCKET_DISABLED_MESSAGE);
    expect(FakeWebSocket.urls).toEqual([]);
  });

  describe('with the build-time opt-in VITE_ENABLE_WEBSOCKET=1', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_ENABLE_WEBSOCKET', '1');
    });

    it('still prefers WebTransport when it works', async () => {
      const wt = fakeWebTransport('ok');
      stubBrowser(wt.FakeWT);
      const client = new NetcodeClient({});
      const connected = client.connectWithFallback('default', WS_URL, undefined, { sessionConfig });
      await vi.waitFor(() => expect(() => wt.welcome(3)).not.toThrow());
      await connected;
      expect(client.transport).toBe('webtransport');
      expect(FakeWebSocket.urls).toEqual([]);
      client.disconnect();
    });

    it('falls back to WebSocket only after WebTransport fails, and says so', async () => {
      const wt = fakeWebTransport('fail');
      stubBrowser(wt.FakeWT);
      const client = new NetcodeClient({});
      await client.connectWithFallback('default', WS_URL, undefined, { sessionConfig });
      expect(wt.constructed.length).toBe(1);
      expect(FakeWebSocket.urls).toEqual([WS_URL]);
      expect(client.transport).toBe('websocket');
      expect(getTransportNote()).toContain('using WebSocket (VITE_ENABLE_WEBSOCKET=1)');
      client.disconnect();
    });
  });
});
