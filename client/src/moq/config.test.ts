import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RELAY_ENDPOINT,
  buildConnectUrl,
  loadMoqDemoConfig,
  parseCertificateHash,
  parseNamespace,
} from './config';

describe('parseNamespace', () => {
  it('splits a slash path into tuple fields', () => {
    expect(parseNamespace('vibe-land/demo')).toEqual(['vibe-land', 'demo']);
    expect(parseNamespace('a/b/c')).toEqual(['a', 'b', 'c']);
  });

  it('ignores leading, trailing and doubled slashes', () => {
    expect(parseNamespace('/vibe-land//demo/')).toEqual(['vibe-land', 'demo']);
  });

  it('falls back to the default rather than producing an empty tuple', () => {
    expect(parseNamespace('')).toEqual(['vibe-land', 'demo']);
    expect(parseNamespace('///')).toEqual(['vibe-land', 'demo']);
  });
});

describe('buildConnectUrl', () => {
  it('appends the token as a path segment', () => {
    expect(buildConnectUrl('https://relay.example', 'tok123')).toBe('https://relay.example/tok123');
  });

  it('does not double up on slashes', () => {
    expect(buildConnectUrl('https://relay.example/', 'tok123')).toBe(
      'https://relay.example/tok123',
    );
    expect(buildConnectUrl('https://relay.example', '/tok123')).toBe(
      'https://relay.example/tok123',
    );
  });

  it('leaves the endpoint alone when there is no token', () => {
    // A local relay has no auth, so the bare endpoint is the connect URL.
    expect(buildConnectUrl('https://localhost:4443', '')).toBe('https://localhost:4443');
    expect(buildConnectUrl('https://localhost:4443', '   ')).toBe('https://localhost:4443');
  });

  it('accepts a token pasted as a whole URL', () => {
    // The Cloudflare API hands back a full URL; pasting it should just work.
    expect(
      buildConnectUrl('https://relay.example', 'https://draft-16.example.com/abc123'),
    ).toBe('https://draft-16.example.com/abc123');
  });

  it('escapes a token containing URL-significant characters', () => {
    expect(buildConnectUrl('https://relay.example', 'a/b?c')).toBe(
      'https://relay.example/a%2Fb%3Fc',
    );
  });
});

describe('loadMoqDemoConfig', () => {
  it('defaults to the Cloudflare draft-16 endpoint with no token', () => {
    const config = loadMoqDemoConfig('');
    expect(config.endpoint).toBe(DEFAULT_RELAY_ENDPOINT);
    expect(config.token).toBe('');
    expect(config.namespace).toEqual(['vibe-land', 'demo']);
    expect(config.certificateHash).toBeNull();
  });

  it('lets the query string override everything', () => {
    const config = loadMoqDemoConfig(
      '?relay=https://localhost:4443/&token=abc&ns=game/eu-west&certhash=' + 'ab'.repeat(32),
    );

    expect(config.endpoint).toBe('https://localhost:4443');
    expect(config.token).toBe('abc');
    expect(config.namespace).toEqual(['game', 'eu-west']);
    expect(config.certificateHash).toBe('ab'.repeat(32));
  });
});

describe('parseCertificateHash', () => {
  it('turns a hex digest into the WebTransport hash form', () => {
    const [hash] = parseCertificateHash('00ff'.repeat(16));
    expect(hash.algorithm).toBe('sha-256');

    const value = hash.value as Uint8Array;
    expect(value.length).toBe(32);
    expect(value[0]).toBe(0x00);
    expect(value[1]).toBe(0xff);
  });

  it('tolerates the colon-separated form openssl prints', () => {
    const colons = Array.from({ length: 32 }, () => 'ab').join(':');
    expect((parseCertificateHash(colons)[0].value as Uint8Array).length).toBe(32);
  });

  it('rejects anything that is not a 32-byte digest', () => {
    expect(() => parseCertificateHash('abcd')).toThrow(/64 hex characters/);
    expect(() => parseCertificateHash('zz'.repeat(32))).toThrow(/64 hex characters/);
  });
});
