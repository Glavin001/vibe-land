// WebTransport is required; WebSocket is an explicit opt-in, never a fallback.
// Pinned because the failure mode of getting this wrong is silent: the session
// still works, on a wire with completely different loss behaviour from the one
// the debris codec is designed and measured against.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { wantsWebSocketTransport } from './transportPolicy';

function withSearch(search: string): void {
  vi.stubGlobal('window', { location: { search } } as unknown as Window);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transport policy', () => {
  it('does not allow WebSocket by default', () => {
    withSearch('');
    expect(wantsWebSocketTransport()).toBe(false);
  });

  it('does not allow WebSocket for unrelated query params', () => {
    withSearch('?netlab=1&impair=lte&match=city-default');
    expect(wantsWebSocketTransport()).toBe(false);
  });

  it('allows WebSocket only for the explicit opt-in', () => {
    withSearch('?transport=ws');
    expect(wantsWebSocketTransport()).toBe(true);
    withSearch('?foo=1&transport=ws&bar=2');
    expect(wantsWebSocketTransport()).toBe(true);
  });

  it('is not fooled by a near-miss value', () => {
    withSearch('?transport=websocket');
    expect(wantsWebSocketTransport()).toBe(false);
    withSearch('?transport=WS');
    expect(wantsWebSocketTransport()).toBe(false);
  });
});
