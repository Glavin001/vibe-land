/**
 * Wire primitives for MoQ Transport: QUIC variable-length integers plus the
 * buffered readers and writers built on top of them.
 *
 * MoQ inherits RFC 9000 §16 varints, where the top two bits of the first byte
 * give the encoded length (1, 2, 4 or 8 bytes) and the remaining 62 bits carry
 * the value.
 */

/** Largest value a QUIC varint can hold (2^62 - 1). */
export const MAX_VARINT = 2n ** 62n - 1n;

/**
 * Values above 2^53 - 1 lose precision as JavaScript numbers. Nothing in this
 * protocol legitimately reaches that far — group and object IDs would have to
 * run for millions of years — so we surface it as an error rather than silently
 * decoding garbage.
 */
export class VarintRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'VarintRangeError';
  }
}

/** Number of bytes `value` occupies when varint-encoded. */
export function varintLength(value: number): 1 | 2 | 4 | 8 {
  if (!Number.isInteger(value) || value < 0) {
    throw new VarintRangeError(`varint must be a non-negative integer, got ${value}`);
  }
  if (value < 0x40) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x4000_0000) return 4;
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new VarintRangeError(`varint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return 8;
}

/** Length of the varint starting with `firstByte`, read from its top two bits. */
export function varintLengthFromPrefix(firstByte: number): 1 | 2 | 4 | 8 {
  return ([1, 2, 4, 8] as const)[firstByte >> 6];
}

/** Decode a varint from `bytes` at `offset`, which must hold the whole value. */
export function decodeVarint(bytes: Uint8Array, offset = 0): number {
  const length = varintLengthFromPrefix(bytes[offset]);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);

  switch (length) {
    case 1:
      return view.getUint8(0) & 0x3f;
    case 2:
      return view.getUint16(0) & 0x3fff;
    case 4:
      return view.getUint32(0) & 0x3fff_ffff;
    default: {
      const value = view.getBigUint64(0) & 0x3fff_ffff_ffff_ffffn;
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new VarintRangeError(`varint ${value} exceeds Number.MAX_SAFE_INTEGER`);
      }
      return Number(value);
    }
  }
}

/** A growable output buffer for building control messages. */
export class ByteWriter {
  #bytes: Uint8Array;
  #length = 0;

  constructor(initialCapacity = 256) {
    this.#bytes = new Uint8Array(initialCapacity);
  }

  get length(): number {
    return this.#length;
  }

  /** A view of everything written so far. Not a copy — do not retain it. */
  bytes(): Uint8Array {
    return this.#bytes.subarray(0, this.#length);
  }

  #reserve(extra: number): number {
    const needed = this.#length + extra;
    if (needed > this.#bytes.length) {
      let capacity = this.#bytes.length * 2;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.#bytes.subarray(0, this.#length));
      this.#bytes = grown;
    }
    const offset = this.#length;
    this.#length = needed;
    return offset;
  }

  u8(value: number): this {
    const offset = this.#reserve(1);
    this.#bytes[offset] = value;
    return this;
  }

  /** 16-bit big-endian, used for the control message length field. */
  u16(value: number): this {
    const offset = this.#reserve(2);
    this.#bytes[offset] = (value >> 8) & 0xff;
    this.#bytes[offset + 1] = value & 0xff;
    return this;
  }

  varint(value: number): this {
    const length = varintLength(value);
    const offset = this.#reserve(length);
    const view = new DataView(this.#bytes.buffer, this.#bytes.byteOffset + offset, length);

    switch (length) {
      case 1:
        view.setUint8(0, value);
        break;
      case 2:
        view.setUint16(0, value | 0x4000);
        break;
      case 4:
        view.setUint32(0, value | 0x8000_0000);
        break;
      default:
        view.setBigUint64(0, BigInt(value) | 0xc000_0000_0000_0000n);
        break;
    }
    return this;
  }

  raw(bytes: Uint8Array): this {
    const offset = this.#reserve(bytes.length);
    this.#bytes.set(bytes, offset);
    return this;
  }

  /** Varint length followed by the bytes themselves. */
  lengthPrefixed(bytes: Uint8Array): this {
    return this.varint(bytes.length).raw(bytes);
  }

  string(value: string): this {
    return this.lengthPrefixed(new TextEncoder().encode(value));
  }
}

/** Reads wire values out of a complete, in-memory buffer. */
export class ByteReader {
  #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  get done(): boolean {
    return this.remaining === 0;
  }

  #require(count: number): void {
    if (this.remaining < count) {
      throw new RangeError(`truncated message: wanted ${count} bytes, have ${this.remaining}`);
    }
  }

  u8(): number {
    this.#require(1);
    return this.#bytes[this.#offset++];
  }

  u16(): number {
    this.#require(2);
    const value = (this.#bytes[this.#offset] << 8) | this.#bytes[this.#offset + 1];
    this.#offset += 2;
    return value;
  }

  varint(): number {
    this.#require(1);
    const length = varintLengthFromPrefix(this.#bytes[this.#offset]);
    this.#require(length);
    const value = decodeVarint(this.#bytes, this.#offset);
    this.#offset += length;
    return value;
  }

  bytes(count: number): Uint8Array {
    this.#require(count);
    const slice = this.#bytes.subarray(this.#offset, this.#offset + count);
    this.#offset += count;
    return slice;
  }

  lengthPrefixed(): Uint8Array {
    return this.bytes(this.varint());
  }

  string(): string {
    return new TextDecoder().decode(this.lengthPrefixed());
  }
}

/**
 * Reads wire values off a QUIC stream, waiting for more data as needed.
 *
 * MoQ messages routinely straddle chunk boundaries — a subgroup stream is a
 * header followed by an unbounded run of objects — so every read has to be able
 * to block until enough bytes have arrived.
 */
export class StreamReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #closed = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Bytes pulled off the stream but not yet consumed by a read. */
  get buffered(): number {
    return this.#buffered;
  }

  /** Pull chunks until at least `count` bytes are buffered. False at EOF. */
  async #fill(count: number): Promise<boolean> {
    while (this.#buffered < count) {
      if (this.#closed) return false;
      const { done, value } = await this.#reader.read();
      if (done) {
        this.#closed = true;
        return false;
      }
      if (value.length > 0) {
        this.#chunks.push(value);
        this.#buffered += value.length;
      }
    }
    return true;
  }

  #take(count: number): Uint8Array {
    const head = this.#chunks[0];
    if (head.length >= count) {
      const slice = head.subarray(0, count);
      if (head.length === count) {
        this.#chunks.shift();
      } else {
        this.#chunks[0] = head.subarray(count);
      }
      this.#buffered -= count;
      return slice;
    }

    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.#chunks[0];
      const take = Math.min(chunk.length, count - filled);
      out.set(chunk.subarray(0, take), filled);
      if (take === chunk.length) {
        this.#chunks.shift();
      } else {
        this.#chunks[0] = chunk.subarray(take);
      }
      filled += take;
    }
    this.#buffered -= count;
    return out;
  }

  /** True once the stream has ended and nothing is left buffered. */
  async atEof(): Promise<boolean> {
    if (this.#buffered > 0) return false;
    return !(await this.#fill(1));
  }

  async bytes(count: number): Promise<Uint8Array> {
    if (count === 0) return new Uint8Array(0);
    if (!(await this.#fill(count))) {
      throw new RangeError(`stream ended after ${this.#buffered} of ${count} expected bytes`);
    }
    return this.#take(count);
  }

  async u8(): Promise<number> {
    return (await this.bytes(1))[0];
  }

  async u16(): Promise<number> {
    const bytes = await this.bytes(2);
    return (bytes[0] << 8) | bytes[1];
  }

  async varint(): Promise<number> {
    if (!(await this.#fill(1))) {
      throw new RangeError('stream ended mid-varint');
    }
    const length = varintLengthFromPrefix(this.#chunks[0][0]);
    return decodeVarint(await this.bytes(length));
  }

  async cancel(reason?: unknown): Promise<void> {
    this.#closed = true;
    this.#chunks = [];
    this.#buffered = 0;
    try {
      await this.#reader.cancel(reason);
    } catch {
      // The peer may have reset the stream already; nothing useful to do.
    }
  }
}
