import { MoqClient } from '../../client/src/moq/client';
import { buildConnectUrl, parseNamespace } from '../../client/src/moq/config';

const HEADER_BYTES = 32;
const MAGIC = [0x56, 0x4d, 0x42, 0x31]; // VMB1
const MAX_LATENCY_SAMPLES = 200_000;

interface TrackMetrics {
  objects: number;
  bytes: number;
  gaps: number;
  outOfOrder: number;
  malformed: number;
  lastSequence: number | null;
  latencySamplesMs: number[];
  latencySeen: number;
}

interface BenchResult {
  durationMs: number;
  objects: number;
  bytes: number;
  objectsPerSecond: number;
  megabitsPerSecond: number;
  gaps: number;
  outOfOrder: number;
  malformed: number;
  latencyMs: {
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
    samples: number;
  };
  tracks: Record<string, Omit<TrackMetrics, 'latencySamplesMs'>>;
}

interface BenchState {
  status: 'idle' | 'connecting' | 'warming' | 'measuring' | 'completed' | 'error';
  error: string | null;
  logs: string[];
  maxDatagramSize: number | null;
  result: BenchResult | null;
}

const state: BenchState = {
  status: 'idle',
  error: null,
  logs: [],
  maxDatagramSize: null,
  result: null,
};

(window as unknown as { __MOQ_BENCH__?: BenchState }).__MOQ_BENCH__ = state;

function emptyMetrics(): TrackMetrics {
  return {
    objects: 0,
    bytes: 0,
    gaps: 0,
    outOfOrder: 0,
    malformed: 0,
    lastSequence: null,
    latencySamplesMs: [],
    latencySeen: 0,
  };
}

function resetMetrics(metrics: TrackMetrics): void {
  Object.assign(metrics, emptyMetrics());
}

function addLatencySample(metrics: TrackMetrics, latencyMs: number): void {
  if (!Number.isFinite(latencyMs)) return;
  metrics.latencySeen += 1;
  if (metrics.latencySamplesMs.length < MAX_LATENCY_SAMPLES) {
    metrics.latencySamplesMs.push(latencyMs);
    return;
  }

  // Reservoir sampling keeps quantiles representative without unbounded memory.
  const replacement = Math.floor(Math.random() * metrics.latencySeen);
  if (replacement < MAX_LATENCY_SAMPLES) metrics.latencySamplesMs[replacement] = latencyMs;
}

function quantile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function decodeHeader(payload: Uint8Array): {
  trackId: number;
  sequence: number;
  publishedAtUs: number;
  payloadLength: number;
} | null {
  if (payload.length < HEADER_BYTES) return null;
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (payload[index] !== MAGIC[index]) return null;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    trackId: view.getUint32(4, true),
    sequence: Number(view.getBigUint64(8, true)),
    publishedAtUs: Number(view.getBigUint64(16, true)),
    payloadLength: view.getUint32(24, true),
  };
}

function summarize(metricsByTrack: Map<string, TrackMetrics>, durationMs: number): BenchResult {
  let objects = 0;
  let bytes = 0;
  let gaps = 0;
  let outOfOrder = 0;
  let malformed = 0;
  const latencySamples: number[] = [];
  const tracks: Record<string, Omit<TrackMetrics, 'latencySamplesMs'>> = {};

  for (const [track, metrics] of metricsByTrack) {
    objects += metrics.objects;
    bytes += metrics.bytes;
    gaps += metrics.gaps;
    outOfOrder += metrics.outOfOrder;
    malformed += metrics.malformed;
    latencySamples.push(...metrics.latencySamplesMs);
    const { latencySamplesMs: _, ...serializable } = metrics;
    tracks[track] = serializable;
  }

  latencySamples.sort((left, right) => left - right);
  const seconds = durationMs / 1000;
  return {
    durationMs,
    objects,
    bytes,
    objectsPerSecond: objects / seconds,
    megabitsPerSecond: (bytes * 8) / seconds / 1_000_000,
    gaps,
    outOfOrder,
    malformed,
    latencyMs: {
      p50: quantile(latencySamples, 0.5),
      p95: quantile(latencySamples, 0.95),
      p99: quantile(latencySamples, 0.99),
      max: latencySamples.at(-1) ?? null,
      samples: latencySamples.length,
    },
    tracks,
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const endpoint = params.get('relay') ?? '';
  const token = params.get('token') ?? '';
  const namespace = parseNamespace(params.get('ns') ?? 'vibe-land/benchmark');
  const trackCount = Number(params.get('tracks') ?? 1);
  const warmupMs = Number(params.get('warmupMs') ?? 2_000);
  const durationMs = Number(params.get('durationMs') ?? 8_000);
  const metricsByTrack = new Map<string, TrackMetrics>();
  let measuring = false;

  state.status = 'connecting';
  const client = await MoqClient.connect(buildConnectUrl(endpoint, token), {
    onLog: (level, message) => state.logs.push(`${level}: ${message}`),
    onClose: (reason) => state.logs.push(`closed: ${reason}`),
    maxRequestId: Math.max(100, trackCount * 4),
  });
  state.maxDatagramSize = client.maxDatagramSize;

  for (let trackId = 0; trackId < trackCount; trackId += 1) {
    const track = `benchmark-${trackId}`;
    const metrics = emptyMetrics();
    metricsByTrack.set(track, metrics);

    await client.subscribe(namespace, track, (object) => {
      if (!measuring) return;
      const header = decodeHeader(object.payload);
      if (!header || header.trackId !== trackId || header.payloadLength !== object.payload.length) {
        metrics.malformed += 1;
        return;
      }

      if (metrics.lastSequence !== null) {
        if (header.sequence <= metrics.lastSequence) metrics.outOfOrder += 1;
        else if (header.sequence > metrics.lastSequence + 1) {
          metrics.gaps += header.sequence - metrics.lastSequence - 1;
        }
      }
      metrics.lastSequence = header.sequence;
      metrics.objects += 1;
      metrics.bytes += object.payload.length;

      const receivedAtEpochUs = (performance.timeOrigin + object.receivedAt) * 1000;
      addLatencySample(metrics, (receivedAtEpochUs - header.publishedAtUs) / 1000);
    });
  }

  state.status = 'warming';
  await sleep(warmupMs);
  for (const metrics of metricsByTrack.values()) resetMetrics(metrics);

  state.status = 'measuring';
  measuring = true;
  const startedAt = performance.now();
  await sleep(durationMs);
  const elapsedMs = performance.now() - startedAt;
  measuring = false;

  state.result = summarize(metricsByTrack, elapsedMs);
  state.status = 'completed';
  await client.close('benchmark complete');
}

void run().catch((error: unknown) => {
  state.status = 'error';
  state.error = error instanceof Error ? error.message : String(error);
});
