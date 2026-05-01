import { describe, expect, it } from 'vitest';
import {
  VIBE_JAM_PORTAL_URL,
  buildPortalRedirectUrl,
  buildReturnPortalUrl,
  readPortalParams,
} from './portalParams';

describe('readPortalParams', () => {
  it('returns inactive defaults for an empty query string', () => {
    expect(readPortalParams('')).toEqual({
      isFromPortal: false,
      ref: null,
      forwarded: {},
    });
  });

  it('detects portal=true and ref', () => {
    const result = readPortalParams('?portal=true&ref=fly.pieter.com');
    expect(result.isFromPortal).toBe(true);
    expect(result.ref).toBe('fly.pieter.com');
    expect(result.forwarded).toEqual({});
  });

  it('treats portal=anything-else as not from portal', () => {
    expect(readPortalParams('?portal=1').isFromPortal).toBe(false);
    expect(readPortalParams('?portal=false').isFromPortal).toBe(false);
  });

  it('captures all forwarded keys when present', () => {
    const search =
      '?portal=true&username=levelsio&color=red&speed=5&avatar_url=https://x/y.png'
      + '&team=blue&hp=88&speed_x=1&speed_y=2&speed_z=3'
      + '&rotation_x=0.1&rotation_y=0.2&rotation_z=0.3&ref=fly.pieter.com';
    const result = readPortalParams(search);
    expect(result.isFromPortal).toBe(true);
    expect(result.ref).toBe('fly.pieter.com');
    expect(result.forwarded).toEqual({
      username: 'levelsio',
      color: 'red',
      speed: '5',
      avatar_url: 'https://x/y.png',
      team: 'blue',
      hp: '88',
      speed_x: '1',
      speed_y: '2',
      speed_z: '3',
      rotation_x: '0.1',
      rotation_y: '0.2',
      rotation_z: '0.3',
    });
  });

  it('ignores empty forwarded values', () => {
    expect(readPortalParams('?username=&color=blue').forwarded).toEqual({ color: 'blue' });
  });

  it('ignores ref outside the params object even when empty', () => {
    expect(readPortalParams('?ref=').ref).toBeNull();
  });
});

describe('buildPortalRedirectUrl', () => {
  it('forwards params and sets ref', () => {
    const url = buildPortalRedirectUrl(
      VIBE_JAM_PORTAL_URL,
      { username: 'levelsio', color: 'red', speed: '5' },
      'vibe-land.example',
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(VIBE_JAM_PORTAL_URL);
    expect(parsed.searchParams.get('username')).toBe('levelsio');
    expect(parsed.searchParams.get('color')).toBe('red');
    expect(parsed.searchParams.get('speed')).toBe('5');
    expect(parsed.searchParams.get('ref')).toBe('vibe-land.example');
  });

  it('omits ref when selfRef is null', () => {
    const url = buildPortalRedirectUrl(VIBE_JAM_PORTAL_URL, {}, null);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('ref')).toBeNull();
  });

  it('overrides any inbound ref forwarded into the dict with selfRef', () => {
    const url = buildPortalRedirectUrl(
      VIBE_JAM_PORTAL_URL,
      { username: 'a' },
      'me.example',
    );
    expect(new URL(url).searchParams.get('ref')).toBe('me.example');
  });
});

describe('buildReturnPortalUrl', () => {
  it('prepends https:// when ref is bare host and adds portal=true', () => {
    const url = buildReturnPortalUrl('fly.pieter.com', { username: 'levelsio' }, 'me.example');
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('fly.pieter.com');
    expect(parsed.searchParams.get('portal')).toBe('true');
    expect(parsed.searchParams.get('username')).toBe('levelsio');
    expect(parsed.searchParams.get('ref')).toBe('me.example');
  });

  it('keeps explicit https:// scheme', () => {
    const url = buildReturnPortalUrl('https://fly.pieter.com/foo', {}, null);
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('fly.pieter.com');
    expect(parsed.pathname).toBe('/foo');
    expect(parsed.searchParams.get('portal')).toBe('true');
    expect(parsed.searchParams.get('ref')).toBeNull();
  });

  it('preserves http:// when caller explicitly requests it', () => {
    const url = buildReturnPortalUrl('http://localhost:3000', {}, null);
    expect(new URL(url).protocol).toBe('http:');
  });
});
