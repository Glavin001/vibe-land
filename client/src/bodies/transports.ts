import { MoqClient, type MoqSubscription } from '../moq/client';
import { buildConnectUrl, parseCertificateHash, parseNamespace } from '../moq/config';

export type BodyTransportMode = 'direct' | 'moq';
export type BodyMotionMode = 'collapse' | 'wave' | 'formation';

export interface BodyLabConfig {
  transport: BodyTransportMode;
  bodies: number;
  hz: number;
  duration: number;
  mbps: number | null;
  shards: number;
  directUrl: string;
  directCertHash: string;
  relay: string;
  token: string;
  namespace: string;
  moqCertHash: string;
  motion: BodyMotionMode;
  autostart: boolean;
}

export interface ClockSample {
  rttMs: number;
  offsetUs: number;
}

export interface BodyConnection {
  maxDatagramSize: number | null;
  resetMotion(): Promise<void>;
  setMotionMode(mode: BodyMotionMode): Promise<void>;
  close(): Promise<void>;
}

export function loadBodyLabConfig(search: string): BodyLabConfig {
  const query = new URLSearchParams(search);
  return {
    transport: query.get('transport') === 'moq' ? 'moq' : 'direct',
    bodies: clampInt(query.get('bodies'), 5_000, 1, 50_000),
    hz: clampNumber(query.get('hz'), 20, 1, 120),
    duration: clampInt(query.get('duration'), 120, 1, 600),
    mbps: optionalNumber(query.get('mbps')),
    shards: clampInt(query.get('shards'), 4, 1, 16),
    directUrl: query.get('direct')
      ?? envValue('VITE_BODY_DIRECT_URL')
      ?? 'https://127.0.0.1:4433',
    directCertHash: query.get('wthash')
      ?? envValue('VITE_BODY_DIRECT_CERT_HASH')
      ?? '',
    relay: query.get('relay')
      ?? envValue('VITE_MOQ_RELAY_URL')
      ?? 'https://draft-16.cloudflare.mediaoverquic.com',
    token: query.get('token') ?? envValue('VITE_MOQ_SUBSCRIBE_TOKEN') ?? '',
    namespace: query.get('ns') ?? envValue('VITE_MOQ_NAMESPACE') ?? 'vibe-land/bodies',
    moqCertHash: query.get('certhash') ?? envValue('VITE_MOQ_CERT_HASH') ?? '',
    motion: parseMotionMode(query.get('motion')),
    autostart: query.has('autostart') || query.has('autotest'),
  };
}

export async function connectBodyTransport(
  config: BodyLabConfig,
  onPacket: (bytes: Uint8Array, receiveWallUs: number) => void,
  onClock: (sample: ClockSample) => void,
  onClose: (reason: string) => void,
): Promise<BodyConnection> {
  return config.transport === 'moq'
    ? connectMoq(config, onPacket, onClock, onClose)
    : connectDirect(config, onPacket, onClock, onClose);
}

export async function resetBodyMotion(config: BodyLabConfig): Promise<void> {
  if (!config.directUrl || !config.directCertHash) {
    throw new Error('the direct WebTransport endpoint is required to reset the shared motion');
  }
  const url = new URL(config.directUrl);
  url.pathname = '/bodies-reset';
  url.search = '';
  const transport = new WebTransport(url.toString(), webTransportOptions(config.directCertHash));
  await transport.ready;
  await Promise.race([
    transport.closed.catch(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
  ]);
  transport.close();
}

export async function setBodyMotion(
  config: BodyLabConfig,
  mode: BodyMotionMode,
): Promise<void> {
  if (!config.directUrl || !config.directCertHash) {
    throw new Error('the direct WebTransport endpoint is required to change shared motion');
  }
  const url = new URL(config.directUrl);
  url.pathname = '/bodies-motion';
  url.search = new URLSearchParams({ mode }).toString();
  const transport = new WebTransport(url.toString(), webTransportOptions(config.directCertHash));
  await transport.ready;
  await Promise.race([
    transport.closed.catch(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
  ]);
  transport.close();
}

async function connectDirect(
  config: BodyLabConfig,
  onPacket: (bytes: Uint8Array, receiveWallUs: number) => void,
  onClock: (sample: ClockSample) => void,
  onClose: (reason: string) => void,
): Promise<BodyConnection> {
  const url = new URL(config.directUrl);
  url.pathname = '/bodies';
  url.search = new URLSearchParams({
    bodies: String(config.bodies),
    hz: String(config.hz),
    duration: String(config.duration),
    ...(config.mbps === null ? {} : { mbps: String(config.mbps) }),
  }).toString();
  const transport = new WebTransport(url.toString(), webTransportOptions(config.directCertHash));
  await transport.ready;
  let closed = false;
  const timers = startClockLoop(transport, onClock);
  transport.closed.then(
    () => { if (!closed) onClose('direct transport closed'); },
    (error) => { if (!closed) onClose(`direct transport error: ${String(error)}`); },
  );
  void readDirectDatagrams(transport, onPacket, onClose);
  return {
    maxDatagramSize: transport.datagrams.maxDatagramSize,
    resetMotion: () => sendResetRequest(transport),
    setMotionMode: (mode) => sendMotionModeRequest(transport, mode),
    async close() {
      closed = true;
      for (const timer of timers) window.clearInterval(timer);
      transport.close();
    },
  };
}

async function connectMoq(
  config: BodyLabConfig,
  onPacket: (bytes: Uint8Array, receiveWallUs: number) => void,
  onClock: (sample: ClockSample) => void,
  onClose: (reason: string) => void,
): Promise<BodyConnection> {
  const relayUrl = buildConnectUrl(config.relay, config.token);
  const moq = await MoqClient.connect(relayUrl, {
    serverCertificateHashes: config.moqCertHash
      ? parseCertificateHash(config.moqCertHash)
      : undefined,
    onClose,
  });
  const subscriptions: MoqSubscription[] = [];
  const namespace = parseNamespace(config.namespace);
  for (let shard = 0; shard < config.shards; shard += 1) {
    subscriptions.push(await moq.subscribe(namespace, `bodies-${shard}`, (object) => {
      if (object.payload.byteLength > 0) onPacket(object.payload, Date.now() * 1000);
    }));
  }

  let clockTransport: WebTransport | null = null;
  const clockTimers: number[] = [];
  if (config.directCertHash && config.directUrl) {
    try {
      const clockUrl = new URL(config.directUrl);
      clockUrl.pathname = '/clock';
      clockUrl.search = '';
      clockTransport = new WebTransport(clockUrl.toString(), webTransportOptions(config.directCertHash));
      await clockTransport.ready;
      clockTimers.push(...startClockLoop(clockTransport, onClock));
    } catch {
      clockTransport?.close();
      clockTransport = null;
    }
  }

  return {
    maxDatagramSize: moq.maxDatagramSize,
    resetMotion: () => clockTransport
      ? sendResetRequest(clockTransport)
      : resetBodyMotion(config),
    setMotionMode: (mode) => clockTransport
      ? sendMotionModeRequest(clockTransport, mode)
      : setBodyMotion(config, mode),
    async close() {
      for (const timer of clockTimers) window.clearInterval(timer);
      for (const subscription of subscriptions) await subscription.unsubscribe().catch(() => undefined);
      await moq.close('body viewer closed');
      clockTransport?.close();
    },
  };
}

async function sendResetRequest(transport: WebTransport): Promise<void> {
  const { readable, writable } = await transport.createBidirectionalStream();
  const writer = writable.getWriter();
  await writer.write(Uint8Array.of(3));
  await writer.close();
  const response = await readAll(readable);
  if (response.byteLength !== 1 || response[0] !== 4) {
    throw new Error('body source did not acknowledge the reset');
  }
}

async function sendMotionModeRequest(
  transport: WebTransport,
  mode: BodyMotionMode,
): Promise<void> {
  const modeId = mode === 'wave' ? 1 : mode === 'formation' ? 2 : 0;
  const { readable, writable } = await transport.createBidirectionalStream();
  const writer = writable.getWriter();
  await writer.write(Uint8Array.of(5, modeId));
  await writer.close();
  const response = await readAll(readable);
  if (response.byteLength !== 2 || response[0] !== 6 || response[1] !== modeId) {
    throw new Error('body source did not acknowledge the motion mode');
  }
}

function parseMotionMode(value: string | null): BodyMotionMode {
  return value === 'collapse' || value === 'formation' ? value : 'wave';
}

async function readDirectDatagrams(
  transport: WebTransport,
  onPacket: (bytes: Uint8Array, receiveWallUs: number) => void,
  onClose: (reason: string) => void,
): Promise<void> {
  const reader = transport.datagrams.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onPacket(value, Date.now() * 1000);
    }
  } catch (error) {
    onClose(`datagram reader error: ${String(error)}`);
  } finally {
    reader.releaseLock();
  }
}

function startClockLoop(
  transport: WebTransport,
  onClock: (sample: ClockSample) => void,
): number[] {
  let bestRtt = Number.POSITIVE_INFINITY;
  const ping = async () => {
    try {
      const { readable, writable } = await transport.createBidirectionalStream();
      const writer = writable.getWriter();
      const t0 = BigInt(Date.now()) * 1000n;
      const request = new Uint8Array(9);
      request[0] = 1;
      new DataView(request.buffer).setBigUint64(1, t0, true);
      await writer.write(request);
      await writer.close();
      const response = await readAll(readable);
      const t3 = BigInt(Date.now()) * 1000n;
      if (response.byteLength !== 25 || response[0] !== 2) return;
      const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
      const t1 = view.getBigUint64(9, true);
      const t2 = view.getBigUint64(17, true);
      const rttMs = Math.max(0, Number((t3 - t0) - (t2 - t1)) / 1000);
      const offsetUs = Number((t1 - t0) + (t2 - t3)) / 2;
      if (rttMs <= bestRtt) {
        bestRtt = rttMs;
        onClock({ rttMs, offsetUs });
      }
    } catch {
      // Clock sync is optional in relay mode and transport closure is handled elsewhere.
    }
  };
  void ping();
  return [window.setInterval(() => void ping(), 2_000)];
}

async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function webTransportOptions(hash: string): WebTransportOptions | undefined {
  const clean = hash.trim();
  if (!clean) return undefined;
  const value = new Uint8Array(new ArrayBuffer(32));
  if (/^[0-9a-fA-F:]{64,95}$/.test(clean)) {
    const hex = clean.replace(/:/g, '');
    for (let index = 0; index < 32; index += 1) {
      value[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
  } else {
    const decoded = Uint8Array.from(atob(clean), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== 32) throw new Error('direct certificate hash must be 32 bytes');
    value.set(decoded);
  }
  return {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: value.buffer }],
    congestionControl: 'low-latency',
    requireUnreliable: true,
  };
}

function envValue(key: string): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const value = env?.[key];
  return value && value.length > 0 ? value : undefined;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function clampNumber(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && raw !== null ? Math.min(max, Math.max(min, value)) : fallback;
}

function optionalNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}
