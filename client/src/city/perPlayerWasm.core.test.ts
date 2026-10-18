import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initSync as initCore } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { coreCityStream } from '../core/clientCore';
import type { LoadedCityManifest } from './manifest';
import { decodeBinaryManifest } from './manifestBinary';
import type { PerPlayerCore } from './perPlayerCityClient';
import { createPerPlayerCore, initPerPlayerWasm, provideCoreCityStream } from './perPlayerWasm';

const dir = dirname(fileURLToPath(import.meta.url));
/** A live session recorded with `vl-headless --record` (a meteor at 5 s): the manifest and every
 * wire 4 city packet with its arrival. */
const CORPUS = join(dir, '../../../client-core/tests/corpus/citypp-meteor');

type Packet = { arrivalMs: number; bytes: Uint8Array };

function readCorpus(): { manifest: Uint8Array; packets: Packet[] } {
  const manifest = new Uint8Array(readFileSync(join(CORPUS, 'manifest.vlcm')));
  const raw = readFileSync(join(CORPUS, 'packets.bin'));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const packets: Packet[] = [];
  for (let at = 0; at < raw.byteLength;) {
    const arrivalMs = view.getFloat64(at + 1, true);
    const length = view.getUint32(at + 9, true);
    packets.push({ arrivalMs, bytes: new Uint8Array(raw.buffer, raw.byteOffset + at + 13, length) });
    at += 13 + length;
  }
  return { manifest, packets };
}

describe("wire 4 city stream built by the core (the Unreal client's construction)", () => {
  beforeAll(() => {
    initCore({ module: readFileSync(join(dir, '../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
    initPerPlayerWasm(readFileSync(join(dir, '../wasm/perplayer-pkg/vibe_land_perplayer_bg.wasm')));
  });
  afterEach(() => provideCoreCityStream(null));

  it.skipIf(!existsSync(CORPUS))('presents the same bodies as the TypeScript-built stream on a recorded session', () => {
    const { manifest, packets } = readCorpus();
    const loaded: LoadedCityManifest = {
      manifest: decodeBinaryManifest(manifest.buffer.slice(manifest.byteOffset, manifest.byteOffset + manifest.byteLength) as ArrayBuffer),
      hashHex: '',
      totalChunks: 0,
      totalBonds: 0,
      binary: manifest,
    };
    provideCoreCityStream(null);
    const ts: PerPlayerCore = createPerPlayerCore(loaded);
    provideCoreCityStream(coreCityStream);
    const core: PerPlayerCore = createPerPlayerCore(loaded);
    provideCoreCityStream(null);

    let worst = 0, sampled = 0, bodiesSeen = 0, changesSeen = 0;
    const end = packets[packets.length - 1].arrivalMs + 500;
    let next = 0;
    // Render frames every 16 ms over the session, the packets that arrived by then ingested first.
    for (let now = packets[0].arrivalMs; now <= end; now += 16) {
      while (next < packets.length && packets[next].arrivalMs <= now) {
        ts.ingest(packets[next].bytes, packets[next].arrivalMs);
        core.ingest(packets[next].bytes, packets[next].arrivalMs);
        next += 1;
      }
      const a = ts.advance(now);
      const b = core.advance(now);
      expect(Number.isNaN(a)).toBe(Number.isNaN(b));
      if (!Number.isNaN(a)) expect(b).toBeCloseTo(a, 9);
      const ca = ts.drain_changes();
      const cb = core.drain_changes();
      expect(Array.from(cb)).toEqual(Array.from(ca));
      changesSeen += ca.length;
      const pa = ts.body_poses();
      const pb = core.body_poses();
      expect(pb.length).toBe(pa.length);
      for (let i = 0; i < pa.length; i += 1) worst = Math.max(worst, Math.abs(pa[i] - pb[i]));
      bodiesSeen = Math.max(bodiesSeen, pa.length / 10);
      sampled += 1;
    }
    expect(Array.from(core.ack())).toEqual(Array.from(ts.ack()));
    console.info(`stream parity: ${packets.length} packets, ${sampled} frames, up to ${bodiesSeen} bodies, ${changesSeen} change words, worst pose difference ${worst}`);
    expect(bodiesSeen).toBeGreaterThan(0); // the corpus carries a fracture
    expect(worst).toBeLessThanOrEqual(1e-5);
    expect(core.hash_mismatches()).toBe(0);
    expect(ts.hash_mismatches()).toBe(0);
  });
});
