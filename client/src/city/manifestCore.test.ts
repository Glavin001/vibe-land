import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initSync } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { decodeBinaryManifest, provideBinaryManifestDecoder } from './manifestBinary';
import { decodeManifestCore } from './manifestCore';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => {
  const b = readFileSync(join(here, '__fixtures__', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('core manifest decoding (the Unreal client\'s, via WASM)', () => {
  beforeAll(() => {
    initSync({ module: readFileSync(join(here, '../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
  });
  afterEach(() => provideBinaryManifestDecoder(null));

  it.each(['manifest-rig-column.bin', 'manifest-mass-offset.bin'])('%s: the same CityManifest as manifestBinary.ts', (name) => {
    const bytes = fixture(name);
    const web = decodeBinaryManifest(bytes);
    const core = decodeManifestCore(bytes);
    expect(core).toStrictEqual(web);
    expect(core.structures.reduce((n, s) => n + s.chunks.length, 0)).toBeGreaterThan(0);
  });

  it('decodeBinaryManifest uses it once provided', () => {
    const bytes = fixture('manifest-rig-column.bin');
    let calls = 0;
    provideBinaryManifestDecoder((b) => { calls += 1; return decodeManifestCore(b); });
    expect(decodeBinaryManifest(bytes)).toStrictEqual((provideBinaryManifestDecoder(null), decodeBinaryManifest(bytes)));
    expect(calls).toBe(1);
  });
});
