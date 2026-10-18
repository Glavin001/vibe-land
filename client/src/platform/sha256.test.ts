import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256 } from './sha256';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('sha256', () => {
  it('matches node:crypto across block boundaries', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 100_003]) {
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) data[i] = (i * 31 + 7) & 0xff;
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});
