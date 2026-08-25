/**
 * Transport policy: WebTransport only.
 *
 * The two transports are not interchangeable for this game. WebTransport
 * carries pose datagrams unreliably, which is what the debris codec is built
 * for -- it restates parked lanes and heals loss through a nack loop, and its
 * bandwidth governor is tuned against that behaviour. WebSocket delivers the
 * same packets on an ordered reliable stream, so a session that falls back is
 * playing a materially different game: no loss, head-of-line blocking instead,
 * and every measurement taken on it describes a wire no other player is on.
 *
 * Falling back also hides the real failure. A silent downgrade turns "QUIC
 * could not connect" into "the game feels different", which is far harder to
 * diagnose -- an entire investigation here was run against WebSocket without
 * anyone noticing the session was not on the transport being debugged.
 *
 * `?transport=ws` remains as an explicit, visible opt-in for debugging the
 * fallback path itself.
 */
export function wantsWebSocketTransport(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('transport') === 'ws';
  } catch {
    return false;
  }
}

/** Whether this browser can speak WebTransport at all. */
export function browserSupportsWebTransport(): boolean {
  return typeof window !== 'undefined' && 'WebTransport' in window;
}
