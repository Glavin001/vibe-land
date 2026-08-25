import type { SessionConfigResponse } from '../net/webTransportClient';
import { isCityMatchId } from './matchId';

/**
 * Asking the control plane for a GPU server to play on.
 *
 * Opt-in: with no control plane configured this module is inert and the game
 * keeps connecting straight to whatever `VITE_MULTIPLAYER_HTTP_ORIGIN` points
 * at, which is how local development and the hand-run box keep working.
 *
 * When it is configured, the control plane -- not the game server -- is the
 * source of connect metadata. A rented box serves a self-signed certificate,
 * and `serverCertificateHashes` only rescues the WebTransport handshake; a
 * plain `fetch()` to that origin for `/session-config` would be rejected by the
 * browser. So the session block travels out through heartbeats and comes back
 * here instead.
 */

export type ControlPlaneConfig = {
  baseUrl: string;
};

export type JoinSession = {
  url: string;
  sim_hz: number;
  snapshot_hz: number;
  interpolation_delay_ms: number;
  protocol_version: number;
  physics_backend: number;
  client_movement_mode: number;
  city_manifest_hash?: string;
};

export type JoinReady = {
  ready: true;
  matchId: string;
  url: string;
  certHashHex: string;
  session: JoinSession;
};

export type JoinPending = {
  ready: false;
  phase: string;
  etaSeconds: number;
  retryAfterSeconds: number;
};

export type JoinResponse = JoinReady | JoinPending;

export type JoinProgress = {
  phase: string;
  etaSeconds: number;
  attempt: number;
};

export type MatchmakeEnv = {
  VITE_CONTROL_PLANE_URL?: string;
};

const MIN_POLL_SECONDS = 5;

/**
 * Query string wins over build-time config so a single deployed bundle can be
 * pointed at a scratch control plane without a rebuild. Same precedence the
 * MoQ and body-lab configs already use.
 */
export function resolveControlPlane(
  search: string,
  env: MatchmakeEnv = import.meta.env as MatchmakeEnv,
): ControlPlaneConfig | null {
  const params = new URLSearchParams(search);
  const raw = params.get('controlPlane')?.trim() || env.VITE_CONTROL_PLANE_URL?.trim();
  if (!raw) return null;
  // A relative value ("/cp") means the control plane is reachable through this
  // origin, which is how local development avoids mixed-content blocking when
  // the dev server is HTTPS and `wrangler dev` is not.
  if (raw.startsWith('/')) {
    return { baseUrl: raw.replace(/\/+$/, '') };
  }
  try {
    return { baseUrl: new URL(raw).toString().replace(/\/+$/, '') };
  } catch {
    console.warn('[join] ignoring malformed control plane URL:', raw);
    return null;
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export type JoinOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: JoinProgress) => void;
  /** Injected in tests; defaults to the global. */
  fetchImpl?: typeof fetch;
};

/**
 * Ask for a server, waiting through a cold start if one has to be rented.
 *
 * Polls rather than holding a socket open: renting and booting a GPU box takes
 * minutes, and the server tells us how long to wait between attempts so the
 * cadence stays a control-plane decision.
 */
export async function joinServer(
  config: ControlPlaneConfig,
  options: JoinOptions = {},
): Promise<JoinReady> {
  const doFetch = options.fetchImpl ?? fetch;
  let attempt = 0;

  for (;;) {
    options.signal?.throwIfAborted();
    attempt += 1;

    const response = await doFetch(`${config.baseUrl}/join`, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`control plane returned HTTP ${response.status} ${response.statusText}`);
    }
    const result = (await response.json()) as JoinResponse;

    if (result.ready) {
      console.info('[join] server ready', { matchId: result.matchId, url: result.url });
      return result;
    }

    options.onProgress?.({
      phase: result.phase,
      etaSeconds: result.etaSeconds,
      attempt,
    });
    const waitSeconds = Math.max(MIN_POLL_SECONDS, result.retryAfterSeconds ?? MIN_POLL_SECONDS);
    await sleep(waitSeconds * 1000, options.signal);
  }
}

/**
 * Reshape a join result into the session config the transport already speaks,
 * so nothing downstream needs to know a control plane was involved.
 */
export function toSessionConfig(result: JoinReady): SessionConfigResponse {
  const cityWorld = isCityMatchId(result.matchId) && Boolean(result.session.city_manifest_hash);
  return {
    match_id: result.matchId,
    url: result.session.url ?? result.url,
    server_certificate_hash_hex: result.certHashHex,
    sim_hz: result.session.sim_hz,
    snapshot_hz: result.session.snapshot_hz,
    interpolation_delay_ms: result.session.interpolation_delay_ms,
    protocol_version: result.session.protocol_version,
    physics_backend: result.session.physics_backend,
    client_movement_mode: result.session.client_movement_mode,
    city_world: cityWorld,
    city_manifest_hash: result.session.city_manifest_hash,
  };
}
