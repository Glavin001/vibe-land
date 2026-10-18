import { describe, expect, it } from 'vitest';

import { ByteReader, ByteWriter, StreamReader } from './coding';
import {
  ControlMessageType,
  ObjectStatus,
  decodeRequestError,
  decodeSubscribeOk,
  describeRequestError,
  encodeClientSetup,
  encodeSubscribe,
  encodeUnsubscribe,
  readControlMessage,
  readDatagramObject,
  readKeyValuePairs,
  readKeyValuePairsToEnd,
  readSubgroupHeader,
  readSubgroupObject,
  subgroupStreamShape,
  writeKeyValuePairs,
} from './protocol';

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

const ascii = (text: string) => Array.from(new TextEncoder().encode(text));

describe('key-value pairs', () => {
  it('delta-encodes keys and picks the value form from key parity', () => {
    const writer = new ByteWriter();
    // Key 1 is odd, so it carries bytes; key 2 is even, so it carries an int.
    writeKeyValuePairs(writer, [
      { key: 1, value: new TextEncoder().encode('testpath') },
      { key: 2, value: 100 },
    ]);

    // Layout asserted by moq-rs's own setup::Client test.
    expect(Array.from(writer.bytes())).toEqual([
      0x02, // two pairs
      0x01, // delta 1 -> key 1 (odd, bytes)
      0x08,
      ...ascii('testpath'),
      0x01, // delta 1 -> key 2 (even, int)
      0x40,
      0x64, // 100 as a two-byte varint
    ]);
  });

  it('sorts keys so the deltas never go backwards', () => {
    const writer = new ByteWriter();
    writeKeyValuePairs(writer, [
      { key: 6, value: 1 },
      { key: 2, value: 2 },
    ]);

    const pairs = readKeyValuePairs(new ByteReader(writer.bytes()));
    expect(pairs).toEqual([
      { key: 2, value: 2 },
      { key: 6, value: 1 },
    ]);
  });

  it('rejects a value whose type contradicts its key parity', () => {
    expect(() => writeKeyValuePairs(new ByteWriter(), [{ key: 2, value: bytesOf(1) }])).toThrow(
      TypeError,
    );
    expect(() => writeKeyValuePairs(new ByteWriter(), [{ key: 3, value: 1 }])).toThrow(TypeError);
  });

  it('reads unprefixed pairs to the end for track extensions', () => {
    // key 2 = 5, then key 4 = 9, written as deltas 2 and 2.
    const pairs = readKeyValuePairsToEnd(new ByteReader(bytesOf(0x02, 0x05, 0x02, 0x09)));
    expect(pairs).toEqual([
      { key: 2, value: 5 },
      { key: 4, value: 9 },
    ]);
  });
});

describe('control messages', () => {
  it('encodes CLIENT_SETUP as parameters only', () => {
    // Draft-16 moved version negotiation out of the setup payload entirely.
    expect(Array.from(encodeClientSetup(100))).toEqual([
      0x20, // CLIENT_SETUP
      0x00,
      0x04, // 16-bit big-endian payload length
      0x01, // one parameter
      0x02, // delta 2 -> MAX_REQUEST_ID
      0x40,
      0x64, // 100
    ]);
  });

  it('encodes SUBSCRIBE byte-for-byte the way moq-rs does', () => {
    // Vector lifted from moq-rs's draft16_wire_layouts test.
    expect(Array.from(encodeSubscribe(0, ['ns'], 't'))).toEqual([
      0x03, // SUBSCRIBE
      0x00,
      0x08, // payload length
      0x00, // request id
      0x01, // namespace tuple: one field
      0x02,
      ...ascii('ns'),
      0x01,
      ...ascii('t'), // track name
      0x00, // no parameters
    ]);
  });

  it('encodes multi-field namespaces as a tuple', () => {
    const encoded = encodeSubscribe(4, ['vibe-land', 'demo'], 'region-0');
    const reader = new ByteReader(encoded);

    expect(reader.varint()).toBe(ControlMessageType.Subscribe);
    const length = reader.u16();
    expect(length).toBe(encoded.length - 3);

    expect(reader.varint()).toBe(4);
    expect(reader.varint()).toBe(2);
    expect(reader.string()).toBe('vibe-land');
    expect(reader.string()).toBe('demo');
    expect(reader.string()).toBe('region-0');
  });

  it('encodes UNSUBSCRIBE with just the request id', () => {
    expect(Array.from(encodeUnsubscribe(6))).toEqual([0x0a, 0x00, 0x01, 0x06]);
  });

  it('decodes SUBSCRIBE_OK, including the trailing track extensions', () => {
    // moq-rs vector: request id 0, track alias 1, no params, no extensions.
    expect(decodeSubscribeOk(bytesOf(0x00, 0x01, 0x00))).toEqual({
      requestId: 0,
      trackAlias: 1,
      params: [],
      extensions: [],
    });

    // Same, but with one parameter and one track extension appended.
    expect(decodeSubscribeOk(bytesOf(0x02, 0x07, 0x01, 0x02, 0x09, 0x04, 0x05))).toEqual({
      requestId: 2,
      trackAlias: 7,
      params: [{ key: 2, value: 9 }],
      extensions: [{ key: 4, value: 5 }],
    });
  });

  it('decodes REQUEST_ERROR and names the well-known codes', () => {
    const payload = new ByteWriter();
    payload.varint(0).varint(0x1).varint(0).string('bad token');

    const error = decodeRequestError(payload.bytes());
    expect(error).toEqual({
      requestId: 0,
      errorCode: 0x1,
      retryInterval: 0,
      reason: 'bad token',
    });
    expect(describeRequestError(error)).toBe('unauthorized: bad token');
  });

  it('reads a control message off a stream and stops at the length boundary', async () => {
    const stream = new StreamReader(
      streamOf(encodeUnsubscribe(6), encodeUnsubscribe(8)),
    );

    const first = await readControlMessage(stream);
    expect(first.type).toBe(ControlMessageType.Unsubscribe);
    expect(Array.from(first.payload)).toEqual([0x06]);

    const second = await readControlMessage(stream);
    expect(Array.from(second.payload)).toEqual([0x08]);
  });
});

describe('subgroup stream shapes', () => {
  it('derives the field layout from the header type', () => {
    // The full table from moq-rs's StreamHeaderType enum.
    const expected: Record<number, [boolean, boolean, boolean, boolean]> = {
      // headerType: [hasExtensions, subgroupIdFromFirstObject, hasSubgroupId, endOfGroup]
      0x10: [false, false, false, false],
      0x11: [true, false, false, false],
      0x12: [false, true, false, false],
      0x13: [true, true, false, false],
      0x14: [false, false, true, false],
      0x15: [true, false, true, false],
      0x18: [false, false, false, true],
      0x19: [true, false, false, true],
      0x1a: [false, true, false, true],
      0x1b: [true, true, false, true],
      0x1c: [false, false, true, true],
      0x1d: [true, false, true, true],
    };

    for (const [type, [hasExtensions, fromFirst, hasSubgroupId, endOfGroup]] of Object.entries(
      expected,
    )) {
      const shape = subgroupStreamShape(Number(type));
      expect(shape, `header type ${type}`).toEqual({
        hasExtensions,
        subgroupIdFromFirstObject: fromFirst,
        hasSubgroupId,
        endOfGroup,
      });
    }
  });

  it('rejects types outside the subgroup range and the unassigned holes', () => {
    for (const type of [0x05, 0x0f, 0x16, 0x17, 0x1e]) {
      expect(subgroupStreamShape(type)).toBeNull();
    }
  });
});

describe('subgroup data streams', () => {
  it('parses a header with an explicit subgroup id', async () => {
    const stream = new StreamReader(streamOf(bytesOf(0x14, 0x09, 0x07, 0x02, 0x80)));
    const headerType = await stream.varint();
    const header = await readSubgroupHeader(stream, headerType);

    expect(header).toMatchObject({
      trackAlias: 9,
      groupId: 7,
      subgroupId: 2,
      publisherPriority: 0x80,
    });
  });

  it('accumulates object ids from their deltas', async () => {
    // Header type 0x14, then three objects with deltas 0, 0, 2.
    const stream = new StreamReader(
      streamOf(
        bytesOf(0x14, 0x01, 0x00, 0x00, 0x00),
        bytesOf(0x00, 0x02, 0xaa, 0xbb),
        bytesOf(0x00, 0x01, 0xcc),
        bytesOf(0x02, 0x01, 0xdd),
      ),
    );

    const headerType = await stream.varint();
    const header = await readSubgroupHeader(stream, headerType);

    const ids: number[] = [];
    const payloads: number[][] = [];
    let previous: number | null = null;

    for (;;) {
      const object = await readSubgroupObject(stream, header.shape, previous);
      if (!object) break;
      previous = object.objectId;
      ids.push(object.objectId);
      payloads.push(Array.from(object.payload));
    }

    // First object's id is the delta itself; each later one is prev + delta + 1.
    expect(ids).toEqual([0, 1, 4]);
    expect(payloads).toEqual([[0xaa, 0xbb], [0xcc], [0xdd]]);
  });

  it('reads a zero-length object as a status marker', async () => {
    const stream = new StreamReader(streamOf(bytesOf(0x10, 0x01, 0x00, 0x00), bytesOf(0x00, 0x00, 0x03)));

    const headerType = await stream.varint();
    const header = await readSubgroupHeader(stream, headerType);
    const object = await readSubgroupObject(stream, header.shape, null);

    expect(object).toMatchObject({
      objectId: 0,
      status: ObjectStatus.EndOfGroup,
    });
    expect(object?.payload.length).toBe(0);
  });

  it('parses extension headers on the variants that carry them', async () => {
    // 0x15: explicit subgroup id plus extension headers.
    const stream = new StreamReader(
      streamOf(
        bytesOf(0x15, 0x01, 0x00, 0x00, 0x00),
        // object 0: delta 0, 2 bytes of extensions (key 2 = 1), payload "hi"
        bytesOf(0x00, 0x02, 0x02, 0x01, 0x02, ...ascii('hi')),
      ),
    );

    const headerType = await stream.varint();
    const header = await readSubgroupHeader(stream, headerType);
    expect(header.shape.hasExtensions).toBe(true);

    const object = await readSubgroupObject(stream, header.shape, null);
    expect(object?.extensions).toEqual([{ key: 2, value: 1 }]);
    expect(new TextDecoder().decode(object?.payload)).toBe('hi');
  });

  it('returns null once the stream ends', async () => {
    const stream = new StreamReader(streamOf(bytesOf(0x10, 0x01, 0x00, 0x00)));
    const headerType = await stream.varint();
    const header = await readSubgroupHeader(stream, headerType);

    expect(await readSubgroupObject(stream, header.shape, null)).toBeNull();
  });

  it('decodes an unreliable MoQ payload datagram', () => {
    expect(readDatagramObject(bytesOf(0x00, 0x03, 0x04, 0x05, 0x07, 0xaa, 0xbb))).toEqual({
      trackAlias: 3,
      groupId: 4,
      objectId: 5,
      publisherPriority: 7,
      status: ObjectStatus.Normal,
      payload: bytesOf(0xaa, 0xbb),
    });
  });

  it('rejects unsupported or empty MoQ datagrams', () => {
    expect(() => readDatagramObject(bytesOf(0x01))).toThrow('unsupported MoQ datagram type');
    expect(() => readDatagramObject(bytesOf(0x00, 0x00, 0x00, 0x00, 0x00))).toThrow(
      'MoQ payload datagram was empty',
    );
  });
});
