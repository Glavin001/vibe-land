import { describe, expect, it } from 'vitest';

import { SERVER_CLOSE_MARKER, serverCloseReason } from './disconnectReason';

describe('serverCloseReason', () => {
  it("returns the server's words from a described close", () => {
    const text = 'the destructible city needs VIBE_PHYSICS_BACKEND=physx_gpu';
    expect(serverCloseReason(`webtransport ${SERVER_CLOSE_MARKER}${text}`)).toBe(text);
  });

  it('is null for closes the server did not explain', () => {
    expect(serverCloseReason(undefined)).toBeNull();
    expect(serverCloseReason('webtransport closed')).toBeNull();
    expect(serverCloseReason('webtransport closed (code 0)')).toBeNull();
  });
});
