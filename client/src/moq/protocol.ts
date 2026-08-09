/**
 * MoQ Transport draft-16 message encoding, limited to what a subscriber needs.
 *
 * Wire details follow draft-ietf-moq-transport-16 and were checked against
 * Cloudflare's Rust implementation (github.com/cloudflare/moq-rs, crate
 * `moq-transport`), which is what their relay speaks. `protocol.test.ts` pins
 * the encoders to byte vectors lifted from that crate's own tests.
 *
 * Two framings live here:
 *
 *   - Control messages, on a single bidirectional stream:
 *     `type (varint) | length (16-bit big-endian) | payload`
 *   - Data, on unidirectional streams: a subgroup header followed by a run of
 *     objects until the stream ends.
 */

import { ByteReader, ByteWriter, type StreamReader } from './coding';

/** Control message type IDs (draft-16 Table 1). */
export const ControlMessageType = {
  RequestUpdate: 0x02,
  Subscribe: 0x03,
  SubscribeOk: 0x04,
  RequestError: 0x05,
  PublishNamespace: 0x06,
  RequestOk: 0x07,
  Namespace: 0x08,
  PublishNamespaceDone: 0x09,
  Unsubscribe: 0x0a,
  PublishDone: 0x0b,
  PublishNamespaceCancel: 0x0c,
  TrackStatus: 0x0d,
  NamespaceDone: 0x0e,
  Goaway: 0x10,
  SubscribeNamespace: 0x11,
  MaxRequestId: 0x15,
  Fetch: 0x16,
  FetchCancel: 0x17,
  FetchOk: 0x18,
  RequestsBlocked: 0x1a,
  Publish: 0x1d,
  PublishOk: 0x1e,
  // Setup messages are framed like control messages but sit outside the table.
  ClientSetup: 0x20,
  ServerSetup: 0x21,
} as const;

/** Setup parameter keys (draft-16 §9.3). */
export const SetupParameter = {
  Path: 0x1,
  MaxRequestId: 0x2,
  AuthorizationToken: 0x3,
  MaxAuthTokenCacheSize: 0x4,
  Authority: 0x5,
  MoqtImplementation: 0x7,
} as const;

/** REQUEST_ERROR codes worth naming (draft-16 §13.4.2). */
export const RequestErrorCode: Record<number, string> = {
  0x0: 'internal error',
  0x1: 'unauthorized',
  0x2: 'timeout',
  0x3: 'not supported',
  0x4: 'malformed auth token',
  0x5: 'expired auth token',
  0x10: 'track does not exist',
  0x11: 'invalid range',
  0x12: 'malformed track',
  0x19: 'duplicate subscription',
  0x20: 'uninterested',
  0x30: 'namespace prefix overlap',
  0x32: 'invalid joining request id',
};

/**
 * A key-value pair. Even keys carry an integer, odd keys carry bytes — the
 * parity *is* the type tag, so there is no separate discriminator on the wire.
 */
export interface KeyValuePair {
  key: number;
  value: number | Uint8Array;
}

/**
 * Key-value pairs are delta-encoded: each entry writes the difference from the
 * previous key rather than the key itself, so ascending order is mandatory.
 */
function writeKeyValuePairsBody(writer: ByteWriter, pairs: readonly KeyValuePair[]): void {
  const sorted = [...pairs].sort((a, b) => a.key - b.key);
  let previous = 0;

  for (const pair of sorted) {
    writer.varint(pair.key - previous);
    previous = pair.key;

    if (pair.key % 2 === 0) {
      if (typeof pair.value !== 'number') {
        throw new TypeError(`key ${pair.key} is even and must carry an integer value`);
      }
      writer.varint(pair.value);
    } else {
      if (typeof pair.value === 'number') {
        throw new TypeError(`key ${pair.key} is odd and must carry a bytes value`);
      }
      writer.lengthPrefixed(pair.value);
    }
  }
}

/** Count-prefixed key-value pairs, the form used by message parameters. */
export function writeKeyValuePairs(writer: ByteWriter, pairs: readonly KeyValuePair[]): void {
  writer.varint(pairs.length);
  writeKeyValuePairsBody(writer, pairs);
}

function readKeyValuePair(reader: ByteReader, previous: number): [KeyValuePair, number] {
  const key = previous + reader.varint();
  const value = key % 2 === 0 ? reader.varint() : reader.lengthPrefixed();
  return [{ key, value }, key];
}

/** Read a count-prefixed run of key-value pairs. */
export function readKeyValuePairs(reader: ByteReader): KeyValuePair[] {
  const count = reader.varint();
  const pairs: KeyValuePair[] = [];
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const [pair, key] = readKeyValuePair(reader, previous);
    pairs.push(pair);
    previous = key;
  }
  return pairs;
}

/**
 * Read key-value pairs that run to the end of the message rather than being
 * count-prefixed. Track extensions are encoded this way, which is why they can
 * only ever be the last field.
 */
export function readKeyValuePairsToEnd(reader: ByteReader): KeyValuePair[] {
  const pairs: KeyValuePair[] = [];
  let previous = 0;
  while (!reader.done) {
    const [pair, key] = readKeyValuePair(reader, previous);
    pairs.push(pair);
    previous = key;
  }
  return pairs;
}

/** Wrap a payload in the control message framing. */
export function frameControlMessage(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffff) {
    throw new RangeError(`control message payload of ${payload.length} bytes exceeds 16 bits`);
  }
  const writer = new ByteWriter(payload.length + 8);
  writer.varint(type).u16(payload.length).raw(payload);
  return writer.bytes().slice();
}

/**
 * CLIENT_SETUP. Since draft-16 the version is negotiated out of band (by ALPN
 * for raw QUIC, or by the relay endpoint you connect to for WebTransport), so
 * the payload carries parameters only.
 *
 * `maxRequestId` is the ceiling we advertise for requests the *relay* may send
 * us, not for our own.
 */
export function encodeClientSetup(maxRequestId: number): Uint8Array {
  const payload = new ByteWriter(16);
  writeKeyValuePairs(payload, [{ key: SetupParameter.MaxRequestId, value: maxRequestId }]);
  return frameControlMessage(ControlMessageType.ClientSetup, payload.bytes());
}

export function encodeSubscribe(
  requestId: number,
  namespace: readonly string[],
  track: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const payload = new ByteWriter(64);

  payload.varint(requestId);
  payload.varint(namespace.length);
  for (const field of namespace) {
    payload.lengthPrefixed(encoder.encode(field));
  }
  payload.string(track);
  writeKeyValuePairs(payload, []);

  return frameControlMessage(ControlMessageType.Subscribe, payload.bytes());
}

export function encodeUnsubscribe(requestId: number): Uint8Array {
  const payload = new ByteWriter(8);
  payload.varint(requestId);
  return frameControlMessage(ControlMessageType.Unsubscribe, payload.bytes());
}

export interface ControlMessage {
  type: number;
  payload: Uint8Array;
}

/**
 * Read one control message. The 16-bit length lets us skip message types we do
 * not implement instead of losing stream sync, which matters because the relay
 * is free to send us anything in the table.
 */
export async function readControlMessage(stream: StreamReader): Promise<ControlMessage> {
  const type = await stream.varint();
  const length = await stream.u16();
  return { type, payload: await stream.bytes(length) };
}

export interface SubscribeOk {
  requestId: number;
  trackAlias: number;
  params: KeyValuePair[];
  extensions: KeyValuePair[];
}

export function decodeSubscribeOk(payload: Uint8Array): SubscribeOk {
  const reader = new ByteReader(payload);
  return {
    requestId: reader.varint(),
    trackAlias: reader.varint(),
    params: readKeyValuePairs(reader),
    extensions: readKeyValuePairsToEnd(reader),
  };
}

export interface RequestError {
  requestId: number;
  errorCode: number;
  /** Milliseconds to wait before retrying, plus one. Zero means never retry. */
  retryInterval: number;
  reason: string;
}

export function decodeRequestError(payload: Uint8Array): RequestError {
  const reader = new ByteReader(payload);
  return {
    requestId: reader.varint(),
    errorCode: reader.varint(),
    retryInterval: reader.varint(),
    reason: reader.string(),
  };
}

export function describeRequestError(error: RequestError): string {
  const name = RequestErrorCode[error.errorCode] ?? `error code 0x${error.errorCode.toString(16)}`;
  return error.reason ? `${name}: ${error.reason}` : name;
}

/** Shape of a subgroup data stream, derived from its header type. */
export interface SubgroupStreamShape {
  hasSubgroupId: boolean;
  hasExtensions: boolean;
  /** The subgroup ID is implied by the first object's ID rather than sent. */
  subgroupIdFromFirstObject: boolean;
  /** The last object in the stream also ends the group. */
  endOfGroup: boolean;
}

/**
 * Subgroup stream header types occupy 0x10-0x1d. The low bits encode which
 * optional fields are present rather than there being a flags byte:
 * bit 0 = extension headers, bits 1-2 = how the subgroup ID is carried,
 * bit 3 = end-of-group marker.
 */
export function subgroupStreamShape(headerType: number): SubgroupStreamShape | null {
  if (headerType < 0x10 || headerType > 0x1d) return null;

  // Mode 0b11 is unassigned, which is what leaves 0x16 and 0x17 as holes.
  const subgroupIdMode = (headerType >> 1) & 0b11;
  if (subgroupIdMode === 0b11) return null;

  return {
    hasExtensions: (headerType & 0b1) === 1,
    subgroupIdFromFirstObject: subgroupIdMode === 0b01,
    hasSubgroupId: subgroupIdMode === 0b10,
    endOfGroup: (headerType & 0b1000) !== 0,
  };
}

export interface SubgroupHeader {
  headerType: number;
  shape: SubgroupStreamShape;
  trackAlias: number;
  groupId: number;
  subgroupId: number;
  publisherPriority: number;
}

/** Read the header of a subgroup stream, `headerType` already consumed. */
export async function readSubgroupHeader(
  stream: StreamReader,
  headerType: number,
): Promise<SubgroupHeader> {
  const shape = subgroupStreamShape(headerType);
  if (!shape) {
    throw new Error(`unsupported data stream header type 0x${headerType.toString(16)}`);
  }

  const trackAlias = await stream.varint();
  const groupId = await stream.varint();
  const subgroupId = shape.hasSubgroupId ? await stream.varint() : 0;
  const publisherPriority = await stream.u8();

  return { headerType, shape, trackAlias, groupId, subgroupId, publisherPriority };
}

/** Object status values that survived into draft-16 (§10.2.1.1). */
export const ObjectStatus = {
  Normal: 0x0,
  EndOfGroup: 0x3,
  EndOfTrack: 0x4,
} as const;

export interface SubgroupObject {
  objectId: number;
  status: number;
  payload: Uint8Array;
  extensions: KeyValuePair[];
}

/**
 * Read the next object from a subgroup stream, or null at end of stream.
 *
 * Object IDs are delta-encoded against the previous object: the first object's
 * ID is the delta itself, and every one after that is `previous + delta + 1`.
 * Pass `null` as `previousObjectId` for the first object in the stream.
 */
export async function readSubgroupObject(
  stream: StreamReader,
  shape: SubgroupStreamShape,
  previousObjectId: number | null,
): Promise<SubgroupObject | null> {
  if (await stream.atEof()) return null;

  const delta = await stream.varint();
  const objectId = previousObjectId === null ? delta : previousObjectId + delta + 1;

  let extensions: KeyValuePair[] = [];
  if (shape.hasExtensions) {
    // Extension headers are byte-length prefixed rather than count prefixed.
    const extensionBytes = await stream.bytes(await stream.varint());
    extensions = readKeyValuePairsToEnd(new ByteReader(extensionBytes));
  }

  const payloadLength = await stream.varint();
  if (payloadLength === 0) {
    // A zero-length object carries a status instead of a payload.
    return { objectId, status: await stream.varint(), payload: new Uint8Array(0), extensions };
  }

  return {
    objectId,
    status: ObjectStatus.Normal,
    payload: await stream.bytes(payloadLength),
    extensions,
  };
}
