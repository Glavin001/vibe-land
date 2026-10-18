/**
 * Decoder for the vibe-land world-state payloads carried inside MoQ objects.
 *
 * MoQ itself does not care what is in an object — this is our format, and the
 * encoder lives in `moq/publisher/src/wire.rs`. The golden vectors in
 * `payload.test.ts` are the same bytes that crate's tests assert on, so the two
 * implementations cannot drift apart silently.
 *
 * Everything is little-endian.
 */

export const PAYLOAD_VERSION = 1;

export const PayloadKind = {
  Snapshot: 1,
  Delta: 2,
  Meta: 3,
} as const;

/** Header shared by every payload kind. */
const HEADER_LENGTH = 14;
const CHUNK_LENGTH = 12;

/** Region and chunk geometry, mirrored from `moq/publisher/src/world.rs`. */
export const REGION_COUNT = 4;
export const REGION_COLUMNS = 2;
export const CHUNKS_PER_SIDE = 8;
export const CHUNKS_PER_REGION = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;

export const ChunkState = {
  Intact: 0,
  Damaged: 1,
  Falling: 2,
  Rubble: 3,
} as const;

export const CHUNK_STATE_LABELS: Record<number, string> = {
  [ChunkState.Intact]: 'intact',
  [ChunkState.Damaged]: 'damaged',
  [ChunkState.Falling]: 'falling',
  [ChunkState.Rubble]: 'rubble',
};

export interface WorldChunk {
  id: number;
  state: number;
  /** 0-255, where 255 is undamaged. */
  hp: number;
  /** Position in metres. */
  x: number;
  y: number;
  z: number;
  /** Yaw in radians. */
  yaw: number;
}

export interface RegionPayload {
  kind: 'snapshot' | 'delta';
  tick: number;
  /** Publisher's wall clock at encode time, unix epoch milliseconds. */
  publishedAtMs: number;
  region: number;
  chunks: WorldChunk[];
}

export interface MetaPayload {
  kind: 'meta';
  tick: number;
  publishedAtMs: number;
  round: number;
  playersAlive: number;
  destroyedPct: number;
  headline: string;
}

export type WorldPayload = RegionPayload | MetaPayload;

export class PayloadDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadDecodeError';
  }
}

export function decodeWorldPayload(bytes: Uint8Array): WorldPayload {
  if (bytes.length < HEADER_LENGTH) {
    throw new PayloadDecodeError(
      `payload of ${bytes.length} bytes is shorter than the ${HEADER_LENGTH}-byte header`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const version = view.getUint8(0);
  if (version !== PAYLOAD_VERSION) {
    throw new PayloadDecodeError(`unsupported payload version ${version}`);
  }

  const kind = view.getUint8(1);
  const tick = view.getUint32(2, true);
  // Safe as a Number: epoch milliseconds stay well under 2^53 until the year
  // 287396, and BigInt arithmetic downstream would only be a nuisance.
  const publishedAtMs = Number(view.getBigUint64(6, true));

  switch (kind) {
    case PayloadKind.Snapshot:
    case PayloadKind.Delta:
      return decodeRegion(view, kind === PayloadKind.Snapshot ? 'snapshot' : 'delta', tick, publishedAtMs);
    case PayloadKind.Meta:
      return decodeMeta(view, bytes, tick, publishedAtMs);
    default:
      throw new PayloadDecodeError(`unknown payload kind ${kind}`);
  }
}

function decodeRegion(
  view: DataView,
  kind: 'snapshot' | 'delta',
  tick: number,
  publishedAtMs: number,
): RegionPayload {
  if (view.byteLength < HEADER_LENGTH + 3) {
    throw new PayloadDecodeError('region payload is missing its region and count fields');
  }

  const region = view.getUint8(HEADER_LENGTH);
  const count = view.getUint16(HEADER_LENGTH + 1, true);

  const bodyStart = HEADER_LENGTH + 3;
  const expected = bodyStart + count * CHUNK_LENGTH;
  if (view.byteLength < expected) {
    throw new PayloadDecodeError(
      `region payload declares ${count} chunks (${expected} bytes) but is ${view.byteLength} bytes`,
    );
  }

  const chunks: WorldChunk[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = bodyStart + index * CHUNK_LENGTH;
    chunks[index] = {
      id: view.getUint16(offset, true),
      state: view.getUint8(offset + 2),
      hp: view.getUint8(offset + 3),
      x: view.getInt16(offset + 4, true) / 100,
      y: view.getInt16(offset + 6, true) / 100,
      z: view.getInt16(offset + 8, true) / 100,
      yaw: view.getInt16(offset + 10, true) / 1000,
    };
  }

  return { kind, tick, publishedAtMs, region, chunks };
}

function decodeMeta(
  view: DataView,
  bytes: Uint8Array,
  tick: number,
  publishedAtMs: number,
): MetaPayload {
  if (view.byteLength < HEADER_LENGTH + 6) {
    throw new PayloadDecodeError('meta payload is truncated');
  }

  const round = view.getUint16(HEADER_LENGTH, true);
  const playersAlive = view.getUint16(HEADER_LENGTH + 2, true);
  const destroyedPct = view.getUint8(HEADER_LENGTH + 4);
  const headlineLength = view.getUint8(HEADER_LENGTH + 5);

  const headlineStart = HEADER_LENGTH + 6;
  if (view.byteLength < headlineStart + headlineLength) {
    throw new PayloadDecodeError(
      `meta payload declares a ${headlineLength}-byte headline but only ` +
        `${view.byteLength - headlineStart} bytes remain`,
    );
  }

  const headline = new TextDecoder().decode(
    bytes.subarray(headlineStart, headlineStart + headlineLength),
  );

  return { kind: 'meta', tick, publishedAtMs, round, playersAlive, destroyedPct, headline };
}

/**
 * Apply a snapshot or delta on top of the chunks already known for a region.
 *
 * Snapshots replace the region wholesale; deltas patch only the chunks they
 * carry. This is the whole reason a track can run at 1 Hz without the client
 * losing track of what happened — the next snapshot resynchronises it.
 */
export function applyRegionPayload(
  known: Map<number, WorldChunk>,
  payload: RegionPayload,
): Map<number, WorldChunk> {
  const next = payload.kind === 'snapshot' ? new Map<number, WorldChunk>() : new Map(known);
  for (const chunk of payload.chunks) {
    next.set(chunk.id, chunk);
  }
  return next;
}
