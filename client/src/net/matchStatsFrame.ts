// Decodes PKT_MATCH_STATS: the per-match server telemetry the stats overlay
// shows, pushed once a second.
//
// Two payloads share the kind. Servers before the compact frame sent the whole
// /match-stats snapshot as JSON (~15 kB a second on the ordered stream); they
// start with '{'. The compact frame (server/src/match_stats_frame.rs) carries
// only the fields in shared/match-stats-frame.json, in that order, as a
// ~250-byte datagram. Both decode to the same nested object, so the overlay and
// the tape tools read one shape whichever server they talk to.

import table from '../../../shared/match-stats-frame.json';

type FieldType = 'f' | 'u' | 'b' | 's';
type Field = { path: readonly string[]; type: FieldType };

const JSON_OPEN_BRACE = 0x7b;
export const MATCH_STATS_FRAME_FORMAT = 1;
const ABSENT_U32 = 0xffffffff;
const ABSENT_BYTE = 0xff;

export const MATCH_STATS_FIELDS: readonly Field[] = (table.fields as [string[], string][]).map(
  ([path, type]) => ({ path, type: type as FieldType }),
);

const utf8 = new TextDecoder();

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    let next = node[key] as Record<string, unknown> | undefined;
    if (next === undefined) {
      next = {};
      node[key] = next;
    }
    node = next;
  }
  node[path[path.length - 1]] = value;
}

/**
 * The stats object carried by a PKT_MATCH_STATS packet (kind byte included),
 * or null when it cannot be read (truncated, or a format this client does not
 * know). Fields the server marked absent are left out -- never zero -- and an
 * object (e.g. `city`) exists only when one of its fields is present.
 */
export function decodeMatchStatsPacket(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length < 2) return null;
  if (bytes[1] === JSON_OPEN_BRACE) {
    try {
      return JSON.parse(utf8.decode(bytes.subarray(1))) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (bytes[1] !== MATCH_STATS_FRAME_FORMAT || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, unknown> = { server_tick: view.getUint32(2, true) };
  // A newer server may append fields this client does not know: they are at
  // the end, so decoding the known prefix is exact.
  const count = Math.min(view.getUint16(6, true), MATCH_STATS_FIELDS.length);
  let o = 8;
  for (let i = 0; i < count; i += 1) {
    const field = MATCH_STATS_FIELDS[i];
    switch (field.type) {
      case 'f': {
        if (o + 4 > bytes.length) return null;
        const v = view.getFloat32(o, true);
        o += 4;
        if (!Number.isNaN(v)) setPath(out, field.path, v);
        break;
      }
      case 'u': {
        if (o + 4 > bytes.length) return null;
        const v = view.getUint32(o, true);
        o += 4;
        if (v !== ABSENT_U32) setPath(out, field.path, v);
        break;
      }
      case 'b': {
        if (o + 1 > bytes.length) return null;
        const v = bytes[o];
        o += 1;
        if (v !== ABSENT_BYTE) setPath(out, field.path, v === 1);
        break;
      }
      case 's': {
        if (o + 1 > bytes.length) return null;
        const len = bytes[o];
        o += 1;
        if (len === ABSENT_BYTE) break;
        if (o + len > bytes.length) return null;
        setPath(out, field.path, utf8.decode(bytes.subarray(o, o + len)));
        o += len;
        break;
      }
    }
  }
  return out;
}
