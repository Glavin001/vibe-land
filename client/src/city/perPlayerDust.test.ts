import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LoadedCityManifest } from './manifest';
import { decodeBinaryManifest } from './manifestBinary';
import { PerPlayerCityClient } from './perPlayerCityClient';
import { createPerPlayerCore, initPerPlayerWasm, provideCoreCityStream } from './perPlayerWasm';

const dir = dirname(fileURLToPath(import.meta.url));
/** A live session recorded with `vl-headless --record` (a meteor at 5 s). */
const CORPUS = join(dir, '../../../client-core/tests/corpus/citypp-meteor');

function readCorpus(): { manifest: Uint8Array; packets: { arrivalMs: number; bytes: Uint8Array }[] } {
  const manifest = new Uint8Array(readFileSync(join(CORPUS, 'manifest.vlcm')));
  const raw = readFileSync(join(CORPUS, 'packets.bin'));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const packets = [];
  for (let at = 0; at < raw.byteLength;) {
    const arrivalMs = view.getFloat64(at + 1, true);
    const length = view.getUint32(at + 9, true);
    packets.push({ arrivalMs, bytes: new Uint8Array(raw.buffer, raw.byteOffset + at + 13, length) });
    at += 13 + length;
  }
  return { manifest, packets };
}

describe('wire 4 destruction dust on the web', () => {
  beforeAll(() => {
    initPerPlayerWasm(readFileSync(join(dir, '../wasm/perplayer-pkg/vibe_land_perplayer_bg.wasm')));
  });
  afterEach(() => vi.restoreAllMocks());

  // The per-player client applied each fracture to the ledger itself, past the city client's
  // applyTopologyMessage, where breaks become dust and sound sources: a meteor on a wire 4 match
  // made no fracture dust in the browser (only impacts), while the core (Unreal) made it.
  it.skipIf(!existsSync(CORPUS))('a fracture in the stream becomes dust sources', () => {
    const { manifest, packets } = readCorpus();
    const loaded: LoadedCityManifest = {
      manifest: decodeBinaryManifest(manifest.buffer.slice(manifest.byteOffset, manifest.byteOffset + manifest.byteLength) as ArrayBuffer),
      hashHex: '',
      totalChunks: 0,
      totalBonds: 0,
      binary: manifest,
    };
    provideCoreCityStream(null);
    let now = packets[0].arrivalMs;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const client = new PerPlayerCityClient(loaded, () => {}, createPerPlayerCore(loaded));
    const kinds = new Map<string, number>();
    let next = 0, bodies = 0;
    for (; now <= packets[packets.length - 1].arrivalMs + 500; now += 16) {
      while (next < packets.length && packets[next].arrivalMs <= now) client.handlePacket(packets[next++].bytes);
      bodies = Math.max(bodies, client.samplePresentation(now).size);
      client.drainDustSources((s) => kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1));
    }
    console.info(`dust sources from the recorded meteor: ${JSON.stringify(Object.fromEntries(kinds))}; up to ${bodies} moving bodies; ${JSON.stringify(client.stats()).slice(0, 300)}`);
    expect(bodies).toBeGreaterThan(0); // the stream did break the city
    expect(kinds.get('fracture') ?? 0).toBeGreaterThan(0);
  });

  // Nor did it give the impact detector the bodies' motion (wire 3 differences its samples), so
  // falling debris landing raised no impact dust and no collapse waves.
  it.skipIf(!existsSync(CORPUS))('debris landing becomes impact dust', () => {
    const { manifest, packets } = readCorpus();
    const loaded: LoadedCityManifest = {
      manifest: decodeBinaryManifest(manifest.buffer.slice(manifest.byteOffset, manifest.byteOffset + manifest.byteLength) as ArrayBuffer),
      hashHex: '',
      totalChunks: 0,
      totalBonds: 0,
      binary: manifest,
    };
    provideCoreCityStream(null);
    let now = packets[0].arrivalMs;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const client = new PerPlayerCityClient(loaded, () => {}, createPerPlayerCore(loaded));
    const kinds = new Map<string, number>();
    let next = 0;
    for (; now <= packets[packets.length - 1].arrivalMs + 500; now += 16) {
      while (next < packets.length && packets[next].arrivalMs <= now) client.handlePacket(packets[next++].bytes);
      client.samplePresentation(now);
      client.drainDustSources((s) => kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1));
    }
    console.info(`dust sources from debris: ${JSON.stringify(Object.fromEntries(kinds))}`);
    expect((kinds.get('impact') ?? 0) + (kinds.get('wave') ?? 0)).toBeGreaterThan(0);
  });
});
