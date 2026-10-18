// VLCHNK01: the city layer's pose tables as the client stage saw them, per
// frame. Written by clientStage.mts, read by the Rust scorer
// (server/src/bin/netlab2/chunks.rs). gzip-compressed (Node 22.1 has no
// zstd); the reader sniffs the gzip magic and also reads it raw.
//
// Little-endian. Magic `VLCHNK01`; u32 header length; JSON header
// ({chunkCount, structures: [{structureId, slotBase, chunks}], simHz,
// clockOriginMs, ...}); then frames:
//   [f64 sampleMs][u32 simTick][f32 renderTick][f32 playoutDelayTicks]
//   [u32 nBodies] nBodies x [u32 index][u32 key][f32 px py pz][f32 qx qy qz qw]
//   [u32 nRecords] nRecords x [u32 slot][i32 index][f32 lx ly lz][f32 qx qy qz qw]
// Only entries that changed since the previous frame are listed; a reader
// holds the rest forward. A chunk is drawn at body[index].pose ∘ record, as
// the vertex shader composes it (cityPoseStore.ts); a slot with no record, or
// composed below the hide depth, is not drawn. `key` is the body the index
// was last given (the drawn identity).

import { createWriteStream } from 'node:fs';
import zlib from 'node:zlib';

export const CHUNK_MAGIC = 'VLCHNK01';
export const CHUNK_FRAME_HEADER_BYTES = 8 + 4 + 4 + 4;
export const CHUNK_ENTRY_BYTES = 4 + 4 + 28;
const FLOATS_PER_BODY = 16;
const FLOATS_PER_CHUNK = 8;

/** The parts of CityPoseStore the writer reads. */
export interface PoseTables {
  chunkCount: number;
  chunkData: Float32Array;
  bodyData: Float32Array;
  bodyIndexOfSlot: Int32Array;
  keyOfIndex(index: number): number;
}

export interface ChunkStreamWriter {
  frame(
    sampleMs: number,
    simTick: number,
    renderTick: number,
    playoutDelayTicks: number,
    tables: PoseTables,
    changes: { bodies: number[]; slots: number[] },
  ): void;
  end(): Promise<void>;
}

/** Encodes one frame; `emitted*` hold what the reader has, updated in place. */
export function encodeChunkFrame(
  sampleMs: number,
  simTick: number,
  renderTick: number,
  playoutDelayTicks: number,
  tables: PoseTables,
  changes: { bodies: number[]; slots: number[] },
  emittedBodies: Map<number, Float64Array>,
  emittedSlots: Map<number, Float64Array>,
  shiftX: ((key: number) => number) | null = null,
): Uint8Array {
  const bodies: number[] = [];
  for (const index of changes.bodies) {
    const at = index * FLOATS_PER_BODY;
    const key = tables.keyOfIndex(index);
    const now = [key, tables.bodyData[at], tables.bodyData[at + 1], tables.bodyData[at + 2],
      tables.bodyData[at + 4], tables.bodyData[at + 5], tables.bodyData[at + 6], tables.bodyData[at + 7]];
    const last = emittedBodies.get(index);
    const stored = Float64Array.from(now, (v, k) => (k === 0 ? v : Math.fround(v)));
    if (last && stored.every((v, k) => last[k] === v)) continue;
    emittedBodies.set(index, stored);
    bodies.push(index);
  }
  const slots: number[] = [];
  for (const slot of changes.slots) {
    const at = slot * FLOATS_PER_CHUNK;
    const index = tables.bodyIndexOfSlot[slot];
    const now = [index, tables.chunkData[at + 1], tables.chunkData[at + 2], tables.chunkData[at + 3],
      tables.chunkData[at + 4], tables.chunkData[at + 5], tables.chunkData[at + 6], tables.chunkData[at + 7]];
    const last = emittedSlots.get(slot);
    const stored = Float64Array.from(now, (v, k) => (k === 0 ? v : Math.fround(v)));
    if (last && stored.every((v, k) => last[k] === v)) continue;
    emittedSlots.set(slot, stored);
    slots.push(slot);
  }
  const out = new Uint8Array(CHUNK_FRAME_HEADER_BYTES + 4 + bodies.length * CHUNK_ENTRY_BYTES + 4 + slots.length * CHUNK_ENTRY_BYTES);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setFloat64(o, sampleMs, true); o += 8;
  view.setUint32(o, simTick >>> 0, true); o += 4;
  view.setFloat32(o, renderTick, true); o += 4;
  view.setFloat32(o, playoutDelayTicks, true); o += 4;
  view.setUint32(o, bodies.length, true); o += 4;
  for (const index of bodies) {
    const at = index * FLOATS_PER_BODY;
    view.setUint32(o, index, true); o += 4;
    view.setUint32(o, tables.keyOfIndex(index) >>> 0, true); o += 4;
    const dx = shiftX ? shiftX(tables.keyOfIndex(index)) : 0;
    for (const k of [0, 1, 2, 4, 5, 6, 7]) { view.setFloat32(o, tables.bodyData[at + k] + (k === 0 ? dx : 0), true); o += 4; }
  }
  view.setUint32(o, slots.length, true); o += 4;
  for (const slot of slots) {
    const at = slot * FLOATS_PER_CHUNK;
    view.setUint32(o, slot, true); o += 4;
    view.setInt32(o, tables.bodyIndexOfSlot[slot], true); o += 4;
    for (let k = 1; k < 8; k += 1) { view.setFloat32(o, tables.chunkData[at + k], true); o += 4; }
  }
  return out;
}

export function encodeChunkHeader(header: Record<string, unknown>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + 4 + json.length);
  for (let i = 0; i < 8; i += 1) out[i] = CHUNK_MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  return out;
}

/**
 * `shiftX` (Netlab's negative control, `--perturb`): metres added to the x
 * of what is recorded for a body key -- a deliberately wrong client the
 * scorer must catch. Never set for a measurement.
 */
export function openChunkStream(
  path: string,
  header: Record<string, unknown>,
  shiftX: ((key: number) => number) | null = null,
): ChunkStreamWriter {
  const file = createWriteStream(path);
  const gzip = zlib.createGzip({ level: 1 });
  gzip.pipe(file);
  gzip.write(encodeChunkHeader(header));
  const emittedBodies = new Map<number, Float64Array>();
  const emittedSlots = new Map<number, Float64Array>();
  return {
    frame(sampleMs, simTick, renderTick, playoutDelayTicks, tables, changes) {
      gzip.write(encodeChunkFrame(sampleMs, simTick, renderTick, playoutDelayTicks, tables, changes, emittedBodies, emittedSlots, shiftX));
    },
    end: () => new Promise<void>((done, fail) => {
      file.on('finish', () => done());
      file.on('error', fail);
      gzip.end();
    }),
  };
}
