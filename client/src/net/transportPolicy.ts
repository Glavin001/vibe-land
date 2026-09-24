/**
 * Transport policy: WebTransport only. WebSocket is DISABLED.
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
 * So the game client never selects WebSocket and never falls back to it. The
 * ONE way to re-enable it is a build-time flag, `VITE_ENABLE_WEBSOCKET=1`
 * (in the repo-root `.env`, or the environment of `vite` / `vite build`).
 * There is deliberately no URL parameter or localStorage switch: a link, a
 * bookmark or a test script must not be able to put a player on WebSocket.
 * Even with the flag set, WebTransport is still tried first and WebSocket is
 * used only if it fails. The game server must also be started with
 * `VIBE_ENABLE_WEBSOCKET=1`, or its `/ws/:match_id` route refuses the upgrade.
 */

export type TransportPolicyEnv = {
  VITE_ENABLE_WEBSOCKET?: string;
};

/** Shown to the player, and thrown, when WebTransport fails and there is no fallback. */
export const WEBSOCKET_DISABLED_MESSAGE = 'WebTransport unavailable; WebSocket transport is disabled';

/** Thrown by any attempt to use the game WebSocket while the transport is disabled. */
export class WebSocketTransportDisabledError extends Error {
  constructor(detail?: string) {
    super(detail ? `${WEBSOCKET_DISABLED_MESSAGE} (${detail})` : WEBSOCKET_DISABLED_MESSAGE);
    this.name = 'WebSocketTransportDisabledError';
  }
}

function buildEnv(): TransportPolicyEnv {
  // `import.meta.env` is replaced by Vite at build time; guard for runtimes
  // (node tooling) where it does not exist.
  // Spelled literally as `import.meta.env` so Vite (and Vitest's stubEnv) see it.
  return (import.meta.env ?? {}) as TransportPolicyEnv;
}

/**
 * Whether the game client may use WebSocket at all. Default: no. Only the exact
 * value `'1'` enables it; anything else (unset, `true`, `yes`, `0`) is off.
 */
export function websocketTransportEnabled(env: TransportPolicyEnv = buildEnv()): boolean {
  return env?.VITE_ENABLE_WEBSOCKET === '1';
}

/**
 * The opt-in for node tooling that drives the game's WebSocket route directly
 * (the `simulate` load test, the benchmark's WebSocket bots). It reads
 * `VIBE_ENABLE_WEBSOCKET=1` -- the variable the game server gates the route
 * on -- because these tools only work against a server started with it.
 */
export function websocketToolingEnabled(env: Record<string, string | undefined>): boolean {
  return env.VIBE_ENABLE_WEBSOCKET === '1';
}

/** Whether this browser can speak WebTransport at all. */
export function browserSupportsWebTransport(): boolean {
  return typeof window !== 'undefined' && 'WebTransport' in window;
}
