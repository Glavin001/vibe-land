/**
 * Init-guard for the wire-v3 debris decoder wasm module, mirroring
 * `src/wasm/sharedPhysics.ts`.
 *
 * The decoder is the same Rust the server encodes with -- quaternion packing,
 * sampled-chain reconstruction, the loss gap rule -- compiled for the browser.
 * A TS port would be a second implementation drifting from day one, and the
 * golden-vector cost of keeping it honest would exceed the module's 326 KB.
 */
import init, { DebrisDecoder, initSync } from '../wasm/debris-pkg/destruction_codec.js';
import { nativeFileBytes } from '../platform/nativeFiles';

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function initDebrisWasm(): Promise<void> {
  if (initialized) {
    return;
  }
  if (!initPromise) {
    initPromise = (__NATIVE__
      ? nativeFileBytes('destruction_codec_bg.wasm').then((module) => { initSync({ module }); })
      : init()
    ).then(() => {
      initialized = true;
    });
  }
  await initPromise;
}

/** The shipped v3 packet dictionary; must match the server's byte-for-byte. */
export async function fetchDebrisDictionary(): Promise<Uint8Array> {
  if (__NATIVE__) return new Uint8Array(await nativeFileBytes('city-packet-v3.dict'));
  const url = new URL('./city-packet-v3.dict', import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`debris dictionary fetch failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function createDebrisDecoder(
  dictionary: Uint8Array,
  maxLanes: number,
  simHz: number,
): DebrisDecoder {
  if (!initialized) {
    throw new Error('initDebrisWasm() has not completed');
  }
  return new DebrisDecoder(dictionary, maxLanes, simHz);
}

export type { DebrisDecoder };
