import { describe, expect, it } from 'vitest';

import {
  ByteReader,
  ByteWriter,
  StreamReader,
  VarintRangeError,
  decodeVarint,
  varintLength,
  varintLengthFromPrefix,
} from './coding';

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

describe('varints', () => {
  it('uses the shortest encoding for each range boundary', () => {
    expect(varintLength(0)).toBe(1);
    expect(varintLength(63)).toBe(1);
    expect(varintLength(64)).toBe(2);
    expect(varintLength(16_383)).toBe(2);
    expect(varintLength(16_384)).toBe(4);
    expect(varintLength(1_073_741_823)).toBe(4);
    expect(varintLength(1_073_741_824)).toBe(8);
  });

  it('matches the worked examples from RFC 9000 section 16', () => {
    // The RFC's 8-byte example (0xc2197c5eff14e88c) is above 2^53 and is
    // covered by the range check below instead.
    expect(decodeVarint(bytesOf(0xc0, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00))).toBe(2 ** 40);
    expect(decodeVarint(bytesOf(0x9d, 0x7f, 0x3e, 0x7d))).toBe(494_878_333);
    expect(decodeVarint(bytesOf(0x7b, 0xbd))).toBe(15_293);
    expect(decodeVarint(bytesOf(0x25))).toBe(37);
  });

  it('round-trips values across every encoded width', () => {
    for (const value of [0, 1, 63, 64, 16_383, 16_384, 1_073_741_823, 1_073_741_824, 2 ** 40]) {
      const writer = new ByteWriter();
      writer.varint(value);
      const bytes = writer.bytes();

      expect(bytes.length).toBe(varintLength(value));
      expect(varintLengthFromPrefix(bytes[0])).toBe(varintLength(value));
      expect(decodeVarint(bytes)).toBe(value);
    }
  });

  it('refuses values that cannot survive as JavaScript numbers', () => {
    // 2^53 and above would decode to a rounded value, which is worse than an error.
    expect(() => varintLength(Number.MAX_SAFE_INTEGER + 2)).toThrow(VarintRangeError);
    expect(() => decodeVarint(bytesOf(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toThrow(
      VarintRangeError,
    );
    expect(() => varintLength(-1)).toThrow(VarintRangeError);
  });
});

describe('ByteWriter', () => {
  it('grows past its initial capacity without corrupting earlier writes', () => {
    const writer = new ByteWriter(2);
    for (let index = 0; index < 500; index += 1) writer.u8(index & 0xff);

    const bytes = writer.bytes();
    expect(bytes.length).toBe(500);
    expect(bytes[0]).toBe(0);
    expect(bytes[499]).toBe(499 & 0xff);
  });

  it('writes the control-message length field big-endian', () => {
    const writer = new ByteWriter();
    writer.u16(0x0108);
    expect(Array.from(writer.bytes())).toEqual([0x01, 0x08]);
  });

  it('length-prefixes strings with a varint', () => {
    const writer = new ByteWriter();
    writer.string('region-0');
    expect(Array.from(writer.bytes())).toEqual([8, ...new TextEncoder().encode('region-0')]);
  });
});

describe('ByteReader', () => {
  it('reads back what ByteWriter produced', () => {
    const writer = new ByteWriter();
    writer.varint(300).u8(7).u16(65_535).string('meta');

    const reader = new ByteReader(writer.bytes());
    expect(reader.varint()).toBe(300);
    expect(reader.u8()).toBe(7);
    expect(reader.u16()).toBe(65_535);
    expect(reader.string()).toBe('meta');
    expect(reader.done).toBe(true);
  });

  it('throws rather than reading past the end of a truncated message', () => {
    const reader = new ByteReader(bytesOf(0x05));
    expect(() => reader.bytes(4)).toThrow(RangeError);
  });
});

describe('StreamReader', () => {
  it('reassembles values that straddle chunk boundaries', async () => {
    // A 4-byte varint delivered one byte at a time.
    const encoded = bytesOf(0x9d, 0x7f, 0x3e, 0x7d);
    const reader = new StreamReader(streamOf(...Array.from(encoded, (byte) => bytesOf(byte))));

    expect(await reader.varint()).toBe(494_878_333);
  });

  it('splits a single chunk across several reads', async () => {
    const reader = new StreamReader(streamOf(bytesOf(0x01, 0x02, 0x03, 0x04, 0x05)));

    expect(await reader.u8()).toBe(0x01);
    expect(Array.from(await reader.bytes(3))).toEqual([0x02, 0x03, 0x04]);
    expect(await reader.u8()).toBe(0x05);
    expect(await reader.atEof()).toBe(true);
  });

  it('joins bytes that span more than two chunks', async () => {
    const reader = new StreamReader(
      streamOf(bytesOf(1, 2), bytesOf(3), bytesOf(4, 5, 6), bytesOf(7)),
    );
    expect(Array.from(await reader.bytes(7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('reports end of stream only once the buffer is drained', async () => {
    const reader = new StreamReader(streamOf(bytesOf(0xaa)));

    expect(await reader.atEof()).toBe(false);
    expect(await reader.u8()).toBe(0xaa);
    expect(await reader.atEof()).toBe(true);
  });

  it('throws when the stream ends mid-value', async () => {
    const reader = new StreamReader(streamOf(bytesOf(0x01, 0x02)));
    await expect(reader.bytes(4)).rejects.toThrow(RangeError);
  });

  it('ignores empty chunks', async () => {
    const reader = new StreamReader(
      streamOf(new Uint8Array(0), bytesOf(0x42), new Uint8Array(0)),
    );
    expect(await reader.u8()).toBe(0x42);
    expect(await reader.atEof()).toBe(true);
  });
});
