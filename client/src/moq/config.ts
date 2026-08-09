/**
 * Where the demo page gets its relay details.
 *
 * Precedence is query string, then build-time env, then a built-in default.
 * The query string wins so a single deployed page can be pointed at a local
 * relay for debugging without a rebuild.
 *
 * The subscribe token is deliberately *not* committed. Set
 * `VITE_MOQ_SUBSCRIBE_TOKEN` at build time, or paste it into the page.
 */

/** Cloudflare's draft-16 relay endpoint. */
export const DEFAULT_RELAY_ENDPOINT = 'https://draft-16.cloudflare.mediaoverquic.com';

export const DEFAULT_NAMESPACE = 'vibe-land/demo';

export interface MoqDemoConfig {
  /** Relay origin, without the token path segment. */
  endpoint: string;
  /** Subscribe-capable token, or an empty string for a relay that needs none. */
  token: string;
  /** Namespace as its tuple fields, e.g. ['vibe-land', 'demo']. */
  namespace: string[];
  /**
   * SHA-256 of a self-signed relay certificate, hex encoded. Only needed
   * against a local relay; Chrome accepts pinned hashes for certificates valid
   * 14 days or less.
   */
  certificateHash: string | null;
}

function envValue(key: string): string | undefined {
  // `import.meta.env` is replaced at build time by Vite; guard for tests and
  // any non-Vite consumer.
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const value = env?.[key];
  return value && value.length > 0 ? value : undefined;
}

/** Split a `a/b/c` namespace into the tuple fields MoQ puts on the wire. */
export function parseNamespace(raw: string): string[] {
  const fields = raw.split('/').filter((field) => field.length > 0);
  return fields.length > 0 ? fields : DEFAULT_NAMESPACE.split('/');
}

/** Strip trailing slashes so joining a token cannot produce a double slash. */
function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function loadMoqDemoConfig(search: string): MoqDemoConfig {
  const params = new URLSearchParams(search);

  const endpoint = normalizeEndpoint(
    params.get('relay') ?? envValue('VITE_MOQ_RELAY_URL') ?? DEFAULT_RELAY_ENDPOINT,
  );
  const token = (params.get('token') ?? envValue('VITE_MOQ_SUBSCRIBE_TOKEN') ?? '').trim();
  const namespace = parseNamespace(
    params.get('ns') ?? envValue('VITE_MOQ_NAMESPACE') ?? DEFAULT_NAMESPACE,
  );
  const certificateHash = (params.get('certhash') ?? envValue('VITE_MOQ_CERT_HASH') ?? '').trim();

  return {
    endpoint,
    token,
    namespace,
    certificateHash: certificateHash.length > 0 ? certificateHash : null,
  };
}

/**
 * Cloudflare authenticates by token in the URL path, so the connect URL is the
 * endpoint with the token appended.
 */
export function buildConnectUrl(endpoint: string, token: string): string {
  const base = normalizeEndpoint(endpoint);
  const trimmed = token.trim();
  if (trimmed.length === 0) return base;

  // Tolerate a token pasted as a full URL, which is what the Cloudflare API
  // response and the docs' curl examples hand you.
  if (/^https?:\/\//i.test(trimmed)) return normalizeEndpoint(trimmed);

  return `${base}/${encodeURIComponent(trimmed.replace(/^\/+/, ''))}`;
}

/** Convert a hex SHA-256 digest into the form WebTransport wants. */
export function parseCertificateHash(hex: string): WebTransportHash[] {
  const clean = hex.trim().replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('certificate hash must be 64 hex characters (a SHA-256 digest)');
  }

  const value = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    value[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return [{ algorithm: 'sha-256', value }];
}
